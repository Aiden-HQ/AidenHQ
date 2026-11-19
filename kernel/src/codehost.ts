// The one path to the code hosts' operations (one-way phase 2, Lane T): every caller asks POST /v1/codehost/:op here
// with its own module token. That covers github-mcp, apps-mcp and the ci module's runner registration. The kernel checks the
// caller's grant once (its module.yaml `codehost:`, kernel/schemas/codehost.json, compiled into the kernel's module table;
// owner authority, loader/authority.ts). It then calls
// codehost-github with the code host's own key, the one it calls its executor with, so the code host serves ops to the kernel
// alone and only codehost-github holds the GitHub App key.
//   token    {repo: owner/name | owner/*, perms} → {token, repo, perms, expires_at, app}; owner/* is an org-wide token
//   snapshot {repo, ref} → a tar.gz with no .git and no credentials
//   clone    {repo, ref, into: task} → a credential-free clone in the workspace of a task whose agent the caller dispatches
// A `local/…` repo (the org codehost-local owns) is served by codehost-local (in process: its snapshot) under the same grants
// and the same answer. It has no token, and no clone (host git never writes a workspace: a box clones a local repo itself,
// `aidenhq clone`); every op without codehost-github for other orgs is 404.
// The change-request ops are write kinds, not broker ops: `codehost-local.{push,pr,merge,close,create_repo}` (host.ts's
// executor, its `change` check job, and the kernel's localmerge.ts auto-merge) run in the kernel, never here.
//
// Which host owns a repo is hostOf's, the one routing rule: codehost-local the org `local`, codehost-github every other. A
// write names an action on repos (`codehost.<action>`) and routeKind turns it into that host's kind.
import http from "node:http";
import type { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { LOCAL_ORG } from "./kinds.ts";
import type { Resolver } from "./net.ts";
import type { Facts } from "./facts.ts";
import type { Kind } from "./writes.ts";

export const CODEHOST = "github";
/** The code host modules: their write kinds are an Engineer's (admission.ts), each for the repos it owns. */
export const CODEHOSTS = [CODEHOST, "codehost-local"];
/** The code host module that owns `repo`: codehost-local the org `local`, codehost-github every other. */
export const hostOf = (repo: string) => (String(repo).split("/")[0]!.toLowerCase() === LOCAL_ORG ? "codehost-local" : CODEHOST);
/**
 * A code host action (`codehost.<action>`: push, pr, merge, close, create_repo) on the repos its args name, as the kind of the
 * host that owns them; any other kind as it is. One write is on one host: repos on two are refused.
 */
export function routeKind(kind: string, args: unknown): string {
  if (!kind.startsWith("codehost.")) return kind;
  const a = (args ?? {}) as { repo?: unknown; only?: { repo?: unknown }[]; prs?: { repo?: unknown }[] };
  const repos = [a.repo, ...[a.only ?? [], a.prs ?? []].flat().map((x) => x?.repo)].filter((r) => typeof r === "string") as string[];
  const hosts = [...new Set(repos.map(hostOf))];
  if (hosts.length !== 1) throw fail(400, hosts.length ? `${kind} names repos on more than one code host: file one write per host` : `${kind} names no repository`);
  return `${hosts[0]}.${kind.slice("codehost.".length)}`;
}
/** A code host's answer to an op: a status, headers and a body stream (an http response, or codehost-local's tarball). */
export type Answer = Readable & { statusCode?: number; headers: http.IncomingHttpHeaders };
// A module's grant (its `codehost:`, taken literally): repos are owner/name, owner/*, */* (anything the App covers), or
// @instance, @product, @agents/<name|*> (in each agents org), @orgs (every repo of each owner the instance allows, github_orgs)
// and @maintained (the repos it maintains, maintainer_repos), which resolve from the kernel's own configuration (its repos),
// never from a module's settings.
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
 * A grant's repo entry with its @ name resolved: none when the kernel has no such repo, one per agents org for @agents/. A
 * resolved value is a plain owner/name (or org): a `*` only ever comes from the grant as written, which the owner saw.
 */
export function resolveRepo(p: string, r: KernelRepos): string[] {
  if (p === "@instance") return r.instance && PLAIN.test(r.instance) ? [r.instance] : [];
  if (p === "@product") return r.product && PLAIN.test(r.product) ? [r.product] : [];
  if (p === "@orgs") return (r.orgs ?? []).filter((o) => ORG.test(o)).map((o) => `${o}/*`);
  if (p === "@maintained") return (r.maintained ?? []).filter((x) => PLAIN.test(x));
  if (p.startsWith("@agents/")) return (r.agentsOrgs ?? []).filter((o) => ORG.test(o)).map((o) => `${o}/${p.slice("@agents/".length)}`);
  return [p];
}
/** The kernel's repos; `agentsOrgs`: one per enabled code host (the GitHub agents org, `local` with codehost-local). */
export type KernelRepos = { instance?: string; product?: string; agentsOrgs?: string[]; orgs?: string[]; maintained?: string[] };

/** Whether a grant's repos cover `slug` (owner/name, or owner/* for an org-wide token). */
export function covers(slug: string, repos: string[] = [], r: KernelRepos = {}): boolean {
  const owner = slug.split("/")[0]!;
  return repos.flatMap((p) => resolveRepo(p, r)).some((p) => (p === "*/*" || same(p, slug) || (p.endsWith("/*") && same(p.slice(0, -2), owner))));
}

/** codehost-local's ops, in process (modules/codehost-local/src). */
export type LocalOps = { snapshot(repo: string, ref: string): Promise<Answer> };

export function createCodehost({ grants, repos, kind, secret, resolver, workspace, local = () => undefined }: {
  grants: () => OpsGrant[];
  /** The kernel's own repos (AIDENHQ_INSTANCE_REPO, AIDENHQ_PRODUCT_REPO, the agents org): what @ names in grants resolve to. */
  repos: () => KernelRepos;
  /** The code host's executor (from its write kinds): where it runs, and the key it answers the kernel with. */
  kind: () => Kind | undefined;
  secret: (name: string) => string; resolver: Resolver;
  /** The workspace folder of task `task`, if `module` dispatches its agent (jobs.ts workspace); throws otherwise. */
  workspace: (module: string, task: unknown) => Promise<{ workspace: string }>;
  /** codehost-local's ops, when that module is enabled. */
  local?: () => LocalOps | undefined;
}) {
  /** Checks `module`'s grant and asks the code host: its answer as it came (JSON, or a snapshot's tarball). */
  async function ask(module: string, op: string, b: Record<string, unknown>): Promise<Answer> {
    if (!["token", "snapshot", "clone"].includes(op)) throw fail(404, `no codehost operation ${op}`);
    const repo = String(b?.repo ?? "");
    const m = SLUG.exec(repo);
    const onLocal = m !== null && same(m[1]!, LOCAL_ORG);
    const k = kind();
    if (!onLocal && !k?.executor) throw fail(404, "no GitHub code host here (the GitHub App isn't set up)");
    if (!m || DOTS.test(m[1]!) || DOTS.test(m[2]!) || (m[2] === "*" && op !== "token")) throw fail(400, `${repo} is not owner/name${op === "token" ? " or owner/*" : ""}`);
    const g = grants().find((x) => x.module === module);
    const grant = g?.[op as "token" | "snapshot" | "clone"];
    if (!covers(repo, grant?.repos, repos())) throw fail(403, `${module} has no ${op} grant on ${repo}`);
    if (onLocal) {
      const ref = String(b.ref ?? "");
      if (op === "clone") throw fail(422, `a repository on this server is cloned in your computer: run \`aidenhq clone ${repo}\``);
      if (op === "token") throw fail(404, "codehost-local has no token operation");
      if (!REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch or a commit`);
      const l = local();
      if (!l) throw fail(404, "codehost-local isn't enabled here");
      return l.snapshot(repo, ref);
    }
    const k2 = k!;
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
    const key = secret(k2.executor!.auth_secret);
    if (!key) throw fail(503, `${CODEHOST}'s key is missing`);
    const url = new URL(`/ops/${op}`, k2.executor!.url).toString();
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(out));
    return new Promise<Answer>((ok, reject) => {
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
      res.writeHead(r.statusCode ?? 502, { "content-type": String(r.headers["content-type"] ?? "application/json"), ...(r.headers["x-aidenhq-commit"] ? { "x-aidenhq-commit": String(r.headers["x-aidenhq-commit"]) } : {}) });
      await new Promise<void>((ok, reject) => { r.pipe(res); r.on("end", ok).on("error", reject); });
    },
  };
}

/**
 * codehost-local's Flow facts (modules/codehost-local/src/host.ts `fact`): recorded straight into the kernel's fact store as
 * `module:codehost-local` with the module in the version as POST /v1/facts stamps it (generations.ts trusts only code hosts' pr.merged),
 * the same pr.* and code.* facts codehost-github emits there. A fact never fails the write it describes.
 */
export const localFacts = (facts: Facts) => (f: { type: string; subject: string; version: string; at: string; task?: string | null; data?: Record<string, unknown> }) => {
  try { facts.record({ ...f, version: `codehost-local/${f.version}`, task: f.task ?? undefined, actor: "module:codehost-local" }); } catch { /* a fact write never blocks the action */ }
};
