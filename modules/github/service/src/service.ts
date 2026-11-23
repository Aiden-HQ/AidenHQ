// The code host as its own service: the executor of codehost-github.{push,pr,merge,close,create_repo} (executor@1; the
// kernel tiers each record with plan.ts and calls execute only for an approved, claimed and revalidated one), and typed
// GitHub operations for other modules (/ops/snapshot, /ops/bundle here; fetch, head, read, comment, commit and
// runner_token in ops.ts), which only the kernel calls: it checks each module's grant (its own module.yaml `codehost:`) at
// POST /v1/codehost/:op and calls here with this service's key. Every GitHub call is the owner's (spec
// 2026-11-20-github-owner-identity): `access` holds the sign-in, and no answer ever carries its token.
//
// Repo code never runs here. Every git command carries SAFE_GIT_ARGS and no global or system config but the service's own
// (no hooks, no filters, no fsmonitor); a job's commits come in by a fetch from the bundle its box wrote (copied out, never followed) into this
// service's bare cache clone, which is never checked out; the owner's token lives only in the env of the one git call that needs it.
// Every commit it makes is the owner's with the AidenHQ trailer. An approved write that finds GitHub disconnected is held
// (held.json) and runs once by id after the reconnect. An approved merge runs as a queue (merges.ts) whose outcome
// comes once its PRs merged at their approved heads, or it stopped.
//
// The instance's land for kernel.apply (the kernel's executor, with this service's executor key): POST /aidenhq/v1/apply/read
// {repo, sha, branch, workspace?} → what the kernel plans and tiers the commit on (its files, texts and diff against
// the instance's main); /apply/land → the commit on main, never forced, once (a commit main already has is a no-op), and never
// one that moves an `aidenhq` marketplace pin (the official modules come with the product pin); /apply/write → the owner's
// typed settings change as a commit on main's head (kernel/src/settings-change.ts), which only a kernel.apply then lands.
// The commit comes from this service's own copy when it made it, else from the task's workspace. The instance repo only.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { serveExecutor, type Executor, type PlanRequest } from "./aidenhq-sdk/executor.ts";
import { CREDENTIAL_ARGS, disconnected, hasTrailer, identityEnv, inOrg, needOf, ownRepo, withFooter, withTrailer, type Gh } from "./git-auth.ts";
import type { GitHubAccess } from "../../connections/github-mcp/src/client.ts";
import { MIGRATION_WAIT, createMerges } from "./merges.ts";
import type { ReviewGate } from "./review-gate.ts";
import { createFlow } from "./flow.ts";
import { createReleaseTrain } from "./train.ts";
import { LOCAL_ORG, plan as planRules } from "./plan.ts";
import { fileContext, numstat } from "./review-files.ts";
/** One changed file as git counts it (review-files.ts numstat; a binary file has no line counts). */
type Changed = { path: string; add?: number; del?: number };
import { SOURCE_EXCEPTIONS_FILE, readCardSourceExceptions } from "./sources.ts";
import { candidatesOf, readSiblings } from "./siblings.ts";
import { notePrTask } from "./pr-watch.ts";

import { createDesignReviews, startDesignReviewSweep } from "./design-review.ts";
import { packBundle, type OpsContext } from "./ops.ts";
import { copyBoxBundle, publishRef } from "./aidenhq-sdk/box-bundle.ts";
import { APPLY_PATHS } from "./aidenhq-sdk/instance-paths.ts";
import { noteKept } from "./tidy.ts";
import * as setupWrite from "./setup.ts";
import { digestOf, upsertMarketplace } from "./share.ts";

/**
 * The requester of a planned write (the kernel's record of who asked; execute carries none), by a digest of its kind and args: it
 * recovers the asker of a held write after a restart, and the task a merge queue's record is for (its already-merged evidence).
 */
export const askerKey = (kind: string, args: unknown) => createHash("sha256").update(JSON.stringify([kind, args ?? {}])).digest("hex");

const run = promisify(execFile);

/** The hardened git arguments: hooks, fsmonitor and ext:: transports off whatever a workspace's config says. */
export const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];

export type Options = {
  key: string; kernelUrl: string; cacheDir: string; tasksDir?: string;
  /** GitHub as the owner (github-mcp client.ts): the one sign-in, limiter and typed needs. */
  access: GitHubAccess; remoteUrl?: (slug: string) => string;
  /** github-mcp's retrying need queue (main.ts): a need met outside a tool call is kept and retried, never a one-shot POST. */
  reportNeed?: (need: { cause: "scope"; scope: string }, detail: string) => Promise<void>;
  /** True while the merge queue must hold (the App migration, migrate.ts): approved merges wait like a disconnect. */
  holdMerges?: () => boolean;
  /** Why merges are held while GitHub is connected (the App migration): the record's own reason, never the reconnect's. */
  mergeHoldReason?: () => string | null | undefined;
  /** The typed ops other modules get through the kernel (ops.ts serveOps: fetch, head, read, comment, commit, runner_token), run
   * here with the owner's token and never answering it; unset: those ops answer 404. */
  ops?: (req: IncomingMessage, res: ServerResponse, ctx: OpsContext) => Promise<void>;
  /** github_fleet_org: where the fleet's repos live on GitHub ("" while unset). */
  fleetOrg: string; allowedOrgs?: string[]; instanceRepo?: string; productRepo?: string;
  /** maintainer_repos ("owner/name"): where the fleet merges and closes outside the agents org and the product repo. */
  maintained?: string[];
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The release train's batch window, minutes (the instance's release_window_minutes). */
  releaseWindowMinutes?: number;
  /** Tests: the merge loop's clock and its poll interval. */
  now?: () => Date; mergeEveryMs?: number;
  /** The churn pass ignores these globs (the churn_exclude setting). */
  churnExclude?: string[];
  /** Code review's verdict on a head before the merge queue merges it (review-gate.ts). */
  reviewGate: ReviewGate;
};

/** A base a change targets: a file read there (source exceptions), and its cache clone at `tip` (siblings). */
type Base = { repo: string; base: string; read: (path: string) => Promise<string>; dir?: string; tip?: string };
// What an apply read collects for the kernel: per file, in all (texts and diff), and how many files.
const MAX_TEXT = 1 << 20, MAX_TOTAL = 8 << 20, MAX_FILES = 200;
const SLUG = /^([\w.-]+)\/([\w.-]+)$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
/**
 * GitHub refuses any push that creates or updates a workflow file when the sign-in's OAuth grant lacks `workflow` ("refusing to
 * allow an OAuth App to create or update workflow ... without `workflow` scope"). The scope is asked for at sign-in, but a grant
 * made before it, or one where the box was unticked, keeps its old scopes: the owner's one fix is to reconnect. It is the same
 * typed need the client names (github-mcp client.ts needText), so a push reports the cause instead of a bare git failure.
 */
const WORKFLOW_SCOPE = "workflow";
const WORKFLOW_MESSAGE = "GitHub needs the `workflow` permission: reconnect GitHub on the board (Settings, Connections)";
const WORKFLOW_NEED: { cause: "scope"; scope: string } = { cause: "scope", scope: WORKFLOW_SCOPE };
/** GitHub's own words for the refusal, as a git child prints them on stderr. */
export const workflowRefusal = (e: unknown) => /create or update workflow[\s\S]*without [`'"]?workflow[`'"]? scope/i.test(String((e as { message?: unknown } | undefined)?.message ?? e));
/** The push's typed need: a 403 (the status ops.ts's need map gives a scope) carrying the need, never a bare git failure. */
export const workflowNeedError = () => Object.assign(fail(403, WORKFLOW_MESSAGE), { need: WORKFLOW_NEED });
/** Our tooling and local paths: what reviewers of a repo outside ours mustn't read in a PR or a commit. */
const INTERNAL = /aidenhq|paperclip|\/home\/|~\/|\bworktree\b|\bopencode\b|\bopenrouter\b|claude code|\bcodex\b/i;
/** The first internal name in text, for telling the agent what to reword. */
export const leakIn = (text: unknown) => String(text ?? "").match(INTERNAL)?.[0];
const slugOf = (repo: unknown) => {
  const m = SLUG.exec(String(repo ?? ""));
  if (!m || m[2]!.endsWith(".git") || m.slice(1).some((p) => /^\.+$/.test(p))) throw fail(400, `${String(repo)} is not owner/name`);
  return { slug: `${m[1]}/${m[2]}`, org: m[1]!, name: m[2]! };
};

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
  const initBare = async (dir: string) => void (await run("git", [...SAFE_GIT_ARGS, "init", "--quiet", "--bare", dir], { env: ENV }));
  const access = o.access;
  /** The owner's token, for one git child's env only. */
  const token = () => access.token();
  /**
   * One push with the owner's token: GitHub's `workflow`-scope refusal is the owner's typed need. It is handed to github-mcp's
   * need queue (which keeps and retries a report the kernel couldn't take) and thrown typed, never as a bare git failure. The push
   * is always attempted: GitHub permits a workflow file that already exists unchanged, so its answer is the only authority on
   * whether the scope is needed. Any other failure is git's own and stays as it was.
   */
  async function push(dir: string, args: string[]): Promise<string> {
    try {
      return await git(dir, args, await token());
    } catch (e) {
      if (!workflowRefusal(e)) throw e;
      const need = workflowNeedError();
      await o.reportNeed?.(WORKFLOW_NEED, need.message)
        .catch((report: Error) => log("workflow scope need not reported", { err: String(report.message ?? report).slice(0, 200) }));
      throw need;
    }
  }
  /** The owner's login, or undefined: a Flow fact never fails the write it describes. */
  const ownerLogin = () => access.identity().then((i) => i.login, () => undefined);
  const gh: Gh = (method, path, body, opts) => access.rest(method, path, body, opts);
  async function api(method: string, path: string, body?: unknown) {
    const r = await gh(method, path, body);
    if (r.status >= 300) throw fail(502, `GitHub ${method} ${path.split("?")[0]}: ${r.status} ${r.body?.message ?? ""}`.trim());
    return r.body;
  }
  const defaultBranch = async (slug: string) => String((await api("GET", `/repos/${slug}`)).default_branch ?? "main");
  /** Whether a GitHub object is in AidenHQ's records (the kernel's GET /v1/objects); a failed read is "no". */
  const ours = (ref: string) => kernel("GET", `/v1/objects?ref=${encodeURIComponent(ref)}`).then((j) => j?.ours === true, () => false);

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
    // git says only "Repository not found" for every refusal: the API's answer names the cause (an org's OAuth App
    // restriction or SSO, a stale sign-in) as a typed need, and tells the owner.
    await git(dir, ["fetch", "--quiet", "--no-tags", remote(s.slug), `+${/^[0-9a-f]{40}$/.test(name) ? name : `refs/heads/${name}`}:${ref}`], await token())
      .catch(async (e) => {
        await gh("GET", `/repos/${s.slug}`);
        // The repo answers, so the ref is what is missing (a deleted branch): a 404 the caller can tell from a failed fetch.
        if (/couldn't find remote ref/i.test(String((e as Error)?.message))) throw fail(404, `${s.slug} has no ${name}`);
        throw e;
      });
    return { dir, ref, sha: await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]) };
  }

  /**
   * A job's branch head, fetched into the ws cache from the bundle its box wrote (`aidenhq publish|review|apply`), copied out of
   * the workspace the one no-follow way (aidenhq-sdk/box-bundle.ts): host git and fs writes never touch the workspace, and git
   * reads only the copy, verifying every object.
   */
  async function fromWorkspace(ident: string, b: { repo: string; branch: string; sha: string }) {
    const s = slugOf(b.repo);
    if (!BRANCH.test(b.branch)) throw fail(400, `${b.branch} is not a branch name`);
    if (!o.tasksDir) throw fail(503, "the job workspaces aren't mounted: codehost-github can't read a job's commits");
    const dir = await cache(s, "ws");
    const ref = `refs/ws/${ident}/${b.branch}`;
    const scratch = mkdtempSync(join(o.cacheDir, "scratch-"));
    try {
      const copy = copyBoxBundle(o.tasksDir, scratch, ident, b.sha, `${b.repo} \`${b.branch}\``);
      await git(dir, ["bundle", "verify", "--quiet", copy]).catch(() => { throw fail(400, `the bundle of ${b.repo} \`${b.branch}\` isn't a valid git bundle for it`); });
      await git(dir, ["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", copy, `+${publishRef(b.sha)}:${ref}`]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const got = await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (got !== b.sha) throw fail(409, `${b.repo} \`${b.branch}\` is at ${got.slice(0, 12)} in the bundle, not ${b.sha.slice(0, 12)}`);
    noteKept(o.cacheDir, { repo: s.slug, ref });
    return { s, dir };
  }

  // GitHub's checks on a commit as plan.ts reads them: { name, ok, pending, skipped } each. The name is only matched (the gate
  // check `ci-required`, merge-gate.ts productMergeEligible), never shown: the card counts checks.
  // Every page is read; if GitHub reports more than could be read, one check stays pending: missing evidence never passes.
  async function checksAt(s: ReturnType<typeof slugOf>, sha: string) {
    const all = async (path: string, key: string) => {
      const items: any[] = [];
      let total = Infinity;
      for (let page = 1; page <= 10 && items.length < total; page++) {
        const r = await api("GET", `/repos/${s.slug}/commits/${sha}/${path}?per_page=100&page=${page}`);
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
      ...runs.items.map((r: any) => ({ name: String(r.name ?? ""), pending: r.status !== "completed", skipped: r.conclusion === "skipped", ok: r.status === "completed" && ["success", "skipped", "neutral"].includes(r.conclusion), success: r.status === "completed" && r.conclusion === "success" })),
      ...status.items.map((x: any) => ({ name: String(x.context ?? ""), pending: x.state === "pending", skipped: false, ok: x.state === "success", success: x.state === "success" })),
    ];
  }
  // The commits this code host pushed, each as "<repo, lowercase> <sha>": a head is the runner's own only in the repo it was
  // pushed to, so the same commit opened as a PR in another repo (a maintained one, say) is never ours there.
  const pushed = join(o.cacheDir, "pushed.json");
  const pushedHeads = (): string[] => (existsSync(pushed) ? JSON.parse(readFileSync(pushed, "utf8")) : []);
  const pushedKey = (repo: string, sha: string) => `${repo.toLowerCase()} ${sha}`;
  const notePushed = (repo: string, sha: string) => writeFileSync(pushed, JSON.stringify([...pushedHeads().slice(-4999), pushedKey(repo, sha)]));
  // Which task opened each PR this code host opened (pr-watch.ts notePrTask): the task's sibling PRs for the reviewer.
  const prTasks = (): Record<string, { task?: string; branch?: string }> => { try { return JSON.parse(readFileSync(join(o.cacheDir, "pr-tasks.json"), "utf8")); } catch { return {}; } };
  const isPlatform = (requester?: { roles?: string[] }) => (requester?.roles ?? []).includes("platform-engineer");

  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diffOf = (dir: string, from: string, to: string) => git(dir, ["-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", from, to]);
  /** The same change counted by git itself (numstat): the reviewer checks the diff it gets against it (review-files.ts sameChanges). */
  const numstatOf = async (dir: string, from: string, to: string) => numstat(await git(dir, ["-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--numstat", from, to]));
  /**
   * The verified state plan.ts tiers a request on (its `s`) and the card's facts (target, sentence, the diff the reviewer
   * reads): read from the workspace, the cache and GitHub, never the args.
   */
  async function stateFor(kind: string, a: any, requester?: { roles?: string[] }) {
    // The Platform Engineer's line: a requester holding the platform-engineer role (the kernel's record of who asked, never the
    // args); it may push to any branch, others to their own task's (plan.ts branch-namespace).
    const base = { agentsOrg: o.fleetOrg, allowedOrgs: o.allowedOrgs, instanceRepo: o.instanceRepo, productRepo: o.productRepo, maintained: o.maintained ?? [], requester: { platform: isPlatform(requester) }, workspace: String(a.workspace ?? ""), also: [] as string[] };
    if (kind.endsWith(".publish_module")) {
      // The owner's preview, bound: the same files (their digest), a public repo, a folder that is this module's own, and the
      // branch still at the tip he previewed. The record's own args are the preview's evidence; nothing else is read for it.
      const files: Record<string, string> = Object.fromEntries((Array.isArray(a.files) ? a.files : []).map((f: { path: string; text: string }) => [f.path, f.text]));
      if (digestOf(String(a.source), files) !== a.digest) throw fail(422, "the files aren't the ones previewed: preview again");
      if (!access.connected()) throw fail(503, "GitHub isn't connected");
      const d = await destination(String(a.repo), String(a.ref), String(a.module));
      if (d.private) throw fail(422, `${d.s.slug} is private: a module is shared to a public repo`);
      if (d.conflict) throw fail(422, d.conflict);
      if (d.tip !== a.base) throw fail(409, `${d.s.slug} \`${a.ref}\` moved since your preview: preview again`);
      const removed = d.existing.filter((p) => !Object.hasOwn(files, p)).map((p) => `--- ${a.module}/${p} (removed)`);
      const shown = [...Object.keys(files).sort().map((p) => `--- ${a.module}/${p} (${Buffer.byteLength(files[p]!)} bytes)\n${files[p]}`), ...removed].join("\n");
      return { state: { ...base, repo: d.s.slug, ref: String(a.ref), base: String(a.base) }, facts: { target: `${d.s.slug} ${a.ref}`, sentence: `Publish the ${a.module} module to ${d.s.slug} (\`${a.ref}\`), as previewed.`, diff: shown } };
    }
    if (kind.endsWith(".create_repo")) {
      const repo = slugOf(a.repo).slug;
      // Never a quiet switch to `local`: a repo for GitHub while GitHub is signed out is refused, saying so.
      if (!access.connected()) throw fail(503, "GitHub isn't connected");
      return { state: { ...base, repo }, facts: { target: repo, sentence: `Create the repository ${repo} on GitHub${inOrg(o.fleetOrg, repo) ? ", with the app starter on main" : ""}.`, diff: "" } };
    }
    // What the reviewer reads beside the diff (review): each changed file at the reviewed head, and the PR's Evidence section.
    const reads: { name: string; read: () => Promise<string> }[] = [];
    // The bases the change targets, each with a way to read a file there (the owner's source exceptions: never the change's own).
    // `dir` and `tip`: the cache clone holding the base at that commit, where the task's merged sibling PRs are read (siblings.ts).
    const bases: Base[] = [];
    // A merge card's own PRs (`repo#n`), never its siblings. A push or PR card's own PR is open, so never counted as merged:
    // an earlier merged PR on a reused branch name is a real sibling.
    const own = new Set<string>();
    if (kind.endsWith(".merge") || kind.endsWith(".close")) {
      const merge = kind.endsWith(".merge");
      const prs = [];
      const changed: Changed[] = [];
      let diff = "";
      for (const p of a.prs ?? []) {
        const s = slugOf(p.repo);
        const pr = await api("GET", `/repos/${s.slug}/pulls/${Number(p.number)}`);
        // A rename counts at both paths: a file moved out of `.github/` still changes `.github/`.
        const listed = await api("GET", `/repos/${s.slug}/pulls/${Number(p.number)}/files?per_page=100`);
        let files: string[] | undefined = pr.changed_files > listed.length ? undefined : listed.flatMap((f: any) => [f.filename, f.previous_filename].filter(Boolean));
        // A merge's card carries the PR's diff at its head (the one the record binds), against its merge base with the base branch.
        if (merge) {
          const head = await fetchRemote(s, String(pr.head?.sha));
          const into = await fetchRemote(s, String(pr.base?.sha));
          const mb = await git(head.dir, ["merge-base", into.sha, head.sha]).catch(() => "");
          diff += `${await diffOf(head.dir, mb || EMPTY_TREE, head.sha)}\n`;
          changed.push(...(await numstatOf(head.dir, mb || EMPTY_TREE, head.sha)));
          // Every changed file, from git itself (GitHub lists at most 100 a page): no renames, so a file moved counts at both paths.
          files = (await git(head.dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mb || EMPTY_TREE, head.sha])).split("\0").filter(Boolean);
          for (const f of files) reads.push({ name: `${s.slug} ${f}`, read: () => git(head.dir, ["show", `${head.sha}:${f}`]) });
          bases.push({ repo: s.slug, base: String(pr.base?.ref ?? ""), read: (path) => git(into.dir, ["show", `${into.sha}:${path}`]), dir: into.dir, tip: into.sha });
        }
        own.add(`${s.slug.toLowerCase()}#${Number(p.number)}`);
        prs.push({
          repo: s.slug, number: Number(p.number), head: pr.head?.sha, base: pr.base?.sha, headMatches: !p.head || p.head === pr.head?.sha,
          files, checks: await checksAt(s, pr.head?.sha),
          // Code review's verdict for this head on the product repo: with ci-required green, a real pass skips the AI reviewer.
          ...(merge && same(s.slug, o.productRepo) ? { verdict: await o.reviewGate(s.slug, Number(p.number), String(pr.head?.sha)) } : {}),
          ownHead: pushedHeads().includes(pushedKey(s.slug, String(pr.head?.sha))), dependabot: pr.user?.login === "dependabot[bot]",
        });
      }
      const urls = prs.map((p) => `https://github.com/${p.repo}/pull/${p.number}`).join(", ");
      // The task a merge is for: the one that opened its PRs (pr-tasks.json), as the flow facts name it.
      const task = prs.map((p) => prTasks()[`https://github.com/${p.repo}/pull/${p.number}`.toLowerCase()]?.task).find(Boolean);
      return { state: { ...base, prs }, facts: { target: urls, sentence: `${merge ? "Merge" : "Close"} ${urls}${merge ? " at its approved head, once its checks are green" : ""}.`, diff: diff.trim() }, reads, changed, bases, own, task };
    }
    const branches = [];
    const changed: Changed[] = [];
    let diff = "";
    for (const b of a.only ?? []) {
      const { s, dir } = await fromWorkspace(a.workspace, b);
      const def = await defaultBranch(s.slug);
      const tip = await fetchRemote(s, def, "ws").then((r) => r.sha, () => "");
      const empty = !tip;
      const mb = empty ? "" : await git(dir, ["merge-base", b.sha, `refs/remote/${def}`]).catch(() => "");
      // No renames: a file moved counts at both paths (one moved out of kernel/ still changes kernel/).
      const files = (await git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mb || EMPTY_TREE, b.sha])).split("\0").filter(Boolean);
      diff += `${await diffOf(dir, mb || EMPTY_TREE, b.sha)}\n`;
      changed.push(...(await numstatOf(dir, mb || EMPTY_TREE, b.sha)));
      // Outside our own repos (the agents org, the product) the PR's text and the branch's commit messages name none of our tooling.
      if (!ownRepo(s.slug, o.fleetOrg, o.productRepo)) {
        // The AidenHQ trailer (attribution, spec §4) is the one internal name these may carry.
        const messages = (await git(dir, ["log", "--format=%B%x1e", mb ? `${mb}..${b.sha}` : b.sha])).split("\x1e").map((m) => m.split("\n").filter((l) => !hasTrailer(l)).join("\n"));
        const leak = kind.endsWith(".pr") ? leakIn(`${a.text?.title ?? ""}\n${a.text?.body ?? ""}`) : undefined;
        if (leak) throw fail(422, `Not done: the PR title or description mentions "${leak}". ${s.slug}'s reviewers mustn't see internal names, tools or local paths; reword it and ask again.`);
        const msg = messages.find((m) => leakIn(m));
        if (msg) throw fail(422, `Not done: a commit message on ${b.branch} mentions "${leakIn(msg)}" ("${msg.trim().split("\n")[0]!.slice(0, 80)}"). ${s.slug}'s reviewers mustn't see internal names; reword the commit and ask again.`);
      }
      for (const f of files) reads.push({ name: `${s.slug} ${f}`, read: () => git(dir, ["show", `${b.sha}:${f}`]) });
      // A branch's PR targets the default branch (execute opens it there); a repo with none yet has no base to read.
      bases.push({ repo: s.slug, base: empty ? "" : def, read: (path) => git(dir, ["show", `refs/remote/${def}:${path}`]), dir, tip });
      branches.push({ repo: s.slug, branch: b.branch, sha: b.sha, base: mb || undefined, files, defaultBranch: def, empty });
    }
    const names = branches.map((b) => `${b.repo} \`${b.branch}\``).join(", ");
    return { state: { ...base, branches }, facts: { target: names, sentence: `${kind.endsWith(".pr") ? "Push and open a PR for" : "Push"} ${names}.`, diff: diff.trim() }, reads, changed, bases, own, task: String(a.workspace ?? "") };
  }

  /**
   * The changed files' text for the reviewer (fileContext, as the runner read them): every one in order, a file that can't be
   * read at the head (deleted) skipped.
   */
  async function readFiles(list: { name: string; read: () => Promise<string> }[]) {
    const files: { name: string; text: string | undefined }[] = [];
    for (const f of list) files.push({ name: f.name, text: await f.read().catch(() => undefined) });
    return fileContext(files);
  }

  const executor: Executor = {
    async plan(req: PlanRequest) {
      if (req.kind.endsWith(".setup")) return setupWrite.plan(api, req.args, (text) => (ownRepo(String(req.args?.repo), o.fleetOrg, o.productRepo) ? undefined : leakIn(text)));
      const { state, facts, reads, changed, bases, own, task } = (await stateFor(req.kind, req.args ?? {}, req.requester)) as Awaited<ReturnType<typeof stateFor>> & { reads?: { name: string; read: () => Promise<string> }[]; changed?: Changed[]; bases?: Base[]; own?: Set<string>; task?: string };
      const planned = planRules({ kind: req.kind, args: req.args }, state, facts);
      // Who asked, by the request's exact kind and args (the revalidating plan carries the record's own args, as execute
      // does): a write held while GitHub is disconnected is re-checked as them, and its PR is signed with their name.
      if (req.requester) noteAsker(req.kind, req.args, { requester: req.requester, task: req.task });
      // The reviewer's context goes with the filing only (a revalidation compares targets): never part of the record's digest.
      const sources = req.revalidate ? undefined : await readCardSourceExceptions(bases ?? [], (repo: string, base: string) => bases!.find((b) => b.repo === repo && b.base === base)!.read(SOURCE_EXCEPTIONS_FILE));
      // The task's other PRs already merged into these bases; a read that fails leaves them out, never the plan.
      const siblings = req.revalidate || !bases?.length ? [] : await readSiblings({ candidates: candidatesOf(prTasks(), task, own), bases, pr: async (repo: string, n: number) => api("GET", `/repos/${repo}/pulls/${n}`), git }).catch((e: Error) => (log("siblings unread", { err: String(e.message ?? e).slice(0, 200) }), []));
      const out = req.revalidate || (!reads?.length && !changed?.length && !sources && !siblings.length) ? planned : { ...planned, review: { ...(reads?.length || changed?.length ? { files: { ...(reads?.length ? await readFiles(reads) : { list: [], leftOut: [] }), ...(changed?.length ? { changed } : {}) } } : {}), ...(sources ? { sources } : {}), ...(siblings.length ? { siblings } : {}) } };
      return out;
    },
    async execute(rec) {
      // A merge is its own durable queue, which waits for the reconnect itself (merges.ts, work.waiting reason github).
      if (rec.kind.endsWith(".merge")) return merges.enqueue(rec.id, rec.args ?? {}, rec.task, rec.identifier, rec.tier);
      // A setup is never held for a reconnect: asked again, it re-reads the branch and the reviewer reads it again.
      if (rec.kind.endsWith(".setup")) return access.connected() ? setupWrite.run(api, rec.args) : { ok: false, text: "GitHub isn't connected: ask again once it is." };
      // Nor is a share: it is bound to the tip the owner previewed, so it runs now or he previews again.
      if (rec.kind.endsWith(".publish_module")) return access.connected() ? publishModule(rec.args) : { ok: false, text: "GitHub isn't connected: preview again once it is." };
      // GitHub signed out, or signed out mid-write: the approved record waits (held.json) and runs once by id after the reconnect.
      if (!access.connected()) return hold(rec);
      try {
        return await run1(rec);
      } catch (e) {
        if (disconnected(e)) return hold(rec);
        throw e;
      }
    },
  };
  /** The write itself; `objects` names what it made on GitHub for the kernel's records (spec §5). */
  async function run1(rec: { id: string; kind: string; args: any; task?: string; identifier?: string; tier?: number }): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    {
      const a = rec.args ?? {};
      const objects: string[] = [];
      const ref = (slug: string) => `github:${slug.toLowerCase()}`;
      const action = rec.kind.replace(/^github\./, "");
      const done: string[] = [];
      if (action === "push" || action === "pr") {
        for (const b of a.only) {
          const { s, dir } = await fromWorkspace(a.workspace, b);
          // A task branch may be rewritten; the default branch only ever moves forward.
          const def = await defaultBranch(s.slug);
          await push(dir, ["push", "--quiet", "--no-verify", remote(s.slug), `${b.branch === def ? "" : "+"}${b.sha}:refs/heads/${b.branch}`]);
          notePushed(s.slug, b.sha);
          objects.push(`${ref(s.slug)}@${b.sha}`);
          if (action === "pr") {
            // The PR this publish is for: an open one into the default branch the plan read (the same head may also target
            // another base, and that one is not what was reviewed). Both filters are GitHub's, so paging can't hide it.
            const open = await api("GET", `/repos/${s.slug}/pulls?state=open&head=${encodeURIComponent(`${s.org}:${b.branch}`)}&base=${encodeURIComponent(def)}`);
            // The PR's text is signed by the agent that asked for it (spec §4).
            const asker = readAskers()[askerKey(rec.kind, rec.args)];
            // A republish that names no text, or only blank text, keeps the PR as it is: a PATCH replaces the whole description,
            // so a blank body must never be sent (it would leave the footer alone). A real body still replaces it, once footered.
            const named = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
            const title = named(a.text?.title), body = named(a.text?.body);
            const text = a.text ? { ...(title ? { title } : {}), ...(body ? { body: withFooter(body, asker?.requester.name || "AidenHQ") } : {}) } : undefined;
            // A new PR still opens with the asking agent's footer alone, as before: the attribution is what it had.
            const opened = a.text ? { ...text, body: withFooter(body ?? "", asker?.requester.name || "AidenHQ") } : undefined;
            const pr = open[0]
              ? (Object.keys(text ?? {}).length ? await api("PATCH", `/repos/${s.slug}/pulls/${open[0].number}`, text) : open[0])
              : await api("POST", `/repos/${s.slug}/pulls`, { ...opened, head: b.branch, base: def });
            done.push(pr.html_url ?? `${s.slug}#${pr.number}`);
            if (pr.number && !open[0]) objects.push(`${ref(s.slug)}#${Number(pr.number)}`); // ours only when this write opened it
            if (pr.html_url) notePrTask(o.cacheDir, pr.html_url, { task: a.workspace, branch: b.branch }); // the PR watch wakes the task that opened it
            if (pr.number) {
              // Flow: the PR opened when this write created it, a head it moves is a push, and CI starts on every head it publishes.
              const n = Number(pr.number);
              // This write opened it: an agent's PR (the owner's login, AidenHQ's record).
              if (!open[0]) flow.opened(s.slug, n, b.sha, b.branch, pr.created_at, a.workspace, undefined, { title: String(pr.title ?? text?.title ?? ""), author: String(pr.user?.login ?? (await ownerLogin()) ?? "ghost"), author_kind: "agent" });
              else if (open[0].head?.sha && open[0].head.sha !== b.sha) {
                // Forced: the old head is no ancestor of the new one.
                const cmp = await api("GET", `/repos/${s.slug}/compare/${open[0].head.sha}...${b.sha}`).catch(() => undefined);
                flow.pushed(s.slug, n, b.sha, String(open[0].head.sha), cmp ? !["ahead", "identical"].includes(String(cmp.status)) : false, String((await ownerLogin()) ?? "ghost"), undefined, a.workspace);
              }
              flow.checksStarted(s.slug, n, b.sha, undefined, a.workspace);
            }
            // A fleet-org PR that changes UI files gets its design review at this head (one that changes none files nothing).
            if (same(s.org, o.fleetOrg) && pr.number) void designReviews?.fileDesignReview({ repo: s.slug, number: Number(pr.number), head: b.sha }).catch((e: Error) => log("design review task failed", { pr: pr.html_url, err: String(e.message ?? e).slice(0, 300) }));
          } else done.push(`${s.slug} ${b.branch} at ${b.sha.slice(0, 12)}`);
        }
        return { ok: true, text: `${action === "pr" ? "PRs" : "Pushed"}: ${done.join(", ")}`, objects };
      }
      // An approved merge is a queue (merges.ts): its outcome comes when every PR merged at its bound head, or the queue stopped.
      if (action === "merge") return merges.enqueue(rec.id, a, rec.task, rec.identifier, rec.tier);
      if (action === "close") {
        for (const p of a.prs) {
          const s = slugOf(p.repo);
          const closed = await api("PATCH", `/repos/${s.slug}/pulls/${Number(p.number)}`, { state: "closed" });
          if (closed?.head?.sha) flow.closed(s.slug, Number(p.number), String(closed.head.sha));
          done.push(`${s.slug}#${p.number}`);
        }
        return { ok: true, text: `Closed: ${done.join(", ")}`, objects };
      }
      if (action === "create_repo") {
        const s = slugOf(a.repo);
        if ((await createRepo(s)) !== "created") return { ok: true, text: `${s.slug}: exists (nothing was created).` };
        // A new app repository in the fleet org starts with the app starter on main; a failed seed is said, never hidden.
        if (!inOrg(o.fleetOrg, s.slug)) return { ok: true, text: `${s.slug}: created (private, with a README).` };
        const failed = await seedStarter(s).then(() => "", (e: Error) => String(e.message ?? e).slice(0, 300));
        if (failed) log("app starter not seeded", { repo: s.slug, err: failed });
        return { ok: true, text: failed
          ? `${s.slug}: created (private, with a README only: adding the app starter failed: ${failed}). Copy the app starter in (\`cp -r /opt/aidenhq/app-starter/. <repo>/\`) as its own first commit, before the app's own work.`
          : `${s.slug}: created (private, with the app starter on main: build on it, so the first change holds only the app's own work).` };
      }
      return { ok: false, text: `no such kind ${rec.kind}` };
    }
  }
  /**
   * Create org/name, private, with a README: only for an approved create_repo (the one caller). Naming, adding or detecting a
   * repo never creates one. "exists" when GitHub says the name is taken.
   */
  async function createRepo(s: ReturnType<typeof slugOf>): Promise<"exists" | "created"> {
    const r = await gh("POST", `/orgs/${s.org}/repos`, { name: s.name, private: true, auto_init: true });
    if (r.status === 201) return "created";
    if (r.status === 422 && /already exists/i.test(JSON.stringify(r.body?.errors ?? r.body?.message ?? ""))) return "exists";
    throw fail(502, `couldn't create ${s.slug}: GitHub said ${r.status} ${r.body?.message ?? ""}`.trim());
  }

  // ---- held writes: approved while GitHub was disconnected ----
  type Asker = { requester: PlanRequest["requester"]; task: string };
  type Held = { id: string; kind: string; args: any; state: "held" | "running" | "done" | "failed"; text?: string; objects?: string[]; at: string; asker?: Asker };
  // The requester of each planned write (the kernel's record of who asked; execute carries none), by a digest of its kind and
  // args, for the held re-check. The last 500 only.
  const askersFile = join(o.cacheDir, "askers.json");
  const readAskers = (): Record<string, Asker> => { try { return JSON.parse(readFileSync(askersFile, "utf8")); } catch { return {}; } };
  function noteAsker(kind: string, args: unknown, who: Asker) {
    const all = readAskers();
    all[askerKey(kind, args)] = who;
    writeFileSync(`${askersFile}.tmp`, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-500))));
    renameSync(`${askersFile}.tmp`, askersFile);
  }
  const heldFile = join(o.cacheDir, "held.json");
  const readHeld = (): Record<string, Held> => { try { return JSON.parse(readFileSync(heldFile, "utf8")); } catch { return {}; } };
  const writeHeld = (h: Record<string, Held>) => { writeFileSync(`${heldFile}.tmp`, JSON.stringify(h)); renameSync(`${heldFile}.tmp`, heldFile); };
  const heldWaiters = new Map<string, (out: { ok: boolean; text: string; objects?: string[] }) => void>();
  /** The record waits for the reconnect: executor@1 status answers running until it ran. */
  function hold(rec: { id: string; kind: string; args: any }): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    const h = readHeld();
    if (!h[rec.id]) {
      const asker = readAskers()[askerKey(rec.kind, rec.args)];
      h[rec.id] = { id: rec.id, kind: rec.kind, args: rec.args, state: "held", at: new Date().toISOString(), ...(asker ? { asker } : {}) };
      writeHeld(h);
      log("write held until GitHub is connected", { record: rec.id, kind: rec.kind });
    }
    return new Promise((ok) => heldWaiters.set(rec.id, ok));
  }
  let heldBusy = false;
  /** Once connected: each held record runs once by id; its outcome goes to its waiter, or to the kernel after a restart. */
  async function stepHeld() {
    if (heldBusy || !access.connected()) return;
    heldBusy = true;
    try {
      for (const r of Object.values(readHeld()).filter((x) => x.state === "held" || x.state === "running")) {
        writeHeld({ ...readHeld(), [r.id]: { ...r, state: "running" } });
        let out: { ok: boolean; text: string; objects?: string[] };
        try { out = (await stillClaimed(r.id)) && (await stillApproved(r)) ? await run1(r) : { ok: false, text: "Not done: it changed while GitHub was disconnected; ask again." }; } catch (e) {
          if (disconnected(e)) { writeHeld({ ...readHeld(), [r.id]: { ...r, state: "held" } }); return; }
          out = { ok: false, text: String((e as Error).message ?? e) };
        }
        writeHeld({ ...readHeld(), [r.id]: { ...r, state: out.ok ? "done" : "failed", text: out.text, ...(out.objects ? { objects: out.objects } : {}) } });
        const w = heldWaiters.get(r.id);
        heldWaiters.delete(r.id);
        if (w) w(out);
        else await report(r.id, out).catch((e: Error) => log("held outcome not delivered", { record: r.id, err: String(e.message).slice(0, 200) }));
      }
    } finally { heldBusy = false; }
  }
  /** The kernel's record is still claimed or approved: one cancelled or decided otherwise while held is dropped, not run. */
  async function stillClaimed(id: string): Promise<boolean> {
    const st = await kernel("GET", `/v1/writes/${id}`).then((j) => String(j?.state));
    const ok = st === "claimed" || st === "approved";
    if (!ok) log("held write dropped: its record is no longer live", { record: id, state: st });
    return ok;
  }
  /**
   * A held record runs only if what it was approved for still holds: its state, read again now as the requester who asked for
   * it (stored when it was held; never made up: without one it doesn't run), still passes the git rules and binds the same
   * commits its args named (each branch at its sha, each PR at its head). Read without the plan's side effects (no provenance
   * note).
   */
  async function stillApproved(r: Held): Promise<boolean> {
    if (!r.asker) return false;
    const targets = await stateFor(r.kind, r.args ?? {}, r.asker.requester)
      .then(({ state, facts }) => planRules({ kind: r.kind, args: r.args }, state, facts).targets as Record<string, { commit?: string | null }>)
      .catch((e) => { if (disconnected(e)) throw e; return undefined; });
    if (!targets) return false;
    const want = [
      ...((r.args?.only ?? []) as { repo: string; branch: string; sha: string }[]).map((b) => [`${slugOf(b.repo).slug} ${b.branch}`, b.sha] as const),
      ...((r.args?.prs ?? []) as { repo: string; number: number; head?: string }[]).filter((p) => p.head).map((p) => [`${slugOf(p.repo).slug}#${Number(p.number)}`, p.head!] as const),
    ];
    return want.every(([k, sha]) => targets[k]?.commit === sha);
  }
  const heldStatus = (id: string) => { const r = readHeld()[id]; return r ? (r.state === "done" || r.state === "failed" ? { state: r.state, text: r.text, ...(r.objects ? { objects: r.objects } : {}) } : { state: "running" }) : undefined; };

  const exec = serveExecutor(executor, { key: o.key, kernelUrl: o.kernelUrl, log });
  async function report(id: string, out: { ok: boolean; text: string; objects?: string[] }) {
    const r = await fetch(`${o.kernelUrl}/v1/writes/${id}/outcome`, { method: "POST", headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" }, body: JSON.stringify(out), signal: AbortSignal.timeout(15_000) });
    if (!r.ok && r.status !== 409) throw new Error(`the kernel answered ${r.status}`);
  }
  // Why a claimed record is still running, to the kernel (its task hears it, once per distinct reason): 409 is a record no
  // longer claimed, which is not an error here.
  async function waiting(id: string, reason: string | null) {
    const r = await fetch(`${o.kernelUrl}/v1/writes/${id}/wait`, { method: "POST", headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" }, body: JSON.stringify({ reason }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok && r.status !== 409) throw new Error(`the kernel answered ${r.status}`);
  }
  async function kernel(method: "GET" | "POST", path: string, b?: unknown) {
    const r = await fetch(`${o.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${o.key}`, ...(b ? { "content-type": "application/json" } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`the kernel's ${path.split("/").slice(0, 3).join("/")} answered ${r.status}: ${String(j?.error?.message ?? j?.error ?? "").slice(0, 200)}`), { status: r.status });
    return j;
  }
  // The design reviewer's tasks (design-review.ts): for a fleet-org PR's UI head when it opens, and for each head the merge
  // queue waits on for its verdict.
  const designReviews = createDesignReviews({ kernelUrl: o.kernelUrl, key: o.key, cacheDir: o.cacheDir, gh: (m, p, b) => gh(m, p, b, { background: true }), log });
  // The managed repos: the fleet org's, the product repo and the instance repo.
  async function managedRepos(): Promise<string[]> {
    const out = new Set([o.productRepo, o.instanceRepo].filter(Boolean).map((r) => r!.toLowerCase()));
    if (o.fleetOrg && access.connected()) {
      for (let page = 1; ; page++) {
        const r = await gh("GET", `/orgs/${o.fleetOrg}/repos?type=all&per_page=100&page=${page}`, undefined, { background: true });
        if (r.status >= 300) throw fail(502, `GitHub GET /orgs/${o.fleetOrg}/repos: ${r.status}`);
        for (const x of r.body ?? []) if (!x.archived && !x.fork) out.add(String(x.full_name).toLowerCase());
        if ((r.body ?? []).length < 100) break;
      }
    }
    return [...out];
  }
  const flow = createFlow({
    kernelUrl: o.kernelUrl, key: o.key, cacheDir: o.cacheDir, log, exclude: o.churnExclude, now: o.now,
    // Signed out: no repos, so the passes call nothing (and tell the owner nothing) until GitHub is connected.
    repos: async () => (access.connected() ? managedRepos() : []),
    gh: (method, path, opts) => gh(method, path, undefined, { background: true, ...opts }),
    self: ownerLogin,
    ours,
    fetchDefault: async (repo) => {
      const s = slugOf(repo);
      const def = await defaultBranch(s.slug);
      const { dir, sha } = await fetchRemote(s, def);
      return { dir, sha };
    },
    git: (dir, args) => git(dir, args),
  });
  const merges = createMerges({
    flow, taskOf: (repo, n) => flow.taskOf(repo, n),
    // A queue persisted before it kept the task's identifier: the record itself has it (kernel work read).
    identifierOf: async (record) => {
      // A record that is gone (404) has no identifier to find; any other failure is transient (the kernel restarting), and the
      // queue must retry it rather than settle a legacy queue without the evidence the identifier would have proven.
      const r = await kernel("GET", `/v1/work?record=${encodeURIComponent(record)}`).catch((e: Error & { status?: number }) => { if (e.status === 404) return undefined; throw e; });
      const ident = String((r as { identifier?: unknown })?.identifier ?? "");
      return ident || undefined;
    },
    // An already-merged PR's other link to its task: with no pr-tasks.json row (the push refused before the PR write noted it),
    // the task's own planned write naming this repo and this exact commit is the attribution. Any state counts (`failed` is the
    // #1281 push). A failed read throws, so the queue retries it rather than treating it as "no binding".
    prBound: async (task, pr) => {
      // A 4xx is the kernel's answer (a task it no longer holds): no binding, so the queue settles rather than retrying a
      // permanent refusal forever. Any other failure is transient (the kernel restarting) and is retried by the next poll.
      const r = await kernel("GET", `/v1/work?task=${encodeURIComponent(task)}`).catch((e: Error & { status?: number }) => {
        if (e.status && e.status >= 400 && e.status < 500) return null;
        throw e;
      });
      if (!r) return false;
      const records = (r as { records?: unknown }).records;
      // HTTP 200 with no whole body (a restart mid-response) is not "no records": the queue must ask again, not settle without it.
      if (!Array.isArray(records)) throw new Error("the kernel's work read answered without its records");
      return (records as { kind?: string; args?: { only?: { repo?: string; sha?: string }[] } }[]).some((x) => (x.kind === "github.pr" || x.kind === "github.push")
        && (x.args?.only ?? []).some((b) => String(b.repo ?? "").toLowerCase() === pr.repo.toLowerCase() && b.sha === pr.head));
    },
    dir: join(o.cacheDir, "merges"), gh: (method, path, body) => gh(method, path, body, { background: true }), connected: () => access.connected() && !o.holdMerges?.(), hold: () => o.holdMerges?.() === true, holdReason: () => o.mergeHoldReason?.(),
    fleetOrg: o.fleetOrg, productRepo: o.productRepo, maintained: o.maintained,
    report, waiting, log, now: o.now, everyMs: o.mergeEveryMs,
    reviewGate: o.reviewGate,
  });
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(o.key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  /** executor@1 status for a merge record answers from its queue, which outlives a restart; any other goes to the SDK. */
  async function status(req: IncomingMessage, res: ServerResponse) {
    const raw = await body(req).catch(() => ({}));
    const q = keyed(req) ? merges.status(String(raw?.id ?? "")) ?? heldStatus(String(raw?.id ?? "")) : undefined;
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
    const def = await defaultBranch(s.slug);
    const { sha: main } = await fetchRemote(s, def, "ws");
    const base = await git(dir, ["merge-base", sha, main]).catch(() => "");
    if (!base) throw fail(409, `${sha.slice(0, 12)} shares no history with the instance's ${def}`);
    return { s, dir, sha, def, main, base };
  }
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
   * texts its rules read on both sides (each changed file and instance.yaml; absent where the file isn't) and the diff. Read
   * from git here, never from the requester.
   */
  async function applyRead(b: any) {
    const c = await instanceCommit(b);
    const files = (await git(c.dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", c.base, c.sha])).split("\0").filter(Boolean);
    if (files.length > MAX_FILES) throw fail(413, `the commit changes ${files.length} files; an apply reviews at most ${MAX_FILES}`);
    const texts: { base: Record<string, string>; head: Record<string, string> } = { base: {}, head: {} };
    let budget = MAX_TOTAL;
    for (const p of new Set([...files, "instance.yaml"])) {
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
    return { files, texts, diff, base: c.base, main: c.main };
  }
  async function applyLand(b: any) {
    const c = await instanceCommit(b);
    // Already on main (a land that ran before a restart): main is what applies, and it contains this commit.
    if (c.base === c.sha) return { landed: c.main, already: true };
    if (c.base !== c.main) throw fail(409, `the instance's ${c.def} moved on since this commit's base; it needs a rebase and a new approval`);
    // The official modules are the product's modules/: their reviewer code reaches this host only with the product pin, whose
    // reviewer changes merged on CI's reviewer eval (ci-required). An `aidenhq` marketplace pin an apply adds or
    // moves would bring reviewer code past that gate, so it never lands; dropping one (a pre-monorepo install) does. The kernel reads the pin structurally from both sides
    // (apply.ts officialMove) and names it; without it nothing lands.
    const pin = (x: any) => x === null || (x && typeof x.repo === "string" && SLUG.test(x.repo) && /^[0-9a-f]{40}$/.test(String(x.sha)));
    const off = b.official;
    if (!off || !pin(off.from) || !pin(off.to)) throw fail(400, "name the official modules' pin on both sides (official: {from, to}, each {repo, sha} or null)");
    if (off.to !== null && JSON.stringify(off.from) !== JSON.stringify(off.to)) throw fail(422, "not landed: it adds or moves an `aidenhq` marketplace pin; the official modules come with the product pin");
    await push(c.dir, ["push", "--quiet", "--no-verify", remote(c.s.slug), `${c.sha}:refs/heads/${c.def}`]);
    log("instance landed", { repo: c.s.slug, sha: c.sha });
    return { landed: c.sha };
  }

  async function body(req: IncomingMessage, max = 100_000): Promise<any> {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > max) throw fail(413, "too large"); }
    try { return JSON.parse(raw || "{}"); } catch { throw fail(400, "not JSON"); }
  }
  const send = (res: ServerResponse, status: number, b: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));

  /**
   * The kernel's `setup` op (kernel/src/codehost.ts: the grant and the shape of every field are checked there): files this code
   * host's own `github.setup` record on the caller's task and waits for its outcome, so the push only ever runs approved and bound
   * to the repo, default-branch head and files the reviewer read. Still waiting after five minutes: { pending, write }; ask again and the
   * same open record is found.
   */
  async function setupOp(b: Record<string, any>): Promise<{ status: number; json: unknown }> {
    log("ops", { op: "setup", module: String(b.module ?? ""), repo: String(b.repo ?? "") });
    const task = String(b.task ?? "");
    if (!task) throw fail(400, "name the task the setup's approval belongs to");
    const args = { repo: slugOf(b.repo).slug, files: b.files, allow: b.allow, title: b.title, body: b.body };
    let rec = await kernel("POST", "/v1/writes", { kind: "github.setup", args, task }) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
    for (const t0 = Date.now(); !["done", "failed", "rejected", "stale", "cancelled", "unknown"].includes(rec.state); ) {
      if (Date.now() - t0 > 5 * 60_000) return { status: 202, json: { pending: true, write: rec.id } };
      await new Promise((r) => setTimeout(r, 2000));
      rec = await kernel("GET", `/v1/writes/${rec.id}`);
    }
    if (rec.state !== "done" || !rec.outcome?.ok) return { status: 409, json: { error: `the setup wasn't done: write ${rec.id} ${rec.state}${rec.outcome?.text ? `: ${rec.outcome.text.slice(0, 300)}` : ""}`, write: rec.id } };
    return { status: 200, json: JSON.parse(rec.outcome.text) };
  }
  async function ops(op: string, req: IncomingMessage, res: ServerResponse) {
    // Only the kernel calls the ops, with this service's key: POST /v1/codehost/:op brokers them under each module's grant.
    if (!keyed(req)) throw fail(401, "the kernel only");
    if (op !== "snapshot" && op !== "bundle") {
      if (!o.ops) throw fail(404, "no such operation");
      return o.ops(req, res, {
        access, cacheDir: o.cacheDir, cache: (s) => cache(s), git, fetchRemote: (s, name) => fetchRemote(slugOf(s.slug), name),
        initBare, ours,
      });
    }
    const b = await body(req);
    // b.module: the module the kernel checked the grant of (for the log).
    log("ops", { op, module: String(b.module ?? ""), repo: String(b.repo ?? "") });
    const s = slugOf(b.repo);
    // HEAD: the repo's default branch, by its name (a clone then has origin/<that branch>). A repo GitHub doesn't show is a 404.
    const asked = String(b.ref ?? "").replace(/^refs\/heads\//, "");
    let name = asked;
    if (asked === "HEAD") {
      const r = await gh("GET", `/repos/${s.slug}`).catch((e) => { throw needOf(e)?.cause === "unreachable" ? fail(404, `${s.slug} isn't on GitHub (or your account can't see it)`) : e; });
      if (r.status === 404) throw fail(404, `${s.slug} isn't on GitHub (or your account can't see it)`);
      if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}: ${r.status}`);
      name = String(r.body?.default_branch ?? "");
    }
    if (!BRANCH.test(name)) throw fail(400, "name a branch or a commit");
    const { dir, sha } = await fetchRemote(s, name);
    if (op === "snapshot") {
      // git archive: the tree only, no .git and no credentials; no filter runs (no config defines one). The whole tree: the repo's
      // own .gitattributes don't apply (no export-ignore, no export-subst), since a check reads every tracked file. In the bare
      // cache --worktree-attributes reads no tree's attributes, and attr.tree (the empty tree) keeps git off HEAD's.
      res.writeHead(200, { "content-type": "application/gzip", "x-aidenhq-commit": sha });
      const p = spawn("git", [...SAFE_GIT_ARGS, "-c", "attr.tree=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "--git-dir", dir, "archive", "--worktree-attributes", "--format=tar.gz", sha], { env: ENV, stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.pipe(res);
      return;
    }
    if (op === "bundle") {
      // The branch alone as a git bundle (its HEAD and refs/heads/<branch>), for a running job's box to clone or fetch itself
      // (`aidenhq clone`): host git never runs in a workspace a box can write. GitHub's objects only (the github cache).
      const stream = await packBundle({ cacheDir: o.cacheDir, git, initBare }, dir, new Map([[`refs/heads/${name}`, sha]]), `refs/heads/${name}`);
      res.writeHead(200, { "content-type": "application/octet-stream", "x-aidenhq-commit": sha });
      stream.pipe(res);
      return;
    }
  }

  /**
   * A commit on top of the repo's default branch head, in the ws cache (refs/train/<sha>, never checked out): `files` (path →
   * new text, or null to delete) are made from that same head, and the author, committer and dates are fixed by the head, so
   * the same head and files give the same commit.
   */
  async function commitOnHead(repo: string, agent: string, message: string, files: (dir: string, head: string, def: string) => Promise<Record<string, string | null>>, branch?: string) {
    const s = slugOf(repo);
    const def = branch ?? (await defaultBranch(s.slug));
    const { dir, sha: head } = await fetchRemote(s, def, "ws");
    const edits = await files(dir, head, def);
    const date = await git(dir, ["log", "-1", "--format=%cI", head]);
    // The owner's, with the AidenHQ trailer naming the writer (spec §4).
    const who = identityEnv(await access.identity());
    const index = join(mkdtempSync(join(o.cacheDir, "scratch-")), "index");
    try {
      const g = (args: string[], input?: string) => new Promise<string>((ok, no) => {
        const p = spawn("git", [...SAFE_GIT_ARGS, "--git-dir", dir, ...args], { env: { ...ENV, GIT_INDEX_FILE: index, ...who, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => (code === 0 ? ok(out.trim()) : no(new Error(`git ${args[0]}: ${err.trim().slice(0, 300)}`))));
        // A git that reads no stdin (read-tree) can exit before the write: the EPIPE isn't the outcome, its exit code is.
        p.stdin.on("error", () => {});
        p.stdin.end(input ?? "");
      });
      await g(["read-tree", head]);
      for (const [path, text] of Object.entries(edits)) {
        if (text === null) await g(["update-index", "--index-info"], `0 0000000000000000000000000000000000000000\t${path}\n`);
        else await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${path}`]);
      }
      const sha = await g(["commit-tree", await g(["write-tree"]), "-p", head], withTrailer(message, agent));
      await git(dir, ["update-ref", `refs/train/${sha}`, sha]);
      return sha;
    } finally {
      rmSync(join(index, ".."), { recursive: true, force: true });
    }
  }
  /**
   * A new app repository's first commit after GitHub's README: the app starter's tracked files (the product repo's
   * modules/apps-platform/starter at its default branch, `git archive`, so nothing untracked) as the owner with the AidenHQ
   * trailer, fast-forwarded onto
   * the new repo's default branch. So an app's first PR holds only the app's own work, and the reviewer never reads the
   * starter (its identity check, its pages, its lock file) as the agent's additions.
   */
  async function seedStarter(s: ReturnType<typeof slugOf>) {
    if (!o.productRepo) throw new Error("no product repo is set, so there is no app starter to copy");
    const p = slugOf(o.productRepo);
    const source = await fetchRemote(p, await defaultBranch(p.slug));
    const def = await defaultBranch(s.slug);
    const { dir, sha: parent } = await fetchRemote(s, def, "ws");
    const tmp = mkdtempSync(join(o.cacheDir, "scratch-"));
    try {
      const files = join(tmp, "files");
      mkdirSync(files);
      await git(source.dir, ["archive", "--format=tar", "-o", join(tmp, "starter.tar"), `${source.sha}:modules/apps-platform/starter`]);
      await run("tar", ["-xf", join(tmp, "starter.tar"), "-C", files], { env: ENV });
      const env = { ...ENV, ...identityEnv(await access.identity()), GIT_INDEX_FILE: join(tmp, "index") };
      const g = async (args: string[]) => (await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "--work-tree", files, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
      await g(["add", "--all", "--force", "."]);
      const sha = await g(["commit-tree", await g(["write-tree"]), "-p", parent, "-m", withTrailer("chore: start from the app starter\n\nWritten by the code host when it created this repository; no agent wrote it.", "code host")]);
      await push(dir, ["push", "--quiet", "--no-verify", remote(s.slug), `${sha}:refs/heads/${def}`]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  /**
   * Where a share lands (publish_module, docs/design/sharing.md): the repo as GitHub reports it (missing is refused), its
   * branch's tip fetched into the ws cache, why its `<module>/` folder or marketplace.json entry isn't this module's own, and
   * the files that folder holds now (`existing`, relative to it): a publish replaces the folder, so the preview shows what goes.
   */
  async function destination(repo: string, ref: string, module: string) {
    const s = slugOf(repo);
    if (!BRANCH.test(ref)) throw fail(400, `${ref.slice(0, 100)} is not a branch name`);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(module)) throw fail(400, `${module.slice(0, 100)} is not a module name`);
    const r = await gh("GET", `/repos/${s.slug}`);
    if (r.status === 404) throw fail(404, `${s.slug} isn't on GitHub (or your account can't see it)`);
    if (r.status >= 300) throw fail(502, `GitHub GET /repos/${s.slug}: ${r.status}`);
    const { dir, sha: tip } = await fetchRemote(s, ref, "ws");
    const listing = await fileAt(dir, tip, "marketplace.json");
    let conflict: string | undefined;
    try { upsertMarketplace(listing, module); } catch (e) { conflict = `${s.slug}: ${(e as Error).message}`; }
    const listed = !conflict && listing !== undefined && upsertMarketplace(listing, module) === listing;
    if (!conflict && !listed && (await git(dir, ["ls-tree", tip, "--", module]))) conflict = `${s.slug} already has a ${module}/ folder its marketplace.json doesn't list as this module`;
    const existing = (await git(dir, ["ls-tree", "-r", "-z", "--name-only", tip, "--", module])).split("\0").filter(Boolean).map((p) => p.slice(module.length + 1));
    return { s, tip, private: r.body?.private !== false, conflict, existing };
  }
  /**
   * An approved share: the previewed files under `<module>/` (any other file there removed, so the folder is exactly the
   * preview) and the marketplace.json entry, as one commit on the previewed tip, pushed without force: a branch that moved
   * fails it, and the owner previews again.
   */
  async function publishModule(a: { repo: string; ref: string; base: string; source: string; module: string; files: { path: string; text: string }[] }) {
    const s = slugOf(a.repo);
    const files = Object.fromEntries(a.files.map((f) => [`${a.module}/${f.path}`, f.text]));
    const sha = await commitOnHead(s.slug, "the owner's share", `feat: publish the ${a.module} module\n\nThe owner's previewed share of instance commit ${a.source.slice(0, 12)}.`, async (dir, head) => {
      if (head !== a.base) throw fail(409, `${s.slug} \`${a.ref}\` moved since the preview: preview again`);
      const had = (await git(dir, ["ls-tree", "-r", "-z", "--name-only", head, "--", a.module])).split("\0").filter(Boolean);
      if (had.some((p) => /[\n\r]/.test(p))) throw fail(422, `${s.slug} has a file under ${a.module}/ whose name holds a line break: rename it there first`);
      return { ...Object.fromEntries(had.filter((p) => !Object.hasOwn(files, p)).map((p) => [p, null])), ...files, "marketplace.json": upsertMarketplace(await fileAt(dir, head, "marketplace.json"), a.module) };
    }, a.ref);
    // Only onto the tip the owner previewed: the push fails if the branch moved, was reset or was deleted since.
    await push(await cache(s, "ws"), ["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${a.ref}:${a.base}`, remote(s.slug), `${sha}:refs/heads/${a.ref}`]);
    log("module published", { repo: s.slug, ref: a.ref, module: a.module, sha });
    return { ok: true, text: `Published the ${a.module} module to ${s.slug} \`${a.ref}\` at ${sha.slice(0, 12)}.`, objects: [`github:${s.slug.toLowerCase()}@${sha}`] };
  }
  /** The release train's pin bump: one file edited as it is at the head. */
  const trainCommit = (repo: string, path: string, edit: (text: string) => string, message: string) =>
    commitOnHead(repo, "release train", message, async (dir, head, def) => {
      const text = await fileAt(dir, head, path);
      if (text === undefined) throw fail(404, `${path} isn't on ${repo}'s ${def}`);
      return { [path]: edit(text) };
    });
  /**
   * POST /aidenhq/v1/apply/write (the kernel's executor key): the owner's typed settings change (kernel/src/settings-change.ts)
   * as a commit on the instance's main, built from the texts the kernel computed at `base`. Only when main is still `base`;
   * only instance config paths. The commit lands only through a kernel.apply, like any other.
   */
  async function applyWrite(b: any) {
    const s = slugOf(b.repo);
    if (!same(s.slug, o.instanceRepo)) throw fail(403, `a settings change writes only the instance repo (${o.instanceRepo ?? "not set"}), not ${s.slug}`);
    const files: Record<string, string | null> = b.files && typeof b.files === "object" && !Array.isArray(b.files) ? b.files : {};
    const paths = Object.keys(files);
    if (!paths.length || paths.some((p) => !APPLY_PATHS.test(p) || (files[p] !== null && typeof files[p] !== "string"))) throw fail(400, "files: instance config paths, each a text or null");
    const message = String(b.message ?? "").slice(0, 2000);
    const sha = await commitOnHead(s.slug, "settings", message || "settings", async (_dir, head, def) => {
      if (head !== String(b.base ?? "")) throw fail(409, `the instance's ${def} moved on since the change was read; try again`);
      return files;
    });
    return { sha };
  }
  // The train lands the bump through GitHub: an instance repo on this server (local/…, codehost-local's) is not its to move.
  const train = o.productRepo && o.instanceRepo && slugOf(o.instanceRepo).org.toLowerCase() !== LOCAL_ORG ? createReleaseTrain({
    dir: join(o.cacheDir, "release"), productRepo: o.productRepo, instanceRepo: o.instanceRepo, windowMinutes: o.releaseWindowMinutes ?? 15, kernel, log, now: o.now,
    commit: trainCommit,
    github: {
      async tip(repo) {
        const s = slugOf(repo);
        const def = await defaultBranch(s.slug);
        const tip = String((await api("GET", `/repos/${s.slug}/commits/${def}`)).sha ?? "");
        const checks = await checksAt(s, tip);
        return { tip: /^[0-9a-f]{40}$/.test(tip) ? tip : undefined, green: checks.length > 0 && checks.every((c) => c.ok && !c.pending) };
      },
      async text(repo, path) {
        const s = slugOf(repo);
        const ref = await defaultBranch(s.slug);
        const { dir, sha } = await fetchRemote(s, ref);
        return fileAt(dir, sha, path);
      },
      async commits(repo, from, to) {
        const s = slugOf(repo);
        const r = await api("GET", `/repos/${s.slug}/compare/${from}...${to}`);
        // Only each subject's PR number: a subject is whoever merged it's words.
        return (r.commits ?? []).slice(-100).map((c: any) => ({ repo: s.slug, sha: String(c.sha), subject: /\(#(\d+)\)\s*$/.exec(String(c.commit?.message ?? "").split("\n")[0]!)?.[0] ?? "" }));
      },
    },
  }) : undefined;

  return Object.assign(async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.url === "/healthz") return send(res, 200, { ok: true });
      // The commit identity a job's box commits as (the kernel's job identity, the executor key): the owner's.
      if (req.url === "/aidenhq/v1/identity" && req.method === "GET") {
        if (!keyed(req)) return send(res, 401, { error: "the kernel's executor key only" });
        if (!access.connected()) return send(res, 503, { error: "GitHub isn't connected" });
        const me = await access.identity();
        return send(res, 200, { name: me.name, email: me.email });
      }
      if (req.url === "/aidenhq/v1/executor/status" && req.method === "POST") return await status(req, res);
      if (await exec(req, res)) return;
      // A share's preview (the kernel's executor key): where it would land, so the owner's save binds that tip.
      if (req.url === "/aidenhq/v1/publish/tip" && req.method === "POST") {
        if (!keyed(req)) return send(res, 401, { error: "the kernel's executor key only" });
        if (!access.connected()) return send(res, 503, { error: "GitHub isn't connected" });
        const b = await body(req);
        const d = await destination(String(b.repo ?? ""), String(b.ref ?? ""), String(b.module ?? ""));
        return send(res, 200, { repo: d.s.slug, base: d.tip, private: d.private, existing: d.existing, ...(d.conflict ? { conflict: d.conflict } : {}) });
      }
      const ap = /^\/aidenhq\/v1\/apply\/(read|land|write)$/.exec(String(req.url ?? ""));
      if (ap && req.method === "POST") {
        if (!keyed(req)) return send(res, 401, { error: "the kernel's executor key only" });
        const b = await body(req, ap[1] === "write" ? 1_000_000 : 100_000);
        return send(res, 200, ap[1] === "read" ? await applyRead(b) : ap[1] === "land" ? await applyLand(b) : await applyWrite(b));
      }
      const m = /^\/ops\/(snapshot|bundle|fetch|head|read|comment|commit|setup|runner_token)$/.exec(String(req.url ?? ""));
      if (m?.[1] === "setup" && req.method === "POST") {
        if (!keyed(req)) throw fail(401, "the kernel only");
        // The kernel's own cap on an op's body (backplane.ts json: 1 MB), so whatever the kernel forwards fits.
        const r = await setupOp(await body(req, 1_000_000));
        return send(res, r.status, r.json);
      }
      if (m && req.method === "POST") return await ops(m[1]!, req, res);
      send(res, 404, { error: "not found" });
    } catch (e) {
      const err = e as { status?: number; message: string };
      log("github request failed", { url: req.url, error: err.message });
      // A typed need (client.ts): its own words (never a token); signed out is 503 "GitHub isn't connected".
      const need = needOf(e);
      if (!res.headersSent) send(res, err.status ?? (need ? (need.cause === "unreachable" ? 404 : need.cause === "rate_limited" ? 429 : 503) : 500), { error: err.message, ...(need ? { need } : {}) });
      else res.end();
    }
  }, {
    /** The merge loop (merges.ts). */
    startMerges: () => merges.start(),
    /** The release train (train.ts): only with the product and instance repos set. */
    startReleases: () => train?.start(),
    /** The superseded design reviews' sweep (design-review.ts). */
    startDesignReviews: () => startDesignReviewSweep(designReviews, { log }),
    /** Held writes run once GitHub is connected again: checked every 30 s. */
    startHeld: () => { const t = setInterval(() => void stepHeld(), 30_000); t.unref?.(); return () => clearInterval(t); },
    stepHeld,
    /** Flow: the churn loop (flow.ts), and the fact queue sent now (tests, shutdown). */
    startFlow: () => flow.startChurn(),
    flushFacts: () => flow.flush(),
    flow,
    stepReleases: () => train?.step(),
    stepMerges: () => merges.step(),
  });
}
