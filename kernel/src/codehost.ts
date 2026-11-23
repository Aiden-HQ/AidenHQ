// The one path to the code hosts' operations: every caller asks POST /v1/codehost/:op here with its own module token. That
// covers github-mcp, apps-mcp, the grader and the ci module's runner registration. The kernel checks the caller's grant once
// (its module.yaml `codehost:`, kernel/schemas/codehost.json, compiled into the kernel's module table; owner authority,
// loader/authority.ts). It then calls the github module's code host with the code host's own key, the one it calls its
// executor with, so the code host serves ops to the kernel alone and only it holds the owner's GitHub token: no op returns it.
//   snapshot     {repo, ref} → a tar.gz with no .git and no credentials
//   bundle       {repo, ref} → the branch as a git bundle, under the clone grant; the kernel's own (a job's `aidenhq clone`, which
//                its box runs at start for the repos its task names, and again when it likes), never a module's: the box clones or
//                fetches it itself, so host git never runs in a workspace a box can write
//   fetch        {repo, ref: refs/heads/* | refs/heads/<b> | refs/pull/<n>/head} → a git bundle of those refs
//   head         {repo, ref: <branch>} → {sha}
//   read         {repo, kind: pr | issue | diff | job | prs | file | run | exists, ...} → that object (a PR or issue as the grader
//                reads it, a diff, a job, the open PRs, a workflow run's identity; `file` a listed path's text at a commit, `exists`
//                whether such a path is there)
//   comment      {repo, number, body, id?} → {id}: posts (or edits comment `id`) with the "via AidenHQ" footer
//   commit       {repo, branch, path, content, parent, message} → {sha}: one file as the owner, with the trailer; 409 when the branch moved off parent
//   setup        {repo, files, title, body, task} → {pr_url, branch, tip}: files the code host's own Tier 1 `github.setup` write
//                (the AI reviewer reads the files), which runs only once approved: one commit adding the missing allowlisted files off the
//                default branch's head, on a new aidenhq/setup-<sha> branch no one else has moved, and its PR (an earlier setup PR is
//                closed). Answers {pending, write} while the record waits.
//   runner_token {org} → {token, expires_at}: an org's runner registration token, and nothing else
// A `local/…` repo (the org codehost-local owns) is served by codehost-local (in process: its snapshot) under the same grants
// and the same answer (its bundle: every branch), and none of the GitHub-only ops (fetch, head, read, comment, commit, runner_token); every op without
// the github code host for other orgs is 404.
// The change-request ops are write kinds, not broker ops: `codehost-local.{push,pr,merge,close,create_repo}` — declared by
// modules/codehost-local/src/kinds.ts, executed by its host.ts in the kernel's process (no service, no key),
// with its `change` check job and the kernel's localmerge.ts auto-merge — run in the kernel, never here. A merge's refusals
// (head-moved, checks-not-green, conflict) are modules/codehost-local/src/refuse.ts.
//
// Which host owns a repo is hostOf's, the one routing rule: codehost-local the org `local`, codehost-github every other. A
// write names an action on repos (`codehost.<action>`) and routeKind turns it into that host's kind.
import { once } from "node:events";
import { createReadStream } from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { LOCAL_ORG } from "./kinds.ts";
import type { Resolver } from "./net.ts";
import type { Facts } from "./facts.ts";
import type { Kind } from "./writes.ts";
import { readNeed, type Need } from "../sdk/src/vendor/needs.ts";

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
// A module's grant (its `codehost:`, taken literally): repos are owner/name, owner/*, */* (anything the owner's account reaches), or
// @instance, @product, @agents/<name|*> (in the fleet org: github_fleet_org), @orgs (every repo of each owner the instance allows,
// github_orgs) and @maintained (the repos it maintains, maintainer_repos), which resolve from the kernel's own configuration (its
// repos), never from a module's settings. A commit grant names the paths it writes (a setup grant the same, where a `*` stands for one path segment), an evidence grant the files it reads; a
// runner grant, the orgs.
export type OpsGrant = { module: string; snapshot?: { repos: string[] }; clone?: { repos: string[] }; fetch?: { repos: string[] }; read?: { repos: string[] }; evidence?: { repos: string[]; paths: string[] }; exists?: { repos: string[] }; comment?: { repos: string[] }; commit?: { repos: string[]; paths: string[] }; setup?: { repos: string[]; paths: string[] }; runner?: { orgs: string[] } };

const SLUG = /^([\w.-]+)\/([\w.-]+|\*)$/;
const DOTS = /^\.+$/;
// A branch, tag or commit: no leading -, no .., no @{, no control characters or spaces, at most 255 characters.
const REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[\w./-]{1,255}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const PLAIN = /^[\w.-]+\/[\w.-]+$/, ORG = /^[\w.-]+$/;
/**
 * A grant's repo entry with its @ name resolved: none when the kernel has no such repo, one per fleet org for @agents/. A
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
/** A runner grant's org entry with its @ name resolved (the grant as written may also be a plain org name or `*`). */
export function resolveOrg(p: string, r: KernelRepos): string[] {
  if (p === "@agents") return r.agentsOrgs ?? [];
  if (p === "@product") return r.product && PLAIN.test(r.product) ? [r.product.split("/")[0]!] : [];
  if (p === "@orgs") return r.orgs ?? [];
  return [p];
}
/** The kernel's repos; `agentsOrgs`: one per enabled code host (the GitHub fleet org, `local` with codehost-local). */
export type KernelRepos = { instance?: string; product?: string; agentsOrgs?: string[]; orgs?: string[]; maintained?: string[] };

/** Whether a grant's repos cover `slug` (owner/name, or owner/* for an org-wide token). */
export function covers(slug: string, repos: string[] = [], r: KernelRepos = {}): boolean {
  const owner = slug.split("/")[0]!;
  return repos.flatMap((p) => resolveRepo(p, r)).some((p) => (p === "*/*" || same(p, slug) || (p.endsWith("/*") && same(p.slice(0, -2), owner))));
}

const NO_HOST = "no GitHub code host here (the github module isn't enabled)";
/** Each op's grant: the key of the module's `codehost:` it needs. */
const GRANT_KEY: Record<string, "snapshot" | "clone" | "fetch" | "read" | "comment" | "commit" | "setup" | "runner"> = {
  snapshot: "snapshot", bundle: "clone", fetch: "fetch", head: "fetch", read: "read", comment: "comment", commit: "commit", setup: "setup", runner_token: "runner",
};
const FETCH_REF = /^(refs\/heads\/\*|refs\/heads\/(?!-)(?!.*\.\.)(?!.*@\{)[\w./-]{1,200}|refs\/pull\/\d{1,9}\/head)$/;
/** How much of a refusal's answer is read to find its need; a bigger body streams through unread (no need is that big). */
const NEED_BODY = 1 << 20;
/**
 * The owner-fixable need in the code host's error answer (`{error, need}`, modules/github/service/src/ops.ts serveOps). An
 * unreachable or rate-limited cause is transient, not the owner's to fix, and records nothing; anything else keeps
 * OWNER_CAUSES. The need's shape is readNeed's (the MCP proxy reads the same fields), and `detail` is the code host's error
 * text, which is what the owner sees.
 */
function ownerNeed(answer: string): Need | undefined {
  let j: { error?: unknown; need?: unknown } | undefined;
  try { j = JSON.parse(answer) as typeof j; } catch { return undefined; }
  const n = j?.need;
  if (!n || typeof n !== "object") return undefined;
  // A transient cause is a plain error, not a connection need; a cause outside OWNER_CAUSES reads as not_connected, as readNeed reads it.
  const cause = (n as { cause?: unknown }).cause;
  if (cause === "unreachable" || cause === "rate_limited") return undefined;
  const need = readNeed({ isError: true, structuredContent: { error: "needs_owner", need: n as Record<string, unknown> } });
  return need && { ...need, detail: typeof j!.error === "string" ? j!.error : need.detail };
}
const READ_KINDS = ["pr", "issue", "diff", "job", "prs", "file", "run", "exists", "commit"];
/** The kinds their own narrow grant covers: a `file` read (a listed path's text) is `evidence`; `exists` (only whether a path is a directory) has its own grant. */
const KIND_GRANT: Record<string, "evidence" | "exists"> = { file: "evidence", exists: "exists" };
const PATH = /^[\w.-][\w./-]{0,499}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw fail(400, `${what} must be a positive integer`);
  return n;
};
const text = (v: unknown, what: string, max: number) => {
  if (typeof v !== "string" || !v || v.length > max) throw fail(400, `${what} must be 1 to ${max} characters`);
  return v;
};
/** The body the code host gets for a GitHub-only op: only the fields the op names, each checked here, never the caller's object. */
function shape(op: string, b: Record<string, unknown>, paths: string[] = [], setupPaths: string[] = []): Record<string, unknown> {
  if (op === "fetch") {
    const ref = String(b.ref ?? "");
    if (!FETCH_REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not refs/heads/*, a branch ref or a pull request's head`);
    return { ref };
  }
  if (op === "head") {
    const ref = String(b.ref ?? "");
    if (!REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch`);
    return { ref };
  }
  if (op === "read") {
    const kind = String(b.kind ?? "");
    if (!READ_KINDS.includes(kind)) throw fail(400, `kind is one of ${READ_KINDS.join(", ")}`);
    if (kind === "prs") return { kind };
    if (kind === "job") return { kind, id: int(b.id, "id") };
    if (kind === "run") return { kind, id: int(b.id, "id") };
    if (kind === "commit") {
      const ref = String(b.ref ?? "");
      if (!SHA40.test(ref)) throw fail(400, "ref is a full commit sha");
      return { kind, ref };
    }
    if (kind === "file" || kind === "exists") {
      const path = String(b.path ?? ""), ref = String(b.ref ?? "");
      if (!PATH.test(path) || path.split("/").some((s) => s === ".." || s === "." || !s)) throw fail(400, `${path.slice(0, 100)} is not a path in the repository`);
      if (!SHA40.test(ref)) throw fail(400, "ref is a full commit sha");
      return { kind, path, ref };
    }
    return { kind, number: int(b.number, "number") };
  }
  if (op === "comment") return { number: int(b.number, "number"), body: text(b.body, "body", 65_000), ...(b.id == null ? {} : { id: int(b.id, "id") }) };
  if (op === "setup") {
    const entries = b.files && typeof b.files === "object" && !Array.isArray(b.files) ? Object.entries(b.files as Record<string, unknown>) : [];
    if (!entries.length || entries.length > 8) throw fail(400, "files is 1 to 8 paths");
    const allowed = setupPaths.map((g) => new RegExp(`^${g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\w.-]+")}$`));
    const files: Record<string, string> = {};
    for (const [path, content] of entries) {
      if (!/^[\w.][\w./-]{0,499}$/.test(path) || path.split("/").some((x) => DOTS.test(x)) || !allowed.some((re) => re.test(path))) throw fail(403, `the setup grant doesn't list ${path.slice(0, 200)}`);
      if (typeof content !== "string") throw fail(400, `${path}: content must be a string`);
      files[path] = content;
    }
    // The code host's executor reads at most 1 MB a request, the record around these args included (github setup.ts SETUP_BYTES).
    if (Buffer.byteLength(JSON.stringify(files)) > 800_000) throw fail(413, "the setup files are at most 800,000 bytes in all");
    const task = String(b.task ?? "");
    if (!/^[\w.:-]{1,100}$/.test(task)) throw fail(400, "task is the id of the task the setup's approval belongs to");
    return { files, allow: setupPaths, title: text(b.title, "title", 200), body: text(b.body, "body", 20_000), task };
  }
  // commit
  const path = text(b.path, "path", 500), branch = String(b.branch ?? ""), parent = String(b.parent ?? "");
  if (!REF.test(branch)) throw fail(400, `${branch.slice(0, 100)} is not a branch`);
  if (!/^[0-9a-f]{40}$/.test(parent)) throw fail(400, "parent is a full commit sha");
  if (!paths.includes(path)) throw fail(403, `the commit grant doesn't list ${path.slice(0, 200)}`);
  if (typeof b.content !== "string" || b.content.length > 1_000_000) throw fail(400, "content must be a string of at most 1,000,000 characters");
  return { branch, path, content: b.content, parent, message: text(b.message, "message", 10_000) };
}

/** codehost-local's ops, in process (modules/codehost-local/src). */
export type LocalOps = { snapshot(repo: string, ref: string): Promise<Answer>; bundle(repo: string): Promise<{ file: string; done: () => void }> };

export function createCodehost({ grants, repos, kind, secret, resolver, local = () => undefined, noteObject = () => {}, recordNeed = () => {}, clearNeed = () => {} }: {
  grants: () => OpsGrant[];
  /** The kernel's own repos (AIDENHQ_INSTANCE_REPO, AIDENHQ_PRODUCT_REPO, the agents org): what @ names in grants resolve to. */
  repos: () => KernelRepos;
  /** The code host's executor (from its write kinds): where it runs, and the key it answers the kernel with. */
  kind: () => Kind | undefined;
  secret: (name: string) => string; resolver: Resolver;
  /** codehost-local's ops, when that module is enabled. */
  local?: () => LocalOps | undefined;
  /** Remembers a GitHub object a module's op made (`record` names who), so a later edit of it is known as ours (objects.ts). */
  noteObject?: (ref: string, record: string) => void;
  /** A code host op's needs_owner answer: the module that asked, and the need, recorded as connection state (main.ts). */
  recordNeed?: (module: string, need: Need) => void;
  /** A code host op's 2xx answer: the owner's sign-in served it, so a full need GitHub had clears (main.ts). */
  clearNeed?: (module: string) => void;
}) {
  /** Checks `module`'s grant and asks the code host: its answer as it came (JSON, a bundle, or a snapshot's tarball). */
  async function ask(module: string, op: string, b: Record<string, unknown>): Promise<Answer> {
    if (!Object.hasOwn(GRANT_KEY, op)) throw fail(404, `no codehost operation ${op}`);
    const g = grants().find((x) => x.module === module);
    const k = kind();
    if (op === "runner_token") {
      const org = String(b?.org ?? "");
      if (!ORG.test(org)) throw fail(400, `${org.slice(0, 100)} is not an org`);
      if (!g?.runner?.orgs.some((o) => o === "*" || resolveOrg(o, repos()).some((x) => same(x, org)))) throw fail(403, `${module} has no runner_token grant on ${org}`);
      if (!k?.executor) throw fail(404, NO_HOST);
      return forward(k, module, op, { module, org });
    }
    const repo = String(b?.repo ?? "");
    const m = SLUG.exec(repo);
    const onLocal = m !== null && same(m[1]!, LOCAL_ORG);
    if (!onLocal && !k?.executor) throw fail(404, NO_HOST);
    if (!m || DOTS.test(m[1]!) || DOTS.test(m[2]!) || m[2] === "*") throw fail(400, `${repo} is not owner/name`);
    const kindOf = op === "read" ? String(b?.kind ?? "") : "";
    const key = KIND_GRANT[kindOf] ?? GRANT_KEY[op]!;
    const grant = g?.[key as "snapshot"];
    if (!covers(repo, grant?.repos, repos())) throw fail(403, `${module} has no ${key} grant on ${repo}`);
    if (onLocal) {
      const ref = String(b.ref ?? "");
      if (op !== "snapshot" && op !== "bundle") throw fail(404, `codehost-local has no ${op} operation`);
      if (!REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch or a commit`);
      const l = local();
      if (!l) throw fail(404, "codehost-local isn't enabled here");
      if (op === "bundle") {
        // Sent from the open file, gone from the scratch at once: nothing is left behind however the send ends.
        const out = await l.bundle(repo);
        try {
          const file = createReadStream(out.file);
          await once(file, "open");
          return Object.assign(file, { statusCode: 200, headers: { "content-type": "application/octet-stream" } });
        } finally { out.done(); }
      }
      return l.snapshot(repo, ref);
    }
    let out: Record<string, unknown> = { module, repo };
    if (op === "snapshot" || op === "bundle") {
      const ref = String(b.ref ?? "");
      if (!REF.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch or a commit`);
      out.ref = ref;
    } else {
      out = { ...out, ...shape(op, b, (g as OpsGrant).commit?.paths, (g as OpsGrant).setup?.paths) };
      // A `file` read names its path here too: the evidence grant lists the exact ones it may read, never a prefix.
      if (op === "read" && String(b?.kind) === "file" && !(g as OpsGrant).evidence?.paths.includes(String(out.path ?? ""))) throw fail(403, `the evidence grant doesn't list ${String(out.path ?? "").slice(0, 200)}`);
    }
    return forward(k!, module, op, out);
  }
  /** The GitHub code host's call: the kernel's executor key, the op's validated body, the answer as it came. */
  async function forward(k2: Kind, module: string, op: string, out: Record<string, unknown>): Promise<Answer> {
    const key = secret(k2.executor!.auth_secret);
    if (!key) throw fail(503, `${CODEHOST}'s key is missing`);
    const url = new URL(`/ops/${op}`, k2.executor!.url).toString();
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(out));
    return new Promise<Answer>((ok, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10 * 60_000, headers: { host: new URL(url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } },
      // The code host answers as the owner: a 2xx proves the sign-in worked, so a full need an earlier refusal recorded clears
      // (a scope need is partial and stays until the owner grants it). The answer itself is untouched.
      (r) => { if ((r.statusCode ?? 500) < 300) clearNeed(module); ok(r); });
      req.on("timeout", () => req.destroy(fail(504, `${CODEHOST} didn't answer`)));
      req.on("error", (e) => { resolver.forget(url); reject((e as { status?: number }).status ? e : fail(502, `${CODEHOST} is unreachable (${e.message})`)); });
      req.end(data);
    });
  }
  let owner: { at: number; id: { name: string; email: string } } | undefined;
  /** The owner's commit identity from the code host (GET /aidenhq/v1/identity), cached 10 minutes; none while GitHub isn't connected or the code host is down. */
  async function identity(): Promise<{ name: string; email: string } | undefined> {
    if (owner && Date.now() - owner.at < 10 * 60_000) return owner.id;
    const k = kind(), key = k?.executor && secret(k.executor.auth_secret);
    if (!k?.executor || !key) return undefined;
    try {
      const url = new URL("/aidenhq/v1/identity", k.executor.url).toString();
      const to = await resolver.resolve(url);
      const got = await new Promise<{ status?: number; body: string }>((ok, no) => {
        const req = http.request({ host: to.host, port: to.port, path: to.path, method: "GET", timeout: 10_000, headers: { host: new URL(url).host, authorization: `Bearer ${key}` } }, (r) => {
          let body = "";
          r.on("data", (c) => (body += c)).on("end", () => ok({ status: r.statusCode, body })).on("error", no);
        });
        req.on("timeout", () => req.destroy(new Error("timeout"))).on("error", no).end();
      });
      const id = got.status === 200 ? (JSON.parse(got.body) as { name?: unknown; email?: unknown }) : undefined;
      if (typeof id?.name !== "string" || typeof id.email !== "string") return undefined;
      owner = { at: Date.now(), id: { name: id.name, email: id.email } };
      return owner.id;
    } catch { return undefined; }
  }
  /**
   * Where a share would land (POST /aidenhq/v1/publish/tip, the code host's executor key): the branch's tip, whether the repo
   * is private, and a folder or marketplace entry there that isn't this module's (module-share.ts preview). Throws the code
   * host's refusal (a missing repo or branch, GitHub signed out).
   */
  async function publishTip(b: { repo: string; ref: string; module: string }): Promise<{ repo: string; base: string; private: boolean; conflict?: string; existing?: string[] }> {
    const k = kind(), key = k?.executor && secret(k.executor.auth_secret);
    if (!k?.executor || !key) throw fail(404, "sharing needs GitHub connected");
    const url = new URL("/aidenhq/v1/publish/tip", k.executor.url).toString();
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(b));
    const got = await new Promise<{ status: number; body: string }>((ok, no) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 60_000, headers: { host: new URL(url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c)).on("end", () => ok({ status: r.statusCode ?? 500, body })).on("error", no);
      });
      req.on("timeout", () => req.destroy(fail(504, `${CODEHOST} didn't answer`))).on("error", (e) => no((e as { status?: number }).status ? e : fail(502, `${CODEHOST} is unreachable (${e.message})`))).end(data);
    });
    let j: { repo?: unknown; base?: unknown; private?: unknown; conflict?: unknown; existing?: unknown; error?: unknown } = {};
    try { j = JSON.parse(got.body); } catch { /* no JSON: the status says it */ }
    if (got.status >= 300) throw fail(got.status >= 500 ? 502 : 422, String(j.error ?? `${CODEHOST} answered ${got.status}`).slice(0, 500));
    if (typeof j.base !== "string" || !/^[0-9a-f]{40}$/.test(j.base) || typeof j.repo !== "string") throw fail(502, `${CODEHOST} named no tip`);
    const existing = Array.isArray(j.existing) ? j.existing.filter((p): p is string => typeof p === "string") : [];
    return { repo: j.repo, base: j.base, private: j.private !== false, existing, ...(typeof j.conflict === "string" ? { conflict: j.conflict } : {}) };
  }
  return {
    ask, identity, publishTip,
    /** POST /v1/codehost/:op: the answer goes back as it came. */
    async op(module: string, op: string, b: Record<string, unknown>, res: ServerResponse): Promise<void> {
      if (op === "bundle") throw fail(404, "no codehost operation bundle");
      const r = await ask(module, op, b);
      // A typed need (a refusal only the owner can fix) is connection state, as an MCP's needs_owner answer is (connection-state.ts):
      // without this a runner registration refused for a missing scope reached nobody. The answer still goes back as it came.
      let body: Buffer | undefined;
      let more: Readable | undefined;
      if ((r.statusCode ?? 500) >= 400 && String(r.headers["content-type"] ?? "").startsWith("application/json")) {
        const it = r[Symbol.asyncIterator]();
        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          const n = await it.next();
          if (n.done) break;
          size += n.value.length;
          if (size > NEED_BODY) {
            // Too big to hold whole: hand what was read and the rest of the answer on unread, and record no need from a partial read.
            // `it` is driven by the source, so a caller that hangs up ends this generator through `more.destroy()`, which
            // returns the upstream answer to the code host's pool instead of leaving it stalled under a full pipe.
            const head = Buffer.concat([...chunks, n.value]);
            const source = it;
            more = Readable.from((async function* () {
              try { yield head; for (;;) { const x = await source.next(); if (x.done) return; yield x.value; } }
              finally { void Promise.resolve(source.return?.()).catch(() => {}); }
            })());
            // Destroying the wrapper (pipeline does it when the caller hangs up) returns the upstream answer even while the
            // generator is parked awaiting a chunk under backpressure: nothing is left holding the code host's connection.
            more.once("close", () => r.destroy());
            break;
          }
          chunks.push(n.value);
        }
        if (!more) {
          body = Buffer.concat(chunks);
          const need = ownerNeed(body.toString("utf8"));
          if (need) recordNeed(module, need);
        }
      }
      // A new comment is ours: remembered by its ref, so editing it (the comment op with `id`) is allowed and no other is.
      if (op === "comment" && b.id == null && r.statusCode === 200) {
        const chunks: Buffer[] = [];
        for await (const c of r) chunks.push(c as Buffer);
        const id = Number((JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: unknown }).id);
        if (Number.isInteger(id) && id > 0) noteObject(`github:${String(b.repo)}#${Number(b.number)}/comment/${id}`, `codehost:${module}`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id }));
        return;
      }
      res.writeHead(r.statusCode ?? 502, { "content-type": String(r.headers["content-type"] ?? "application/json"), ...(r.headers["x-aidenhq-commit"] ? { "x-aidenhq-commit": String(r.headers["x-aidenhq-commit"]) } : {}) });
      if (body) return void res.end(body);
      // The caller's answer is streamed, and the op settles when the response or the answer closes: a caller that hangs up
      // mid-answer destroys the source, so an oversized body parked on a full pipe stops the upstream read rather than
      // stalling this op and holding the code host's connection open.
      const out = more ?? r;
      await new Promise<void>((ok, reject) => {
        let settled = false;
        const done = (e?: Error) => { if (settled) return; settled = true; if (e) reject(e); else ok(); };
        out.on("end", () => done()).on("error", done).on("close", () => done());
        res.on("close", () => { if (!res.writableEnded) out.destroy(); });
        out.pipe(res);
      });
    },
  };
}

/**
 * codehost-local's Flow facts (modules/codehost-local/src/host.ts `fact`): recorded straight into the kernel's fact store as
 * `module:codehost-local` with the module in the version as POST /v1/facts stamps it (generations.ts trusts only code hosts' pr.merged),
 * the same pr.* and code.* facts codehost-github emits there. A fact never fails the write it describes.
 */
export const localFacts = (facts: Facts, projects?: { queue(task: string, repo: string): void; touch(task: string, repo: string): Promise<void> }) => (f: { type: string; subject: string; version: string; at: string; task?: string | null; data?: Record<string, unknown> }) => {
  try {
    // A new PR on a task: the task joins the repo's project, as for codehost-github's (backplane.ts /v1/facts). Queued before
    // the fact is recorded, so a stop in between never leaves a PR without its fill (a fill for a task with a project does nothing).
    const fill = f.type === "pr.opened" && f.task && typeof f.data?.repo === "string" ? { task: f.task, repo: f.data.repo } : undefined;
    if (fill) projects?.queue(fill.task, fill.repo);
    const fresh = facts.record({ ...f, version: `codehost-local/${f.version}`, task: f.task ?? undefined, actor: "module:codehost-local" });
    if (fill && fresh) void projects?.touch(fill.task, fill.repo).catch(() => {});
  } catch { /* a fact write never blocks the action */ }
};
