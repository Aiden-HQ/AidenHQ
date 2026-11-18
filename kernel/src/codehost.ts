// The one path to the GitHub code host's operations (one-way phase 2, Lane T): every caller asks POST /v1/codehost/:op here
// with its own module token. That covers github-mcp, apps-mcp and the ci module's runner registration. The kernel checks the
// caller's grant once (its module.yaml `codehost:`, kernel/schemas/codehost.json, compiled into the kernel's module table;
// owner authority, loader/authority.ts). It then calls
// codehost-github with the code host's own key, the one it calls its executor with, so the code host serves ops to the kernel
// alone and only codehost-github holds the GitHub App key.
//   token    {repo: owner/name | owner/*, perms} → {token, repo, perms, expires_at, app}; owner/* is an org-wide token
//   snapshot {repo, ref} → a tar.gz with no .git and no credentials
//   clone    {repo, ref, into: task} → a credential-free clone in the workspace of a task whose agent the caller dispatches
// Without codehost-github (a codehost-local install), every op is 404: there is no GitHub code host.
import http from "node:http";
import type { ServerResponse } from "node:http";
import type { Resolver } from "./net.ts";
import type { Kind } from "./writes.ts";

export const CODEHOST = "codehost-github";
// A module's grant (its `codehost:`, taken literally): repos are owner/name, owner/*, */* (anything the App covers), or
// @instance, @product, @agents/<name|*>, which resolve from the kernel's own configuration (its repos), never from settings.
export type OpsGrant = { module: string; token?: { repos: string[]; perms: Record<string, string> }; snapshot?: { repos: string[] }; clone?: { repos: string[] } };

const LEVEL = new Map([["read", 1], ["write", 2]]);
const SLUG = /^([\w.-]+)\/([\w.-]+|\*)$/;
const DOTS = /^\.+$/;
// A branch, tag or commit: no leading -, no .., no @{, no control characters or spaces, at most 255 characters.
const REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[\w./-]{1,255}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const PLAIN = /^[\w.-]+\/[\w.-]+$/, ORG = /^[\w.-]+$/;
/**
 * A grant's repo entry with its @ name resolved, or undefined when the kernel has no such repo. A resolved value is a plain
 * owner/name (or org): a `*` only ever comes from the grant as written, which the owner saw.
 */
export function resolveRepo(p: string, r: KernelRepos): string | undefined {
  if (p === "@instance") return r.instance && PLAIN.test(r.instance) ? r.instance : undefined;
  if (p === "@product") return r.product && PLAIN.test(r.product) ? r.product : undefined;
  if (p.startsWith("@agents/")) return r.agentsOrg && ORG.test(r.agentsOrg) ? `${r.agentsOrg}/${p.slice("@agents/".length)}` : undefined;
  return p;
}
export type KernelRepos = { instance?: string; product?: string; agentsOrg?: string };

/** Whether a grant's repos cover `slug` (owner/name, or owner/* for an org-wide token). */
export function covers(slug: string, repos: string[] = [], r: KernelRepos = {}): boolean {
  const owner = slug.split("/")[0]!;
  return repos.map((p) => resolveRepo(p, r)).some((p) => p !== undefined && (p === "*/*" || same(p, slug) || (p.endsWith("/*") && same(p.slice(0, -2), owner))));
}

export function createCodehost({ grants, repos, kind, secret, resolver, workspace }: {
  grants: () => OpsGrant[];
  /** The kernel's own repos (AIDENHQ_INSTANCE_REPO, AIDENHQ_PRODUCT_REPO, the agents org): what @ names in grants resolve to. */
  repos: () => KernelRepos;
  /** The code host's executor (from its write kinds): where it runs, and the key it answers the kernel with. */
  kind: () => Kind | undefined;
  secret: (name: string) => string; resolver: Resolver;
  /** The workspace folder of task `task`, if `module` dispatches its agent (jobs.ts workspace); throws otherwise. */
  workspace: (module: string, task: unknown) => Promise<{ workspace: string }>;
}) {
  /** Checks `module`'s grant and asks the code host: its answer as it came (JSON, or a snapshot's tarball). */
  async function ask(module: string, op: string, b: Record<string, unknown>): Promise<http.IncomingMessage> {
    if (!["token", "snapshot", "clone"].includes(op)) throw fail(404, `no codehost operation ${op}`);
    const k = kind();
    if (!k?.executor) throw fail(404, "no GitHub code host here (codehost-github isn't enabled)");
    const repo = String(b?.repo ?? "");
    const m = SLUG.exec(repo);
    if (!m || DOTS.test(m[1]!) || DOTS.test(m[2]!) || (m[2] === "*" && op !== "token")) throw fail(400, `${repo} is not owner/name${op === "token" ? " or owner/*" : ""}`);
    const g = grants().find((x) => x.module === module);
    const grant = g?.[op as "token" | "snapshot" | "clone"];
    if (!covers(repo, grant?.repos, repos())) throw fail(403, `${module} has no ${op} grant on ${repo}`);
    let out: Record<string, unknown>;
    if (op === "token") {
      const asked = b.perms && typeof b.perms === "object" && !Array.isArray(b.perms) ? Object.entries(b.perms as Record<string, unknown>) : [];
      if (!asked.length) throw fail(400, "name the permissions");
      // Only the grant's own names and the two levels; the forwarded object holds nothing else.
      const granted = g!.token!.perms;
      const perms: Record<string, string> = Object.create(null);
      for (const [p, l] of asked) {
        const have = Object.hasOwn(granted, p) ? granted[p] : undefined;
        if (typeof l !== "string" || !LEVEL.has(l) || typeof have !== "string" || !LEVEL.has(have) || LEVEL.get(l)! > LEVEL.get(have)!) throw fail(403, `${module} has no ${p}:${String(l)} grant`);
        perms[p] = l;
      }
      out = { module, repo, perms: { ...perms } };
    } else {
      const ref = String(b.ref ?? "");
      if (!REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch or a commit`);
      out = { module, repo, ref };
      if (op === "clone") out.into = (await workspace(module, b.into)).workspace;
    }
    const key = secret(k.executor.auth_secret);
    if (!key) throw fail(503, `${CODEHOST}'s key is missing`);
    const url = new URL(`/ops/${op}`, k.executor.url).toString();
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(out));
    return new Promise<http.IncomingMessage>((ok, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10 * 60_000, headers: { host: new URL(url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, ok);
      req.on("timeout", () => req.destroy(fail(504, `${CODEHOST} didn't answer`)));
      req.on("error", (e) => { resolver.forget(url); reject((e as { status?: number }).status ? e : fail(502, `${CODEHOST} is unreachable (${e.message})`)); });
      req.end(data);
    });
  }
  return {
    ask,
    /** POST /v1/codehost/:op: the answer goes back as it came. */
    async op(module: string, op: string, b: Record<string, unknown>, res: ServerResponse): Promise<void> {
      const r = await ask(module, op, b);
      res.writeHead(r.statusCode ?? 502, { "content-type": String(r.headers["content-type"] ?? "application/json") });
      await new Promise<void>((ok, reject) => { r.pipe(res); r.on("end", ok).on("error", reject); });
    },
  };
}
