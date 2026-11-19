// The code host as its own service: the executor of codehost-github.{push,pr,merge,close,create_repo} (executor@1; the
// kernel tiers each record with plan.mjs and calls execute only for an approved, claimed and revalidated one), and narrow
// GitHub operations for other modules (/ops/token, /ops/snapshot, /ops/clone), which only the kernel calls: it checks each
// module's grant (its own module.yaml `codehost:`) at POST /v1/codehost/:op and calls here with this
// service's key.
//
// Repo code never runs here. Every git command carries SAFE_GIT_ARGS and no global or system config but the service's own
// (no hooks, no filters, no fsmonitor); a job's commits come in by a fetch from its workspace's .git into this service's
// bare cache clone, which is never checked out; the App token lives only in the env of the one git or GitHub call that
// needs it. An approved merge runs as a queue (merges.ts) whose outcome
// comes once its PRs merged at their approved heads, or it stopped.
//
// The instance's land for kernel.apply (the kernel's executor, with this service's executor key): POST /aidenhq/v1/apply/read
// {repo, sha, branch, workspace?} → what the kernel plans and tiers the commit on (its files, texts, diff and trial edits against
// the instance's main); /apply/land → the commit on main, never forced, once (a commit main already has is a no-op), and never
// one that moves an `aidenhq` marketplace pin (the official modules come with the product pin).
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
import { createReleaseTrain } from "./train.ts";
import { plan as planRules } from "./plan.mjs";
import { notePrTask } from "./pr-watch.ts";
import { createDesignReviews, startDesignReviewSweep } from "./design-review.ts";
import { noteKept } from "./tidy.ts";

const run = promisify(execFile);

/** The hardened git arguments: hooks, fsmonitor and ext:: transports off whatever a workspace's config says. */
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];

type Gh = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: any }>;
type App = { token(org: string, o: { repositories?: string[]; permissions?: Record<string, string>; fresh?: boolean }): Promise<string>; createRepo(slug: string): Promise<"exists" | "created">; identity(): Promise<{ name: string }> };
export type Options = {
  key: string; kernelUrl: string; cacheDir: string; tasksDir?: string;
  /** The App (github-app.ts appClient); undefined without the key: every GitHub action fails, saying so. */
  app?: App; gh: Gh; remoteUrl?: (slug: string) => string;
  agentsOrg: string; allowedOrgs?: string[]; instanceRepo?: string; productRepo?: string;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The release train's batch window, minutes (the instance's release_window_minutes). */
  releaseWindowMinutes?: number;
  /** The owner's name, as the design reviewer's task names who approved a merge that doesn't wait for it. */
  selfName?: string;
  /** Tests: the merge loop's clock and its poll interval. */
  now?: () => Date; mergeEveryMs?: number;
};

const READ = { contents: "read", metadata: "read" };
// What an apply read collects for the kernel: per file, in all (texts and diff), and how many files.
const MAX_TEXT = 1 << 20, MAX_TOTAL = 8 << 20, MAX_FILES = 200;
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
// An org-wide token's target: owner/*.
const ORG_WIDE = /^([\w.-]+)\/\*$/;

export function createService(o: Options) {
  const log = o.log ?? (() => {});
  const remote = o.remoteUrl ?? ((slug: string) => `https://github.com/${slug}.git`);
  mkdirSync(o.cacheDir, { recursive: true });
  // The only git config any command here reads: safe.directory for workspaces another uid owns, nothing that runs a program.
  const gitconfig = join(o.cacheDir, "gitconfig");
  writeFileSync(gitconfig, "[safe]\n\tdirectory = *\n[protocol]\n\tallow = never\n[protocol \"https\"]\n\tallow = always\n[protocol \"file\"]\n\tallow = always\n");
  const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.cacheDir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
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
  // Who asked to publish each commit (the kernel's task and whether it was the Platform Engineer's line), noted once its push
  // or PR has planned (execute carries no requester, and a plan comes before its push), and never reassigned: another task
  // re-publishing a head, noted or already pushed without a note, doesn't take it. A product merge's head is a requester's
  // own only when it noted it (plan.mjs productMergePart).
  const pushedByFile = join(o.cacheDir, "pushed-by.json");
  const pushedBy = (): Record<string, { task: string; platform: boolean }> => (existsSync(pushedByFile) ? JSON.parse(readFileSync(pushedByFile, "utf8")) : {});
  const notePushedBy = (shas: string[], who: { task: string; platform: boolean }) => {
    const all = pushedBy();
    const pushedAlready = pushedHeads();
    const fresh = shas.filter((sha) => !all[sha] && !pushedAlready.includes(sha));
    if (fresh.length) writeFileSync(pushedByFile, JSON.stringify(Object.fromEntries([...Object.entries(all).slice(-(5000 - fresh.length)), ...fresh.map((sha) => [sha, who])])));
  };
  const isPlatform = (requester?: { roles?: string[] }) => (requester?.roles ?? []).includes("platform-engineer");

  /** The verified state plan.mjs tiers a request on (its `s`): read from the workspace, the cache and GitHub, never the args. */
  async function stateFor(kind: string, a: any, requester?: { roles?: string[] }, task = "") {
    // The Platform Engineer's line: a requester holding the platform-engineer role (the kernel's record of who asked, never the args).
    const base = { agentsOrg: o.agentsOrg, allowedOrgs: o.allowedOrgs, instanceRepo: o.instanceRepo, productRepo: o.productRepo, requester: { platform: isPlatform(requester) }, task, workspace: String(a.workspace ?? ""), also: [] as string[] };
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
          ownHead: pushedHeads().includes(pr.head?.sha), pushedBy: pushedBy()[pr.head?.sha]?.task, platformHead: pushedBy()[pr.head?.sha]?.platform === true, dependabot: pr.user?.login === "dependabot[bot]",
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
      const out = planRules({ kind: req.kind, args: req.args }, await stateFor(req.kind, req.args ?? {}, req.requester, req.task));
      // Its commits were read from this task's workspace (stateFor), so the task is who asked to publish them.
      if (/\.(push|pr)$/.test(req.kind) && req.task) notePushedBy((req.args?.only ?? []).map((b: any) => String(b.sha)), { task: req.task, platform: isPlatform(req.requester) });
      return out;
    },
    async execute(rec) {
      const a = rec.args ?? {};
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
            // An agents-org PR that changes UI files gets its design review at this head (one that changes none files nothing).
            if (same(s.org, o.agentsOrg) && pr.number) void designReviews?.fileDesignReview({ repo: s.slug, number: Number(pr.number), head: b.sha }).catch((e: Error) => log("design review task failed", { pr: pr.html_url, err: String(e.message ?? e).slice(0, 300) }));
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
  // The product's PRs that bring the AI reviewer's own code merge only on a passing
  // reviewer-eval receipt for their head (evalgate.ts; the eval is a kernel check job).
  const evalGate = createEvalGate({
    productRepo: o.productRepo, dir: join(o.cacheDir, "merges"), kernel, log,
    fetch: async (repo, ref) => fetchRemote(slugOf(repo), ref),
    git: (dir, args) => git(dir, args),
    defaultBranch: async (repo) => String((await api("GET", `/repos/${slugOf(repo).slug}`, await tokenFor(slugOf(repo), READ))).default_branch ?? "main"),
  });
  // The design reviewer's tasks (design-review.ts): for an agents-org PR's UI head when it opens, and for each head the merge
  // queue waits on for its verdict.
  const designReviews = o.app ? createDesignReviews({ kernelUrl: o.kernelUrl, key: o.key, cacheDir: o.cacheDir, selfName: o.selfName || "the owner", app: o.app, gh: o.gh, log }) : undefined;
  const merges = createMerges({
    designReview: async (ask) => designReviews?.fileDesignReview(ask),
    dir: join(o.cacheDir, "merges"), gh: o.gh, agentsOrg: o.agentsOrg, productRepo: o.productRepo,
    report, log, now: o.now, everyMs: o.mergeEveryMs,
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
  const AGENT = /^agents\/([a-z0-9][a-z0-9-]*)\/(agent\.yaml|AGENTS\.md|memory\.md)$/;
  /**
   * A file at a commit: undefined only when the path isn't there (ls-tree lists nothing); a path that isn't a regular file, is
   * over MAX_TEXT or binary is refused, and any other git failure throws. What the kernel tiers is never a silent gap.
   */
  async function fileAt(dir: string, rev: string, p: string): Promise<string | undefined> {
    const entry = await git(dir, ["ls-tree", "-z", rev, "--", p]);
    if (!entry) return undefined;
    // Paths are literal (GIT_LITERAL_PATHSPECS): `*` or `:(glob)…` is that file, and the entry must be exactly it.
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([^\0]*)\0?$/.exec(entry);
    if (!m || m[4] !== p) throw fail(422, `${p.slice(0, 200)} didn't resolve to exactly that path at ${rev.slice(0, 12)}`);
    if (m[1] !== "100644" || m[2] !== "blob") throw fail(422, `${p.slice(0, 200)} isn't a regular file at ${rev.slice(0, 12)}`);
    const size = Number(await git(dir, ["cat-file", "-s", m[3]!]));
    if (!(size <= MAX_TEXT)) throw fail(413, `${p.slice(0, 200)} is too large to review (${size} bytes)`);
    const t = (await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "cat-file", "blob", m[3]!], { env: ENV, maxBuffer: MAX_TEXT + 1 })).stdout;
    if (t.includes("\0")) throw fail(422, `${p.slice(0, 200)} is binary`);
    return t;
  }
  /**
   * What the kernel plans an apply on (its apply-tier.ts): the files the commit changes against its merge base with main, the
   * texts its rules read on both sides (each changed file, the agent.yaml of each agent it touches, instance.yaml; absent
   * where the file isn't), the diff, and the graduation card's trial edits. Read from git here, never from the requester.
   */
  async function applyRead(b: any) {
    const c = await instanceCommit(b);
    const files = (await git(c.dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", c.base, c.sha])).split("\0").filter(Boolean);
    if (files.length > MAX_FILES) throw fail(413, `the commit changes ${files.length} files; an apply reviews at most ${MAX_FILES}`);
    const agents = [...new Set(files.map((f) => AGENT.exec(f)?.[1]).filter(Boolean))] as string[];
    const texts: { base: Record<string, string>; head: Record<string, string> } = { base: {}, head: {} };
    let budget = MAX_TOTAL;
    for (const p of new Set([...files, ...agents.map((k) => `agents/${k}/agent.yaml`), "instance.yaml"])) {
      for (const [side, rev] of [["base", c.base], ["head", c.sha]] as const) {
        const t = await fileAt(c.dir, rev, p);
        if (t === undefined) continue;
        if ((budget -= t.length) < 0) throw fail(413, `the commit's files are too large to review together (over ${MAX_TOTAL} bytes)`);
        texts[side][p] = t;
      }
    }
    const diff = await run("git", [...SAFE_GIT_ARGS, "-c", "core.attributesFile=/dev/null", "--git-dir", c.dir, "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", c.base, c.sha], { env: ENV, maxBuffer: Math.max(budget, 1) }).then((o) => o.stdout, (e: Error & { code?: string }) => {
      throw e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? fail(413, `the commit's diff is too large to review (over ${MAX_TOTAL} bytes with its files)`) : e;
    });
    return { files, texts, diff, trial: await trialEdits(c.dir, c.base, agents, texts), base: c.base, main: c.main };
  }
  const isTrial = (t: string | undefined) => t !== undefined && /^trial:[ \t]*true[ \t]*(#.*)?$/m.test(t);
  /**
   * The graduation card's list of what changed without a tap: for each agent the change takes out of trial, the handbook-only
   * commits on main touching its AGENTS.md since the commit that added its agent.yaml, up to the change's merge base. From git
   * only, never agent-written text but the commit subjects (one printable line each). "" when nothing graduates.
   */
  async function trialEdits(dir: string, base: string, agents: string[], texts: { base: Record<string, string>; head: Record<string, string> }) {
    const out: string[] = [];
    for (const key of agents) {
      const def = `agents/${key}/agent.yaml`, book = `agents/${key}/AGENTS.md`;
      if (!isTrial(texts.base[def]) || texts.head[def] === undefined || isTrial(texts.head[def])) continue;
      const added = (await git(dir, ["log", "--diff-filter=A", "--format=%H", base, "--", def])).split("\n").filter(Boolean).pop();
      if (!added) continue;
      const edits: string[] = [];
      for (const sha of (await git(dir, ["log", "--first-parent", "--format=%H", `${added}..${base}`, "--", book])).split("\n").filter(Boolean)) {
        const [date, short, ...subject] = (await git(dir, ["log", "-1", "--format=%as%x09%h%x09%s", sha])).split("\t");
        const [num] = (await git(dir, ["diff", "--no-renames", "--numstat", `${sha}^1`, sha, "--", book])).split("\n").map((l) => l.split("\t"));
        // Other paths are counted, never named: a path is the committer's text and the card is the reviewer's input.
        const others = (await git(dir, ["diff", "--no-renames", "--name-only", "-z", `${sha}^1`, sha])).split("\0").filter((f) => f && f !== book).length;
        edits.push(`${short}  ${date}  ${subject.join(" ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)}  (+${num?.[0] ?? 0} -${num?.[1] ?? 0})${others ? `  also changed: ${others} other file${others === 1 ? "" : "s"}` : ""}`);
      }
      out.push(`${key}: ${edits.length ? `${edits.length} handbook change${edits.length === 1 ? "" : "s"} since the trial began (those not marked "also changed" landed without a tap):\n${edits.join("\n")}` : "no handbook changes since the trial began."}`);
    }
    return out.length ? `Trial edits that landed without a tap:\n${out.join("\n")}` : "";
  }
  async function applyLand(b: any) {
    const c = await instanceCommit(b);
    // Already on main (a land that ran before a restart): main is what applies, and it contains this commit.
    if (c.base === c.sha) return { landed: c.main, already: true };
    if (c.base !== c.main) throw fail(409, `the instance's ${c.def} moved on since this commit's base; it needs a rebase and a new approval`);
    // The official modules are the product's modules/: their reviewer code reaches this host only with the product pin, whose
    // reviewer changes merged on a passing reviewer-eval receipt (evalgate.ts). An `aidenhq` marketplace pin an apply adds or
    // moves would bring reviewer code past that gate, so it never lands; dropping one (a pre-monorepo install) does. The kernel reads the pin structurally from both sides
    // (apply.ts officialMove) and names it; without it nothing lands.
    const pin = (x: any) => x === null || (x && typeof x.repo === "string" && SLUG.test(x.repo) && /^[0-9a-f]{40}$/.test(String(x.sha)));
    const off = b.official;
    if (!off || !pin(off.from) || !pin(off.to)) throw fail(400, "name the official modules' pin on both sides (official: {from, to}, each {repo, sha} or null)");
    if (off.to !== null && JSON.stringify(off.from) !== JSON.stringify(off.to)) throw fail(422, "not landed: it adds or moves an `aidenhq` marketplace pin; the official modules come with the product pin");
    await git(c.dir, ["push", "--quiet", "--no-verify", remote(c.s.slug), `${c.sha}:refs/heads/${c.def}`], await tokenFor(c.s, PUSH));
    log("instance landed", { repo: c.s.slug, sha: c.sha });
    return { landed: c.sha };
  }

  async function body(req: IncomingMessage): Promise<any> {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 100_000) throw fail(413, "too large"); }
    try { return JSON.parse(raw || "{}"); } catch { throw fail(400, "not JSON"); }
  }
  const send = (res: ServerResponse, status: number, b: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));

  async function ops(op: string, req: IncomingMessage, res: ServerResponse) {
    // Only the kernel calls the ops, with this service's key: POST /v1/codehost/:op brokers them under each module's grant.
    if (!keyed(req)) throw fail(401, "the kernel only");
    const b = await body(req);
    // b.module: the module the kernel checked the grant of (for the log).
    log("ops", { op, module: String(b.module ?? ""), repo: String(b.repo ?? "") });
    if (op === "token") {
      // owner/name: a token narrowed to that repo; owner/*: an org-wide one (org permissions such as self-hosted runners or
      // projects, org search).
      const org = ORG_WIDE.exec(String(b.repo ?? ""))?.[1];
      const s = org ? { slug: `${org}/*`, org, name: "" } : slugOf(b.repo);
      const perms: Record<string, string> = b.perms && typeof b.perms === "object" ? b.perms : {};
      if (!Object.keys(perms).length || Object.values(perms).some((l) => !LEVEL[l])) throw fail(400, "name the permissions (read or write)");
      const token = await app().token(s.org, { ...(org ? {} : { repositories: [s.name] }), permissions: perms, fresh: true });
      // A fresh installation token lasts an hour; the App's slug tells its own events (performed_via_github_app) from others'.
      const slug = (await app().identity()).name.replace(/\[bot\]$/, "");
      return send(res, 200, { token, repo: s.slug, perms, expires_at: new Date(Date.now() + 55 * 60_000).toISOString(), app: { slug } });
    }
    const s = slugOf(b.repo);
    if (op !== "snapshot" && op !== "clone") throw fail(404, "no such operation");
    // HEAD: the repo's default branch, by its name (a clone then has origin/<that branch>). A repo GitHub doesn't show is a 404.
    const asked = String(b.ref ?? "").replace(/^refs\/heads\//, "");
    let name = asked;
    if (asked === "HEAD") {
      const r = await o.gh("GET", `/repos/${s.slug}`, await tokenFor(s, READ));
      if (r.status === 404) throw fail(404, `${s.slug} isn't on GitHub (or the App can't see it)`);
      if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}: ${r.status}`);
      name = String(r.body?.default_branch ?? "");
    }
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
      // `into`: the workspace folder the kernel resolved for the caller's task (a dispatcher, for an open task of an agent it
      // dispatches).
      const into = String(b.into ?? "");
      if (!IDENT.test(into)) throw fail(400, `${into} is not a task's workspace folder`);
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

  /**
   * A commit on top of the repo's default branch head with one file edited, in the ws cache (refs/train/<sha>, never checked
   * out): the edit reads the file at that same head, and its author, committer and dates are fixed by the head, so the same
   * head gives the same commit.
   */
  async function trainCommit(repo: string, path: string, edit: (text: string) => string, message: string) {
    const s = slugOf(repo);
    const def = String((await api("GET", `/repos/${s.slug}`, await tokenFor(s, READ))).default_branch ?? "main");
    const { dir, sha: head } = await fetchRemote(s, def, "ws");
    const text = await fileAt(dir, head, path);
    if (text === undefined) throw fail(404, `${path} isn't on ${s.slug}'s ${def}`);
    const files = { [path]: edit(text) };
    const date = await git(dir, ["log", "-1", "--format=%cI", head]);
    const index = join(mkdtempSync(join(o.cacheDir, "scratch-")), "index");
    try {
      const g = (args: string[], input?: string) => new Promise<string>((ok, no) => {
        const p = spawn("git", [...SAFE_GIT_ARGS, "--git-dir", dir, ...args], { env: { ...ENV, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "AidenHQ release train", GIT_AUTHOR_EMAIL: "release-train@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ release train", GIT_COMMITTER_EMAIL: "release-train@aidenhq.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => (code === 0 ? ok(out.trim()) : no(new Error(`git ${args[0]}: ${err.trim().slice(0, 300)}`))));
        p.stdin.end(input ?? "");
      });
      await g(["read-tree", head]);
      for (const [path, text] of Object.entries(files)) await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${path}`]);
      const sha = await g(["commit-tree", await g(["write-tree"]), "-p", head], message);
      await git(dir, ["update-ref", `refs/train/${sha}`, sha]);
      return sha;
    } finally {
      rmSync(join(index, ".."), { recursive: true, force: true });
    }
  }
  const train = o.productRepo && o.instanceRepo ? createReleaseTrain({
    dir: join(o.cacheDir, "release"), productRepo: o.productRepo, instanceRepo: o.instanceRepo, windowMinutes: o.releaseWindowMinutes ?? 15, kernel, log, now: o.now,
    commit: trainCommit,
    evalBump: (from, to) => evalGate.bump(from, to),
    github: {
      async tip(repo) {
        const s = slugOf(repo);
        const token = await tokenFor(s, MERGE);
        const def = String((await api("GET", `/repos/${s.slug}`, token)).default_branch ?? "main");
        const tip = String((await api("GET", `/repos/${s.slug}/commits/${def}`, token)).sha ?? "");
        const checks = await checksAt(s, tip, token);
        return { tip: /^[0-9a-f]{40}$/.test(tip) ? tip : undefined, green: checks.length > 0 && checks.every((c) => c.ok && !c.pending) };
      },
      async text(repo, path) {
        const s = slugOf(repo);
        const ref = String((await api("GET", `/repos/${s.slug}`, await tokenFor(s, READ))).default_branch ?? "main");
        const { dir, sha } = await fetchRemote(s, ref);
        return fileAt(dir, sha, path);
      },
      async commits(repo, from, to) {
        const s = slugOf(repo);
        const r = await api("GET", `/repos/${s.slug}/compare/${from}...${to}`, await tokenFor(s, READ));
        // Only each subject's PR number: a subject is whoever merged it's words.
        return (r.commits ?? []).slice(-100).map((c: any) => ({ repo: s.slug, sha: String(c.sha), subject: /\(#(\d+)\)\s*$/.exec(String(c.commit?.message ?? "").split("\n")[0]!)?.[0] ?? "" }));
      },
    },
  }) : undefined;

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
    /** The merge loop (merges.ts). */
    startMerges: () => merges.start(),
    /** The release train (train.ts): only with the product and instance repos set. */
    startReleases: () => train?.start(),
    /** The superseded design reviews' sweep (design-review.ts): only with the App. */
    startDesignReviews: () => designReviews && startDesignReviewSweep(designReviews, { log }),
    stepReleases: () => train?.step(),
    stepMerges: () => merges.step(),
  });
}
