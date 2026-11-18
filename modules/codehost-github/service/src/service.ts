// The code host as its own service: the executor of codehost-github.{push,pr,merge,close,create_repo} (executor@1; the
// kernel tiers each record with plan.mjs and calls execute only for an approved, claimed and revalidated one), and narrow
// GitHub operations for other modules (/ops/token, /ops/snapshot, /ops/clone), each granted by that module's contribution
// to the point codehost-github.ops.
//
// Repo code never runs here. Every git command carries SAFE_GIT_ARGS and no global or system config but the service's own
// (no hooks, no filters, no fsmonitor); a job's commits come in by a fetch from its workspace's .git into this service's
// bare cache clone, which is never checked out; the App token lives only in the env of the one git or GitHub call that
// needs it. Until `lands_platform_repos` (the big switch), it lands nothing outside the agents org: the product and modules
// repos are refused in plan, in execute and again at the merge. An approved merge runs as a queue (merges.ts) whose outcome
// comes once its PRs merged at their approved heads, or it stopped.
//
// The instance's land for kernel.apply (the kernel's executor, with this service's executor key): POST /aidenhq/v1/apply/read
// {repo, sha, branch, workspace?} → what the commit changes against the instance's main (files, and the agent.yaml texts the
// kernel's trial check reads); /apply/land → the commit on main, never forced, once (a commit main already has is a no-op).
// The commit comes from this service's own copy when it made it, else from the task's workspace. The instance repo only.
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { serveExecutor, type Executor, type PlanRequest } from "./aidenhq-sdk/executor.ts";
import { CREDENTIAL_ARGS } from "./github-app.ts";
import { createEvalGate } from "./evalgate.ts";
import { createMerges } from "./merges.ts";
import { plan as planRules } from "./plan.mjs";
import { notePrTask } from "./pr-watch.ts";
import { noteKept } from "./tidy.ts";

const run = promisify(execFile);

/** codehost-github/src/git.mjs SAFE_GIT_ARGS (test/service.test.mjs checks they match). */
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];

type Gh = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: any }>;
type App = { token(org: string, o: { repositories?: string[]; permissions?: Record<string, string>; fresh?: boolean }): Promise<string>; createRepo(slug: string): Promise<"exists" | "created">; identity(): Promise<{ name: string }> };
/** One module's grant (its contribution to codehost-github.ops; schemas/ops.json). */
export type Grant = { module: string; token?: { repos: string[]; perms: Record<string, string> }; snapshot?: { repos: string[] }; clone?: { repos: string[] } };
export type Options = {
  key: string; kernelUrl: string; cacheDir: string; tasksDir?: string;
  /** The App (src/github-app.ts appClient); undefined without the key: every GitHub action fails, saying so. */
  app?: App; gh: Gh; remoteUrl?: (slug: string) => string;
  agentsOrg: string; instanceRepo?: string; productRepo?: string; modulesRepo?: string;
  landsPlatformRepos: boolean; grants: () => Grant[]; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests: the merge loop's clock and its poll interval. */
  now?: () => Date; mergeEveryMs?: number;
};

const READ = { contents: "read", metadata: "read" };
const PUSH = { contents: "write", pull_requests: "write", metadata: "read" };
const MERGE = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" };
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
const SLUG = /^([\w.-]+)\/([\w.-]+)$/;
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const slugOf = (repo: unknown) => {
  const m = SLUG.exec(String(repo ?? ""));
  if (!m || m[2]!.endsWith(".git") || m.slice(1).some((p) => /^\.+$/.test(p))) throw fail(400, `${String(repo)} is not owner/name`);
  return { slug: `${m[1]}/${m[2]}`, org: m[1]!, name: m[2]! };
};
// A grant's repos: owner/name, owner/* (every repo of owner, and owner's org-wide tokens) or */* (any repo or owner the App
// covers).
const matches = (slug: string, patterns: string[] = []) => patterns.some((p) => p === "*/*" || same(p, slug) || (p.endsWith("/*") && same(p.slice(0, -2), slug.split("/")[0])));
// An org-wide token's target: owner/*.
const ORG_WIDE = /^([\w.-]+)\/\*$/;

export function createService(o: Options) {
  const log = o.log ?? (() => {});
  const remote = o.remoteUrl ?? ((slug: string) => `https://github.com/${slug}.git`);
  mkdirSync(o.cacheDir, { recursive: true });
  // The only git config any command here reads: safe.directory for workspaces another uid owns, nothing that runs a program.
  const gitconfig = join(o.cacheDir, "gitconfig");
  writeFileSync(gitconfig, "[safe]\n\tdirectory = *\n[protocol]\n\tallow = never\n[protocol \"https\"]\n\tallow = always\n[protocol \"file\"]\n\tallow = always\n");
  const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.cacheDir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
  async function git(dir: string, args: string[], token?: string): Promise<string> {
    const env = token ? { ...ENV, AIDENHQ_GIT_TOKEN: token } : ENV;
    const full = [...SAFE_GIT_ARGS, ...(token ? CREDENTIAL_ARGS : []), "--git-dir", dir, ...args];
    return (await run("git", full, { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  }
  const app = () => o.app ?? (() => { throw fail(503, "the GitHub App key isn't mounted: codehost-github can't reach GitHub"); })();
  const tokenFor = (s: { org: string; name: string }, permissions: Record<string, string>) => app().token(s.org, { repositories: [s.name], permissions });
  async function api(method: string, path: string, token: string, body?: unknown) {
    const r = await o.gh(method, path, token, body);
    if (r.status >= 300) throw fail(502, `GitHub ${method} ${path.split("?")[0]}: ${r.status} ${r.body?.message ?? ""}`.trim());
    return r.body;
  }

  /**
   * A repo's bare cache clone (created on first use), never checked out. `github`: GitHub's objects only, the one snapshot and
   * clone serve; `ws`: job commits from workspaces (and GitHub's default branch to diff against), the one pushes come from.
   */
  async function cache(s: { org: string; name: string; slug: string }, kind: "github" | "ws" = "github") {
    const dir = join(o.cacheDir, kind, s.org.toLowerCase(), `${s.name.toLowerCase()}.git`);
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dir, { recursive: true });
      await run("git", [...SAFE_GIT_ARGS, "init", "--quiet", "--bare", dir], { env: ENV });
    }
    return dir;
  }
  /** A branch (name) or commit (sha) of the repo on GitHub, fetched into the cache at refs/remote/<name>: { dir, ref, sha }. */
  async function fetchRemote(s: ReturnType<typeof slugOf>, name: string, kind: "github" | "ws" = "github") {
    const dir = await cache(s, kind);
    const ref = `refs/remote/${name}`;
    await git(dir, ["fetch", "--quiet", "--no-tags", remote(s.slug), `+${/^[0-9a-f]{40}$/.test(name) ? name : `refs/heads/${name}`}:${ref}`], await tokenFor(s, READ));
    return { dir, ref, sha: await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]) };
  }

  /** The job workspace's clone of `name` (<task>/<name> or <task>/<org>--<name>): a real .git directory inside that task's folder. */
  function workspaceGit(ident: string, s: { org: string; name: string }) {
    if (!o.tasksDir) throw fail(503, "the job workspaces aren't mounted: codehost-github can't read a job's commits");
    if (!IDENT.test(ident)) throw fail(400, `${ident} is not a task's workspace`);
    const root = realpathSync(o.tasksDir);
    for (const d of [s.name, `${s.org}--${s.name}`]) {
      const at = join(root, ident, d, ".git");
      if (!existsSync(at)) continue;
      for (const p of [join(root, ident), join(root, ident, d), at]) if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory()) throw fail(400, `${p.slice(root.length + 1)} isn't a plain directory`);
      checkGitDir(at);
      return at;
    }
    throw fail(404, `task ${ident} has no clone of ${s.org}/${s.name}`);
  }
  /**
   * A workspace .git the agent wrote: only plain files and directories (no symlink, fifo or device anywhere), the shape of a
   * clone's own gitdir, and nothing that points git elsewhere (commondir, alternates, http-alternates).
   */
  function checkGitDir(at: string) {
    for (const f of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) if (lstatSync(join(at, f), { throwIfNoEntry: false })) throw fail(400, `the workspace's .git has ${f}; refusing it`);
    if (!lstatSync(join(at, "HEAD"), { throwIfNoEntry: false })?.isFile() || !lstatSync(join(at, "objects"), { throwIfNoEntry: false })?.isDirectory() || !lstatSync(join(at, "refs"), { throwIfNoEntry: false })?.isDirectory()) throw fail(400, "the workspace's .git isn't a clone's git directory");
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (!e.isFile()) throw fail(400, `the workspace's .git has ${join(dir, e.name).slice(at.length + 1)}, which isn't a plain file; refusing it`);
      }
    };
    walk(at);
  }
  /**
   * A job's branch head, fetched from its workspace into the ws cache. Git never reads the workspace's own config or hooks:
   * its refs, objects and HEAD are copied to a scratch gitdir with an empty config, fetched from there, every object checked.
   */
  async function fromWorkspace(ident: string, b: { repo: string; branch: string; sha: string }) {
    const s = slugOf(b.repo);
    if (!BRANCH.test(b.branch)) throw fail(400, `${b.branch} is not a branch name`);
    const dir = await cache(s, "ws");
    const ref = `refs/ws/${ident}/${b.branch}`;
    const from = workspaceGit(ident, s);
    const scratch = mkdtempSync(join(o.cacheDir, "scratch-"));
    try {
      for (const f of ["HEAD", "packed-refs", "objects", "refs"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(scratch, f), { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(scratch, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
      checkGitDir(scratch); // again on the copy: nothing changed between the check and the copy
      await git(dir, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", scratch, `+refs/heads/${b.branch}:${ref}`]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const got = await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (got !== b.sha) throw fail(409, `${b.repo} \`${b.branch}\` is at ${got.slice(0, 12)} in the workspace, not ${b.sha.slice(0, 12)}`);
    noteKept(o.cacheDir, { repo: s.slug, ref });
    return { s, dir };
  }

  // Until the big switch, nothing lands outside the agents org (the product and modules repos included).
  function platformGuard(repos: string[]) {
    if (o.landsPlatformRepos) return;
    const out = repos.find((r) => !same(String(r).split("/")[0], o.agentsOrg) || same(r, o.productRepo) || same(r, o.modulesRepo));
    if (out) throw Object.assign(fail(422, `codehost-github doesn't land in ${out} yet (lands_platform_repos is off until the switch)`), { rule: "platform-repos-off" });
  }
  const reposOf = (kind: string, a: any): string[] => (kind.endsWith(".merge") || kind.endsWith(".close") ? (a.prs ?? []).map((p: any) => p.repo) : kind.endsWith(".create_repo") ? [a.repo] : (a.only ?? []).map((b: any) => b.repo));

  // GitHub's checks on a commit as plan.mjs reads them: { ok, pending, skipped } each (names never leave this function).
  // Every page is read; if GitHub reports more than could be read, one check stays pending: missing evidence never passes.
  async function checksAt(s: ReturnType<typeof slugOf>, sha: string, token: string) {
    const all = async (path: string, key: string) => {
      const items: any[] = [];
      let total = Infinity;
      for (let page = 1; page <= 10 && items.length < total; page++) {
        const r = await api("GET", `/repos/${s.slug}/commits/${sha}/${path}?per_page=100&page=${page}`, token);
        total = Number(r.total_count ?? 0);
        const got = r[key] ?? [];
        items.push(...got);
        if (!got.length) break;
      }
      return { items, complete: items.length >= total };
    };
    const runs = await all("check-runs", "check_runs");
    const status = await all("status", "statuses");
    const unread = runs.complete && status.complete ? [] : [{ pending: true, skipped: false, ok: false }];
    return [
      ...unread,
      ...runs.items.map((r: any) => ({ pending: r.status !== "completed", skipped: r.conclusion === "skipped", ok: r.status === "completed" && ["success", "skipped", "neutral"].includes(r.conclusion) })),
      ...status.items.map((x: any) => ({ pending: x.state === "pending", skipped: false, ok: x.state === "success" })),
    ];
  }
  const pushed = join(o.cacheDir, "pushed.json");
  const pushedHeads = (): string[] => (existsSync(pushed) ? JSON.parse(readFileSync(pushed, "utf8")) : []);
  const notePushed = (sha: string) => writeFileSync(pushed, JSON.stringify([...pushedHeads().slice(-4999), sha]));

  /** The verified state plan.mjs tiers a request on (its `s`): read from the workspace, the cache and GitHub, never the args. */
  async function stateFor(kind: string, a: any) {
    const base = { agentsOrg: o.agentsOrg, instanceRepo: o.instanceRepo, productRepo: o.productRepo, modulesRepo: o.modulesRepo, requester: { platform: false }, also: [] as string[] };
    if (kind.endsWith(".create_repo")) return { ...base, repo: slugOf(a.repo).slug };
    if (kind.endsWith(".merge") || kind.endsWith(".close")) {
      const prs = [];
      for (const p of a.prs ?? []) {
        const s = slugOf(p.repo);
        const token = await tokenFor(s, MERGE);
        const pr = await api("GET", `/repos/${s.slug}/pulls/${Number(p.number)}`, token);
        const files = (await api("GET", `/repos/${s.slug}/pulls/${Number(p.number)}/files?per_page=100`, token)).map((f: any) => f.filename);
        prs.push({
          repo: s.slug, number: Number(p.number), head: pr.head?.sha, base: pr.base?.sha, headMatches: !p.head || p.head === pr.head?.sha,
          files: pr.changed_files > files.length ? undefined : files, checks: await checksAt(s, pr.head?.sha, token),
          ownHead: pushedHeads().includes(pr.head?.sha), dependabot: pr.user?.login === "dependabot[bot]",
        });
      }
      return { ...base, prs };
    }
    const branches = [];
    for (const b of a.only ?? []) {
      const { s, dir } = await fromWorkspace(a.workspace, b);
      const info = await api("GET", `/repos/${s.slug}`, await tokenFor(s, READ));
      const def = String(info.default_branch ?? "main");
      const empty = !(await fetchRemote(s, def, "ws").then(() => true, () => false));
      const mb = empty ? "" : await git(dir, ["merge-base", b.sha, `refs/remote/${def}`]).catch(() => "");
      const files = (await git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", mb || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", b.sha])).split("\0").filter(Boolean);
      branches.push({ repo: s.slug, branch: b.branch, sha: b.sha, base: mb || undefined, files, defaultBranch: def, empty });
    }
    return { ...base, branches };
  }

  const executor: Executor = {
    async plan(req: PlanRequest) {
      platformGuard(reposOf(req.kind, req.args ?? {}));
      return planRules({ kind: req.kind, args: req.args }, await stateFor(req.kind, req.args ?? {}));
    },
    async execute(rec) {
      const a = rec.args ?? {};
      platformGuard(reposOf(rec.kind, a));
      const action = rec.kind.replace(/^codehost-github\./, "");
      const done: string[] = [];
      if (action === "push" || action === "pr") {
        for (const b of a.only) {
          const { s, dir } = await fromWorkspace(a.workspace, b);
          // A task branch may be rewritten; the default branch only ever moves forward.
          const def = String((await api("GET", `/repos/${s.slug}`, await tokenFor(s, READ))).default_branch ?? "main");
          await git(dir, ["push", "--quiet", "--no-verify", remote(s.slug), `${b.branch === def ? "" : "+"}${b.sha}:refs/heads/${b.branch}`], await tokenFor(s, PUSH));
          notePushed(b.sha);
          if (action === "pr") {
            const token = await tokenFor(s, PUSH);
            const open = await api("GET", `/repos/${s.slug}/pulls?state=open&head=${encodeURIComponent(`${s.org}:${b.branch}`)}`, token);
            const text = { title: a.text?.title ?? b.branch, body: a.text?.body ?? "" };
            const pr = open[0] ? await api("PATCH", `/repos/${s.slug}/pulls/${open[0].number}`, token, text) : await api("POST", `/repos/${s.slug}/pulls`, token, { ...text, head: b.branch, base: (await api("GET", `/repos/${s.slug}`, token)).default_branch });
            done.push(pr.html_url ?? `${s.slug}#${pr.number}`);
            if (pr.html_url) notePrTask(o.cacheDir, pr.html_url, { task: a.workspace, branch: b.branch }); // the PR watch wakes the task that opened it
          } else done.push(`${s.slug} ${b.branch} at ${b.sha.slice(0, 12)}`);
        }
        return { ok: true, text: `${action === "pr" ? "PRs" : "Pushed"}: ${done.join(", ")}` };
      }
      // An approved merge is a queue (merges.ts): its outcome comes when every PR merged at its bound head, or the queue stopped.
      if (action === "merge") return merges.enqueue(rec.id, a);
      if (action === "close") {
        for (const p of a.prs) {
          const s = slugOf(p.repo);
          await api("PATCH", `/repos/${s.slug}/pulls/${Number(p.number)}`, await tokenFor(s, MERGE), { state: "closed" });
          done.push(`${s.slug}#${p.number}`);
        }
        return { ok: true, text: `Closed: ${done.join(", ")}` };
      }
      if (action === "create_repo") return { ok: true, text: `${slugOf(a.repo).slug}: ${await app().createRepo(slugOf(a.repo).slug)}` };
      return { ok: false, text: `no such kind ${rec.kind}` };
    },
  };
  const exec = serveExecutor(executor, { key: o.key, kernelUrl: o.kernelUrl, log });
  async function report(id: string, out: { ok: boolean; text: string }) {
    const r = await fetch(`${o.kernelUrl}/v1/writes/${id}/outcome`, { method: "POST", headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" }, body: JSON.stringify(out), signal: AbortSignal.timeout(15_000) });
    if (!r.ok && r.status !== 409) throw new Error(`the kernel answered ${r.status}`);
  }
  async function kernel(method: "GET" | "POST", path: string, b?: unknown) {
    const r = await fetch(`${o.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${o.key}`, ...(b ? { "content-type": "application/json" } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`the kernel's ${path.split("/").slice(0, 3).join("/")} answered ${r.status}: ${String(j?.error?.message ?? j?.error ?? "").slice(0, 200)}`);
    return j;
  }
  // The product's and the official modules repo's PRs that bring the AI reviewer's own code merge only on a passing
  // reviewer-eval receipt for their head (evalgate.ts; the eval is a kernel check job).
  const evalGate = createEvalGate({
    productRepo: o.productRepo, modulesRepo: o.modulesRepo, dir: join(o.cacheDir, "merges"), kernel, log,
    fetch: async (repo, ref) => fetchRemote(slugOf(repo), ref),
    git: (dir, args) => git(dir, args),
    defaultBranch: async (repo) => String((await api("GET", `/repos/${slugOf(repo).slug}`, await tokenFor(slugOf(repo), READ))).default_branch ?? "main"),
  });
  const merges = createMerges({
    dir: join(o.cacheDir, "merges"), gh: o.gh, agentsOrg: o.agentsOrg, productRepo: o.productRepo, modulesRepo: o.modulesRepo,
    landsPlatformRepos: o.landsPlatformRepos, report, log, now: o.now, everyMs: o.mergeEveryMs,
    token: (repo, perms) => tokenFor(slugOf(repo), perms),
    evalGate: (repo, pr) => evalGate(repo, pr),
  });
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(o.key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  /** executor@1 status for a merge record answers from its queue, which outlives a restart; any other goes to the SDK. */
  async function status(req: IncomingMessage, res: ServerResponse) {
    const raw = await body(req).catch(() => ({}));
    const q = keyed(req) ? merges.status(String(raw?.id ?? "")) : undefined;
    if (q) return send(res, 200, q);
    await exec(Object.assign(Readable.from([Buffer.from(JSON.stringify(raw))]), { headers: req.headers, url: req.url, method: req.method }) as unknown as IncomingMessage, res);
  }

  /** The instance commit an apply lands, in the ws cache: { s, dir, main (the default branch's head), def, base }. */
  async function instanceCommit(b: { repo?: unknown; sha?: unknown; branch?: unknown; workspace?: unknown }) {
    const s = slugOf(b.repo);
    if (!same(s.slug, o.instanceRepo)) throw fail(403, `an apply lands only on the instance repo (${o.instanceRepo ?? "not set"}), not ${s.slug}`);
    const sha = String(b.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw fail(400, "sha is a full commit sha");
    const dir = await cache(s, "ws");
    const have = await git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
    if (!have) {
      if (typeof b.workspace !== "string" || !b.workspace) throw fail(404, `${sha.slice(0, 12)} isn't here and no workspace names it`);
      await fromWorkspace(b.workspace, { repo: s.slug, branch: String(b.branch ?? ""), sha });
    }
    const def = String((await api("GET", `/repos/${s.slug}`, await tokenFor(s, READ))).default_branch ?? "main");
    const { sha: main } = await fetchRemote(s, def, "ws");
    const base = await git(dir, ["merge-base", sha, main]).catch(() => "");
    if (!base) throw fail(409, `${sha.slice(0, 12)} shares no history with the instance's ${def}`);
    return { s, dir, sha, def, main, base };
  }
  const DEF = /^agents\/([a-z0-9][a-z0-9-]*)\/(agent\.yaml|AGENTS\.md)$/;
  async function applyRead(b: any) {
    const c = await instanceCommit(b);
    const files = (await git(c.dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", c.base, c.sha])).split("\0").filter(Boolean);
    const agents: { base: Record<string, string>; head: Record<string, string> } = { base: {}, head: {} };
    for (const p of [...new Set(files.map((f) => DEF.exec(f)?.[1]).filter(Boolean))].map((k) => `agents/${k}/agent.yaml`)) {
      for (const [side, rev] of [["base", c.base], ["head", c.sha]] as const) {
        const t = await git(c.dir, ["cat-file", "blob", `${rev}:${p}`]).catch(() => undefined);
        if (t !== undefined) agents[side][p] = t;
      }
    }
    return { files, agents, base: c.base, main: c.main };
  }
  async function applyLand(b: any) {
    const c = await instanceCommit(b);
    // Already on main (a land that ran before a restart): main is what applies, and it contains this commit.
    if (c.base === c.sha) return { landed: c.main, already: true };
    if (c.base !== c.main) throw fail(409, `the instance's ${c.def} moved on since this commit's base; it needs a rebase and a new approval`);
    await git(c.dir, ["push", "--quiet", "--no-verify", remote(c.s.slug), `${c.sha}:refs/heads/${c.def}`], await tokenFor(c.s, PUSH));
    log("instance landed", { repo: c.s.slug, sha: c.sha });
    return { landed: c.sha };
  }

  /** The calling module (its own token, as the kernel's /v1/whoami resolves it) and its grant. */
  async function caller(req: IncomingMessage): Promise<Grant> {
    const auth = String(req.headers.authorization ?? "");
    const r = await fetch(`${o.kernelUrl}/v1/whoami`, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const who = r?.ok ? ((await r.json()) as { kind?: string; module?: string }) : undefined;
    if (!who || who.kind !== "module" || !who.module) throw fail(401, "a module's own token only");
    return o.grants().find((g) => g.module === who.module) ?? { module: who.module };
  }
  async function body(req: IncomingMessage): Promise<any> {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 100_000) throw fail(413, "too large"); }
    try { return JSON.parse(raw || "{}"); } catch { throw fail(400, "not JSON"); }
  }
  const send = (res: ServerResponse, status: number, b: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));

  async function ops(op: string, req: IncomingMessage, res: ServerResponse) {
    const g = await caller(req);
    const b = await body(req);
    if (op === "token") {
      // owner/name: a token narrowed to that repo; owner/*: an org-wide one (org permissions such as self-hosted runners or
      // projects, org search), which only a grant on owner/* or */* allows.
      const org = ORG_WIDE.exec(String(b.repo ?? ""))?.[1];
      const s = org ? { slug: `${org}/*`, org, name: "" } : slugOf(b.repo);
      if (!(org ? g.token?.repos.some((p) => p === "*/*" || same(p, s.slug)) : matches(s.slug, g.token?.repos))) throw fail(403, `${g.module} has no token grant on ${s.slug}`);
      const perms: Record<string, string> = b.perms && typeof b.perms === "object" ? b.perms : {};
      if (!Object.keys(perms).length) throw fail(400, "name the permissions");
      for (const [p, l] of Object.entries(perms)) if (!LEVEL[l] || !(LEVEL[l]! <= (LEVEL[g.token!.perms[p] ?? ""] ?? 0))) throw fail(403, `${g.module} has no ${p}:${l} grant`);
      const token = await app().token(s.org, { ...(org ? {} : { repositories: [s.name] }), permissions: perms, fresh: true });
      // A fresh installation token lasts an hour; the App's slug tells its own events (performed_via_github_app) from others'.
      const slug = (await app().identity()).name.replace(/\[bot\]$/, "");
      return send(res, 200, { token, repo: s.slug, perms, expires_at: new Date(Date.now() + 55 * 60_000).toISOString(), app: { slug } });
    }
    const s = slugOf(b.repo);
    const allowed = (what: { repos: string[] } | undefined) => { if (!matches(s.slug, what?.repos)) throw fail(403, `${g.module} has no ${op} grant on ${s.slug}`); };
    if (op === "snapshot") allowed(g.snapshot);
    else if (op === "clone") allowed(g.clone);
    else throw fail(404, "no such operation");
    const name = String(b.ref ?? "").replace(/^refs\/heads\//, "");
    if (!BRANCH.test(name)) throw fail(400, "name a branch or a commit");
    const { dir, ref, sha } = await fetchRemote(s, name);
    if (op === "snapshot") {
      // git archive: the tree only, no .git and no credentials; no filter runs (no config defines one).
      res.writeHead(200, { "content-type": "application/gzip", "x-aidenhq-commit": sha });
      const p = spawn("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "archive", "--format=tar.gz", sha], { env: ENV, stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.pipe(res);
      return;
    }
    {
      if (!o.tasksDir) throw fail(503, "the job workspaces aren't mounted");
      // `into` is a task: the kernel says, from the caller's own token, whether it may write into that task's workspace (a
      // dispatcher, for an open task of an agent it dispatches) and which folder that is.
      const r = await fetch(`${o.kernelUrl}/v1/jobs/workspace`, { method: "POST", headers: { authorization: String(req.headers.authorization ?? ""), "content-type": "application/json" }, body: JSON.stringify({ task: String(b.into ?? "") }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      const into = r?.ok ? String(((await r.json()) as { workspace?: unknown }).workspace ?? "") : "";
      if (!IDENT.test(into)) throw fail(r && r.status >= 400 && r.status < 500 ? 403 : 503, `${g.module} may not write into task ${String(b.into)}'s workspace (the kernel said ${r?.status ?? "nothing"})`);
      // Only an existing, plain task folder under the tasks dir; the clone is a new directory made here, exclusively.
      const root = realpathSync(o.tasksDir);
      const ws = join(root, into);
      const st = lstatSync(ws, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isDirectory() || realpathSync(ws) !== ws || !ws.startsWith(root + sep)) throw fail(400, `${into} isn't a task's workspace folder`);
      const target = join(ws, s.name);
      try { mkdirSync(target); } catch (e) { throw fail((e as { code?: string }).code === "EEXIST" ? 409 : 400, `${into}/${s.name} can't be made (${(e as Error).message})`); }
      if (realpathSync(target) !== target) throw fail(400, `${into}/${s.name} resolves elsewhere`);
      // A credential-free clone with history: origin is the plain GitHub URL, the head checked out by the cache's own git.
      const t = (...args: string[]) => run("git", [...SAFE_GIT_ARGS, "-C", target, ...args], { env: ENV });
      await run("git", [...SAFE_GIT_ARGS, "init", "--quiet", target], { env: ENV });
      await t("remote", "add", "origin", `https://github.com/${s.slug}.git`);
      await t("fetch", "--quiet", "--no-tags", dir, `+${ref}:refs/remotes/origin/${/^[0-9a-f]{40}$/.test(name) ? "fetched" : name}`);
      await t("checkout", "--quiet", "--detach", sha);
      return send(res, 200, { path: `${into}/${s.name}`, commit: sha });
    }
  }

  return Object.assign(async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.url === "/healthz") return send(res, 200, { ok: true });
      if (req.url === "/aidenhq/v1/executor/status" && req.method === "POST") return await status(req, res);
      if (await exec(req, res)) return;
      const ap = /^\/aidenhq\/v1\/apply\/(read|land)$/.exec(String(req.url ?? ""));
      if (ap && req.method === "POST") {
        if (!keyed(req)) return send(res, 401, { error: "the kernel's executor key only" });
        const b = await body(req);
        return send(res, 200, ap[1] === "read" ? await applyRead(b) : await applyLand(b));
      }
      const m = /^\/ops\/(token|snapshot|clone)$/.exec(String(req.url ?? ""));
      if (m && req.method === "POST") return await ops(m[1]!, req, res);
      send(res, 404, { error: "not found" });
    } catch (e) {
      const err = e as { status?: number; message: string };
      log("codehost-github request failed", { url: req.url, error: err.message });
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
      else res.end();
    }
  }, {
    /** The merge loop (merges.ts), started at the switch with the runner's copy deleted (an approved merge queues until then); one poll of it. */
    startMerges: () => merges.start(),
    stepMerges: () => merges.step(),
  });
}
