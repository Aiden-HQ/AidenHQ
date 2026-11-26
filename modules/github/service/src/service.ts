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
import { execFile, execFileSync, spawn } from "node:child_process";
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
import { approvedAt, HOLD_LABEL } from "./merge-gate.ts";
import { contextRank } from "./aidenhq-sdk/checks.ts";
import { createMerges } from "./merges.ts";
import type { ReviewGate } from "./review-gate.ts";
import { createFlow } from "./flow.ts";
import { createReleaseTrain } from "./train.ts";
import type { Feed } from "./feed.ts";
import { LOCAL_ORG, holdAdmits, namespaced, plan as planRules, type Ship, type ShipHold } from "./plan.ts";
import { fileContext, numstat } from "./review-files.ts";
/** One changed file as git counts it (review-files.ts numstat; a binary file has no line counts). */
type Changed = { path: string; add?: number; del?: number };
import { SOURCE_EXCEPTIONS_FILE, readCardSourceExceptions } from "./sources.ts";
import { candidatesOf, readSiblings } from "./siblings.ts";
import { withBranch } from "./branch-lock.ts";
import { notePrTask } from "./pr-tasks.ts";

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
  /** The typed ops other modules get through the kernel (ops.ts serveOps: fetch, head, read, comment, commit, runner_token), run
   * here with the owner's token and never answering it; unset: those ops answer 404. */
  ops?: (req: IncomingMessage, res: ServerResponse, ctx: OpsContext) => Promise<void>;
  /** The owner's one GitHub App, for the `app_token` op (ops.ts). */
  app?: OpsContext["app"];
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
  /**
   * The ship module's adoptions (its GET /v1/generation): a PR's current generation (null: not adopted) and the adoption's
   * task. Unset when ship isn't installed (compiled config): every write that names a generation is then refused. A ship that
   * doesn't answer throws, and the write is refused until it does.
   */
  ship?: ShipAdoptions;
  /**
   * The reviewer App's REST on a repo where it is installed (the owner's one GitHub App, the identity code review posts as), and
   * its bot login; undefined where it isn't (no approval is posted then: one as the owner would count as a person's).
   */
  reviewer?: (repo: string) => Promise<{ login: string; rest: Gh; /** An installation token, for a git push (a fork PR's branch). */ token: () => Promise<string> } | undefined>;
};
/**
 * The reviewer App (github-mcp's gitHubApp over the owner's one App, `<state>/github-app/`, the identity code review posts as) as `Options.reviewer`: its
 * REST with an installation token on a repo it is installed on, and its bot login; undefined where it isn't (or isn't set up).
 */
export function reviewerOf(app: { installation(repo: string): Promise<number | null>; token(installation: number, fresh?: boolean): Promise<string>; slug(): string | undefined }, fetchFn: typeof fetch = fetch): (repo: string) => Promise<{ login: string; rest: Gh; token: () => Promise<string> } | undefined> {
  return async (repo) => {
    const installation = await app.installation(repo);
    const slug = app.slug();
    if (installation === null || !slug) return undefined;
    const call = async (method: string, path: string, body: unknown, fresh: boolean) => {
      const r = await fetchFn(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${await app.token(installation, fresh)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
      return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
    };
    // A token GitHub rejects (401: revoked before its expiry) is fetched fresh once.
    const rest: Gh = async (method, path, body) => {
      const r = await call(method, path, body, false);
      return r.status === 401 ? call(method, path, body, true) : r;
    };
    return { login: `${slug}[bot]`, rest, token: () => app.token(installation) };
  };
}
/** Ship's answer for one PR (its GET /v1/generation?repo&pr → { generation, hold, task? }): `generation` null when it isn't adopted
 * now, and the hold it sits on when it is. A `stalled` hold leaves the adoption in place: the push that resumes it may land, and
 * nothing else. */
export type ShipAdoptions = { /** `at`: the head the write stands on (a fork's adoption refuses any head but the one handed off). */ generation(repo: string, number: number, at: string, check?: ShipCheck): Promise<{ generation: number | null; hold?: ShipHold; task?: string; refused?: string; retry?: boolean; /** Ask for members' open review comments before the write goes on (member-comments.ts): the hand-off's time, and the PR author whose own comments ask nothing. */ comments?: { since: string; author?: string } }> };
/**
 * The hold off ship's answer, when it carries one: a `stalled` one still admits the push that resumes it, so it is the plan's to
 * judge with its kind. A hold it can't read (not an object, or no kind) is still a hold: it reads as `unknown`, which no write
 * admits, so a malformed field can never leave a write open that ship meant to refuse.
 */
const holdOf = (v: unknown): { hold: ShipHold } | undefined => {
  if (v === null || v === undefined) return undefined;
  const { kind, reason } = (typeof v === "object" ? v : {}) as { kind?: unknown; reason?: unknown };
  return { hold: { kind: typeof kind === "string" && kind ? kind : "unknown", ...(typeof reason === "string" ? { reason: reason.slice(0, 300) } : {}) } };
};
/** Ship's final tier check before a write (risk tiers §7): what is about to happen and the PR as GitHub has it right now (head, base branch, author association). */
export type ShipCheck = { do: "approve" | "merge"; head: string; base: string; association: string; /** The policy an approval was filed under. */ policy?: string };
/** Ship's adoptions read from its service with this module's own token (`url`: compiled only when the ship module is on). */
export function shipAdoptions(o: { url: string; key: () => string; fetchFn?: typeof fetch }): ShipAdoptions {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async generation(repo, number, at, check) {
      const q = new URLSearchParams({ repo: repo.toLowerCase(), pr: String(number), at, ...(check ? { do: check.do, head: check.head, base: check.base, association: check.association, ...(check.policy ? { policy: check.policy } : {}) } : {}) });
      const r = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/generation?${q}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw fail(503, `ship answered ${r.status} for ${repo}#${number}: try again`);
      const j = (await r.json()) as { generation?: unknown; hold?: unknown; task?: unknown; refused?: unknown; retry?: unknown; comments?: { since?: unknown; author?: unknown } };
      const generation = Number.isInteger(j.generation) && (j.generation as number) >= 1 ? (j.generation as number) : null;
      return { generation, ...(holdOf(j.hold) ?? {}), ...(typeof j.task === "string" && j.task ? { task: j.task } : {}), ...(typeof j.refused === "string" && j.refused ? { refused: j.refused.slice(0, 300), ...(j.retry === true ? { retry: true } : {}) } : {}), ...(typeof j.comments?.since === "string" ? { comments: { since: j.comments.since, ...(typeof j.comments.author === "string" ? { author: j.comments.author } : {}) } } : {}) };
    },
  };
}

/** A base a change targets: a file read there (source exceptions), and its cache clone at `tip` (siblings). */
type Base = { repo: string; base: string; read: (path: string) => Promise<string>; dir?: string; tip?: string };
// What an apply read collects for the kernel: per file, in all (texts and diff), and how many files.
const MAX_TEXT = 1 << 20, MAX_TOTAL = 8 << 20, MAX_FILES = 200;
/** How long a repair waits for ship's check job: its recipe's 30-minute limit and a few minutes for a free computer. */
const REPAIR_WAIT_MS = 40 * 60_000;
/** The lockfiles a repair may rewrite besides the plan's generated globs (ship's recipe regenerates them). */
const REPAIR_LOCKS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock"];
/** A glob (`**` any folders, `*` within one) as a whole-path pattern. */
const globRe = (glob: string) => new RegExp(`^${String(glob).split("**/").map((part) => part.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")).join("(?:.*/)?")}$`);
/** One path of a tree: its mode and object sha, as git's own tree has them (never a diff's). */
export type TreeEntry = { path: string; mode: string; sha: string };
/** An entry of `POST /git/trees`: a blob or gitlink by sha, or a deletion (`sha: null`). */
type TreeWrite = { path: string; mode: string; type: string; sha: string | null };
/** What a `POST /git/trees` call was asking for, kept for its refusal's evidence. */
type TreeTry = { diff: string; tree: TreeWrite[] };
/** How many paths one `ls-tree` lookup names: the output stays proportional to the change, never the repository's size. */
const TREE_CHUNK = 200;
/** A git run that keeps stdout as git wrote it: a tree path may start with whitespace, which a trim would eat. */
export type Raw = (args: string[]) => Promise<string>;
const NUL = (out: string) => out.split("\0").filter(Boolean);
/** The paths that differ between two trees (`git diff-tree --name-only`): a change's size, not the tree's. */
const changedPaths = async (raw: Raw, a: string, b: string) => [...new Set(NUL(await raw(["diff-tree", "-r", "-z", "--no-renames", "--name-only", a, b])))];

/**
 * The paths among `paths` that `<tree>` holds as a directory, at any depth (`git ls-tree -d`): `x` is a directory in the result
 * whether it holds `x/y` or only `x/y/z`. These are the paths a tree write must never name as a `sha:null` deletion.
 * Both lookups pass `--literal-pathspecs`: a changed path is looked up as itself. `--` ends option parsing, not pathspec
 * parsing, so without it a file named `:(draft).md` is read as pathspec magic (`fatal: Invalid pathspec magic 'draft'`) and
 * `*.md`/`a[1].txt` are read as patterns that match other paths.
 */
const dirsAt = async (raw: Raw, tree: string, paths: string[]) => {
  const dirs = new Set<string>();
  for (let i = 0; i < paths.length; i += TREE_CHUNK) {
    for (const rec of NUL(await raw(["--literal-pathspecs", "ls-tree", "-d", "-z", tree, "--", ...paths.slice(i, i + TREE_CHUNK)]))) {
      const [meta, ...rest] = rec.split("\t");
      if (String(meta).split(" ")[1] === "tree") dirs.add(rest.join("\t"));
    }
  }
  return dirs;
};
/** What `<tree>` holds at exactly each of `paths`: its mode and sha as git's own tree has them (a tree entry is skipped). */
const entriesAt = async (raw: Raw, tree: string, paths: string[]) => {
  const files = new Map<string, TreeEntry>();
  for (let i = 0; i < paths.length; i += TREE_CHUNK) {
    for (const rec of NUL(await raw(["--literal-pathspecs", "ls-tree", "-z", tree, "--", ...paths.slice(i, i + TREE_CHUNK)]))) {
      const [meta, ...rest] = rec.split("\t");
      const [mode, kind, sha] = String(meta).split(" ");
      if (kind !== "blob" && kind !== "commit") continue;
      const path = rest.join("\t");
      files.set(path, { path, mode: mode!, sha: sha! });
    }
  }
  return files;
};
/**
 * The `POST /git/trees` entries that turn `base` into `want`: the tree write that repairs a PR (and `apiCommits` makes for each
 * commit). They come from the result's own tree for every path the two differ on — git's own mode and sha at that path — never
 * from a raw diff pair. `git diff-tree --no-renames` pairs a file at the head (`D x`) with a path under it (`A x/y`), and a
 * `sha:null` entry for `x` next to `x/y` is a tree GitHub refuses whole (`422 Invalid tree info`): `x` is a directory in the
 * resulting tree. Here `x` is probed in `want` and, found to be a directory at any depth, left out — adding `x/y` over the base's
 * file replaces it. Deletions are the changed paths `want` does not hold, at the mode git's own base tree reports for them.
 */
export const treeWrites = async (raw: Raw, base: string, want: string) => {
  const paths = await changedPaths(raw, base, want);
  const present = await entriesAt(raw, want, paths);
  const dirs = await dirsAt(raw, want, paths.filter((p) => !present.has(p)));
  const gone = paths.filter((p) => !present.has(p) && !dirs.has(p));
  const before = await entriesAt(raw, base, gone);
  const tree: TreeWrite[] = [];
  for (const p of paths) {
    const e = present.get(p);
    // A path `want` holds as a directory gets no entry at all (its contents are the entries that changed); adding one under it
    // over the base's file replaces that file.
    if (e) tree.push({ path: p, mode: e.mode, type: e.mode === "160000" ? "commit" : "blob", sha: e.sha });
    else if (dirs.has(p)) continue;
    else {
      const b = before.get(p);
      if (b) tree.push({ path: p, mode: b.mode, type: b.mode === "160000" ? "commit" : "blob", sha: null });
    }
  }
  return { tree, dirs };
};
/**
 * GitHub's refusal of a `POST /git/trees`, saying what it refused: the entry first (its path and sha, so ship's hold, which keeps
 * the first 300 characters of the first line, still names it), then the diff and GitHub's own words. The entry is the one GitHub
 * points at (`errors[].index`) when it says which; otherwise the first sent, said as such.
 */
const treeRefusal = (where: string, status: number, body: { message?: unknown; errors?: unknown } | undefined, { diff, tree }: TreeTry) => {
  const errors = Array.isArray(body?.errors) ? (body!.errors as { index?: unknown; message?: unknown }[]) : [];
  const named = errors.find((e) => typeof e.index === "number" && tree[e.index as number]);
  const entry = named ? tree[named.index as number] : undefined;
  const why = errors.map((e) => String(e.message ?? "")).filter(Boolean).join("; ").slice(0, 200);
  return `GitHub refused tree entry ${JSON.stringify(entry ?? tree[0] ?? null)}${entry ? "" : " (the first sent: GitHub named none)"}`
    + ` — ${where} ${diff}: ${status} ${String(body?.message ?? "").slice(0, 200)}${why ? ` (${why})` : ""}`
    + `; carried ${tree.length} change(s): ${tree.slice(0, 20).map((e) => `${e.sha === null ? "-" : "+"}${e.path}@${e.mode}`).join(", ")}${tree.length > 20 ? ", …" : ""}`;
};
const SLUG = /^([\w.-]+)\/([\w.-]+)$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
/** The module that adopts PRs and files their writes (approve, enqueue, an adoption's merge): its name as the kernel reports it. */
const SHIP = "ship";
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

/** A PR's merge-queue state, for an enqueue and its reconcile. */
const QUEUE_READ = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id state headRefOid baseRefName authorAssociation labels(first: 100) { nodes { name } } isInMergeQueue mergeQueueEntry { headCommit { oid } } reviewDecision latestOpinionatedReviews(first: 30) { nodes { state authorCanPushToRepository author { __typename login } commit { oid } } } } } }`;

/** GitHub's enqueue, bound to the head: it refuses when the PR's head isn't `head`. */
const DEQUEUE = `mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { state } } }`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { state } } }`;

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
  /**
   * The same clone, read for tree data: git's own bytes, never trimmed (a tree path may start with whitespace).
   * `--literal-pathspecs` is on every run: a changed path is looked up as itself, never as a pathspec, so a file named
   * `:(draft).md`, `*.md` or `a[1].txt` resolves to that file (`--` ends option parsing, not pathspec parsing).
   */
  const rawGit = (dir: string, env: NodeJS.ProcessEnv = ENV): Raw => async (args) => (await run("git", [...SAFE_GIT_ARGS, "--literal-pathspecs", "--git-dir", dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout;
  /**
   * Which of `wanted` shas `<tree>` reaches: `git ls-tree -r` is read as a stream, one path a line, and only a sha in `wanted` is
   * kept. Those are the blobs GitHub holds because it holds that tree, so each is reused by its sha whatever path it sat at, and
   * one the merge brings from another path (a rename, the base's own copy) is never read here just to be uploaded again.
   * Memory is the candidates' own size — the entries of this write, bounded by the change — never the repository's, so a repo
   * of any size stays inside the runner's buffer. Called only when there is a candidate to look for.
   */
  const heldIn = async (dir: string, tree: string, wanted: Set<string>, env: NodeJS.ProcessEnv = ENV) => {
    const found = new Set<string>();
    if (!wanted.size) return found;
    const p = spawn("git", [...SAFE_GIT_ARGS, "--literal-pathspecs", "--git-dir", dir, "ls-tree", "-r", "--format=%(objectname)", tree], { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", err = "";
    p.stderr.on("data", (d) => { if (err.length < 4000) err += String(d); });
    p.stdout.on("data", (d) => {
      buf += String(d);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (wanted.has(line)) found.add(line);
    });
    const code = await new Promise<number | null>((ok) => p.on("close", (c) => ok(c)));
    if (wanted.has(buf)) found.add(buf);
    if (code !== 0) throw new Error(`git ls-tree ${tree.slice(0, 12)}: ${err.trim().slice(0, 300)}`);
    return found;
  };
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
        // As the owner (never the App): the probe is of the owner's own access, which the App's answer would hide.
        await gh("GET", `/repos/${s.slug}`, undefined, { owner: true });
        // The repo answers, so the ref is what is missing (a deleted branch): a 404 the caller can tell from a failed fetch.
        if (/couldn't find remote ref/i.test(String((e as Error)?.message))) throw fail(404, `${s.slug} has no ${name}`);
        throw e;
      });
    return { dir, ref, sha: await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]) };
  }
  /**
   * A branch's head on GitHub, fetched into the ws cache so its commits are here for the ancestry check: undefined when the branch
   * isn't there (a task's first publish, or one deleted since). Only a missing ref reads as "none"; any other failure throws.
   * The ref is keyed by a digest, not the branch name: `release` and `release/v2` are both valid branches and git cannot hold
   * `refs/remote-heads/release` beside `refs/remote-heads/release/v2`.
   */
  async function publishHead(dir: string, slug: string, branch: string): Promise<string | undefined> {
    const ref = `refs/remote-heads/${createHash("sha256").update(branch).digest("hex")}`;
    try {
      await git(dir, ["fetch", "--quiet", "--no-tags", remote(slug), `+refs/heads/${branch}:${ref}`], await token());
    } catch (e) {
      if (/couldn't find remote ref/i.test(String((e as Error)?.message ?? e))) return undefined;
      throw e;
    }
    return await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
  }
  /**
   * Whether `sha` is an ancestor of `ref` in the cache (its commits are there: publishHead and the bundle fetch both put them
   * here). `git merge-base --is-ancestor` exits 1 for "no", and any other failure (a missing object, a broken repo) is thrown
   * rather than read as "no": a check that can't run must not wave a rewind through.
   */
  async function isAncestor(dir: string, sha: string, ref: string): Promise<boolean> {
    try {
      await git(dir, ["merge-base", "--is-ancestor", sha, ref]);
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === 1) return false;
      throw e;
    }
  }

  /**
   * Who may publish to `branch`, from the open PRs on it and their recorded owner tasks (pr-tasks.json) alone:
   * - "own": every open PR on it is recorded as this task's, and this task is still open — a successor republishing the branch it
   *   adopted, or an opener whose PR nobody took over. A branch name proves nothing once ownership has moved.
   * - "handoff": every open PR on it is recorded to a task no longer open — the cancelled or done task's PR a successor finishes
   *   (ship's loop.ts keepForSuccessor), the one path that reaches another task's branch.
   * - "free": no open PR on it, the ordinary first publish.
   * - "refused": a PR on it belongs to another task still open, a PR on it is recorded to nobody, or an owner cannot be read.
   *   Never a guess: a failed read is "refused", so an unreachable kernel never hands a branch over.
   * The unit is one base: the open PRs from this head into the same base (the first one's) are what a push rewrites. A sibling
   * into another base is a different proposal, so it neither blocks this one nor is taken over with it.
   * `base` is that base ref: the change is reviewed against the base the PR actually targets, not today's default branch (a PR into
   * a release or a former default branch is still that PR).
   */
  async function ownershipOf(s: { slug: string; org: string }, branch: string, task: string): Promise<{ state: "own" | "handoff" | "free" | "refused"; base?: string }> {
    const all = await api("GET", `/repos/${s.slug}/pulls?state=open&head=${encodeURIComponent(`${s.org}:${branch}`)}`).catch(() => undefined);
    if (!Array.isArray(all)) return { state: "refused" };
    if (!all.length) return { state: "free" };
    const at = String(all[0].base?.ref ?? "");
    const open = all.filter((p: { base?: { ref?: string } }) => String(p.base?.ref ?? "") === at);
    // Every open PR into it is this task's, or none are: one a live other task owns is never force-pushed by this one.
    const owners = open.map((p: { html_url?: string }) => prTasks()[String(p.html_url ?? "").toLowerCase()]?.task ?? "").filter(Boolean) as string[];
    if (owners.length !== open.length) return { state: "refused" }; // an open PR on it that nobody here opened: not this task's to take
    const status = async (t: string) => {
      const r = await kernel("GET", `/v1/work?task=${encodeURIComponent(t)}`).catch(() => undefined);
      const v = (r as { status?: unknown } | undefined)?.status;
      return typeof v === "string" ? v : undefined;
    };
    // Every owner is this task, and it is open: its own PR. (A closed task cannot claim work back.)
    if (owners.every((t) => t === task)) return (await status(task)) ? { state: "own", base: at || undefined } : { state: "refused" };
    if (owners.some((t) => t === task)) return { state: "refused" }; // some its own, some another's: one push would rewrite both
    // Another task's PR: only a handoff, and only when every owner is closed (one still open keeps the branch its own).
    for (const t of new Set(owners)) {
      const st = await status(t);
      if (st !== "cancelled" && st !== "done") return { state: "refused" };
    }
    return { state: "handoff", base: at || undefined };
  }

  /**
   * Record `task` as the task of every open PR `branch` stands on (notePrTask): a push-only handoff's ownership write, so the PR
   * watch works the handed-over PR for its successor. Run under the branch lock with the push that precedes it.
   */
  async function adoptPrs(s: { slug: string; org: string }, branch: string, task: string, base: string) {
    const open = await api("GET", `/repos/${s.slug}/pulls?state=open&head=${encodeURIComponent(`${s.org}:${branch}`)}`);
    // Only the same-base PRs a push rewrites: a sibling into another base is not this publish's to take over.
    for (const p of Array.isArray(open) ? open : []) if (p?.html_url && String(p.base?.ref ?? base) === base) notePrTask(o.cacheDir, String(p.html_url), { task, branch });
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

  // GitHub's checks on a commit as plan.ts reads them: { name, kind, rank, ok, pending, skipped } each. The name is only matched
  // (the gate check `ci-required`, merge-gate.ts productMergeEligible), never shown: the card counts checks. `kind` and `rank`
  // let the gate keep each name's newest judgement (merge-gate.ts headChecks), so a cancelled run an edit superseded never blocks.
  // Every page is read; if GitHub reports more than could be read, one check stays pending: missing evidence never passes.
  const rankOf = (rank: number | undefined) => (rank !== undefined ? { rank } : {});
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
      ...runs.items.map((r: any) => ({ name: String(r.name ?? ""), kind: "run" as const, ...rankOf(contextRank(r)), pending: r.status !== "completed", skipped: r.conclusion === "skipped", ok: r.status === "completed" && ["success", "skipped", "neutral"].includes(r.conclusion), success: r.status === "completed" && r.conclusion === "success" })),
      ...status.items.map((x: any) => ({ name: String(x.context ?? ""), kind: "status" as const, ...rankOf(contextRank(x)), pending: x.state === "pending", skipped: false, ok: x.state === "success", success: x.state === "success" })),
    ];
  }
  // The commits this code host pushed, each as "<repo, lowercase> <sha>": a head is the runner's own only in the repo it was
  // pushed to, so the same commit opened as a PR in another repo (a maintained one, say) is never ours there.
  const pushed = join(o.cacheDir, "pushed.json");
  const pushedHeads = (): string[] => (existsSync(pushed) ? JSON.parse(readFileSync(pushed, "utf8")) : []);
  const pushedKey = (repo: string, sha: string) => `${repo.toLowerCase()} ${sha}`;
  const notePushed = (repo: string, sha: string) => writeFileSync(pushed, JSON.stringify([...pushedHeads().slice(-4999), pushedKey(repo, sha)]));
  // Which task opened each PR this code host opened (pr-tasks.ts notePrTask): the task's sibling PRs for the reviewer.
  // The merges ship filed itself (a fleet PR's plain merge), noted at plan time: the kernel's execute call carries no requester, and
  // the merge queue stops these when ship is paused, its repo is off or the task is cancelled (merges.ts). Keyed repo#n@head.
  const shipMergesFile = join(o.cacheDir, "ship-merges.json");
  const shipMerges = (): Record<string, string> => { try { return JSON.parse(readFileSync(shipMergesFile, "utf8")); } catch { return {}; } };
  const noteShipMerge = (key: string) => {
    const keep = Object.fromEntries(Object.entries(shipMerges()).filter(([, at]) => Date.now() - Date.parse(at) < 7 * 86_400_000));
    writeFileSync(`${shipMergesFile}.tmp`, JSON.stringify({ ...keep, [key]: new Date().toISOString() }));
    renameSync(`${shipMergesFile}.tmp`, shipMergesFile);
  };
  const mergeKey = (repo: string, n: number, head: string) => `${repo.toLowerCase()}#${n}@${head}`;
  const filedByShip = (rec: { args?: unknown }) => {
    const p = (rec.args as { prs?: { repo?: string; number?: number; head?: string }[]; generation?: unknown } | undefined);
    return p?.generation === undefined && (p?.prs ?? []).some((x) => Boolean(shipMerges()[mergeKey(String(x.repo), Number(x.number), String(x.head))]));
  };
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
  async function stateFor(kind: string, a: any, requester?: PlanRequest["requester"], task?: string) {
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
    // A write for an adopted PR (ship): the PR as GitHub has it now and ship's adoption, never the args.
    const filedOn = [String(task ?? ""), String(a.workspace ?? "")].filter(Boolean);
    const byShip = requester?.kind === "module" && requester.module === SHIP;
    const adoption = async (repo: string, number: number, generation: unknown, expected: unknown, pr: any, bound?: unknown): Promise<Ship> => {
      if (!Number.isInteger(generation) || typeof expected !== "string") throw fail(400, "a write for an adopted PR names its generation and the head it expects");
      const at = o.ship ? await o.ship.generation(repo, number, expected) : undefined;
      return {
        number, generation: generation as number, expected, head: pr?.head?.sha, headRepo: pr?.head?.repo ? String(pr.head.repo.full_name) : null, headRef: pr?.head?.ref, canModify: pr?.maintainer_can_modify === true,
        ...(typeof bound === "string" ? { bound, baseRef: String(pr?.base?.ref ?? "") } : {}),
        current: at ? at.generation : undefined, ...(at?.hold ? { hold: at.hold } : {}), ...(at?.task ? { task: at.task } : {}), filedOn, byShip,
      };
    };
    if (kind.endsWith(".approve") || kind.endsWith(".enqueue") || kind.endsWith(".repair") || kind.endsWith(".retarget") || kind.endsWith(".retitle")) {
      const s = slugOf(a.repo);
      const n = Number(a.number);
      // Outside our own repos a PR's text names none of our tooling: the title is public text on the PR, exactly as a `.pr`'s is.
      if (kind.endsWith(".retitle") && !ownRepo(s.slug, o.fleetOrg, o.productRepo)) {
        const leak = leakIn(a.title);
        if (leak) throw fail(422, `Not done: the PR title mentions "${leak}". ${s.slug}'s reviewers mustn't see internal names, tools or local paths; reword it and ask again.`);
      }
      const pr = await api("GET", `/repos/${s.slug}/pulls/${n}`);
      const ship = await adoption(s.slug, n, a.generation, a.head, pr, a.base);
      // An enqueue is a merge by the queue: the reviewer reads the PR's diff at its head when the head isn't the runner's own.
      let diff = "", files: string[] | undefined;
      if (kind.endsWith(".enqueue") && pr.head?.sha === a.head) {
        const head = await fetchRemote(s, String(pr.head.sha));
        const into = await fetchRemote(s, String(pr.base?.sha));
        const mb = await git(head.dir, ["merge-base", into.sha, head.sha]).catch(() => "");
        diff = await diffOf(head.dir, mb || EMPTY_TREE, head.sha);
        files = (await git(head.dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mb || EMPTY_TREE, head.sha])).split("\0").filter(Boolean);
      }
      // GitHub refuses an approval from the PR's own author: the code host's account where no reviewer App is installed.
      if (kind.endsWith(".approve")) {
        const app = await o.reviewer?.(s.slug);
        if (!app) ship.noApp = "the GitHub App isn't installed on this repo";
        else if (same(String(pr.user?.login ?? ""), app.login)) ship.noApp = "the GitHub App opened it, and GitHub won't let it approve its own PR";
      }
      const url = `https://github.com/${s.slug}/pull/${n}`;
      const at = `at \`${String(a.head).slice(0, 12)}\``;
      const what = kind.endsWith(".approve") ? (a.dismiss === true ? `Dismiss the reviewer App's approvals of ${url} (made on another commit or under another review policy), as the App` : `Approve ${url} ${at}, as the reviewer App`) : kind.endsWith(".enqueue") ? `Add ${url} to its merge queue ${at}` : kind.endsWith(".retarget") ? `Retarget ${url} ${at} from \`${a.base}\` (its merged base PR's branch) to \`${a.to}\`` : kind.endsWith(".retitle") ? `Retitle ${url} ${at} to \`${String(a.title).replace(/`/g, "")}\` (only the title: the PR's head, base and body stay as they are)` : `Merge its base into ${url} ${at} and regenerate its generated files (ship's repair), as the code host`;
      return { ...(kind.endsWith(".retitle") ? { from: String(pr.title ?? "") } : {}), state: { ...base, prs: [{ repo: s.slug, number: n, head: pr.head?.sha, base: pr.base?.sha, headMatches: pr.head?.sha === a.head, checks: kind.endsWith(".enqueue") ? await checksAt(s, String(pr.head?.sha)) : [], ship, ...(files ? { files } : {}),
        // A product enqueue takes the product merge's eligibility: ci-required green and code review's pass on this head.
        ...(kind.endsWith(".enqueue") && same(s.slug, o.productRepo) ? { verdict: await o.reviewGate(s.slug, n, String(pr.head?.sha), { base: String(pr.base?.ref ?? ""), association: String(pr.author_association ?? "") }) } : {}),
        ownHead: pushedHeads().includes(pushedKey(s.slug, String(pr.head?.sha))) }] }, facts: { target: url, sentence: `${what} (generation ${a.generation}).`, diff } };
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
      // An adopted PR's merge names one PR and its adoption (ship files it on the PR's task with a fresh attempt each time).
      if (merge && (a.generation !== undefined || a.attempt !== undefined) && (!Number.isInteger(a.generation) || !Number.isInteger(a.attempt) || (a.prs ?? []).length !== 1)) throw fail(400, "a merge for an adopted PR names one PR, its generation and its attempt");
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
        if (merge && byShip && a.generation === undefined && typeof p.head === "string") noteShipMerge(mergeKey(s.slug, Number(p.number), p.head));
        prs.push({
          repo: s.slug, number: Number(p.number), head: pr.head?.sha, base: pr.base?.sha, headMatches: !p.head || p.head === pr.head?.sha,
          files, checks: await checksAt(s, pr.head?.sha),
          // Code review's verdict for this head on the product repo: with ci-required green, a real pass skips the AI reviewer.
          ...(merge && same(s.slug, o.productRepo) ? { verdict: await o.reviewGate(s.slug, Number(p.number), String(pr.head?.sha), { base: String(pr.base?.ref ?? ""), association: String(pr.author_association ?? "") }) } : {}),
          ownHead: pushedHeads().includes(pushedKey(s.slug, String(pr.head?.sha))), dependabot: pr.user?.login === "dependabot[bot]",
          ...(merge && a.generation !== undefined ? { ship: await adoption(s.slug, Number(p.number), a.generation, p.head, pr, p.base) } : {}),
        });
      }
      const urls = prs.map((p) => `https://github.com/${p.repo}/pull/${p.number}`).join(", ");
      // The task a merge is for: the one that opened its PRs (pr-tasks.json), as the flow facts name it.
      const task = prs.map((p) => prTasks()[`https://github.com/${p.repo}/pull/${p.number}`.toLowerCase()]?.task).find(Boolean);
      return { state: { ...base, prs }, facts: { target: urls, sentence: `${merge ? "Merge" : "Close"} ${urls}${merge ? " at its approved head, once its checks are green" : ""}.`, diff: diff.trim() }, reads, changed, bases, own, task };
    }
    const branches = [];
    const heads: Record<string, string | null> = {};
    const changed: Changed[] = [];
    let diff = "";
    // A push onto an adopted PR's branch: exactly one branch, of that PR's repository, filed as a push (never a PR).
    let onto: { pr: any; s: ReturnType<typeof slugOf> } | undefined;
    if (a.pr !== undefined || a.expected !== undefined || a.generation !== undefined) {
      if (!kind.endsWith(".push") || !a.pr || (a.only ?? []).length !== 1 || !same(slugOf(a.only[0].repo).slug, slugOf(a.pr.repo).slug)) throw fail(400, "a push onto an adopted PR names that PR, its generation and the head it expects, and one branch of its repository");
      const s = slugOf(a.pr.repo);
      onto = { s, pr: await api("GET", `/repos/${s.slug}/pulls/${Number(a.pr.number)}`) };
    }
    for (const b of a.only ?? []) {
      const { s, dir } = await fromWorkspace(a.workspace, b);
      const def = await defaultBranch(s.slug);
      // Recorded ownership decides, where a branch rule applies to this task (the product repo and outside the agents org, a
      // non-platform task -- exactly the condition the executor re-reads it under): "own" is a PR already this task's (a successor
      // republishing what it adopted, or its own branch's), "handoff" a cancelled or done task's PR it finishes, "free" an ordinary
      // first publish. Elsewhere -- an agents-org branch, a platform engineer, a ship push onto an adopted PR -- the publish is the
      // one it had, and no PR is read.
      const gated = !onto && !base.requester.platform && namespaced(s.slug, { agentsOrg: o.fleetOrg, productRepo: o.productRepo });
      const { state: ownership, base: prBase } = gated ? await ownershipOf(s, b.branch, base.workspace) : { state: "own" as const, base: undefined };
      // Refused here as well as under the branch lock: the plan is what the reviewer reads, and a branch this task may not push (a
      // PR another live task owns, one nobody here opened, or ownership that could not be read) must never reach a filed card.
      if (ownership === "refused") throw fail(409, `\`${b.branch}\` isn't this task's branch: name it \`agent/${base.workspace}/<topic>\` and publish again`);
      // A PR into another base (a release branch, a former default) is reviewed against the base it targets, not today's default:
      // the same change, into the base the executor updates. A branch with no PR of this task's targets the default, as before --
      // so the base the plan binds is the one the push produces, in every case.
      const target = prBase && prBase !== def ? prBase : def;
      // The ref `fetchRemote` wrote (`refs/remote/<name>`), or "" when the base could not be fetched: the branch is then diffed against
      // the empty tree, exactly as a repo with no base is.
      const baseRef = await fetchRemote(s, target, "ws").then((r) => r.ref, () => "");
      const tip = baseRef ? await git(dir, ["rev-parse", "--verify", `${baseRef}^{commit}`]).catch(() => "") : "";
      const empty = !tip;
      const mb = empty ? "" : await git(dir, ["merge-base", b.sha, baseRef]).catch(() => "");
      // No renames: a file moved counts at both paths (one moved out of kernel/ still changes kernel/).
      const files = (await git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mb || EMPTY_TREE, b.sha])).split("\0").filter(Boolean);
      diff += `${await diffOf(dir, mb || EMPTY_TREE, b.sha)}\n`;
      changed.push(...(await numstatOf(dir, mb || EMPTY_TREE, b.sha)));
      // Outside our own repos (the agents org, the product) the PR's text and the branch's commit messages name none of our tooling.
      // The commits land where the PR's head lives: a contributor's fork is outside our repos whatever its base is.
      const receiver = onto?.pr?.head?.repo?.full_name ? String(onto.pr.head.repo.full_name) : s.slug;
      if (!ownRepo(s.slug, o.fleetOrg, o.productRepo) || !ownRepo(receiver, o.fleetOrg, o.productRepo)) {
        // The AidenHQ trailer (attribution, spec §4) is the one internal name these may carry.
        const messages = (await git(dir, ["log", "--format=%B%x1e", mb ? `${mb}..${b.sha}` : b.sha])).split("\x1e").map((m) => m.split("\n").filter((l) => !hasTrailer(l)).join("\n"));
        const leak = kind.endsWith(".pr") ? leakIn(`${a.text?.title ?? ""}\n${a.text?.body ?? ""}`) : undefined;
        if (leak) throw fail(422, `Not done: the PR title or description mentions "${leak}". ${s.slug}'s reviewers mustn't see internal names, tools or local paths; reword it and ask again.`);
        const msg = messages.find((m) => leakIn(m));
        if (msg) throw fail(422, `Not done: a commit message on ${b.branch} mentions "${leakIn(msg)}" ("${msg.trim().split("\n")[0]!.slice(0, 80)}"). ${s.slug}'s reviewers mustn't see internal names; reword the commit and ask again.`);
      }
      for (const f of files) reads.push({ name: `${s.slug} ${f}`, read: () => git(dir, ["show", `${b.sha}:${f}`]) });
      // A branch's PR targets the default branch (execute opens it there); a repo with none yet has no base to read. The base
      // the change is reviewed against is the PR's own when ownership says this publish finishes one (own, adopted or handoff): the
      // executor updates exactly that PR, so the diff the reviewer approved is the one the push produces. A push onto an adopted
      // PR (ship) reads the default branch, as before.
      bases.push({ repo: s.slug, base: empty ? "" : target, read: (path) => git(dir, ["show", `${baseRef}:${path}`]), dir, tip });
      // The commits go onto the PR's own head branch (GitHub's name for it, a fork's too); the box's branch only carries them.
      const ship = onto ? { ...(await adoption(onto.s.slug, Number(a.pr.number), a.generation, a.expected, onto.pr)), branch: String(onto.pr?.head?.ref ?? "") } : undefined;
      const handoff = ownership === "handoff";
      // A branch outside this task's namespace whose open PR is recorded to it: a PR it already took over, whatever base it targets.
      // (A branch nobody owns is "free", and still needs this task's own namespace; its own namespace needs no grant.)
      const adopted = ownership === "own" && gated && !b.branch.startsWith(`agent/${base.workspace}/`);
      // `defaultBranch` stays the repository's own default: plan.ts refuses a publish straight onto it, and a handoff must not be able to
      // switch that guard off by targeting another base. `destination` is the base the change is reviewed against: the open PR's own
      // base whenever one decides the publish (own, adopted or handoff -- the executor updates exactly that PR), the default when there
      // is none. Bound by the target, so a base switch after approval makes the record stale.
      const destination = gated && ownership !== "free" ? target : def;
      // The branch's head as the plan reads it, where the push may rewrite it: a card whose branch moves after this is stale and
      // refused at execution (ship-head-moved), rather than rewriting the newer commit with its older bundle. The default branch is
      // never rewritten (its push carries no force), so it needs no binding.
      const land = ship ? ship.branch : b.branch;
      if (land !== def) heads[`${s.slug} ${land}`] = (await publishHead(dir, s.slug, land)) ?? null;
      // An adopted PR's push is planned against where it lands (the PR's head branch), never the box's local branch name.
      branches.push({ repo: s.slug, branch: ship ? ship.branch : b.branch, sha: b.sha, base: mb || undefined, files, defaultBranch: def, destination, empty, ...(ship ? { ship } : {}), ...(handoff ? { handoff: true } : {}), ...(adopted ? { adopted: true } : {}) });
    }
    const names = branches.map((b) => `${b.repo} \`${b.branch}\``).join(", ");
    return { state: { ...base, branches }, facts: { target: names, sentence: `${kind.endsWith(".pr") ? "Push and open a PR for" : "Push"} ${names}.`, diff: diff.trim() }, reads, changed, bases, heads, own, task: String(a.workspace ?? "") };
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
      const { state, facts, reads, changed, bases, heads, own, task, from } = (await stateFor(req.kind, req.args ?? {}, req.requester, req.task)) as Awaited<ReturnType<typeof stateFor>> & { reads?: { name: string; read: () => Promise<string> }[]; changed?: Changed[]; bases?: Base[]; heads?: Record<string, string | null>; own?: Set<string>; task?: string; from?: string };
      // The head each published branch had when this plan read it rides in the record's own args: the kernel stores the plan's
      // args (never the caller's) and its digest covers them, so a card can only ever rewrite the branch from the head it was
      // filed at -- and a later plan of the same request, at a head that has moved, is its own record instead of widening this
      // one. A revalidation gets the record's stored args back, `heads` included, unchanged. The caller's args are stripped
      // first: a requester can't name a head.
      // A caller can name neither a bound head nor the title a retitle was planned against (both are the plan's own read).
      const { heads: _asked, from: _from, ...asked } = (req.args ?? {}) as { heads?: unknown; from?: unknown };
      // A retitle also binds the title it read: an author's own correction while the record waits is refused, never overwritten.
      const title = !req.revalidate && from !== undefined ? { from } : {};
      const bound = req.revalidate ? (req.args ?? {}) : { ...(!heads || !Object.keys(heads).length ? asked : { ...asked, heads }), ...title };
      const planned = planRules({ kind: req.kind, args: bound }, state, facts);
      // Who asked, by the request's exact kind and args (the revalidating plan carries the record's own args, as execute
      // does): a write held while GitHub is disconnected is re-checked as them, and its PR is signed with their name.
      // The base each branch was reviewed against is kept with the asker (the plan read it here): a write held while GitHub is
      // away compares it on reconnect, so a PR retargeted meanwhile is stale rather than pushing a diff read against another base.
      const reviewedBases = req.revalidate ? undefined : Object.fromEntries(Object.entries((planned.targets ?? {}) as Record<string, { base_branch?: string | null }>).filter(([, t]) => t && "base_branch" in t).map(([k, t]) => [k, t.base_branch ?? null]));
      if (req.requester) noteAsker(req.kind, asked, { requester: req.requester, task: req.task, ...(reviewedBases && Object.keys(reviewedBases).length ? { bases: reviewedBases } : {}) });
      // The reviewer's context goes with the filing only (a revalidation compares targets): never part of the record's digest.
      const sources = req.revalidate ? undefined : await readCardSourceExceptions(bases ?? [], (repo: string, base: string) => bases!.find((b) => b.repo === repo && b.base === base)!.read(SOURCE_EXCEPTIONS_FILE));
      // The task's other PRs already merged into these bases; a read that fails leaves them out, never the plan.
      const siblings = req.revalidate || !bases?.length ? [] : await readSiblings({ candidates: candidatesOf(prTasks(), task, own), bases, pr: async (repo: string, n: number) => api("GET", `/repos/${repo}/pulls/${n}`), git }).catch((e: Error) => (log("siblings unread", { err: String(e.message ?? e).slice(0, 200) }), []));
      const out = req.revalidate || (!reads?.length && !changed?.length && !sources && !siblings.length) ? planned : { ...planned, review: { ...(reads?.length || changed?.length ? { files: { ...(reads?.length ? await readFiles(reads) : { list: [], leftOut: [] }), ...(changed?.length ? { changed } : {}) } } : {}), ...(sources ? { sources } : {}), ...(siblings.length ? { siblings } : {}) } };
      return out;
    },
    async execute(rec) {
      // A merge is its own durable queue, which waits for the reconnect itself (merges.ts, work.waiting reason github).
      if (rec.kind.endsWith(".merge")) return merges.enqueue(rec.id, rec.args ?? {}, rec.task, rec.identifier, rec.tier, filedByShip(rec));
      // A setup is never held for a reconnect: asked again, it re-reads the branch and the reviewer reads it again.
      if (rec.kind.endsWith(".setup")) return access.connected() ? setupWrite.run(api, rec.args) : { ok: false, text: "GitHub isn't connected: ask again once it is." };
      // Nor is a share: it is bound to the tip the owner previewed, so it runs now or he previews again.
      if (rec.kind.endsWith(".publish_module")) return access.connected() ? publishModule(rec.args) : { ok: false, text: "GitHub isn't connected: preview again once it is." };
      // An approval or an enqueue is never held: its adoption and head are read again by the next round, which files a new one.
      if (/\.(approve|enqueue|repair)$/.test(rec.kind) && !access.connected()) return { ok: false, text: "GitHub isn't connected: the next round asks again once it is." };
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
  /**
   * The PR a publish is for: an open one into the default branch the plan read (the same head may also target another base, and that
   * one is not what was reviewed). Both filters are GitHub's, so paging can't hide it. Run under the branch lock with the push that
   * precedes it, so the ownership it records (notePrTask) is never seen lagging the ref it describes.
   */
  async function openOrUpdatePr(s: ReturnType<typeof slugOf>, b: { branch: string }, def: string, rec: { kind: string; args: any }, sha: string, objects: string[], done: string[], targetBase: string, byOwner = false) {
    const a = rec.args ?? {};
    const ref = (slug: string) => `github:${slug.toLowerCase()}`;
    // The PR this publish is for, whatever base it targets: an already-owned one (recorded to this task, or the cancelled task's it
    // finishes) is the one to finish. Opening a second PR into today's default branch would leave the original unowned and unworked,
    // and a PR into a release or a former default is still the PR the plan reviewed against that base.
    // Every open PR the branch stands on, read once: one of them is the PR this publish finishes (an already-owned one, whatever
    // base it targets, or the open PR into the default branch), and the ownership write below moves all of them to this task. A
    // branch with no PR of this task's reads only the default-base one, as before. GitHub's head filter, so paging can't hide one.
    const head = `/repos/${s.slug}/pulls?state=open&head=${encodeURIComponent(`${s.org}:${b.branch}`)}`;
    const got = await api("GET", byOwner ? head : `${head}&base=${encodeURIComponent(def)}`);
    const onBranch: any[] = byOwner && Array.isArray(got) ? got : [];
    const open = (Array.isArray(got) ? got : []).filter((p: { html_url?: string; base?: { ref?: string } }) =>
      (!byOwner || String(p.base?.ref ?? "") === targetBase) && (!byOwner || prTasks()[String(p.html_url ?? "").toLowerCase()]?.task));
    // The PR's text is signed by the agent that asked for it (spec §4).
    const asker = askerOf(rec.kind, rec.args);
    // A republish that names no text, or only blank text, keeps the PR as it is: a PATCH replaces the whole description,
    // so a blank body must never be sent (it would leave the footer alone). A real body still replaces it, once footered.
    const named = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
    const title = named(a.text?.title), body = named(a.text?.body);
    const text = a.text ? { ...(title ? { title } : {}), ...(body ? { body: withFooter(body, asker?.requester.name || "AidenHQ") } : {}) } : undefined;
    // A new PR still opens with the asking agent's footer alone, as before: the attribution is what it had.
    const opened = a.text ? { ...text, body: withFooter(body ?? "", asker?.requester.name || "AidenHQ") } : undefined;
    // Ownership is recorded before the PR's text is updated: the push has already landed, so a refused or failed description PATCH
    // must not leave the branch carrying the successor's commits while pr-tasks.json still names the cancelled opener (the watcher
    // would never work the new head, and another successor could take the branch over again).
    const owned0 = open[0] as { html_url?: string } | undefined;
    if (owned0?.html_url) notePrTask(o.cacheDir, String(owned0.html_url), { task: a.workspace, branch: b.branch });
    const pr = open[0]
      ? (Object.keys(text ?? {}).length ? await api("PATCH", `/repos/${s.slug}/pulls/${open[0].number}`, text) : open[0])
      // A new PR targets the base the plan reviewed against: the default, or the one an owned PR on the branch already had (a handoff
      // that lost its PR to a close between the plan and this push still lands where the reviewer read it).
      : await api("POST", `/repos/${s.slug}/pulls`, { ...opened, head: b.branch, base: byOwner ? targetBase : def });
    done.push(pr.html_url ?? `${s.slug}#${pr.number}`);
    if (pr.number && !open[0]) objects.push(`${ref(s.slug)}#${Number(pr.number)}`); // ours only when this write opened it
    // Ownership moves to this task for every open PR from this head into the *same* base, not only the one bound above: two such
    // PRs (a publish into a changed default branch opens a second) advance together with this push, so leaving one recorded to the
    // old owner would meet the next publish as mixed ownership and refuse it. A sibling into another base is a different
    // proposal whose diff was not what the reviewer read, so it stays where it is.
    for (const p of onBranch as { html_url?: string; base?: { ref?: string } }[]) if (p?.html_url && String(p.base?.ref ?? def) === targetBase) notePrTask(o.cacheDir, String(p.html_url), { task: a.workspace, branch: b.branch });
    if (!pr.number) return;
    // A hold is the stop label every automatic merge respects (merge-gate decide, ship's rounds): put on with this write, and lifted
    // by the next publish without `hold`, but only when it was this path that put it on (a person's label stays).
    const url = String(pr.html_url ?? "").toLowerCase();
    const wasHeld = Boolean(url && prTasks()[url]?.held);
    // A label a person already put on stays theirs: only a label this write added is a hold a later publish may lift.
    const theirs = !wasHeld && (open[0]?.labels ?? []).some((l: { name?: string }) => l?.name === HOLD_LABEL);
    // Ownership first, so a label call that fails still leaves the PR worked by this task (a lift of a label that never landed is a 404).
    // A lift keeps the hold recorded until the label is gone, so a failed lift is retried by the next publish.
    if (pr.html_url) notePrTask(o.cacheDir, pr.html_url, { task: a.workspace, branch: b.branch, held: (a.hold === true && !theirs) || (!a.hold && wasHeld) }); // the PR watch works the PR for the task that published it
    if (a.hold) {
      if (!theirs) await api("POST", `/repos/${s.slug}/issues/${Number(pr.number)}/labels`, { labels: [HOLD_LABEL] });
      // A PR already in GitHub's native merge queue leaves it: the label alone doesn't stop a queued merge (not queued: GitHub says so, ignored).
      if (pr.node_id) await gh("POST", "/graphql", { query: DEQUEUE, variables: { id: pr.node_id } }).catch(() => undefined);
    } else if (wasHeld) {
      const r = await gh("DELETE", `/repos/${s.slug}/issues/${Number(pr.number)}/labels/${encodeURIComponent(HOLD_LABEL)}`);
      if (r.status >= 300 && r.status !== 404) throw fail(502, `GitHub could not lift the hold on ${pr.html_url}: ${r.status} ${r.body?.message ?? ""}`.trim());
      notePrTask(o.cacheDir, pr.html_url, { task: a.workspace, branch: b.branch, held: false });
    }
    // Flow: the PR opened when this write created it, a head it moves is a push, and CI starts on every head it publishes.
    const n = Number(pr.number);
    if (!open[0]) flow.opened(s.slug, n, sha, b.branch, pr.created_at, a.workspace, undefined, { title: String(pr.title ?? text?.title ?? ""), author: String(pr.user?.login ?? (await ownerLogin()) ?? "ghost"), author_kind: "agent" });
    else if (open[0].head?.sha && open[0].head.sha !== sha) {
      // Forced: the old head is no ancestor of the new one.
      const cmp = await api("GET", `/repos/${s.slug}/compare/${open[0].head.sha}...${sha}`).catch(() => undefined);
      flow.pushed(s.slug, n, sha, String(open[0].head.sha), cmp ? !["ahead", "identical"].includes(String(cmp.status)) : false, String((await ownerLogin()) ?? "ghost"), undefined, a.workspace);
    }
    flow.checksStarted(s.slug, n, sha, undefined, a.workspace);
  }
  /** The write itself; `objects` names what it made on GitHub for the kernel's records (spec §5). */
  async function run1(rec: { id: string; kind: string; args: any; task?: string; identifier?: string; tier?: number }): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    {
      const a = rec.args ?? {};
      const objects: string[] = [];
      const ref = (slug: string) => `github:${slug.toLowerCase()}`;
      const action = rec.kind.replace(/^github\./, "");
      const done: string[] = [];
      if (action === "approve") return approve(a);
      if (action === "enqueue") return enqueue(a);
      if (action === "repair") return repairPr(a);
      if (action === "retarget") return retarget(a);
      if (action === "retitle") return retitle(a);
      if (action === "push" && a.pr) return pushOnto(a);
      if (action === "push" || action === "pr") {
        for (const b of a.only) {
          const { s, dir } = await fromWorkspace(a.workspace, b);
          // A task branch may be rewritten; the default branch only ever moves forward.
          const def = await defaultBranch(s.slug);
          // Where a branch rule applies to this task (the product repo and outside the agents org, a non-platform task), recorded
          // ownership decides, re-read under the lock where it is used: the task's own branch name proves nothing once a successor has
          // adopted it (a reopened opener must not force-push over the successor), a cancelled or done task's PR is the successor's to
          // finish, and a PR another live task owns is refused. Elsewhere -- an agents-org branch, a platform engineer -- the publish
          // is the one it had.
          const asker = askerOf(rec.kind, a);
          const platform = isPlatform(asker?.requester);
          const gatedOwnership = !platform && namespaced(s.slug, { agentsOrg: o.fleetOrg, productRepo: o.productRepo });
          // Under the branch lock the watch's close and delete take before touching a branch (branch-lock.ts, via ship-routes.ts):
          // the PR write that records this push's owner (notePrTask) lands inside the same step, so no cleanup sees a branch pushed
          // and unowned.
          await withBranch(s.slug, b.branch, async () => {
            // "free" is the ordinary first publish of this task's own branch; "own" a PR recorded to this task; "handoff" the
            // cancelled or done task's PR a successor finishes; anything else is refused before anything is pushed.
            const { state: ownership, base: prBase } = gatedOwnership ? await ownershipOf(s, b.branch, a.workspace) : { state: "own" as const, base: undefined };
            if (ownership === "refused") throw fail(409, `\`${b.branch}\` isn't this task's branch: name it \`agent/${a.workspace}/<topic>\` and publish again`);
            if (ownership === "free" && !b.branch.startsWith(`agent/${a.workspace}/`)) throw fail(409, `\`${b.branch}\` isn't this task's branch: name it \`agent/${a.workspace}/<topic>\` and publish again`);
            const handoff = ownership === "handoff";
            const base0 = prBase && prBase !== def ? prBase : def;
            // The base the plan reviewed against is part of what was approved: a PR retargeted after the kernel revalidated it (but
            // before this lock) would receive a diff nobody read against that base. Read under the lock, where the base is re-read,
            // and refused before the push, so nothing lands on a proposal nobody reviewed.
            const reviewed = asker?.bases?.[`${s.slug} ${b.branch}`];
            if (typeof reviewed === "string" && reviewed && reviewed !== base0) throw fail(409, `\`${b.branch}\` now targets \`${base0}\`, not \`${reviewed}\` as its change was reviewed: publish again so the diff is read against its base`);
            // The default branch only ever moves forward: its push carries no force and no lease, exactly as before. A task branch may
            // be rewritten, but only from the head its write was planned at, and never rewound.
            const isDef = b.branch === def;
            const head = isDef ? undefined : await publishHead(dir, s.slug, b.branch);
            // What this write was planned against: the head the plan read, bound into the record's own args (null: the branch was
            // absent then), so a card can never be widened by a later plan of the same request. A record filed before heads were
            // bound carries none, and falls back to the head read here, so its lease and ancestry check still guard it.
            const planned = (a as { heads?: Record<string, string | null> }).heads?.[`${s.slug} ${b.branch}`];
            /** The refusal: the head this write was planned at, and the one it found (undefined: the branch is gone). */
            const refused = (seen: string | null, now: string | undefined, why?: string) => fail(409, `ship-head-moved: ${s.slug} \`${b.branch}\` ${
              why ?? (seen === null ? `appeared at \`${String(now).slice(0, 12)}\` since the write read it absent`
              : now === undefined ? `was deleted since the write read \`${seen.slice(0, 12)}\``
              : `moved to \`${now.slice(0, 12)}\` since the write read \`${seen.slice(0, 12)}\``)}: nothing was pushed to it; read it again.`);
            // The branch exists now at a head other than the one this write was planned at, and doesn't already hold the commit it
            // pushes: its head is not the one the diff was read against, so nothing may land on it. Two cases are not that. A branch
            // that already holds the commit is this same write's own push (a retry after the ref moved but before the PR was opened):
            // there is nothing to push and the PR is finished. A branch that is gone (deleted since) has no head to rewind: it is
            // the ordinary missing-branch publish, leased empty so a branch created in the gap still refuses.
            if (!isDef && head !== undefined && head !== b.sha && planned !== undefined && head !== planned) throw refused(planned, head);
            // A bundle whose commit the branch already holds is the defect from the other side (#1775: the older bundle winning over
            // a newer push), so a commit that is an ancestor of the head is refused even when the lease would match.
            if (head && head !== b.sha && (await isAncestor(dir, b.sha, head))) throw refused(b.sha, head);
            // The lease, on the head just read: an absent branch is leased empty, so a branch created in the gap refuses this create
            // rather than taking its push as a fast-forward. A lease never widens what may move -- git forces a refspec it can -- so
            // the checks above are what keep a stale bundle from winding the branch back. A branch that already holds the commit
            // needs no push at all.
            if (head !== b.sha) await push(dir, isDef
              ? ["push", "--quiet", "--no-verify", remote(s.slug), `${b.sha}:refs/heads/${b.branch}`]
              : ["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${b.branch}:${head ?? ""}`, remote(s.slug), `${b.sha}:refs/heads/${b.branch}`])
              .catch(async (e: Error) => {
                if (isDef || !/stale info|fetch first|non-fast-forward/i.test(String(e?.message ?? e))) throw e;
                // Read it again to say where it went; a read that fails still refuses, in the lease's own words rather than a
                // claim the branch was deleted.
                const now = await publishHead(dir, s.slug, b.branch).catch(() => "unread" as const);
                if (now === "unread") throw refused(head ?? null, undefined, `moved while this was pushing (the lease on \`${(head ?? b.sha).slice(0, 12)}\` refused it)`);
                throw refused(head ?? null, now);
              });
            notePushed(s.slug, b.sha);
            objects.push(`${ref(s.slug)}@${b.sha}`);
            if (action === "pr") await openOrUpdatePr(s, b, def, rec, b.sha, objects, done, base0, gatedOwnership && (ownership === "own" || handoff));
            else {
              // A push-only handoff still takes the PR over: notePrTask is what the watcher reads for the PR's task, so without it a
              // successor's push would leave the PR looking cancelled and unworked. Any open PR on the branch moves to this task.
              if (handoff) await adoptPrs(s, b.branch, a.workspace, base0);
              done.push(`${s.slug} ${b.branch} at ${b.sha.slice(0, 12)}`);
            }
          });
        }
        return { ok: true, text: `${action === "pr" ? "PRs" : "Pushed"}: ${done.join(", ")}`, objects };
      }
      // An approved merge is a queue (merges.ts): its outcome comes when every PR merged at its bound head, or the queue stopped.
      if (action === "merge") return merges.enqueue(rec.id, a, rec.task, rec.identifier, rec.tier, filedByShip(rec));
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
   * The adoption, read once more right before an effect runs (one call to ship): a hand-back, a stop, a pause (hold) or a newer
   * generation since the filing refuses it, as the direct merge does before its PUT. Undefined while it holds.
   */
  /**
   * A stacked adopted PR onto the default branch once the PR it stood on merged (ship's `retarget`): only from the base it was
   * filed against, only onto the repo's default branch, at the bound head and generation. Already there is done.
   */
  async function retarget(a: any): Promise<{ ok: boolean; text: string }> {
    const s = slugOf(a.repo);
    const n = Number(a.number);
    const url = `https://github.com/${s.slug}/pull/${n}`;
    const pr = await api("GET", `/repos/${s.slug}/pulls/${n}`);
    if (pr.base?.ref === a.to) return { ok: true, text: `${url} targets \`${a.to}\`.` };
    if (pr.state !== "open") return { ok: false, text: `${url} is ${pr.state}: not retargeted.` };
    if (pr.base?.ref !== a.base) return { ok: false, text: `ship-scope: ${url} now targets \`${pr.base?.ref}\`, not \`${a.base}\`: not retargeted.` };
    if (pr.head?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.head?.sha).slice(0, 12)}\`, not \`${String(a.head).slice(0, 12)}\`: not retargeted.` };
    if (a.to !== await defaultBranch(s.slug)) return { ok: false, text: `ship-scope: \`${a.to}\` isn't ${s.slug}'s default branch: not retargeted.` };
    const ended = await adoptionEnded(s.slug, n, a.generation, String(a.head));
    if (ended) return { ok: false, text: ended };
    const r = await gh("PATCH", `/repos/${s.slug}/pulls/${n}`, { base: a.to });
    return r.status < 300 ? { ok: true, text: `${url} now targets \`${a.to}\`.` } : { ok: false, text: `GitHub refused the retarget of ${url}: HTTP ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
  }
  /**
   * An adopted PR's title, replaced with a Conventional Commit one (ship's `retitle`): the `policy` job's title check is red and no
   * commit can make it pass. Only the title is written (never the body, base or state), only at the bound head and generation, and
   * only while the PR is open and still says what the record read. Already that title is done.
   */
  async function retitle(a: any): Promise<{ ok: boolean; text: string }> {
    const s = slugOf(a.repo);
    const n = Number(a.number);
    const url = `https://github.com/${s.slug}/pull/${n}`;
    const pr = await api("GET", `/repos/${s.slug}/pulls/${n}`);
    if (pr.state !== "open") return { ok: false, text: `${url} is ${pr.state}: not retitled.` };
    if (pr.head?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.head?.sha).slice(0, 12)}\`, not \`${String(a.head).slice(0, 12)}\`: not retitled.` };
    const ended = await adoptionEnded(s.slug, n, a.generation, String(a.head));
    if (ended) return { ok: false, text: ended };
    // Already the title this write asks for: it landed (a replay after a lost answer), so there is nothing to send.
    if (pr.title === a.title) return { ok: true, text: `${url} is titled \`${a.title}\`.` };
    // The title the plan read: an author's own correction while the record waited is theirs, not overwritten.
    if (pr.title !== a.from) return { ok: false, text: `ship-scope: ${url}'s title changed since the write was filed (it now reads ${JSON.stringify(String(pr.title).slice(0, 80))}): read it again.` };
    const r = await gh("PATCH", `/repos/${s.slug}/pulls/${n}`, { title: a.title });
    return r.status < 300 ? { ok: true, text: `${url} is now titled \`${a.title}\`.` } : { ok: false, text: `GitHub refused the retitle of ${url}: HTTP ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
  }
  /**
   * Why this write may not go on, or undefined. `push`: this is the push onto the PR's branch, the one write a `stalled` hold admits
   * (ship clears such a hold on a new head, so the push is what resumes the adoption). Approve, enqueue, a repair and a retarget keep
   * `push` false: any hold refuses them, and a hand-back, a stop or a pause refuses the push too. Whether a hold admits the write is
   * the plan's own rule (`holdAdmits`), with the adoption's task as ship reports it, so the two never disagree.
   */
  async function adoptionEnded(repo: string, n: number, generation: number, head: string, check?: ShipCheck, push = false): Promise<string | undefined> {
    const at = o.ship ? await o.ship.generation(repo, n, head, check).catch(() => undefined) : undefined;
    if (at?.generation === generation && at.refused) return `${at.retry ? "ship-tier-pending" : "ship-tier"}: https://github.com/${repo}/pull/${n}: ${at.refused}: nothing was done.`;
    if (at?.generation !== generation) return `ship-generation: https://github.com/${repo}/pull/${n} is no longer adopted at generation ${generation} (handed back, stopped, paused or handed over again): nothing was done.`;
    // A member's comment since the record was filed: the same read the round's decision makes, once, right before the write.
    if (check && at.comments && (await merges.openComments(repo, n, at.comments)).length) return `ship-tier-pending: https://github.com/${repo}/pull/${n}: members have open review comments: nothing was done.`;
    if (at.hold && !holdAdmits(at.hold, { push, task: push ? at.task : undefined })) return `ship-generation: https://github.com/${repo}/pull/${n} is on hold by ship (${at.hold.kind}${at.hold.kind === "stalled" ? ": only the push that resumes it may land" : ""})${at.hold.reason ? `: ${at.hold.reason}` : ""}: nothing was done.`;
    return undefined;
  }

  /** The code host's own sign-in (the fleet's one write identity), for the content writes ship makes: never the reviewer App. */
  const writer = async () => ({ login: String((await ownerLogin()) ?? "ghost"), rest: gh, token: async () => token() });
  /**
   * A push onto an adopted PR's branch (ship), written through GitHub's API as the code host's sign-in (the identity every
   * ordinary task push uses): the PR is read again here (a Tier 0 push runs right after its plan, with no revalidation), each
   * commit from `expected` to the branch's commit is created as blobs, a tree and a commit, and the ref is moved by a
   * fast-forward update from `expected` (force: false). A contributor's push in between makes that update fail
   * (ship-head-moved), never overwritten. The commit is not noted as the runner's own head: the branch holds the contributor's
   * commits, so its merge stays the AI reviewer's (foreign-head tiering).
   */
  async function pushOnto(a: any): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    const b = a.only[0];
    const { s, dir } = await fromWorkspace(a.workspace, b);
    const pr = await api("GET", `/repos/${s.slug}/pulls/${Number(a.pr.number)}`);
    const url = `https://github.com/${s.slug}/pull/${Number(a.pr.number)}`;
    // The branch lives where the PR's head does: the base repo, or a fork whose author lets maintainers push to it.
    const fork = pr.head?.repo && !same(String(pr.head.repo.full_name), s.slug);
    if (!pr.head?.repo || (fork && pr.maintainer_can_modify !== true)) return { ok: false, text: `ship-fork: ${url}'s head is in a fork that doesn't allow maintainers to push: nothing was pushed.` };
    const into = slugOf(pr.head.repo.full_name).slug;
    if (pr.state !== "open") return { ok: false, text: `ship-scope: ${url} is ${pr.state}: nothing was pushed.` };
    const ended = await adoptionEnded(s.slug, Number(a.pr.number), a.generation, String(a.expected), undefined, true);
    if (ended) return { ok: false, text: ended };
    if (pr.head.sha !== a.expected) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.head.sha).slice(0, 12)}\`, not \`${String(a.expected).slice(0, 12)}\`: nothing was pushed; read it again.` };
    const who = await writer();
    // A fork's branch: the code host's sign-in pushes the commits as they are, leased on the head the write expects.
    if (fork) {
      // The lease guards a race; the fix itself must build on the head, never rewrite the contributor's history.
      if (!(await git(dir, ["merge-base", "--is-ancestor", String(a.expected), String(b.sha)]).then(() => true, () => false))) return { ok: false, text: `ship-scope: \`${String(b.sha).slice(0, 12)}\` doesn't build on ${url}'s head \`${String(a.expected).slice(0, 12)}\`: nothing was pushed.` };
      const late = await adoptionEnded(s.slug, Number(a.pr.number), a.generation, String(a.expected), undefined, true);
      if (late) return { ok: false, text: late };
      const pushed = await forkPush(dir, into, String(pr.head.ref), String(a.expected), String(b.sha), who, url);
      if (pushed) return pushed;
      flow.pushed(s.slug, Number(a.pr.number), b.sha, String(a.expected), false, who.login, undefined, a.workspace);
      flow.checksStarted(s.slug, Number(a.pr.number), b.sha, undefined, a.workspace);
      return { ok: true, text: `Pushed ${url} \`${pr.head.ref}\` (${into}) from \`${String(a.expected).slice(0, 12)}\` to \`${String(b.sha).slice(0, 12)}\` as ${who.login}.`, objects: [`github:${into.toLowerCase()}@${b.sha}`] };
    }
    // The code host's sign-in writes the commits: the same identity as every ordinary task push.
    const made = await apiCommits(who.rest, into, dir, String(a.expected), String(b.sha));
    if ("refused" in made) return { ok: false, text: `${made.refused.startsWith("ship-") ? "" : "GitHub refused the commit: "}${made.refused} (${url}): nothing was pushed.` };
    // The adoption once more, right before the branch moves: a pause or a hand-back during the upload refuses it.
    const late = await adoptionEnded(s.slug, Number(a.pr.number), a.generation, String(a.expected), undefined, true);
    if (late) return { ok: false, text: late };
    // The PR once more, as the repair reads it: a close or a retarget during the upload refuses it rather than move its branch.
    const again = await api("GET", `/repos/${s.slug}/pulls/${Number(a.pr.number)}`);
    if (again.state !== "open") return { ok: false, text: `ship-scope: ${url} is ${again.state}: nothing was pushed.` };
    if (again.base?.ref !== pr.base?.ref) return { ok: false, text: `ship-scope: ${url} was retargeted during the push (it now targets \`${String(again.base?.ref)}\`, not \`${String(pr.base?.ref)}\`): nothing was pushed.` };
    if (again.head?.sha !== a.expected) return { ok: false, text: `ship-head-moved: ${url} moved while writing: nothing was pushed; read it again.` };
    // The PR's own head branch, as GitHub names it: the box's branch is only where the commits came from.
    const r = await who.rest("PATCH", `/repos/${into}/git/refs/heads/${String(pr.head.ref).split("/").map(encodeURIComponent).join("/")}`, { sha: made.sha, force: false });
    // A 422 or 409 is a moved head or a refusal of GitHub's own (a rule, a validation): the branch read back tells them apart,
    // as the repair's does, so a rule refusal keeps GitHub's reason instead of reading as head movement.
    if (r.status === 422 || r.status === 409) {
      const now = await who.rest("GET", `/repos/${into}/git/ref/heads/${String(pr.head.ref).split("/").map(encodeURIComponent).join("/")}`);
      if (now.status < 300 && now.body?.object?.sha === a.expected) return { ok: false, text: `GitHub refused the update of ${url}'s branch: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
      return { ok: false, text: `ship-head-moved: ${url} moved while writing (the update from \`${String(a.expected).slice(0, 12)}\` isn't a fast-forward any more): nothing was pushed; read it again.` };
    }
    if (r.status >= 300) return { ok: false, text: `GitHub refused the update of ${url}'s branch: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
    flow.pushed(s.slug, Number(a.pr.number), made.sha, String(a.expected), false, who.login, undefined, a.workspace);
    flow.checksStarted(s.slug, Number(a.pr.number), made.sha, undefined, a.workspace);
    return { ok: true, text: `Wrote ${url} \`${pr.head.ref}\` from \`${String(a.expected).slice(0, 12)}\` to \`${made.sha.slice(0, 12)}\` as ${who.login}.`, objects: [`github:${into.toLowerCase()}@${made.sha}`] };
  }

  /**
   * Ship's repair of an adopted PR (a `repair` record ship filed). Its `ship-repair` check job (ship's recipe, no model, no
   * credential) merges the base into the head in a box and runs the repo's generators, which on a fork are the contributor's own
   * code: what it keeps is untrusted. So the merge is made here, in the cache (`git merge-tree`), and the box's files are taken
   * only on generated paths (the plan's globs) and known lockfiles, as regular files or symlinks, never under `.github/` unless
   * they are the base's own; every conflict must be on such a path. The result is one merge commit (parents: the head and the
   * base's tip): through the API as the code host's sign-in on the base repo, or a leased git push as that same sign-in to a fork
   * whose author allows maintainer edits (unsigned: a rule requiring signed commits refuses it, loudly). Leftover conflicts and a
   * failed generator come back as the outcome, `leftover: <path>` lines and `ship-generator:`, for ship's next round.
   */
  async function repairPr(a: any): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    const s = slugOf(a.repo);
    const n = Number(a.number);
    const url = `https://github.com/${s.slug}/pull/${n}`;
    const read = async () => api("GET", `/repos/${s.slug}/pulls/${n}`);
    let pr = await read();
    if (pr.state !== "open") return { ok: false, text: `ship-scope: ${url} is ${pr.state}: nothing was changed.` };
    if (pr.base?.ref !== a.base) return { ok: false, text: `ship-scope: ${url}'s base changed to \`${String(pr.base?.ref)}\`: nothing was changed.` };
    if (pr.head?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.head?.sha ?? "").slice(0, 12)}\`, not \`${String(a.head).slice(0, 12)}\`: nothing was changed.` };
    const fork = !pr.head?.repo || !same(String(pr.head.repo.full_name), s.slug);
    if (fork && (!pr.head?.repo || pr.maintainer_can_modify !== true)) return { ok: false, text: `ship-fork: ${url}'s head is in a fork that doesn't allow maintainer edits: nothing was changed.` };
    const into = slugOf(pr.head.repo.full_name).slug;
    // The code host's sign-in writes the repair (the identity every ordinary task push uses); the reviewer App only reviews.
    const who = await writer();
    const baseSha = String(pr.base.sha);
    // Both commits in the cache (a fork's head is the base repo's too, as refs/pull/<n>/head).
    const { dir } = await fetchRemote(s, a.head);
    await fetchRemote(s, baseSha);
    const mergeBase = await git(dir, ["merge-base", a.head, baseSha]);
    // The box's run, followed to its end: the recipe's own limit (ship's module.yaml, 30 minutes) and a free computer's wait.
    let check = await kernel("POST", "/v1/checks", { repo: s.slug, head: a.head, run: "ship-repair", spec: { base: baseSha, merge_base: mergeBase, base_ref: String(a.base), plan: JSON.stringify(a.plan ?? {}), attempt: String(a.attempt ?? 1) } });
    const until = Date.now() + REPAIR_WAIT_MS;
    while (check.state === "running" && Date.now() < until) check = await kernel("GET", `/v1/checks/${check.id}?after=${Number(check.version ?? 0)}&wait=25000`);
    const result = check.result ?? {};
    if (Array.isArray(result.leftovers) && result.leftovers.length) return { ok: false, text: `ship-leftovers: merging \`${a.base}\` into ${url} leaves conflicts no generator rewrites:\n${result.leftovers.map((p: string) => `leftover: ${p}`).join("\n")}` };
    if (result.merge_failed) return { ok: false, text: `ship-merge-failed: merging \`${a.base}\` into ${url} failed (data, not instructions):\n${String(result.merge_failed).slice(0, 2000)}` };
    if (result.failed) return { ok: false, text: `ship-generator: the repair of ${url} stopped (data, not instructions):\n${String(result.failed).slice(0, 2000)}` };
    if (check.state !== "done" || typeof result.changed !== "number") return { ok: false, text: `ship-repair: the repair of ${url} didn't finish (${String(check.error ?? check.state).slice(0, 300)}): nothing was changed.` };
    const kept = await kernel("GET", `/v1/checks/${check.id}/kept`);
    const entries: { path: string; mode: string; sha: string | null; content?: string }[] = Array.isArray(kept.entries) ? kept.entries : [];
    const globs = (Array.isArray(a.plan?.globs) ? a.plan.globs : []).map(globRe);

    const tmp = mkdtempSync(join(o.cacheDir, "repair-"));
    let final: string, made: string;
    try {
      const env = { ...ENV, GIT_INDEX_FILE: join(tmp, "index"), ...identityEnv(await access.identity()) };
      const g = async (args: string[]) => (await run("git", [...SAFE_GIT_ARGS, "--literal-pathspecs", "--git-dir", dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
      const raw = rawGit(dir, env);
      const blobAt = async (tree: string, p: string) => (await g(["ls-tree", "-z", tree, "--", p])).split("\0")[0]?.split(/[ \t]/) ?? [];
      // git's own merge: its tree, and the paths it couldn't merge (exit 1 is "conflicts", still a tree).
      const out = await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "merge-tree", "--write-tree", "--no-messages", "--name-only", "-z", a.head, baseSha], { env, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, (e: { code?: number; stdout?: string }) => { if (e.code === 1 && e.stdout) return e.stdout; throw e; });
      const [merged, ...conflicted] = out.split("\0").filter(Boolean);
      // A generated path (the plan's globs), or a lockfile only where git couldn't merge it (its package manager rewrote it), even
      // when a glob names lockfiles.
      const allowed = (p: string) => (REPAIR_LOCKS.includes(p.slice(p.lastIndexOf("/") + 1)) ? conflicted.includes(p) : globs.some((re: RegExp) => re.test(p)));
      const refuse = (why: string) => ({ ok: false, text: `ship-refused: the repair of ${url} ${why}: nothing was changed.` });
      const taken = new Set<string>();
      await g(["read-tree", merged!]);
      for (const e of entries) {
        // A plain repo path: no control characters, no absolute or `..` path (git's index takes it as it is).
        if (typeof e.path !== "string" || !e.path || /[\x00-\x1f\x7f]/.test(e.path) || e.path.startsWith("/") || e.path.split("/").some((x) => !x || x === "." || x === "..")) return refuse("kept a path that isn't a plain repo path");
        if (e.sha !== null && !["100644", "100755", "120000"].includes(e.mode)) return refuse(`kept \`${e.path}\` as mode ${e.mode} (only files and symlinks)`);
        const [mode, , sha] = await blobAt(merged!, e.path);
        // As git's merge has it: nothing to write, but on a generated path or a lockfile it is the repair's decision (a conflict
        // it resolved to that same side).
        if (e.sha === (sha ?? null) && (e.sha === null || e.mode === mode)) { if (allowed(e.path)) taken.add(e.path); continue; }
        if (!allowed(e.path)) return refuse(`changed \`${e.path}\`, which is neither a generated path nor a conflicted lockfile`);
        // A symlink only where git's merge already has one: a new link could point outside the repo.
        if (e.mode === "120000" && mode !== "120000") return refuse(`kept \`${e.path}\` as a symlink where the merge has none`);
        if (e.path.startsWith(".github/") && e.sha !== ((await blobAt(baseSha, e.path))[2] ?? null)) return refuse(`changed \`${e.path}\` under .github/`);
        if (e.sha === null) { execFileSync("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "update-index", "-z", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${e.path}\0` }); taken.add(e.path); continue; }
        if (e.content !== undefined) {
          const f = join(tmp, "blob");
          writeFileSync(f, Buffer.from(String(e.content), "base64"));
          if ((await g(["hash-object", "-w", "--", f])) !== e.sha) return refuse(`kept \`${e.path}\` whose content isn't ${e.sha.slice(0, 12)}`);
        } else if ((await g(["cat-file", "-t", e.sha]).catch(() => "")) !== "blob") return refuse(`named \`${e.path}\` by a blob neither side has`);
        await g(["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`]);
        taken.add(e.path);
      }
      const left = conflicted.filter((p) => !taken.has(p));
      if (left.length) return refuse(`left conflicts on paths it may not write (${left.length})`);
      final = await g(["write-tree"]);
      made = await g(["commit-tree", final, "-p", a.head, "-p", baseSha, "-m", String(kept.message ?? `Merge branch '${a.base}'`).slice(0, 2000)]);
      if (!fork) {
        // Through the API as the code host's sign-in: the files that differ from the head; a blob the head's or the base's tree
        // already reaches is named by its sha, any other (git's clean merge of both sides, a regenerated file) is uploaded.
        const post = async (path: string, body: unknown) => {
          const r = await who.rest("POST", `/repos/${into}/git/${path}`, body);
          if (r.status >= 300) throw Object.assign(new Error(`GitHub refused the ${path.replace(/s$/, "")} on ${into}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`), { refused: true });
          return r.body;
        };
        // The entries come from the merge tree itself, never the raw diff pair: a path that is a file at the head and a directory
        // in the merge (`x` -> `x/y`) is one added path, and sending the diff's `D x` as a `sha:null` deletion next to `x/y` is
        // what GitHub refuses (422 Invalid tree info: `x` is a directory in the resulting tree).
        const baseTree = await g(["rev-parse", `${a.head}^{tree}`]);
        const { tree } = await treeWrites(raw, a.head, final);
        const diff = `${String(a.head).slice(0, 12)}..${final.slice(0, 12)}`;
        // An empty entry list is a head the merge leaves as it is (a base already merged, or a conflict the kept set resolves to
        // the head's own side): there is nothing to record, so it is a clean "nothing was changed", never an empty tree (GitHub
        // refuses one with 422 Invalid tree info).
        if (!tree.length) return refuse("changed nothing: the merge and the kept files leave every path at the head's");
        try {
          // GitHub holds every blob its head's and its base's trees reach, so only a blob neither has is read and uploaded: one
          // the merge brings from another path (a rename, the base's own copy) is reused by its sha, whatever path it sat at.
          const candidates = new Set(tree.filter((e) => e.sha !== null && e.type !== "commit").map((e) => e.sha!));
          const held = new Set([...(await heldIn(dir, a.head, candidates, env)), ...(await heldIn(dir, baseSha, candidates, env))]);
          for (const e of tree) {
            if (e.sha === null || e.type === "commit" || held.has(e.sha)) continue;
            const content = (await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "cat-file", "blob", e.sha], { env: ENV, encoding: "buffer", maxBuffer: MAX_TOTAL })).stdout as Buffer;
            await post("blobs", { content: content.toString("base64"), encoding: "base64" });
          }
          const r = await who.rest("POST", `/repos/${into}/git/trees`, { base_tree: baseTree, tree });
          if (r.status >= 300) throw Object.assign(new Error(treeRefusal(into, r.status, r.body, { diff, tree })), { refused: true });
          const t = r.body;
          if (t.sha !== final) return refuse(`built a tree on GitHub (${String(t.sha).slice(0, 12)}) that isn't the merge's (${final.slice(0, 12)})`);
          made = String((await post("commits", { message: String(kept.message ?? `Merge branch '${a.base}'`).slice(0, 2000), tree: final, parents: [a.head, baseSha] })).sha);
        } catch (e) {
          if ((e as { refused?: boolean }).refused) return { ok: false, text: `ship-refused: ${(e as Error).message} (${url}): nothing was changed.` };
          throw e;
        }
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    // The adoption and the PR once more, right before the branch moves: a pause, a hand-back or a push during the run refuses it.
    const ended = await adoptionEnded(s.slug, n, a.generation, String(a.head));
    if (ended) return { ok: false, text: ended };
    pr = await read();
    if (pr.head?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} moved during the repair: nothing was changed.` };
    if (pr.state !== "open" || pr.base?.ref !== a.base || !pr.head?.repo || !same(String(pr.head.repo.full_name), into) || (fork && pr.maintainer_can_modify !== true)) return { ok: false, text: `ship-scope: ${url} was closed, retargeted or stopped allowing maintainer edits during the repair: nothing was changed.` };
    if (fork) {
      const refused = await forkPush(dir, into, String(pr.head.ref), String(a.head), made, who, url);
      if (refused) return refused;
    } else {
      const r = await who.rest("PATCH", `/repos/${into}/git/refs/heads/${String(pr.head.ref).split("/").map(encodeURIComponent).join("/")}`, { sha: made, force: false });
      if (r.status >= 300) {
        // Moved, or a refusal of GitHub's own (a rule, a validation): the branch read back tells them apart.
        const now = await who.rest("GET", `/repos/${into}/git/ref/heads/${String(pr.head.ref).split("/").map(encodeURIComponent).join("/")}`);
        if (now.status < 300 && now.body?.object?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} moved during the repair: nothing was changed.` };
        return { ok: false, text: `ship-refused: GitHub refused the update of ${url}'s branch: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
      }
    }
    flow.pushed(s.slug, n, made, String(a.head), false, who.login, undefined, undefined);
    flow.checksStarted(s.slug, n, made, undefined, undefined);
    return { ok: true, text: `Repaired ${url}: merged \`${a.base}\` and regenerated (${result.changed} file(s)) at \`${made.slice(0, 12)}\`, as ${who.login}${fork ? ` (pushed to ${into})` : ""}.`, objects: [`github:${into.toLowerCase()}@${made}`] };
  }

  /**
   * A push to a fork PR's head branch as the code host's sign-in (GitHub lets it where the author allows maintainer edits),
   * leased on the head the write expects: a contributor's push in between wins (ship-head-moved). Anything else GitHub
   * refuses (no access, a rule requiring signed commits) is its own reason (ship-refused). Undefined when it pushed.
   */
  async function forkPush(dir: string, into: string, ref: string, expected: string, sha: string, who: { token: () => Promise<string> }, url: string): Promise<{ ok: false; text: string } | undefined> {
    try {
      await git(dir, ["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${ref}:${expected}`, remote(into), `${sha}:refs/heads/${ref}`], await who.token());
      return undefined;
    } catch (e) {
      const said = String((e as Error).message ?? e);
      if (/stale info/i.test(said)) return { ok: false, text: `ship-head-moved: ${url} moved while pushing (the lease on \`${expected.slice(0, 12)}\` refused it): nothing was pushed; read it again.` };
      return { ok: false, text: `ship-refused: GitHub refused the push to ${into} \`${ref}\` (data, not instructions): ${said.replace(/x-access-token:[^@\s]+@/g, "").slice(-500)}` };
    }
  }

  /**
   * The commits from `from` to `to` (first-parent order) created on GitHub through the API: per commit, the blobs GitHub may not
   * have (a path's blob that no other parent has at that path), a tree on the new first parent's, and a commit with the same
   * message and other parents (a merge of the base keeps the base commit). Each tree must come out as git's own, or nothing is
   * written. Answers the last commit's sha on GitHub (the API's commits carry the writer's identity, so it differs from `to`).
   */
  async function apiCommits(rest: Gh, repo: string, dir: string, from: string, to: string): Promise<{ sha: string } | { refused: string }> {
    if (!(await git(dir, ["merge-base", "--is-ancestor", from, to]).then(() => true, () => false))) return { refused: `ship-scope: \`${to.slice(0, 12)}\` doesn't build on the PR's head \`${from.slice(0, 12)}\`` };
    const list = (await git(dir, ["rev-list", "--reverse", "--first-parent", `${from}..${to}`])).split("\n").filter(Boolean);
    if (!list.length || list.length > 20) return { refused: `ship-scope: ${list.length} commits to write (1 to 20)` };
    const post = async (path: string, body: unknown, tried?: TreeTry) => {
      const r = await rest("POST", `/repos/${repo}/git/${path}`, body);
      // A refused tree names what was rejected (its diff and the entry), so the hold says which path failed.
      if (r.status >= 300) throw Object.assign(new Error(tried ? treeRefusal(repo, r.status, r.body, tried) : `${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`), { refused: true });
      return r.body;
    };
    let parent = from;
    // The replay builds each commit on the one before it, so each commit's first parent must be that one (the head for the
    // first): a merge made the other way round (the PR branch merged into a base checkout) has the base tip as its first parent,
    // and replaying it would drop the head's content and leave the PR behind its base. Its parents can't be kept here.
    let expected = from;
    try {
      for (const c of list) {
        const [, first, ...others] = (await git(dir, ["rev-list", "--parents", "-n", "1", c])).split(" ");
        if (first !== expected) return { refused: `ship-scope: \`${c.slice(0, 12)}\` builds on \`${String(first).slice(0, 12)}\`, not the head's own chain \`${expected.slice(0, 12)}\`: not replayed` };
        expected = c;
        // The entries come from the commit's own tree (`ls-tree`), never a diff pair: a path that is a file in the first parent and
        // a directory here (`x` -> `x/y`) is one added path, and the diff's `D x` sent as a `sha:null` deletion next to `x/y` is
        // what GitHub refuses (422 Invalid tree info).
        const baseTree = await git(dir, ["rev-parse", `${first}^{tree}`]);
        const wantSha = await git(dir, ["rev-parse", `${c}^{tree}`]);
        // The changed paths, then git's own entry at each (and each deletion's mode): proportional to the change, not the tree.
        const { tree } = await treeWrites(rawGit(dir), first!, c);
        // GitHub holds every blob its parents' trees reach, so only a blob none of them has is read and uploaded: one a parent has
        // at another path (a rename from the base's own copy) is reused by its sha, never read just to be sent again. Each parent
        // is scanned only for the blobs still in question, and not at all when the commit adds none.
        const held = new Set<string>();
        const candidates = new Set(tree.filter((e) => e.sha !== null && e.type !== "commit").map((e) => e.sha!));
        for (const p of [first!, ...others]) for (const sha of await heldIn(dir, p!, candidates)) held.add(sha);
        const diff = `${String(first).slice(0, 12)}..${String(c).slice(0, 12)}`;
        let uploads = 0;
        for (const e of tree) {
          if (e.sha === null || e.type === "commit" || held.has(e.sha)) continue;
          if (++uploads > MAX_FILES) return { refused: `ship-scope: more than ${MAX_FILES} new files in one commit` };
          const content = (await run("git", [...SAFE_GIT_ARGS, "--git-dir", dir, "cat-file", "blob", e.sha], { env: ENV, encoding: "buffer", maxBuffer: MAX_TOTAL })).stdout as Buffer;
          const blob = await post("blobs", { content: content.toString("base64"), encoding: "base64" });
          if (blob.sha !== e.sha) return { refused: `GitHub stored ${e.path} as ${String(blob.sha).slice(0, 12)}, not ${e.sha.slice(0, 12)}` };
        }
        // An empty changed set is a commit whose tree is its first parent's (an "ours" merge): the commit carries that tree as it
        // is, with no tree written (GitHub refuses an empty tree array).
        if (tree.length) {
          const t = await post("trees", { base_tree: baseTree, tree }, { diff, tree });
          if (t.sha !== wantSha) return { refused: `the tree GitHub built (${String(t.sha).slice(0, 12)}) isn't the repair's (${wantSha.slice(0, 12)})` };
        }
        const message = await git(dir, ["log", "-1", "--format=%B", c]);
        const made = await post("commits", { message, tree: wantSha, parents: [parent, ...others] });
        parent = String(made.sha);
      }
    } catch (e) {
      if ((e as { refused?: boolean }).refused) return { refused: String((e as Error).message) };
      throw e;
    }
    return { sha: parent };
  }

  /**
   * The reviewer App's approval of an adopted PR at exactly its head (`commit_id`), never the owner's account (that would count
   * as a person's, a code owner's included): no App on the repo, or the App's own PR, is "approval needs a human". The head is read
   * once before posting; GitHub binds the review to `commit_id`, so an approval that raced a push stands on the old head only.
   */
  async function approve(a: any): Promise<{ ok: boolean; text: string }> {
    const s = slugOf(a.repo);
    const n = Number(a.number);
    const url = `https://github.com/${s.slug}/pull/${n}`;
    const pr = await api("GET", `/repos/${s.slug}/pulls/${n}`);
    if (pr.head?.sha !== a.head) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.head?.sha ?? "").slice(0, 12)}\`, not \`${String(a.head).slice(0, 12)}\`: not approved.` };
    // A dismissal asks ship nothing but the adoption; an approval also asks its final tier check (the tier's approve is `on` and code
    // review passed this head), with the live base and author.
    const ended = await adoptionEnded(s.slug, n, a.generation, String(a.head), a.dismiss === true ? undefined : { do: "approve", head: a.head, base: String(pr.base?.ref ?? ""), association: String(pr.author_association ?? ""), ...(typeof a.policy === "string" ? { policy: a.policy } : {}) });
    if (ended) return { ok: false, text: ended };
    const app = await o.reviewer?.(s.slug);
    if (!app) return { ok: false, text: `ship-no-app: ${url}: approval needs a human (the GitHub App isn't installed on this repo).` };
    if (same(String(pr.user?.login ?? ""), app.login)) return { ok: false, text: `ship-no-app: ${url}: approval needs a human (the GitHub App opened it).` };
    // An App approval made on another commit or under another review policy is dismissed (ship files it before anything it must
    // not count for): every approval of this PR the App made, whatever its head.
    if (a.dismiss === true) {
      // Every page: GitHub lists a PR's reviews oldest first, so a recent approval may be on a later one.
      const mine: any[] = [];
      for (let page = 1; ; page++) {
        const list = await app.rest("GET", `/repos/${s.slug}/pulls/${n}/reviews?per_page=100&page=${page}`);
        if (list.status >= 300) return { ok: false, text: `GitHub refused to list ${url}'s reviews: ${list.status}` };
        const got = list.body as any[];
        mine.push(...got.filter((r) => r.state === "APPROVED" && same(String(r.user?.login ?? ""), app.login)));
        if (got.length < 100 || page >= 20) break;
      }
      for (const r of mine) {
        const d = await app.rest("PUT", `/repos/${s.slug}/pulls/${n}/reviews/${r.id}/dismissals`, { message: "Ship: this approval was made on another commit or under another review policy; it is dismissed, and the current head is judged again: approved by the App under the current policy, or by a person." });
        if (d.status >= 300) return { ok: false, text: `GitHub refused to dismiss the App's approval of ${url}: ${d.status} ${String(d.body?.message ?? "").slice(0, 200)}` };
      }
      return { ok: true, text: `Dismissed ${mine.length} App approval(s) of ${url}.` };
    }
    const r = await app.rest("POST", `/repos/${s.slug}/pulls/${n}/reviews`, { event: "APPROVE", commit_id: a.head });
    if (r.status >= 300) return { ok: false, text: `GitHub refused the approval of ${url}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}` };
    // No object: an approval makes nothing the fleet owns (the PR stays its author's).
    return { ok: true, text: `Approved ${url} at \`${String(a.head).slice(0, 12)}\` as ${app.login}.` };
  }

  /**
   * An adopted PR into its branch's merge queue, bound by GitHub to the head (`expectedHeadOid`). An answer that never came
   * (a timeout, a 5xx) is reconciled by reading the PR's queue entry, never by asking again: queued at this head (or merged at
   * it) is done; anything else fails and the next round files a new attempt after reading the PR itself.
   */
  async function enqueue(a: any): Promise<{ ok: boolean; text: string; objects?: string[] }> {
    const s = slugOf(a.repo);
    const n = Number(a.number);
    const url = `https://github.com/${s.slug}/pull/${n}`;
    const read = async () => {
      const r = await gh("POST", "/graphql", { query: QUEUE_READ, variables: { owner: s.org, repo: s.name, number: n } });
      const pr = r.body?.data?.repository?.pullRequest;
      if (r.status >= 300 || r.body?.errors?.length || !pr) throw fail(502, `GitHub couldn't read ${url}'s queue entry: ${r.body?.errors?.[0]?.message ?? r.status}`);
      return pr;
    };
    const settled = (pr: any) => {
      if (pr.baseRefName !== a.base) return undefined;
      const done = pr.state === "MERGED" && pr.headRefOid === a.head ? `${url} is merged at \`${String(a.head).slice(0, 12)}\`.`
        : pr.isInMergeQueue && pr.mergeQueueEntry?.headCommit?.oid === a.head ? `${url} is in the merge queue at \`${String(a.head).slice(0, 12)}\`.` : undefined;
      return done ? { ok: true, text: done } : undefined;
    };
    // Code review's gate holds a queued merge as it holds a direct one (merges.ts): only its pass queues.
    // Asked first, so the PR read below is the last one before the mutation.
    const live = await read();
    const review = await o.reviewGate(s.slug, n, a.head, { base: String(live.baseRefName ?? ""), association: String(live.authorAssociation ?? "") });
    // A wait blocks a new enqueue, not the confirmation that an earlier attempt already queued (or merged) this head.
    if (review && "wait" in review) return settled(await read()) ?? { ok: false, text: `not queued: ${review.wait}${review.unblock ? ` (${review.unblock})` : ""}` };
    const pr = await read();
    const now = settled(pr);
    if (now) return now;
    if (pr.state !== "OPEN") return { ok: false, text: `${url} is ${String(pr.state).toLowerCase()}: not queued.` };
    if (pr.baseRefName !== a.base) return { ok: false, text: `ship-scope: ${url}'s base changed: it now targets \`${pr.baseRefName}\`, not \`${a.base}\`: not queued.` };
    const ended = await adoptionEnded(s.slug, n, a.generation, String(a.head), { do: "merge", head: a.head, base: String(pr.baseRefName ?? ""), association: String(pr.authorAssociation ?? "") });
    if (ended) return { ok: false, text: ended };
    if ((pr.labels?.nodes ?? []).some((l: { name?: string }) => l?.name === HOLD_LABEL)) return { ok: false, text: `${url} carries the \`${HOLD_LABEL}\` label: not queued; queued once it is removed.` };
    if (pr.headRefOid !== a.head || pr.isInMergeQueue) return { ok: false, text: `ship-head-moved: ${url} is at \`${String(pr.headRefOid).slice(0, 12)}\`, not \`${String(a.head).slice(0, 12)}\`: not queued.` };
    // Where GitHub's rules ask for a review, an approval on this exact head (merge-gate approvedAt), read right before the enqueue:
    // GitHub may still count an earlier commit's.
    const app = (await o.reviewer?.(s.slug).catch(() => undefined))?.login.replace(/\[bot\]$/, "");
    if ((pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "APPROVED") && !approvedAt(pr, a.head, app)) return { ok: false, text: `ship-tier-pending: ${url} has no approval on \`${String(a.head).slice(0, 12)}\` from someone who can push: not queued; queued again once it has one.` };
    let r: { status: number; body: any } | undefined;
    try { r = await gh("POST", "/graphql", { query: ENQUEUE, variables: { id: pr.id, head: a.head } }); } catch (e) { log("enqueue unanswered", { pr: url, err: String((e as Error).message).slice(0, 200) }); }
    // Success is GitHub's queue entry, not a bare 200: an answer without one is read back like a lost answer.
    if (r && r.status < 300 && !r.body?.errors?.length && r.body?.data?.enqueuePullRequest?.mergeQueueEntry) {
      return { ok: true, text: `${url} is in the merge queue at \`${String(a.head).slice(0, 12)}\`.` };
    }
    // GitHub's own refusal (a GraphQL error, a 4xx): the PR wasn't queued.
    if (r && r.status < 500 && (r.status >= 300 || r.body?.errors?.length)) return { ok: false, text: `GitHub refused to queue ${url}: ${String(r.body?.errors?.[0]?.message ?? r.body?.message ?? r.status).slice(0, 300)}` };
    const again = await read().catch(() => undefined);
    return (again && settled(again)) ?? { ok: false, text: `${url}: GitHub didn't answer the enqueue and the PR doesn't read as queued at \`${String(a.head).slice(0, 12)}\`: the next round reads it and asks again.` };
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
  /** The requester of a planned write, and the base each target was reviewed against (`plan.ts`'s `base_branch`): a held write
   *  re-checks it, so a PR retargeted while GitHub was away is stale rather than pushing a diff read against another base. */
  type Asker = { requester: PlanRequest["requester"]; task: string; bases?: Record<string, string | null> };
  type Held = { id: string; kind: string; args: any; state: "held" | "running" | "done" | "failed"; text?: string; objects?: string[]; at: string; asker?: Asker; /** A publish's base per target when it was held (`github.pr`/`github.push`): the base the diff was reviewed against. */ bases?: Record<string, string | null> };
  // The requester of each planned write (the kernel's record of who asked; execute carries none), by a digest of its kind and
  // args, for the held re-check. The last 500 only.
  const askersFile = join(o.cacheDir, "askers.json");
  const readAskers = (): Record<string, Asker> => { try { return JSON.parse(readFileSync(askersFile, "utf8")); } catch { return {}; } };
  /** A request without the head its plan bound (`heads`, carried in the record's own args): who asked is the same request either way. */
  // The caller's own words of a request: the heads the plan bound and the title a retitle bound are the plan's reads, stripped
  // from both the note and the lookup so a held write finds the requester that filed it.
  const askedOf = (args: unknown) => { const { heads: _heads, from: _from, ...rest } = (args ?? {}) as Record<string, unknown>; return rest; };
  const askerOf = (kind: string, args: unknown): Asker | undefined => { const all = readAskers(); return all[askerKey(kind, askedOf(args))]; };
  function noteAsker(kind: string, args: unknown, who: Asker) {
    const all = readAskers();
    // Keyed without the bound head, so the record's own args (a revalidation's) and the request as asked read the same entry. Merged,
    // never replaced: a revalidation at execution carries no bases of its own, and must not drop the ones the filing recorded.
    const key = askerKey(kind, askedOf(args));
    all[key] = { ...all[key], ...who };
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
      const asker = askerOf(rec.kind, rec.args);
      h[rec.id] = { id: rec.id, kind: rec.kind, args: rec.args, state: "held", at: new Date().toISOString(), ...(asker ? { asker, ...(asker.bases ? { bases: asker.bases } : {}) } : {}) };
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
    const planned = await stateFor(r.kind, r.args ?? {}, r.asker.requester, r.asker.task)
      .then(({ state, facts }) => ({ branches: (state as { branches?: { branch: string }[] }).branches ?? [], targets: planRules({ kind: r.kind, args: r.args }, state, facts).targets as Record<string, { commit?: string | null }> }))
      .catch((e) => { if (disconnected(e)) throw e; return undefined; });
    if (!planned) return false;
    const { targets, branches } = planned;
    const want = [
      // Keyed as the plan keys its targets: the planned branch (an adopted PR's push lands on its head ref, not the box's branch).
      ...((r.args?.only ?? []) as { repo: string; branch: string; sha: string }[]).map((b, i) => [`${slugOf(b.repo).slug} ${branches[i]?.branch ?? b.branch}`, b.sha] as const),
      ...((r.args?.prs ?? []) as { repo: string; number: number; head?: string }[]).filter((p) => p.head).map((p) => [`${slugOf(p.repo).slug}#${Number(p.number)}`, p.head!] as const),
    ];
    if (!want.every(([k, sha]) => (targets[k] as { commit?: string | null })?.commit === sha)) return false;
    // A publish also binds the base its diff was reviewed against (plan.ts's `base_branch`, recorded when it was held): a PR
    // retargeted while the record waited would push that diff into a base nobody read it against, so the record is stale.
    const base = targets as Record<string, { base_branch?: string | null }>;
    return Object.entries(r.bases ?? {}).every(([k, b]) => (base[k]?.base_branch ?? null) === b);
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
  async function kernel(method: "GET" | "POST", path: string, b?: unknown, timeoutMs = 30_000) {
    const r = await fetch(`${o.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${o.key}`, ...(b ? { "content-type": "application/json" } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`the kernel's ${path.split("/").slice(0, 3).join("/")} answered ${r.status}: ${String(j?.error?.message ?? j?.error ?? "").slice(0, 200)}`), { status: r.status });
    return j;
  }
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
    ship: o.ship, reviewer: o.reviewer,
    flow, taskOf: (repo, n) => flow.taskOf(repo, n),
    taskStatus: async (task) => String(((await kernel("GET", `/v1/work?task=${encodeURIComponent(task)}`)) as { status?: unknown })?.status ?? "") || null,
    // A task's id from its identifier: the kernel's work read resolves it by its jobs, which carry the id.
    taskIdOf: async (identifier) => {
      const r = await kernel("GET", `/v1/work?task=${encodeURIComponent(identifier)}`) as { jobs?: { task?: unknown }[] };
      return String(r?.jobs?.[0]?.task ?? "") || undefined;
    },
    // A queue persisted before it kept the task's identifier: the record itself has it (kernel work read).
    identifierOf: async (record) => {
      // A record that is gone (404) has no identifier to find; any other failure is transient (the kernel restarting), and the
      // queue must retry it rather than settle a legacy queue without the evidence the identifier would have proven.
      const r = await kernel("GET", `/v1/work?record=${encodeURIComponent(record)}`).catch((e: Error & { status?: number }) => { if (e.status === 404) return undefined; throw e; });
      if (!r) return undefined;
      const ident = String((r as { identifier?: unknown }).identifier ?? "");
      // `pending`: no identifier yet and none read (a claimed record the kernel's upgrade reconcile is about to fill in), so an
      // absence here is not the task's answer and the queue holds for it rather than settling.
      return { ...(ident ? { identifier: ident } : {}), pending: (r as { identifier_pending?: unknown }).identifier_pending === true };
    },
    // A cancelled task's approved merge never lands: ship's loop leaves its PR for a successor, and the queue checks this before
    // every merge, not only when the record was filed. A failed read holds the merge rather than landing it.
    statusOf: async (task) => {
      const r = await kernel("GET", `/v1/work?task=${encodeURIComponent(task)}`).catch((e: Error & { status?: number }) => {
        if (e.status === 404) return { status: "cancelled" }; // a task the kernel no longer holds has no work left to merge
        throw e;
      });
      const status = (r as { status?: unknown })?.status;
      return typeof status === "string" ? status : undefined;
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
    dir: join(o.cacheDir, "merges"), gh: (method, path, body) => gh(method, path, body, { background: true }), connected: () => access.connected(),
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
  /** The change feed's rule (managedRepos, and main.ts adds maintainer_repos): the product, instance and maintained repos, and the fleet org's non-fork, non-archived ones. */
  const feedWatched = (slug: string, repo: { isFork?: boolean; isArchived?: boolean }) =>
    same(slug, o.productRepo) || same(slug, o.instanceRepo) || (o.maintained ?? []).some((m) => same(m, slug)) || (same(slug.split("/")[0], o.fleetOrg) && !repo.isFork && !repo.isArchived);
  async function ops(op: string, req: IncomingMessage, res: ServerResponse) {
    // Only the kernel calls the ops, with this service's key: POST /v1/codehost/:op brokers them under each module's grant.
    if (!keyed(req)) throw fail(401, "the kernel only");
    if (op !== "snapshot" && op !== "bundle") {
      if (!o.ops) throw fail(404, "no such operation");
      return o.ops(req, res, {
        access, cacheDir: o.cacheDir, feedWatched, cache: (s) => cache(s), git, fetchRemote: (s, name) => fetchRemote(slugOf(s.slug), name),
        initBare, ours, app: o.app,
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
  const trainCommit = (repo: string, path: string, edit: (text: string) => string, message: string, base?: string) =>
    commitOnHead(repo, "release train", message, async (dir, head, def) => {
      // The bump is built on exactly the instance revision the compile preflight passed, never a main that moved since.
      if (base !== undefined && head !== base) throw fail(409, `${repo}'s ${def} moved since the compile check (${base.slice(0, 12)} -> ${head.slice(0, 12)}): checked again on the next poll`);
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
  // The change feed (feed.ts, started by main.ts): the train's product tip comes from its snapshot.
  let feed: Pick<Feed, "tip"> | undefined;
  // The train lands the bump through GitHub: an instance repo on this server (local/…, codehost-local's) is not its to move.
  const train = o.productRepo && o.instanceRepo && slugOf(o.instanceRepo).org.toLowerCase() !== LOCAL_ORG ? createReleaseTrain({
    dir: join(o.cacheDir, "release"), productRepo: o.productRepo, instanceRepo: o.instanceRepo, windowMinutes: o.releaseWindowMinutes ?? 60, kernel, log, now: o.now,
    commit: trainCommit,
    // The target must compile the instance before a bump is filed (#1730): the kernel's read-only preflight, which runs the
    // target's own staged compiler exactly as the apply does. Its throw is transient (the next poll retries); a refusal is the
    // compiler's own first message.
    async compile(to) {
      // The kernel bounds the whole check (two dep installs then the compile, `CHECK_DEADLINE_MS`); this client waits past that
      // bound so a slow host's completed verdict is never discarded and the deps reinstalled on the next poll.
      // `pin: to` — the instance tree that is compiled carries the pin the bump writes, so a module fork is validated against
      // the base the real apply will use, not the old one.
      const r = await kernel("POST", "/v1/compile/check", { product: to, pin: to }, 600_000);
      if (typeof r?.ok !== "boolean" || typeof r?.base !== "string") throw new Error("the kernel's compile check answered no verdict");
      // `base` is the instance commit compiled: the bump is committed on it, so a verdict is never applied to another revision.
      return r.ok ? { ok: true, base: r.base } : { ok: false, base: r.base, error: String(r.error ?? "the staged compile failed").slice(0, 300) };
    },
    github: {
      async tip(repo) { return feed?.tip(repo); },
      async text(repo, path, at) {
        const s = slugOf(repo);
        const ref = await defaultBranch(s.slug);
        const { dir, sha } = await fetchRemote(s, ref);
        // At the commit a push named (the branch's tip may already be past it): the fetch brings it.
        return fileAt(dir, at && /^[0-9a-f]{40}$/.test(at) ? at : sha, path);
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
      const m = /^\/ops\/(snapshot|bundle|fetch|head|read|comment|commit|setup|runner_token|app_token)$/.exec(String(req.url ?? ""));
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
    train, managedRepos: () => (access.connected() ? managedRepos() : Promise.resolve([] as string[])),
    /** The change feed this service's train reads its product tip from. */
    useFeed: (f: Pick<Feed, "tip">) => { feed = f; },
    /** Held writes run once GitHub is connected again: checked every 30 s. */
    startHeld: () => { const t = setInterval(() => void stepHeld(), 30_000); t.unref?.(); return () => clearInterval(t); },
    stepHeld,
    /** Flow's fact queue sent now (tests, shutdown). */
    flushFacts: () => flow.flush(),
    flow,
    stepReleases: () => train?.step(),
    stepMerges: () => merges.step(),
    /** Ship's round decision for an adopted PR (merges.ts decision), for /internal/ship/decision. */
    shipDecision: (repo: string, number: number, head: string, view?: { pr: any; main: { name: string; oid?: string; rollup?: any }; stackedOn?: number; comments?: { since: string; author?: string } }) => merges.decision(repo, number, head, view),
  });
}
