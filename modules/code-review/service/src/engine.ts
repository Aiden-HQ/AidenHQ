// The code-review state service's decisions: which PR head gets which review, when, and whether it may spend.
//
// What changed on GitHub comes from the github module's change feed (the kernel's event log, read every tick; feed()): each PR it
// names is read once (PrSource), each PR comment checked for a command, each review reply read as an answer, and a repo is read
// whole at this process's start, a gap in the log, the feed's resync, or an event whose handling failed (bootstrap()). A new PR is reviewed with each of the repo's
// on_open combos, a push with each on_push combo (incrementally), and `aiden review …` from someone with write access now does
// what it says. One trigger is a batch: one run per combo (engine, model, effort), each posting its own review; only its first run rechecks the PR's still-open findings. Queued runs start when due, each
// starting while the day's real spend is under the repo's and the instance's day caps, in one transaction; running ones are polled, and
// a finished one is posted (Poster) unless its PR has moved on (superseded). Every run starts and ends with a flow fact on its PR.
//
// Each run keeps what an analysis of reviewers needs as plain columns: engine, model, effort, the kernel's billed cost and the
// ledger's tokens, duration, and its findings (table findings) with their later outcome: fixed (a later recheck found it gone),
// open_at_merge or open_at_close (still open when the PR closed).
//
// The first look at a repo (it was just added to the watched repos) reviews only the newest open PR (the highest number: the last one
// opened) and every PR opened after it, with their pushes. The other PRs open at that look are backlog (cutoffs, their exact numbers): they
// get no automatic review, no tier comment, until `aiden review` or a request asks for one; after that they are followed like any PR.
// A push debounces (DEBOUNCE): another push in the window replaces the queued batch, so a burst of pushes is one review each.
// On a gated repo each open PR's head carries the commit status aidenhq/review, mirroring verdict() (mirror): GitHub's view of the
// verdict; the merge queue still asks verdict() itself.
// A skip is a run too (status skipped, why), acknowledged once per PR and reason, never silent.
//
// Risk tiers (docs/superpowers/specs/2026-11-24-risk-tiers-design.md): each open PR head is classified before anything is queued for it
// (classifyPr: one consistent read of its files, the repo's rules, stored on its row with the inputs it came from); a head without a
// current classification is pending and gets nothing. What runs is its tier's (tierCfg). A head's policy (config.ts policyOf: the
// tier's mandatory combos, its base branch, the ignore globs) changing starts a new run of heads (policy_since): it gets the tier's
// full opening batch, and only runs and coverage under the current policy count for its verdict.
//
// A repo review (a batch whose target is a tree: a whole repo at one commit, resolved once when it is asked for) runs on the same
// lifecycle: its catalog options as runs of one batch: the tools check (the selected tool options together, token-free) and each
// whole-repo model option (catalog `scope: repo`, deepsec) start at once, each its own check in its own box. Every other model
// option waits for the batch's area plan (the `code-review-plan` check, recipe/plan.ts: the repo split into areas a check reads
// whole, by a cheap model checked in code; a repo within one area's budget is one area), stored on the batch; then, in one
// transaction, each per-area option is filed once per area (one area: once, as a whole-repo review always was), a stack option
// (`stack`) once per area tagged with its stack (none: a skipped run saying there is no such code), and a `scope: map` option once
// over the whole repo with the areas as data. A failed plan fails the options that waited for it. At most TREE_RUNNING tree runs
// run at once (each fetches its snapshot before it waits for a check computer). Its runs never post, gate or ack; once the last ends, report.ts renders the report, which goes to
// Primer (a new private document per review) and is served to the board. deepsec's set-up files from a run are asked
// for once as a setup PR (the code host's `setup` op: github files its own reviewed write), and later runs scan with the files on
// that PR's branch until it merges. Spend is the gateway's (each check metered, the install's limits): a repo review has no budget of
// its own. Every deepsec run (a PR's or a repo review's) is handed the repo's deepsec records this service keeps (deepsec-store.ts)
// and the records it changed are laid over them when it ends, so a later run resumes where earlier ones stopped.
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { parseCommand, type Command } from "./commands.ts";
import { combos as parseCombos, DEFAULT_MODEL, ENGINES, gated, gatesAny, openOnly, policyOf, PRESETS, tierCfg, type Combo, type Config, type Entry, type Repo } from "./config.ts";
import { authorKind, classify, factsOf, tooMany, TOO_MANY_FILES, type Facts, type Tier } from "./aidenhq-sdk/tiers.ts";
import type { Ack, CodeHost, Feed, Finding, Posted, Poster, PrComment, PrSource, Publisher, PullRequest, Review, ReviewRunner, RunResult, Status as Mirror, Thread, Unsafe } from "./seams.ts";
import { detect, toolSpec, whyNot, type Option } from "./catalog.ts";
import { render } from "./report.ts";
import { PREVIOUS_BUDGET, SETUP_PATH } from "./adapters.ts";
import { INPUT_MAX, mergeRecords, type DeepsecStore } from "./deepsec-store.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";

/** How a finding reopened by an unsafe answer says so in the post (fixed words). */
const REOPENED = { title: "Reopened, its answer found unsafe: ", why: "The recheck found the answer to this finding unsafe: its fix or reason hides the problem or adds one.\n\n" };

export const DEBOUNCE = 60_000;
/** A PR head whose tier couldn't be classified (its files unreadable, or the head moved during the read) is read again after this. */
const AGAIN_MS = 60_000;
/** The idle pass (every open PR's triggers from its row: a run settling or failing can change them) and the status mirror's
 * retries run at least this often, with no GitHub read. */
const IDLE_MS = 60_000;
/** A post refused by something other than a decision (stale after a restart, a failed GitHub call, a rate limit) is filed again
 * after this, doubling each time (2 to 32 minutes), up to POST_TRIES times while its PR is open. */
export const POST_RETRY = 2 * 60_000;
/** A refused post's notice that couldn't be filed waits this long, doubling up to the cap, while its pull request is open. */
const NOTICE_RETRY = 60_000;
const NOTICE_RETRY_CAP = 15 * 60_000;
const POST_TRIES = 6;
/** A run its model token's spend cap refused (the gateway's "spend cap reached") waits this long, its attempt not counted. */
/** A failed run's retry waits this long (a deploy or restart that made it fail is usually over by then). */
const RUN_RETRY = 60_000;
/** A run the install's spend limit refused (the gateway's 402) waits this long, its attempt not counted. */
const CAP_WAIT = 30 * 60_000;
/** A run that couldn't run is tried this many times in all, on the same reservation. */
const ATTEMPTS = 2;
/** A mandatory run is tried this many times in all, each retry RUN_RETRY after the last (flat: a stream error or a restart is
 * over by then, and the merge waits on it). */
const MANDATORY_ATTEMPTS = 4;
const WRITERS = new Set(["admin", "maintain", "write"]);

export type Kind = "auto" | "command" | "oneoff";
/** The moment a run is for: a PR's opening review (on_open, and `aiden review`) or a push (on_push). */
export type Moment = "open" | "push";
export type Status = "queued" | "running" | "done" | "skipped" | "failed";
export type RunRow = {
  id: string; repo: string; number: number; head: string; base: string; engine: string; model: string; effort: string;
  kind: Kind; status: Status; why: string | null;
  cost_usd: number; important: number; nit: number; pre_existing: number; started: string | null; ended: string | null; check_job: string | null;
  /** When its check job got its box (ISO): a review's wall time runs from here, excluding queueing. */
  box_at: string | null;
  focus: string | null; full: number; incremental_from: string | null; due: number; created: number;
  posted: string | null; author: string; attempts: number;
  /** The trigger it ran for (its combos share it), and whether it rechecks the PR's still-open findings (the batch's first
   * mandatory run, else its first). */
  batch: string; recheck: number;
  /** Its combo was mandatory when queued: its review counts toward the head's coverage and its important findings gate merges. */
  mandatory: number;
  /** The moment it was queued for. */
  moment: Moment | null;
  /** The head's risk tier when it was queued, and the review policy it runs under (config.ts policyOf; a one-off: none). */
  tier: string | null; policy: string | null;
  /** 1 once its review is stored whole (no important finding withheld); what coverage reads, never its post's fate. */
  complete: number | null;
  /** The ledger's tokens for its model token (the kernel's figure), and how long it ran. */
  tokens_in: number | null; tokens_cached: number | null; tokens_out: number | null; duration_ms: number | null;
  /** What earlier attempts of this run were billed (the kernel's figure): the retry gets only what's left. */
  billed_prior: number;
  /** Each earlier attempt's check job and what the kernel billed it (JSON): a retry may reuse the check (billed cumulatively) or start another. */
  bills: string | null;
  /** The kernel write record of its post, while its outcome is pending. */
  write_id: string | null;
  /** The merge base of its base and head (what the review diffed against), set when it starts. */
  merge_base: string | null;
  /** Once posted: the review's link on GitHub, the threads it resolved, the identity it posted as. */
  review_url: string | null; resolved: number | null; identity: string | null;
  /** Its post filed again once (a refusal that wasn't a decision), and when that is due (posted 'retry'). */
  post_tries: number; post_due: number | null;
  /** What it reviews: a PR (`pr`) or a repo review's tree (`tree`: number 0, head the commit); for a tree, the catalog option it
   * runs (the tools run: its tool options, comma-separated) and its check job (`code-review` or `code-review-tools`). */
  target: "pr" | "tree"; option: string | null; profile: string | null;
  /** A repo review run's area of its batch's plan (null: the whole repo). */
  area: string | null;
  /** An area (or whole-repo) run skipped as unchanged: JSON { sha, at, findings } of the last review that read its files, whose findings stay in the report. */
  carried: string | null;
  /** A refused post's typed need (needs_owner, JSON): restricted, expired, sso or scope, with what fixes it. */
  need: string | null;
  /** A refused post's notice on the pull request: `pending` until the kernel took its notice write, then `sent`. A delivery that
   * failed (a kernel or GitHub that can't answer now) is asked again with backoff, for as long as the run's pull request is open:
   * waiting is not failing, so the acknowledgement is never given up on and the pull request never left silent. `failed` only when
   * the pull request closed first. `notice_write` is its record while the outcome is still ours to read. */
  notice: "pending" | "sent" | "failed" | null; notice_tries: number; notice_due: number | null; notice_write: string | null;
};
/** A repo review: its repo and the commit resolved when it was asked for, its options and combo, and once it ended its verdict and report. */
export type BatchRow = {
  id: string; repo: string; sha: string; options: string; combo: string; status: "running" | "done"; verdict: string | null;
  report: string | null; report_url: string | null; report_version: number | null; report_why: string | null; created: number; ended: string | null; author: string;
  /** The commit has deepsec set up (any `.deepsec/` file): deepsec scans, and no setup branch is read. */
  deepsec: number;
  /** The deepsec setup branch when the review started (deepsec picked and not set up at the commit): its tip and files, which
   * deepsec scans with; a branch there means its PR is pending, so no second one is asked for. */
  setup_tip: string | null; setup_files: string | null;
  /** The report's primer.publish write record, while its outcome is pending. */
  report_write: string | null;
  /** Its area plan (recipe/plan.ts), once its plan run is done: JSON. */
  plan: string | null;
  /** The eligible files' blob shas at the commit (the plan's), JSON; `full`: a Full review (every area reviewed, whatever changed). */
  blobs: string | null; full: number;
};
/** A batch's area plan, as recipe/plan.ts gives it. */
export type Plan = { eligible: number; lines: number; planned_by: "one" | "model" | "folders"; note: string | null; areas: { id: string; name: string; tags: string[]; files: Record<string, string[]>; count: number; lines: number }[] };
/** The area planner's model (cheap: it reads only paths and line counts) and its check job. */
const PLAN_MODEL = "anthropic/claude-haiku-5.5", PLAN = "code-review-plan";
/** Tree runs running at once: each fetches its snapshot before it waits for one of the kernel's check computers (its default
 * check_computers_max), so more would only hold snapshots to wait. */
const TREE_RUNNING = 32;
/** A stack option's skip when no area has its stack (a run with nothing to review: never a gap in the verdict). */
export const NO_CODE = "skipped: no ";
/** The deepsec set-up files a run's box gets from a pending setup branch: its summary, config and matchers (the spec's json cap). */
const BOX_SETUP = /^\.deepsec\/(deepsec\.config\.ts|generated-matchers\.ts|data\/[A-Za-z0-9_.-]+\/INFO\.md)$/;
/** A deepsec setup PR asked for and not on the code host yet (refused, or still with the AI reviewer) is asked for again after this. */
const SETUP_RETRY = 24 * 3600_000;
/** The most a check's json spec field holds (kernel/src/checkjobs.ts: 16,384 characters), with room. */
const SETUP_FILES_MAX = 16_000;
/** The longest a request waits for a repo's snapshot listing: under the board's 15 seconds. */
const TREE_WAIT_MS = 12_000;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** What `aiden review`, `always` and a one-off run where the head's tier has no opening reviewer: one cheap review, as advice. */
const ADVICE: Combo[] = PRESETS.standard.trivial.on_open.map((c) => ({ ...c, mandatory: false }));
/** deepsec's efforts (recipe/engines.ts). */
const DEEPSEC_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

const DDL = `
CREATE TABLE IF NOT EXISTS prs (repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, last_reviewed_head TEXT,
  mode TEXT NOT NULL DEFAULT 'auto', focus TEXT, updated TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '', draft INTEGER NOT NULL DEFAULT 0, fork INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
  merged INTEGER NOT NULL DEFAULT 0, last_reviewed_base TEXT, title TEXT, close_due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, why TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER, tokens_cached INTEGER, tokens_out INTEGER, duration_ms INTEGER,
  important INTEGER NOT NULL DEFAULT 0, nit INTEGER NOT NULL DEFAULT 0, pre_existing INTEGER NOT NULL DEFAULT 0, started TEXT, ended TEXT, check_job TEXT,
  focus TEXT, full INTEGER NOT NULL DEFAULT 0, incremental_from TEXT, due INTEGER NOT NULL, created INTEGER NOT NULL,
  posted TEXT, author TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, billed_prior REAL NOT NULL DEFAULT 0, write_id TEXT,
  merge_base TEXT, review_url TEXT, resolved INTEGER, identity TEXT, batch TEXT NOT NULL, recheck INTEGER NOT NULL DEFAULT 0,
  need TEXT);
CREATE INDEX IF NOT EXISTS runs_pr ON runs (repo, number, created);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status, due);
CREATE TABLE IF NOT EXISTS reviews (run TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (run TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, severity TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, outcome TEXT, outcome_at TEXT, why TEXT, evidence TEXT, claim TEXT,
  option TEXT NOT NULL DEFAULT '', lens TEXT, PRIMARY KEY (run, id, option));
CREATE INDEX IF NOT EXISTS findings_pr ON findings (repo, number, outcome);
CREATE TABLE IF NOT EXISTS seen (repo TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (repo, comment));
CREATE TABLE IF NOT EXISTS covered (repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, number, head));
CREATE TABLE IF NOT EXISTS dispositions (finding TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL, state TEXT NOT NULL,
  reason TEXT NOT NULL, evidence TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS dispositions_pr ON dispositions (repo, number, finding);
CREATE TABLE IF NOT EXISTS cursors (repo TEXT PRIMARY KEY, comments TEXT NOT NULL);
-- The PRs a repo had open at its first look, other than that look's newest (the one it reviews): each is backlog and gets no automatic
-- review until asked for. The exact set, never a number, so a PR closed at that look and reopened later is an ordinary PR and is reviewed.
CREATE TABLE IF NOT EXISTS cutoffs (repo TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (repo, number));
CREATE TABLE IF NOT EXISTS comments (repo TEXT NOT NULL, number INTEGER NOT NULL, comment INTEGER NOT NULL, run TEXT NOT NULL, PRIMARY KEY (repo, comment));
CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, repo TEXT NOT NULL, sha TEXT NOT NULL, options TEXT NOT NULL, combo TEXT NOT NULL,
  status TEXT NOT NULL, verdict TEXT, report TEXT, report_url TEXT, report_version INTEGER, report_why TEXT, created INTEGER NOT NULL, ended TEXT,
  author TEXT NOT NULL DEFAULT '', deepsec INTEGER NOT NULL DEFAULT 0, setup_tip TEXT, setup_files TEXT, report_write TEXT);
CREATE TABLE IF NOT EXISTS setups (repo TEXT PRIMARY KEY, asked INTEGER NOT NULL, answer TEXT);
-- Incremental repo reviews: per repo, option and its model and effort (combo), each file's blob sha and mode at the last area review that read it, the run, commit and time of that review.
CREATE TABLE IF NOT EXISTS area_seen (repo TEXT NOT NULL, option TEXT NOT NULL, combo TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, run TEXT NOT NULL, sha TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, option, combo, path));
-- Who asked for a one-off review: their task and the agent or owner's name, and the runs their own request was answered with
-- (its run set: the same ask twice by two askers shares them, and each hears the summary of the runs it asked for).
-- \`text\` is that summary, stored before it is sent; \`pending\` the stamp it was written from and \`sent\` the one delivered, so
-- a kernel that can't take it now is retried on a later tick and a settled summary is never sent twice. \`claim\` marks a send in
-- flight: a crash mid-send leaves it set, and the next start clears it so the summary is tried again (at least once, never lost).
CREATE TABLE IF NOT EXISTS askers (batch TEXT NOT NULL, task TEXT NOT NULL DEFAULT '', setkey TEXT NOT NULL DEFAULT '', requester TEXT NOT NULL,
  runs TEXT NOT NULL DEFAULT '', text TEXT, pending TEXT, sent TEXT, claim TEXT, PRIMARY KEY (batch, task, setkey));
CREATE TABLE IF NOT EXISTS replies (repo TEXT NOT NULL, number INTEGER NOT NULL, finding TEXT NOT NULL, body TEXT NOT NULL, write TEXT, tries INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, PRIMARY KEY (repo, number, finding));`;
/** The data's format (module.yaml data_version), migrated forward at start. 1: combos and findings; a database from before starts
 * fresh (its runs, its PRs and today's spend counts are dropped: the first look at each repo then records what is open, as on a new
 * install). 2: repo reviews (batches, setups; runs' target, option and profile) and findings per option observation
 * (their key gains the option): a version 1 database keeps every run, review and finding. */
export const DATA_VERSION = 3;

type Log = (msg: string, f?: Record<string, unknown>) => void;
export type EngineDeps = {
  db: DatabaseSync; config: () => Config; source: PrSource; runner: ReviewRunner; poster: Poster;
  /** Repo reviews: the code host (snapshots, the deepsec setup PR), the option catalog, and Primer (the report's document). */
  codehost: CodeHost; catalog: () => Option[]; publisher: Publisher;
  /** deepsec's records per repo (this service's /data). */
  deepsec: DeepsecStore;
  /** The kernel's log of the github change feed's events this module subscribes to (module.yaml `subscribes:`). */
  feed: Feed;
  emit?: (f: FactIn) => void; log?: Log; now?: () => number;
};
export class RequestError extends Error {
  status = 400;
  extra: Record<string, unknown>;
  constructor(message: string, extra: Record<string, unknown> = {}) { super(message); this.extra = extra; }
}
/** A read GitHub answered with a refusal (a 4xx bar 408 and 429): retrying won't change it. */
const permanent = (e: unknown) => { const s = (e as { status?: number }).status; return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 429; };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createEngine(d: EngineDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  const log: Log = d.log ?? (() => {});
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 1) {
    db.exec("DROP TABLE IF EXISTS prs; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS reviews; DROP TABLE IF EXISTS findings; DROP TABLE IF EXISTS seen; DROP TABLE IF EXISTS cursors; DROP TABLE IF EXISTS askers;");
    db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
  }
  // An `askers` table from before a row was keyed by its run set held one row per ask task, so a second distinct ask of the same task
  // overwrote the first's runs and its summary. It holds only summaries not yet delivered, so it starts fresh: each ask is recorded again.
  if ((db.prepare("SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = 'askers'").get() as { n: number }).n
    && !(db.prepare("PRAGMA table_info(askers)").all() as { name: string }[]).some((c) => c.name === "setkey")) db.exec("DROP TABLE IF EXISTS askers");
  // An area_seen table of the first shape (no model and effort in its key) holds only a cache: rebuilt.
  if ((db.prepare("PRAGMA table_info(area_seen)").all() as { name: string }[]).length && !(db.prepare("PRAGMA table_info(area_seen)").all() as { name: string }[]).some((c) => c.name === "combo")) db.exec("DROP TABLE area_seen");
  db.exec(DDL);
  // Columns added after data_version 1, kept on the data there is.
  for (const [table, col, type] of [["runs", "box_at", "TEXT"], ["prs", "close_due", "INTEGER NOT NULL DEFAULT 0"], ["runs", "mandatory", "INTEGER NOT NULL DEFAULT 0"], ["runs", "complete", "INTEGER"], ["findings", "why", "TEXT"], ["findings", "evidence", "TEXT"], ["runs", "post_tries", "INTEGER NOT NULL DEFAULT 0"], ["runs", "post_due", "INTEGER"], ["runs", "notice", "TEXT"], ["runs", "notice_tries", "INTEGER NOT NULL DEFAULT 0"], ["runs", "notice_write", "TEXT"], ["runs", "notice_due", "INTEGER"], ["prs", "merged", "INTEGER NOT NULL DEFAULT 0"], ["prs", "status_key", "TEXT"], ["prs", "ack", "INTEGER"], ["runs", "moment", "TEXT"], ["runs", "policy", "TEXT"], ["covered", "policy", "TEXT"], ["findings", "claim", "TEXT"], ["runs", "bills", "TEXT"], ["runs", "need", "TEXT"], ["askers", "runs", "TEXT NOT NULL DEFAULT ''"], ["askers", "text", "TEXT"], ["askers", "pending", "TEXT"], ["askers", "sent", "TEXT"], ["askers", "claim", "TEXT"],
    ["runs", "target", "TEXT NOT NULL DEFAULT 'pr'"], ["runs", "option", "TEXT"], ["runs", "profile", "TEXT"], ["runs", "area", "TEXT"], ["batches", "plan", "TEXT"], ["batches", "blobs", "TEXT"], ["batches", "full", "INTEGER NOT NULL DEFAULT 0"], ["runs", "carried", "TEXT"],
    ["prs", "tier", "TEXT"], ["prs", "rule", "INTEGER"], ["prs", "why", "TEXT"], ["prs", "facts", "TEXT"], ["prs", "cls", "TEXT"], ["prs", "policy", "TEXT"], ["prs", "policy_since", "TEXT"], ["prs", "policy_at", "INTEGER"], ["runs", "tier", "TEXT"], ["prs", "handled", "TEXT"], ["prs", "noted", "TEXT"]] as const)
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  // 1 → 2: a finding is stored per option observation (one tools run reports for several options), so its key gains the option.
  if (version === 1) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE findings_v2 (run TEXT NOT NULL, id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, severity TEXT NOT NULL,
        path TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, outcome TEXT, outcome_at TEXT, why TEXT, evidence TEXT, claim TEXT,
        option TEXT NOT NULL DEFAULT '', lens TEXT, PRIMARY KEY (run, id, option));
      INSERT INTO findings_v2 (rowid, run, id, repo, number, severity, path, line, title, outcome, outcome_at, why, evidence, claim)
        SELECT rowid, run, id, repo, number, severity, path, line, title, outcome, outcome_at, why, evidence, claim FROM findings;
      DROP TABLE findings;
      ALTER TABLE findings_v2 RENAME TO findings;
      CREATE INDEX IF NOT EXISTS findings_pr ON findings (repo, number, outcome);
      PRAGMA user_version = 2;
      COMMIT;`);
  }
  // 2 → 3: a `fixed` answer closes its finding at once (no claim recheck): the claims still pending close as fixed, and a claim
  // recheck still queued or running is retired (it ran no finder, so it never covers a head, and no longer gates one).
  if (version >= 1 && version < 3) {
    const at = new Date((d.now ?? Date.now)()).toISOString();
    db.prepare("UPDATE findings SET outcome = 'fixed', outcome_at = ? WHERE outcome IS NULL AND claim LIKE 'fixed:%'").run(at);
    if ((db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).some((c) => c.name === "recheck_only"))
      db.prepare("UPDATE runs SET status = 'skipped', mandatory = 0, why = 'retired: claim rechecks are gone', ended = ? WHERE recheck_only = 1 AND status IN ('queued', 'running')").run(at);
    db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
  }
  // A send a restart cut off (its claim still set) is tried again: the summary is recoverable, never dropped.
  db.exec("UPDATE askers SET claim = NULL WHERE claim IS NOT NULL");
  // A start a restart cut off (running, no check job yet) is queued again.
  db.prepare("UPDATE runs SET status = 'queued', started = NULL, attempts = 0, billed_prior = 0, bills = NULL WHERE status = 'running' AND check_job IS NULL").run();
  const iso = () => new Date(now()).toISOString();
  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
  const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as T[];
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));
  const tx = <T>(f: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const v = f(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const repoCfg = (repo: string) => d.config().repos.find((r) => r.repo === repo.toLowerCase());
  type PrRow = { repo: string; number: number; head: string; base: string; last_reviewed_head: string | null; mode: string; focus: string | null; author: string; draft: number; fork: number; open: number; merged: number; last_reviewed_base: string | null; title: string | null;
    /** Its head's risk tier, the rule that named it, why, the facts (JSON), and the inputs it was computed from (JSON Inputs). */
    tier: Tier | null; rule: number | null; why: string | null; facts: string | null; cls: string | null;
    /** The head and tier the PR's comment last said (`head:tier`). */
    noted: string | null;
    /** The current run of heads under one policy: the policy, its first head and when it started. */
    policy: string | null; policy_since: string | null; policy_at: number | null;
    /** The head the triggers last ran for (a push seen while its tier was pending is still a push once classified). */
    handled: string | null };
  const prRow = (repo: string, n: number) => one<PrRow>("SELECT * FROM prs WHERE repo = ? AND number = ?", repo, n);
  /** What a head's classification was computed from: a stored one whose inputs differ from these is stale (pending). */
  type Inputs = { head: string; base: string; ref: string; author: string; association: string; config: string };
  const inputsOf = (p: PullRequest, cfg: Entry): Inputs => ({ head: p.head, base: p.base, ref: p.base_ref, author: authorKind(p.author, p.association, p.own), association: String(p.association ?? ""), config: cfg.hash });
  /** A PR head's tier as code review serves it: classified (current inputs), pending (none yet, or stale), or unwatched. `live` is a
   * caller's own read of the PR (its base branch and author association): one that differs from what the tier came from is pending. */
  type TierState = { state: "unwatched" } | { state: "pending" } | { state: "classified"; tier: Tier; rule: number; why: string; facts: Facts | null; c: Repo; policy: string; at: number };
  function tierState(repo: string, n: number, head: string, live: { base?: string; association?: string } = {}): TierState {
    const cfg = repoCfg(repo);
    if (!cfg) return { state: "unwatched" };
    const p = prRow(repo, n);
    const i = p?.cls ? (JSON.parse(p.cls) as Inputs) : undefined;
    // A caller's live read that differs (a PR retargeted or its author's role changed, which the feed doesn't announce): the PR is
    // read again on the next tick.
    const moved = !!p?.open && !!i && i.head === head && ((live.base !== undefined && live.base !== i.ref) || (live.association !== undefined && live.association !== i.association));
    if (moved && !again.has(`${repo}#${n}`)) again.set(`${repo}#${n}`, 0);
    if (!p || !i || !p.tier || p.head !== head || i.head !== head || i.config !== cfg.hash || moved) return { state: "pending" };
    const policy = policyOf(cfg, p.tier, i.ref);
    // A policy the watcher hasn't started its run of heads for yet (a settings edit since): nothing reviewed under it counts.
    return { state: "classified", tier: p.tier, rule: p.rule ?? -1, why: p.why ?? "", facts: p.facts ? JSON.parse(p.facts) : null, c: tierCfg(cfg, p.tier), policy, at: p.policy === policy ? (p.policy_at ?? 0) : Infinity };
  }
  /** The tier a classified head runs, with its policy and when that policy's run of heads started; undefined while pending. */
  const current = (repo: string, n: number, head: string) => { const t = tierState(repo, n, head); return t.state === "classified" ? t : undefined; };
  const runRow = (id: string) => one<RunRow>("SELECT * FROM runs WHERE id = ?", id);
  const subject = (repo: string, n: number) => `pr:${repo}#${n}`;
  /** The notice of a PR's last run, as its status shows it: its phase, reviewer, findings and cost. */
  const lastRunAck = (repo: string, n: number): Ack | undefined => {
    const last = one<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? ORDER BY created DESC LIMIT 1", repo, n);
    return last && { repo: last.repo, number: last.number, head: last.head, state: last.status, run: last.id, combo: comboOf(last), why: last.why ?? undefined,
      counts: { important: last.important, nit: last.nit, pre_existing: last.pre_existing, cost_usd: round(last.cost_usd), ...(last.complete === 0 ? { partial: true } : {}) } };
  };
  /** The head's classification on its notice: every phase of the one comment carries the tier line (none while the head is pending). */
  const withTier = (a: Ack): Ack => {
    const tier = riskOf(a);
    return tier ? { ...a, tier } : a;
  };
  /** The threads other reviewers and people opened, one line each (path:line, who, the comment's first words), within the check's text limit. */
  const othersOf = (ts: Thread[]) => {
    const lines = ts.filter((t) => !t.finding && t.body && !t.resolved && !t.outdated).slice(0, 25).map((t) => `${t.path ?? "?"}:${t.line ?? "?"} (${String(t.author ?? "").slice(0, 40)}): ${t.body!.replace(/\s+/g, " ").slice(0, 200)}`);
    let out = "";
    for (const l of lines) if ((out + l).length < 1990) out += `${l}\n`;
    return out.trim();
  };
  /** The head's risk tier and why, said in its review's header (none while the head is unclassified or has moved). */
  const riskOf = (r: { repo: string; number: number; head: string }) => { const p = prRow(r.repo, r.number); return p?.tier && p.head === r.head ? { tier: p.tier, why: p.why ?? "" } : undefined; };
  /** The acknowledgement comment each PR has (recorded from an outcome, never found by its marker), and notices still settling. */
  const ackOf = (repo: string, n: number) => one<{ ack: number | null }>("SELECT ack FROM prs WHERE repo = ? AND number = ?", repo, n)?.ack ?? undefined;
  /** Records an acknowledgement's outcome; false when its comment's id could not be recorded (the notice stays pending). */
  const acked = (repo: string, n: number, o: Posted | undefined, write?: string): boolean => {
    if (o?.state === "pending" && o.write) return void acking.set(o.write, { repo, number: n }), true;
    // The comment's id and the notices it settles are written in one transaction: the run that filed a notice must never be
    // marked sent while the id of the comment it made is lost, or the next notice would make a second acknowledgement instead of
    // editing that one.
    // Any settled outcome (posted, or refused) gives up a dropped notice's filed write: the record is kept only while the write
    // is still ours to read, and a refused record is never read again, so it would otherwise restore its slot at every restart
    // and poll a record that is already terminal.
    if (o && o.state !== "pending" && (o.ack || write)) {
      try {
        tx(() => {
          if (o.ack) run("UPDATE prs SET ack = ? WHERE repo = ? AND number = ?", o.ack, repo, n);
          // A refused post's waiting notice whose own write the shared queue read as done is told; another notice on the same PR
          // is not (its delivery reads its own record).
          if (write) {
            if (o.state === "posted") run("UPDATE runs SET notice = 'sent', notice_write = NULL, notice_due = NULL WHERE notice = 'pending' AND notice_write = ?", write);
            // A notice dropped because the head moved keeps its filed write's record only until that write settles: now it has,
            // so the record (and the slot it held) is given up, and a notice for the newer head is free to speak.
            run("UPDATE runs SET notice_write = NULL WHERE notice = 'failed' AND notice_write = ?", write);
          }
        });
      } catch (e) {
        // Neither half landed, and the comment on the pull request has no id recorded: the PR's slot stays taken by that comment's
        // write, so a queued notice cannot start a second acknowledgement meanwhile. Its next read of the same record saves the id
        // and releases the slot; an answer queued behind it goes then, editing the one comment, never making another.
        log("notice's comment id not recorded; the notice asks again", { repo, pr: n, err: String((e as Error).message).slice(0, 200) });
        // The slot stays taken by that comment's write, whose record the next tick reads again to learn the id. Nothing was
        // recorded to read back (no write): there is no comment to guard, so the slot is freed for whatever waits behind it.
        const held = write ?? o?.write;
        if (held) acking.set(held, { repo, number: n });
        else release(repo, n);
        return false;
      }
    }
    release(repo, n);
    return true;
  };
  /** A notice waiting behind another one on the same PR: the PR's slot is free, so it goes now rather than on some later answer. */
  const release = (repo: string, n: number) => {
    const next = ackNext.get(`${repo}#${n}`);
    if (next) { ackNext.delete(`${repo}#${n}`); void ack(next); }
  };
  /** Notices filed and not settled yet (write id: its PR), and the latest notice waiting behind one (by PR). */
  const acking = new Map<string, { repo: string; number: number }>();
  // A restart between filing a notice and learning its comment's id leaves the record in its run row: that write still holds its
  // PR's slot, so a second notice waits for it (two in flight would each make their own acknowledgement comment, and the one
  // without the id could never be edited in place). Restored here, before any notice is accepted.
  // A write filed for a notice that was then dropped (its head moved) is still live on GitHub: its record is restored too, so its
  // outcome is read and its slot given up only once it settles.
  for (const r of all<{ notice_write: string; repo: string; number: number }>("SELECT notice_write, repo, number FROM runs WHERE notice_write IS NOT NULL"))
    acking.set(r.notice_write, { repo: r.repo, number: r.number });
  const ackNext = new Map<string, Ack>();
  const acking_ = (repo: string, n: number) => [...acking.values()].some((t) => t.repo === repo && t.number === n);
  // The notice is the only path that makes the acknowledgement: one at a time per PR until its comment's id is known (two in
  // flight would each make one); a notice meanwhile waits, the latest replacing an earlier one, and goes once it is known.
  /** Resolves true once the notice is posted (a pending write or a failed one: false, so the caller tries again). */
  const ack = (a: Ack): Promise<boolean> => {
    if (!ackOf(a.repo, a.number) && acking_(a.repo, a.number)) return void ackNext.set(`${a.repo}#${a.number}`, a), Promise.resolve(false);
    // The PR's slot is taken now, before the call returns: a second notice meanwhile waits behind it.
    const slot = `slot:${randomBytes(6).toString("hex")}`;
    acking.set(slot, { repo: a.repo, number: a.number });
    return d.poster.ack({ ...withTier(a), ack: ackOf(a.repo, a.number) }).then((o) => (acking.delete(slot), acked(a.repo, a.number, o, o?.write) && o?.state !== "pending"), (e) => {
      acking.delete(slot);
      log("ack not posted", { repo: a.repo, pr: a.number, state: a.state, err: String((e as Error).message).slice(0, 200) });
      acked(a.repo, a.number, undefined);
      return false;
    });
  };

  function upsertPr(p: PullRequest) {
    run(`INSERT INTO prs (repo, number, head, base, updated, author, draft, fork, open, merged, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repo, number) DO UPDATE SET head = excluded.head, base = excluded.base, updated = excluded.updated, author = excluded.author,
      draft = excluded.draft, fork = excluded.fork, open = excluded.open, merged = excluded.merged, title = excluded.title`, p.repo, p.number, p.head, p.base, iso(), p.author.toLowerCase(), p.draft ? 1 : 0, p.fork ? 1 : 0, p.open ? 1 : 0, p.merged ? 1 : 0, p.title?.slice(0, 200) ?? null);
  }

  // ---- runs: queue, skip, start, finish ---------------------------------------------------------------------------------------

  type Target = { repo: string; number: number; head: string; base: string; author: string };
  /** An asker of a one-off batch: the agent's name, and its task (absent: the owner's board or an agent with no task). Kept once per batch and task. */
  type Asker = { requester: string; task?: string };
  /** One ask's stored row: its batch, task, run-set key and run ids. */
  type Ask = { batch: string; task: string; setkey: string; runs: string };
  /**
   * One trigger's batch: a queued run per combo, the first rechecking the PR's still-open findings. An automatic batch replaces
   * the PR's queued automatic runs (the push they were for is superseded); the same ask twice (two comments, a double click) is
   * the batch already waiting or running on that head.
   */
  function queue(p: Target, list: Combo[], kind: Kind, o: { due?: number; full?: boolean; focus?: string | null; moment?: Moment; asker?: Asker } = {}): RunRow[] {
    const due = o.due ?? now();
    mirrorDue = true;
    if (kind === "auto") {
      // The push they were for is superseded; a run of a batch that already started (a retry, or the sibling of a run that ran)
      // stays as a skipped run, so its head's batch never reads as finished (pushRounds).
      for (const q of all<RunRow>("SELECT * FROM runs q WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued' AND (billed_prior > 0 OR attempts > 0 OR EXISTS (SELECT 1 FROM runs b WHERE b.repo = q.repo AND b.number = q.number AND b.batch = q.batch AND b.status != 'queued'))", p.repo, p.number)) skipQueued(q.id, "superseded: a newer push");
      run("DELETE FROM runs WHERE repo = ? AND number = ? AND kind = 'auto' AND status = 'queued'", p.repo, p.number);
    }
    const batch = `b-${randomBytes(6).toString("hex")}`;
    // Each run records the head's tier and the policy it runs under (a one-off: none; it never gates or covers).
    const at = kind === "oneoff" ? undefined : current(p.repo, p.number, p.head);
    // A one-off never gates; the recheck runs in the first mandatory run (whose verdict counts), else the first.
    const mand = (c: Combo) => kind !== "oneoff" && c.mandatory;
    const checker = Math.max(0, list.findIndex(mand));
    const runs = list.map((c, i) => {
      if (kind !== "auto") {
        // The same ask is the same run only when it asks the same question: a different focus (or none) is its own run, so a
        // one-off asked with a focus never reuses a queued run of another ask and drop that ask's focus.
        // …and under the same review policy and its run of heads: a run under an older ignore list or tier is another question.
        const same = one<{ id: string }>("SELECT id FROM runs WHERE repo = ? AND number = ? AND head = ? AND engine = ? AND model = ? AND effort = ? AND kind = ? AND full = ? AND focus IS ? AND policy IS ? AND created >= ? AND status IN ('queued', 'running')", p.repo, p.number, p.head, c.engine, c.model, c.effort, kind, o.full ? 1 : 0, o.focus ?? null, at?.policy ?? null, at && Number.isFinite(at.at) ? at.at : 0);
        if (same) return runRow(same.id)!;
      }
      const id = `cr-${randomBytes(6).toString("hex")}`;
      run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, kind, status, focus, full, due, created, author, batch, recheck, mandatory, moment, tier, policy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, kind,
        o.focus ?? null, o.full ? 1 : 0, due, now(), p.author.toLowerCase(), batch, i === checker ? 1 : 0, mand(c) ? 1 : 0, o.moment ?? "open", at?.tier ?? null, at?.policy ?? null);
      return runRow(id)!;
    });
    // Who asked, and the runs this request was answered with (its run set): the same ask twice by two askers shares those runs,
    // and each hears one summary of them (a request that also picks up a run already queued is one ask, not two). The row sits
    // in the first run's batch, whose end re-summarises it. A one-off with no asker (the owner's own call from the Reviews page) is the owner's.
    if (kind === "oneoff" && runs.length) recordAsker(runs[0]!.batch, o.asker ?? { requester: "" }, runs.map((r) => r.id));
    return runs;
  }

  /** Records that `asker` asked for `runs`: their own summary is of those runs, never of another ask's. */
  function recordAsker(batch: string, a: Asker, runs: string[]) {
    // One row per ask: its batch, its task and its own run set. A later ask of the same task (another combo, another focus) is its
    // own row and its own summary, never a rewrite of the first ask's; the same ask twice is the same row, so it is told once.
    // The set is a set: sorted, so the same runs asked for in another combo order (a later ask that reuses them all) are one ask.
    const setkey = createHash("sha256").update(JSON.stringify([...runs].sort())).digest("hex").slice(0, 16);
    run(`INSERT INTO askers (batch, task, setkey, requester, runs) VALUES (?, ?, ?, ?, ?) ON CONFLICT (batch, task, setkey) DO UPDATE SET
      requester = excluded.requester`, batch, a.task ?? "", setkey, a.requester.slice(0, 100), JSON.stringify(runs));
    // The runs may already be where they will end (a run the spend limit holds, or one settled before this ask named it): a summary
    // only a later end would write would never come, so the new asker is looked at now. One still queued or running returns here.
    summariseFor(batch, a.task ?? "", setkey, JSON.stringify(runs));
  }

  /** A queued run skipped (superseded, closed, stopped): it keeps what its earlier attempts were billed, and its flow ends. */
  function skipQueued(id: string, why: string) {
    run("UPDATE runs SET status = 'skipped', why = ?, ended = ?, cost_usd = billed_prior WHERE id = ?", why, iso(), id);
    end(runRow(id)!);
  }

  /** A skip, as a run with its reason, acknowledged on the PR once per reason. */
  function skip(p: Target, c: Combo, kind: Kind, why: string) {
    const key = why.split(":")[0];
    const had = one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status = 'skipped' AND why LIKE ? || '%'", p.repo, p.number, key);
    if (had) return;
    const id = `cr-${randomBytes(6).toString("hex")}`;
    run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, kind, status, why, due, created, ended, author, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?)`,
      id, p.repo, p.number, p.head, p.base, c.engine, c.model, c.effort, kind, why, now(), now(), iso(), p.author.toLowerCase(), id);
    end(runRow(id)!);
    void ack({ repo: p.repo, number: p.number, head: p.head, state: "skipped", run: id, combo: c, why });
  }

  /** What each running run's check job has spent so far (the kernel's figure, read each tick), by run id (shown, never a cap). */
  const live = new Map<string, number>();
  /** Running runs whose check job still waits for a computer (the kernel says so each tick). */
  const waiting = new Set<string>();

  /** Spent today (UTC), real money only: ended runs' billed cost plus what running ones have spent so far, for one repo or the whole instance. */
  function spent(repo?: string) {
    const m = day(now());
    const where = repo ? " AND repo = ?" : "";
    const ended = one<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM runs WHERE substr(ended, 1, 10) = ?${where}`, m, ...(repo ? [repo] : []))!.s;
    const running = all<RunRow>(`SELECT * FROM runs WHERE status = 'running'${where}`, ...(repo ? [repo] : []));
    // A failed attempt waiting for its retry (queued) has spent what it was billed.
    const retrying = one<{ s: number }>(`SELECT COALESCE(SUM(billed_prior), 0) s FROM runs WHERE status = 'queued'${where}`, ...(repo ? [repo] : []))!.s;
    return ended + retrying + running.reduce((n, r) => n + charge(r, live.get(r.id)), 0);
  }

  /** Moves a due queued run to running. Spend is the install's limits' (the model gateway), never a day cap here. */
  function admit(r: RunRow): RunRow | undefined {
    run("UPDATE runs SET status = 'running', started = ?, why = NULL WHERE id = ? AND status = 'queued'", iso(), r.id);
    return runRow(r.id);
  }

  /** The baseline a run reviews from, unless it is full: in a gated tier the last head covered under the run's policy (so every
   * incremental range starts at a covered head), elsewhere the last reviewed one. It counts only while it is an ancestor of the head
   * (startRun asks GitHub): the base branch's sha moving on (main moved) never resets it. */
  function baseline(r: RunRow): string | null {
    if (r.full || r.kind === "oneoff") return null;
    const cfg = repoCfg(r.repo);
    if (cfg && r.tier && gated(cfg.tiers[r.tier as Tier])) return one<{ head: string }>("SELECT head FROM covered WHERE repo = ? AND number = ? AND head != ? AND policy IS ? AND at >= ? ORDER BY at DESC LIMIT 1", r.repo, r.number, r.head, r.policy, isoAt(activeSince(r)))?.head ?? null;
    const p = prRow(r.repo, r.number);
    return p?.last_reviewed_head && p.last_reviewed_head !== r.head ? p.last_reviewed_head : null;
  }
  /** An ISO time for a run of heads' start (ms; Infinity: a policy not started yet, which nothing is at or after). */
  const isoAt = (ms: number) => new Date(Math.min(ms, 8.64e15)).toISOString();
  /** Covered under `policy` in its current run of heads (since `since`): coverage from an earlier stay under the same policy never counts. */
  const isCovered = (repo: string, n: number, head: string, policy: string | null, since = 0) => !!one("SELECT 1 FROM covered WHERE repo = ? AND number = ? AND head = ? AND policy IS ? AND at >= ?", repo, n, head, policy, isoAt(since));
  /** When the run of heads under `policy` started on this PR, for a run's policy: 0 for a policy that isn't the PR's current one. */
  const activeSince = (r: { repo: string; number: number; policy: string | null }) => { const p = prRow(r.repo, r.number); return p && p.policy === r.policy ? p.policy_at ?? 0 : 0; };
  /** The mandatory reviewers that reviewed a head under a policy: its latest run per combo and moment there (one-offs left out),
   * newest first. What the verdict waits on and coverage reads: what reviewed the head under its policy (a run under another policy
   * reviewed it another way: a changed tier, mandatory combo, base branch or ignore list asks for a review under the new one). */
  const reviewers = (repo: string, n: number, head: string, policy: string | null, since = 0) => {
    const seen = new Set<string>();
    return all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND kind != 'oneoff' AND policy IS ? AND created >= ? ORDER BY created DESC", repo, n, head, policy, since)
      .filter((r) => { const k = `${r.engine}|${r.model}|${r.effort}|${r.moment === "push" ? "push" : "open"}`; return !seen.has(k) && !!seen.add(k); });
  };

  /** A PR's on_push rounds under its current policy (since `at`, its run of heads' start): its pushed heads with an automatic push
   * batch whose runs all finished (done or failed), one with a review stored (posted or not). A batch with a run still going or
   * superseded never counts, nor a carried run or an `aiden review`. */
  const pushRounds = (repo: string, n: number, at: number) => one<{ c: number }>(`SELECT COUNT(DISTINCT r.head) c FROM runs r JOIN reviews v ON v.run = r.id WHERE r.repo = ? AND r.number = ? AND r.kind = 'auto' AND r.moment = 'push' AND r.status IN ('done', 'failed') AND r.created >= ?
    AND NOT EXISTS (SELECT 1 FROM runs q WHERE q.repo = r.repo AND q.number = r.number AND q.batch = r.batch AND q.status NOT IN ('done', 'failed'))`, repo, n, at)!.c;
  /** When the PR's current run of heads under one policy started (its push rounds count from there). */
  const since = (repo: string, n: number) => prRow(repo, n)?.policy_at ?? 0;
  /** The PR has had the push reviews its tier's push_rounds allows: later heads get no on_push run. */
  const capped = (cfg: Repo, n: number) => cfg.push_rounds !== null && pushRounds(cfg.repo, n, since(cfg.repo, n)) >= cfg.push_rounds;
  /** openOnly for one PR: its tier has no mandatory on_push, or the PR's push rounds are used up; either way its later heads are
   * gated by the opening review and the findings still open. */
  const openOnlyPr = (cfg: Repo, n: number) => openOnly(cfg) || (gated(cfg) && capped(cfg, n));

  /** What the verdict waits on at a head: the mandatory reviewers that reviewed it (reviewers()). On a repo with no mandatory on_push
   * combo, or a PR whose push rounds are used up (openOnlyPr), the PR's opening review stands for every later head: its latest mandatory opening run per combo, at any head,
   * with the mandatory runs at the head itself (an `aiden review`) and any mandatory run of the PR on its first post (a recheck at
   * an earlier head whose findings aren't posted yet; one still running there is superseded and never posts). */
  const gateRuns = (cfg: Repo, repo: string, n: number, head: string, policy: string, since: number) => {
    const at = reviewers(repo, n, head, policy, since);
    if (!openOnlyPr(cfg, n)) return at;
    // Only the current run of heads under this policy: a batch from an earlier stay in the tier never stands for this one.
    const seen = new Set<string>();
    const opening = all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND mandatory = 1 AND kind != 'oneoff' AND COALESCE(moment, 'open') = 'open' AND policy IS ? AND created >= ? ORDER BY created DESC", repo, n, policy, since)
      .filter((r) => { const k = `${r.engine}|${r.model}|${r.effort}`; return !seen.has(k) && !!seen.add(k); });
    const pending = all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND mandatory = 1 AND kind != 'oneoff' AND status = 'done' AND posted = 'pending' AND post_tries = 0 AND policy IS ? AND created >= ? ORDER BY created DESC", repo, n, policy, since);
    const out = [...opening];
    for (const r of [...at, ...pending]) if (!out.some((o) => o.id === r.id)) out.push(r);
    return out;
  };
  /** The last posted review on the PR (the poster's view of what Aiden posted before). */
  const lastPosted = (r: { repo: string; number: number; id: string }) => one<{ json: string }>("SELECT v.json FROM runs r JOIN reviews v ON v.run = r.id WHERE r.repo = ? AND r.number = ? AND r.posted = 'posted' AND r.id != ? ORDER BY r.ended DESC LIMIT 1", r.repo, r.number, r.id);
  type Open = { id: string; severity: string; path: string; line: number; title: string; why: string | null; evidence: string | null; gating: number; run: string };
  /** The PR's findings still open (no outcome yet), whichever combo found them; `gating`: an important one a mandatory run found
   * and posted. A finding with no GitHub thread yet (its post pending or refused) can't be fixed-and-answered on GitHub, so it
   * never gates: the verdict waits on the post instead (verdict), never on a finding nobody can see. */
  const stillOpen = (repo: string, n: number) => all<Omit<Open, "severity"> & { rank: number }>(
    `SELECT f.id, MIN(CASE f.severity WHEN 'important' THEN 0 WHEN 'nit' THEN 1 ELSE 2 END) rank, f.path, f.line, f.title, f.why, f.evidence, MAX(f.severity = 'important' AND r.mandatory = 1 AND r.posted = 'posted') gating, MAX(f.run) run
     FROM findings f JOIN runs r ON r.id = f.run WHERE f.repo = ? AND f.number = ? AND f.outcome IS NULL GROUP BY f.id ORDER BY gating DESC, MAX(f.rowid) DESC`, repo, n).map(({ rank, ...f }) => ({ ...f, severity: ["important", "nit", "pre_existing"][rank]! }));
  /** The open findings that gate the PR's merge (openImportant). */
  const openGating = (repo: string, n: number) => stillOpen(repo, n).filter((f) => f.gating);
  /** What a run rechecks (spec.previous, shared over PREVIOUS_FIELDS spec fields of 16 KB): every gating finding with its evidence,
   * every answered one, every other open one. Texts shrink before a finding is left out; one that can't fit even bare stays open
   * (never marked fixed unseen; the check says how many were left out). */
  function recheckList(repo: string, n: number, seed: string) {
    // Findings closed by a reply (fixed, disputed, by design, won't fix): rechecked only for a fix or reason that is unsafe.
    const claimed = all<{ id: string; path: string; line: number; title: string; claim: string }>("SELECT id, MIN(path) path, MIN(line) line, MIN(title) title, MAX(claim) claim FROM findings WHERE repo = ? AND number = ? AND claim IS NOT NULL AND outcome IS NOT NULL AND outcome NOT IN ('open_at_merge', 'open_at_close') GROUP BY id ORDER BY MAX(rowid) DESC", repo, n)
      .map((f) => ({ id: f.id, severity: "important", path: f.path, line: f.line, title: f.title.slice(0, 80), claim: f.claim.slice(0, 300) }));
    const open = stillOpen(repo, n);
    const gating = open.filter((f) => f.gating), other = open.filter((f) => !f.gating);
    const size = (v: unknown) => JSON.stringify(v).length;
    const entry = (f: Open, text: number) => ({ id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title.slice(0, 80), ...(f.gating ? { gating: true } : {}),
      ...(text ? { why: (f.why ?? "").slice(0, text), evidence: (f.evidence ?? "").slice(0, text) } : {}) });
    let out: object[] = [];
    for (const text of [400, 150, 0]) if (size((out = [...gating.map((f) => entry(f, text)), ...claimed, ...other.map((f) => entry(f, 0))])) <= PREVIOUS_BUDGET) break;
    // Over budget, each recheck of the PR starts the list one budget further on, so repeated rechecks cover every finding.
    if (size(out) > PREVIOUS_BUDGET && out.length > 1) {
      let fit = 0, room = PREVIOUS_BUDGET;
      while (fit < out.length && (room -= size(out[fit]) + 1) >= 0) fit++;
      const before = one<{ c: number }>("SELECT COUNT(*) c FROM runs WHERE repo = ? AND number = ? AND recheck = 1 AND id != ?", repo, n, seed)!.c;
      const k = (before * Math.max(fit, 1)) % out.length;
      out = [...out.slice(k), ...out.slice(0, k)];
    }
    return out;
  }
  const comboOf = (r: { engine: string; model: string; effort: string }) => ({ engine: r.engine, model: r.model, effort: r.effort });

  async function startRun(r: RunRow) {
    if (r.target === "tree") return startTree(r);
    const cfg = repoCfg(r.repo);
    mirrorDue = true;
    // A retry is incremental too: the ancestor check below is asked again, so a force-push since makes it full.
    let incremental_from = baseline(r);
    run("UPDATE runs SET attempts = attempts + 1 WHERE id = ?", r.id);
    if (!r.attempts) {
      d.emit?.({ type: "review.started", subject: subject(r.repo, r.number), version: r.id, at: iso(), data: { ...comboOf(r), kind: r.kind, head: r.head, run: r.id } });
    }
    try {
      // The merge base is what a full review diffs against (the PR's own, not its stale base sha). The baseline counts only while it is still an
      // ancestor of the head (a force-push or rebase drops it): else, or when GitHub can't say, the review is full.
      const { merge_base } = await d.source.mergeBase(r.repo, r.number, r.head);
      // The baseline counts only on the same merge base: a rebase, main merged in or a retarget moved it, and then the PR's own
      // change is either the baseline's (a bare rebase: its review and verdict carry, unrun) or reviewed whole.
      const was = incremental_from ? one<{ merge_base: string }>("SELECT merge_base FROM runs WHERE repo = ? AND number = ? AND head = ? AND merge_base IS NOT NULL AND status = 'done' ORDER BY created DESC LIMIT 1", r.repo, r.number, incremental_from)?.merge_base : undefined;
      if (incremental_from && was !== merge_base) {
        if (was && r.kind === "auto" && !answeredSince(r, incremental_from) && await sameChange(r, was, incremental_from, merge_base)) return carry(r, incremental_from, merge_base);
        incremental_from = null;
      }
      if (incremental_from) {
        const a = await d.source.compare(r.repo, incremental_from, r.head).catch(() => undefined);
        if (a?.status !== "ahead") incremental_from = null;
      }
      run("UPDATE runs SET incremental_from = ?, merge_base = ? WHERE id = ?", incremental_from, merge_base, r.id);
      const previous = r.recheck ? recheckList(r.repo, r.number, r.id) : [];
      // The PR's stated intent, fenced as data in the brief; a fork's author is an outsider, so none.
      const pr = await d.source.get(r.repo, r.number);
      const intent = pr.fork ? "" : [pr.title, pr.body].filter(Boolean).join("\n\n");
      // What others already raised on the PR's threads (not Aiden's own, which `previous` carries): the review skips what is said.
      const threads = await d.source.threads(r.repo, r.number).then(othersOf, () => "");
      const { check } = await d.runner.start({ repo: r.repo, number: r.number, base: r.base, head: r.head, merge_base, combo: comboOf(r), target: "pr", profile: "code-review", focus: r.focus, intent, threads,
        incremental_from, full: incremental_from === null, previous, mandatory: !!r.mandatory, ignore: cfg?.ignore ?? [], max_nits: cfg?.max_nits ?? 5, ...await deepsecData(r) });
      run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
    } catch (e) {
      // Nothing ran (no check job), so nothing was billed. One GitHub or the kernel couldn't answer now (a kernel restart, a 5xx)
      // waits for a later tick; only a refusal (a 4xx) fails the run.
      if (!permanent(e)) {
        run("UPDATE runs SET status = 'queued', started = NULL, attempts = attempts - 1, due = ? WHERE id = ?", now() + 60_000, r.id);
        return void log("review run couldn't start now; it waits for a later tick", { run: r.id, err: String((e as Error).message).slice(0, 200) });
      }
      await finish(runRow(r.id)!, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, billed_usd: 0 });
    }
  }

  /** Whether the PR's own change at the run's head (from its merge base) is the one at `from` (from `was`, the merge base its
   * review recorded): GitHub's fingerprint of each. Anything unknown (a fingerprint GitHub can't make, a failed read) is a change. */
  async function sameChange(r: RunRow, was: string, from: string, merge_base: string) {
    try {
      const [a, b] = await Promise.all([d.source.patchId(r.repo, was, from), d.source.patchId(r.repo, merge_base, r.head)]);
      return !!a.id && a.id === b.id;
    } catch (e) {
      log("couldn't tell a rebase from a change; reviewing it", { run: r.id, err: String((e as Error).message).slice(0, 200) });
      return false;
    }
  }
  /** No carry while the baseline still owes something: a finding answered after its rechecking run started (what that run
   * rechecked was read as it started, so the claim waits for a mandatory recheck), or its review's first post still being decided (the verdict waits on that post at its own head only). */
  const answeredSince = (r: RunRow, from: string) => !!one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND claim IS NOT NULL AND outcome_at > COALESCE((SELECT MAX(started) FROM runs WHERE repo = ? AND number = ? AND head = ? AND status = 'done' AND recheck = 1), '')", r.repo, r.number, r.repo, r.number, from)
    || reviewers(r.repo, r.number, from, r.policy, activeSince(r)).some((x) => x.posted === "pending" && !x.post_tries);
  /** A bare rebase's run: done at no cost and nothing posted, its range from the baseline it carries (covered, and the PR's
   * baseline next). The PR's findings are the PR's, so they stay as they are. */
  function carry(r: RunRow, from: string, merge_base: string) {
    log("a bare rebase: the review carries", { run: r.id, from: from.slice(0, 12), head: r.head.slice(0, 12) });
    run("UPDATE runs SET status = 'done', posted = 'carried', why = ?, incremental_from = ?, merge_base = ?, complete = 1, cost_usd = 0, ended = ?, duration_ms = 0 WHERE id = ?",
      `carried: a bare rebase of ${from.slice(0, 12)} (the pull request's own change is the same)`, from, merge_base, iso(), r.id);
    const row = runRow(r.id)!;
    cover(row);
    landed(row);
    end(row);
  }

  /** A repo review's run: the whole tree at its commit (no merge base, no recheck), one option's check (the tools run: its tool options). */
  async function startTree(r: RunRow) {
    run("UPDATE runs SET attempts = attempts + 1, merge_base = ? WHERE id = ?", r.head, r.id);
    const b = batchRow(r.batch)!;
    const tools = r.profile === "code-review-tools";
    try {
      if (r.profile === PLAN) {
        const { check } = await d.runner.start({ repo: r.repo, number: 0, base: r.head, head: r.head, merge_base: r.head, target: "tree", run: r.id, profile: PLAN, combo: comboOf(r), stacks: stacksOf(catalog()),
          focus: null, intent: "", threads: "", incremental_from: null, full: true, previous: [], mandatory: false, ignore: [], max_nits: 0 });
        return void run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
      }
      const opts = new Map(catalog().map((o) => [o.id, o]));
      const plan = b.plan ? (JSON.parse(b.plan) as Plan) : undefined;
      const area = r.area ? plan?.areas.find((a) => a.id === r.area) : undefined;
      if (r.area && !area) throw new RequestError(`area ${r.area} isn't in the batch's plan`);
      const o = tools ? undefined : opts.get(r.option!);
      const picked = tools ? r.option!.split(",").map((id) => opts.get(id)) : [];
      if (tools ? picked.some((x) => !x) : !o) throw new RequestError(`${tools ? picked.some((x) => !x) && r.option : r.option} isn't in the option catalog`);
      // Only deepsec's small files go to the box (a json spec field holds 16 KB): its package.json and lockfile stay in the setup PR.
      // Files that together don't fit are none: deepsec then sets the repo up itself, as it would with no setup branch.
      const boxed = r.engine === "deepsec" && b.setup_files ? Object.fromEntries(Object.entries(JSON.parse(b.setup_files) as Record<string, string>).filter(([p]) => BOX_SETUP.test(p))) : {};
      const fits = JSON.stringify(boxed).length <= SETUP_FILES_MAX;
      if (!fits) log("deepsec's setup files are too big for a check's spec: it sets up itself", { run: r.id });
      // A rerun's due area is read from the files not covered yet (changed first), the rest of it staying in the checkout as context.
      const unseen = o && o.scope !== "map" && o.scope !== "repo" && plan && b.blobs ? unseenOf(b, r, filesOf(plan, JSON.parse(b.blobs) as Record<string, string>, r.area), JSON.parse(b.blobs) as Record<string, string>) : undefined;
      const { check } = await d.runner.start({ repo: r.repo, number: 0, base: r.head, head: r.head, merge_base: r.head, target: "tree", run: r.id, profile: tools ? "code-review-tools" : "code-review",
        combo: { ...comboOf(r), ...(o?.kind === "skill" ? { harness: o.run.harness, skills: o.run.skills, tools: o.run.tools } : {}), ...(o?.run.max_cost_usd ? { max_cost_usd: o.run.max_cost_usd } : {}) },
        ...(tools ? { tools: toolSpec(picked as Option[]) } : { option: r.option!, lens: o!.lens }),
        ...(fits && Object.keys(boxed).length ? { setup_files: boxed } : {}), ...await deepsecData(r),
        ...(area ? { area: { id: area.id, name: area.name, files: area.files } } : {}), ...(unseen ? { unseen } : {}), ...(o?.scope === "map" && plan && plan.areas.length > 1 ? { area_map: areaMap(plan) } : {}),
        focus: null, intent: "", threads: "", incremental_from: null, full: true, previous: [], mandatory: false, ignore: [], max_nits: 200 });
      run("UPDATE runs SET check_job = ? WHERE id = ?", check, r.id);
    } catch (e) {
      if (!permanent(e)) {
        run("UPDATE runs SET status = 'queued', started = NULL, attempts = attempts - 1, due = ? WHERE id = ?", now() + 60_000, r.id);
        return void log("repo review run couldn't start now; it waits for a later tick", { run: r.id, err: String((e as Error).message).slice(0, 200) });
      }
      await finish(runRow(r.id)!, { state: "failed", why: `couldn't start: ${String((e as Error).message).slice(0, 200)}`, billed_usd: 0 });
    }
  }

  /** A deepsec run's records of its repo, uploaded for its check (none held yet, or more than a check input holds: none). */
  async function deepsecData(r: RunRow) {
    const held = r.engine === "deepsec" ? d.deepsec.read(r.repo) : undefined;
    if (held && held.length > INPUT_MAX) log("deepsec's records are more than a check input holds: this run starts afresh", { run: r.id, bytes: held.length });
    return held && held.length <= INPUT_MAX ? { deepsec_data: await d.runner.input(held) } : {};
  }
  /** A deepsec run's check ended: the records it changed are laid over the repo's. A kernel that can't answer now throws (the run is
   * applied next tick, records and all); a file that isn't records is logged, never the run's failure. */
  async function absorbDeepsec(r: RunRow) {
    const left = await d.runner.kept(r.check_job!);
    try {
      const merged = left && mergeRecords(d.deepsec.read(r.repo), left, r.target === "tree");
      // Records past what a check input holds are not kept: the repo's records stay those that a later run can be handed.
      if (merged && merged.length > INPUT_MAX) log("deepsec's records would be more than a check input holds: not kept", { run: r.id, bytes: merged.length });
      else if (merged) d.deepsec.write(r.repo, merged);
    } catch (e) {
      log("deepsec's records not kept", { run: r.id, err: String((e as Error).message).slice(0, 200) });
    }
  }

  /** The run's review.ended fact (a PR's flow; a repo review's runs have no PR); a one-off's askers are summarised once all the runs they asked for have ended. */
  function end(r: RunRow) {
    if (r.target === "tree") return;
    if (r.kind === "oneoff") summarise(r.batch, r.id);
    d.emit?.({ type: "review.ended", subject: subject(r.repo, r.number), version: r.id, at: r.ended ?? iso(),
      data: { status: r.status, ...(r.why ? { why: r.why.slice(0, 300) } : {}), important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: r.cost_usd, ...comboOf(r), kind: r.kind, run: r.id } });
  }

  /** Each check job's bill, this attempt's included: the kernel's figure for a check covers all its attempts, so a reused check
   *  is counted once and distinct checks (a full retry of an incremental run) are summed. Unknown or invalid adds nothing. */
  const bills = (r: RunRow, billed: unknown): Record<string, number> => {
    const b = JSON.parse(r.bills ?? "{}") as Record<string, number>;
    const v = typeof billed === "number" && Number.isFinite(billed) && billed >= 0 ? billed : 0;
    return r.check_job ? { ...b, [r.check_job]: Math.max(b[r.check_job] ?? 0, v) } : b;
  };
  /** What a run is charged: every check job's bill. */
  const charge = (r: RunRow, billed: unknown) => Object.values(bills(r, billed)).reduce((n, v) => n + v, 0);

  /** A run posts on a task of its own (closed once its post settles) unless its PR is open on a watched repo (the PR's task, closed with the PR). */
  const ownTask = (r: RunRow) => !repoCfg(r.repo) || !prRow(r.repo, r.number)?.open;

  /** A tree run's coverage as the report reads it: `options` (the tools that ran) a list of ids, `failed` a list of { id, why }, when present. */
  /** A model run's file counts: how many files were eligible and how many it confirmed reading, never more than eligible. Without them it can't be called clean. */
  const validCounts = (k: unknown) => {
    const v = (k ?? {}) as { eligible?: unknown; reviewed?: unknown };
    return Number.isInteger(v.eligible) && Number.isInteger(v.reviewed) && (v.reviewed as number) >= 0 && (v.reviewed as number) <= (v.eligible as number);
  };
  const treeCoverageOk = (c: unknown, r: RunRow, withheld: unknown) => {
    const v = (c ?? {}) as { options?: unknown; failed?: unknown; reviewed?: unknown; excluded?: unknown; incomplete?: unknown };
    const w = (withheld ?? {}) as Record<string, unknown>;
    // Coverage and what was withheld are the evidence a run ran in full: a result without them is no result, never a clean one.
    if (!Array.isArray(v.reviewed) || !Array.isArray(v.excluded) || !(v.incomplete === null || typeof v.incomplete === "string")) return false;
    if (!["important", "nit", "pre_existing"].every((k) => Number.isInteger(w[k]) && (w[k] as number) >= 0)) return false;
    const ids = (x: unknown) => typeof x === "string" && x.length > 0;
    return (v.options === undefined || (Array.isArray(v.options) && v.options.every(ids)))
      && (v.failed === undefined || (Array.isArray(v.failed) && v.failed.every((f) => ids((f as { id?: unknown })?.id) && typeof (f as { why?: unknown }).why === "string")))
      && (r.profile !== "code-review-tools" ? validCounts((c as { counts?: unknown } | undefined)?.counts) : Array.isArray(v.options));
  };
  async function finish(r: RunRow, res: { state: "failed"; why: string; billed_usd?: number } | { state: "done"; review: Review; billed_usd?: number }) {
    live.delete(r.id);
    mirrorDue = true;
    // A result is bound to its run: one for another repo, PR, head or base (what a box could claim) is refused, never posted.
    if (res.state === "done" && r.profile === PLAN) {
      // The plan is the run's kept file (its result only the summary); a read that fails now is asked again next tick.
      const kept = await d.runner.kept(r.check_job!);
      let plan: ReturnType<typeof planOf> = "the plan run left no plan";
      if (kept) { try { plan = planOf(r, JSON.parse(kept.toString("utf8"))); } catch { plan = "the plan isn't JSON"; } }
      if (typeof plan !== "string") { filePlan(r, plan.plan, plan.blobs, charge(r, res.billed_usd)); return batchEnded(r.batch); }
      res = { state: "failed", why: `the review's result isn't a plan: ${plan}`, billed_usd: res.billed_usd };
    }
    if (res.state === "done") {
      const v = res.review as Partial<Review>;
      const bound = String(v.repo ?? "").toLowerCase() === r.repo && v.head === r.head && Array.isArray(v.findings) && (r.target === "tree" || (v.pr === r.number && v.base === r.merge_base));
      if (!bound) res = { state: "failed", why: "the review's result isn't for this run (repo, PR, head or base differ)", billed_usd: res.billed_usd };
      // A repo review's findings come from many tools' mappers: one not in the shared shape fails the run with that reason.
      else if (r.target === "tree" && !v.findings!.every((f) => f && typeof f.id === "string" && f.id && ["important", "nit", "pre_existing"].includes(f.severity) && typeof f.path === "string" && Number.isInteger(f.line) && typeof f.title === "string" && (f.end_line === undefined || Number.isInteger(f.end_line)) && ["why", "evidence", "fix_brief", "option", "lens"].every((k) => (f as Record<string, unknown>)[k] === undefined || typeof (f as Record<string, unknown>)[k] === "string")))
        res = { state: "failed", why: "the review's result isn't for this run: a finding isn't in the shared shape (id, severity, path, line, title, and its optional text and end line)", billed_usd: res.billed_usd };
      else if (r.target === "tree" && !treeCoverageOk(v.coverage, r, v.withheld))
        res = { state: "failed", why: "the review's result isn't for this run: its coverage, file counts or withheld counts aren't in the shared shape", billed_usd: res.billed_usd };
      // A tools run's findings each name one of the options it was asked for (a box's word for another's is no word at all).
      else if (r.target === "tree" && r.profile === "code-review-tools" && !v.findings!.every((f) => typeof f.option === "string" && r.option!.split(",").includes(f.option)))
        res = { state: "failed", why: "the review's result isn't for this run: a finding names an option the run wasn't asked for", billed_usd: res.billed_usd };
    }
    if (res.state === "failed") {
      // A spend limit the gateway refused waits for it (the owner raises it, or the day or month turns), its attempt not counted;
      // its why is kept for the verdict while it waits. Otherwise again, unless it never started or the result was a wrong one.
      // A repo review run the spend limit refused ends failed with that reason (its batch then reports it): waiting for the limit would hold the whole review.
      const limited = SPEND_LIMIT.test(res.why), tree = r.target === "tree", capped = limited && !tree;
      if (capped) run("UPDATE runs SET attempts = attempts - 1 WHERE id = ?", r.id);
      if ((capped || (r.attempts < (r.mandatory ? MANDATORY_ATTEMPTS : ATTEMPTS) && !(limited && tree))) && !res.why.startsWith("couldn't start") && !res.why.startsWith("the review's result")) {
        log("review run failed, trying again", { run: r.id, attempt: r.attempts, why: res.why.slice(0, 200) });
        run("UPDATE runs SET billed_prior = ?, bills = ?, why = ?, status = 'queued', started = NULL, check_job = NULL, due = ? WHERE id = ?", charge(r, res.billed_usd), JSON.stringify(bills(r, res.billed_usd)), res.why.slice(0, 500), now() + (capped ? CAP_WAIT : RUN_RETRY), r.id);
        // A one-off the install's spend limit holds is told now: its batch's summary would otherwise wait on a run that can't
        // start, and the asker would hear nothing at all. It reads as skipped for the limit, with the limit as the one fix.
        if (capped && r.kind === "oneoff") summarise(r.batch, r.id);
        return;
      }
      const why = res.why, cost = charge(r, res.billed_usd);
      const failed = () => run("UPDATE runs SET status = 'failed', why = ?, cost_usd = ?, ended = ? WHERE id = ?", why.slice(0, 500), cost, iso(), r.id);
      // A failed plan and the failures of the options that waited for it land together: never a plan failed with nothing to say so.
      if (r.profile === PLAN) tx(() => { failed(); failPlan(r, why); });
      else failed();
      end(runRow(r.id)!);
      if (r.target === "tree") return batchEnded(r.batch);
      // An automatic review has no one to tell and its sibling may still speak: it is said only when nothing else at this head will.
      if (r.kind !== "auto" || !one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND id != ? AND status IN ('queued', 'running', 'done')", r.repo, r.number, r.head, r.id)) void ack({ repo: r.repo, number: r.number, head: r.head, state: "failed", run: r.id, combo: comboOf(r), why: res.why.slice(0, 300) });
      return;
    }
    const cost = charge(r, res.billed_usd);
    if (r.target === "tree") return finishTree(r, res.review, cost);
    // The run's own facts over whatever the box wrote for them.
    const { tokens, ...rest } = res.review;
    const review: Review = { ...rest, repo: r.repo, pr: r.number, head: r.head, base: r.merge_base!, ...comboOf(r), cost_usd: cost };
    const count = (s: string) => review.findings.filter((f) => f.severity === s).length;
    const t = (k: "input" | "cached" | "output") => (Number.isInteger(tokens?.[k]) ? tokens![k] : null);
    // A result for a head the PR has moved on from is kept for analysis, never applied: its findings and fixes belong to an old head.
    // The PR's head as GitHub has it now (a push since the last look supersedes this result too); the last look's when it can't say.
    const pr = prRow(r.repo, r.number);
    // Unreadable now: the run stays running and the next tick finishes it again (nothing is applied on a guess).
    const gh = pr ? await d.source.get(r.repo, r.number).catch(() => undefined) : undefined;
    if (pr && !gh) return void log("finished review not applied yet: its PR can't be read now; the next tick asks again", { run: r.id });
    const stale = !!gh && gh.open && gh.head !== r.head;
    // A claim the mandatory recheck found unsafe opens again (below) and goes in this run's post, saying so, so GitHub shows why
    // it came back (its row links its earlier thread), at the severity it gates at (a mandatory run's important row first).
    // Only an entry that names why the answer is unsafe and the defect still there reopens a finding: an id alone is silence.
    // A result whose unsafe isn't a list is no list (never a throw that leaves the run stuck on the same result).
    const listed: unknown[] = Array.isArray(review.unsafe) ? review.unsafe : [];
    const named = listed.filter((x): x is Unsafe => !!x && typeof x === "object" && "id" in x && typeof x.id === "string" && "why" in x && typeof x.why === "string" && !!x.why.trim());
    const unsafe: Unsafe[] = r.mandatory && !stale ? [...new Map(named.map((x) => [x.id, x])).values()] : [];
    // The entries that really reopen (a reason the finding's own note already records is no new defect, so it never gets here).
    const reopening: Unsafe[] = [];
    // Reopened findings this run only carries for its post: never stored as this run's own row, so each reopens at the severity
    // and gating its own rows have (an advisory combo's finding stays advice).
    const carried = new Set<string>();
    // What each reopen writes to the finding's own row, so the next recheck reads the reason as its current note.
    const reopenedRows = new Map<string, { run: string; option: string; why: string; line: number }>();
    // A finding this run reports again keeps the report's own note in its new row: the reopen note is written below, only when
    // the claim it reopens is really updated, so a reopen the timestamp guard suppresses leaves no history behind.
    const original = new Map<string, { why: string; line: number; title: string }>();
    for (const u of unsafe) {
      const f = one<Omit<Finding, "fix_brief"> & { run: string; option: string }>(`SELECT f.id, f.run, f.option, f.severity, f.path, f.line, f.title, COALESCE(f.why, '') AS why, COALESCE(f.evidence, '') AS evidence FROM findings f
        JOIN runs x ON x.id = f.run WHERE f.repo = ? AND f.number = ? AND f.id = ? AND f.claim IS NOT NULL ORDER BY (f.severity = 'important' AND x.mandatory = 1) DESC, f.rowid DESC LIMIT 1`, r.repo, r.number, u.id);
      if (!f) continue;
      // An answer recorded after this run started (a correction made while it ran) stands: this result can't reopen the finding,
      // and its post must not say it did.
      if (r.started && one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND id = ? AND claim IS NOT NULL AND outcome_at > ?", r.repo, r.number, u.id, r.started)) continue;
      const at = review.findings.findIndex((x) => x.id === u.id);
      // The finding as the post carries it: its own row's report fields, never the row's run or option columns (a post schema takes
      // neither).
      const was = at >= 0 ? review.findings[at]! : { id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title, why: f.why, evidence: f.evidence, fix_brief: "Fix it and push, or answer on its thread again with a reason that holds." };
      // The same defect named again is no new defect: a reason the finding's own current note already records, case-insensitive
      // and contained either way, at the same line when the entry gives one, never reopens it twice. Each reopen's reason sits
      // ahead of the note it replaced, separated by a blank line, so the segments are reasons and the last one is the original
      // report, which records no reopen and never suppresses a new reason. The history is read from the newest row that carries a
      // reopen, whatever row the post shows (a later report's row has none).
      const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
      const prior = one<{ why: string; line: number }>("SELECT why, line FROM findings WHERE repo = ? AND number = ? AND id = ? AND why LIKE ? ORDER BY rowid DESC LIMIT 1", r.repo, r.number, u.id, `${REOPENED.why}%`);
      const parts = prior ? prior.why.slice(REOPENED.why.length).split("\n\n") : [];
      const reasons = (parts.length > 1 ? parts.slice(0, -1) : parts).map(norm).filter(Boolean);
      const said = norm(u.why);
      const same = (t: string) => !!said && !!t && (t.includes(said) || said.includes(t));
      if (same(reasons[0] ?? "") && (u.line === undefined || u.line === prior!.line)) continue;
      if (reasons.slice(1).some(same)) continue;
      // Kept only once the reopen is real: a restatement (or a duplicate) keeps the report's own note in its row.
      if (at >= 0) original.set(u.id, { why: was.why, line: was.line, title: was.title });
      // The reason leads the reopened note (the original note after it), so GitHub shows what came back and why; the entry's line is
      // where the defect is now.
      const line = Number.isInteger(u.line) && (u.line as number) >= 1 ? u.line! : was.line;
      // A finding with an earlier thread is listed in the post by its title and link only, so the reason goes in the title too (as
      // much as the post schema's 200 leaves): that is how the author sees why it came back. The original title is cut to 40 so the
      // reason gets the rest of the row: the reason is what the author has not seen, so it gets the room.
      const head = `${REOPENED.title}${was.title.replace(REOPENED.title, "").slice(0, 40)}`.slice(0, 80);
      // The summary renderer cuts a row's title at 160, so the whole title stays inside that: the reason is never cut away there.
      const titleRoom = 160 - head.length - 3;
      const short = titleRoom > 20 ? u.why.trim().replace(/\s+/g, " ").slice(0, titleRoom) : "";
      const shown = String(was.why ?? "");
      const body = shown.startsWith(REOPENED.why) ? shown.slice(REOPENED.why.length) : shown;
      // The reason (then a blank line, then the note the finding already had) is what the no-loop check reads back, so the
      // original note gives way first: the reason is never cut by the row's 1500 or the post's 3000 cap.
      const reason = u.why.trim().slice(0, 800);
      const kept = body.trim().slice(0, Math.max(0, 1500 - REOPENED.why.length - 2 - reason.length));
      const reopened = { ...was, line, ...(line !== was.line ? { end_line: undefined } : {}), title: `${head}${short ? ` — ${short}` : ""}`.slice(0, 200), why: `${REOPENED.why}${reason}${kept ? `\n\n${kept}` : ""}`.slice(0, 3000) };
      // The finding's own row keeps what it came back for: the next recheck reads it there and the same defect never reopens it twice.
      reopenedRows.set(u.id, { run: f.run, option: f.option, why: reopened.why, line: reopened.line });
      if (at >= 0) { review.findings[at] = reopened; reopening.push(u); continue; }
      // At the post's 200, the lowest-ranked advice makes room (withheld): a reopened finding always says why on GitHub.
      const cut = review.findings.length >= 200 ? review.findings.findLastIndex((x) => x.severity !== "important") : -1;
      if (cut >= 0) review.withheld[review.findings.splice(cut, 1)[0]!.severity]++;
      // A reopen only counts when its post carries it: one the post can't hold (200 important ones already) stays closed, since
      // a merge blocked by a finding GitHub never showed, with no reason there, is the reasonless reopen this change removes. It
      // is counted as withheld, so the post says something was left out.
      if (review.findings.length >= 200) { review.withheld.important++; continue; }
      review.findings.push(reopened);
      carried.add(u.id);
      reopening.push(u);
    }
    // An eviction at the post's 200 can drop a reopen added earlier: only those the final post carries reopen their findings.
    const shown = new Set(review.findings.map((x) => x.id));
    const reopens = reopening.filter((u) => shown.has(u.id));
    tx(() => {
      run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
      run("UPDATE runs SET cost_usd = ?, ended = ?, important = ?, nit = ?, pre_existing = ?, incremental_from = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, complete = ? WHERE id = ?",
        cost, iso(), count("important"), count("nit"), count("pre_existing"), review.incremental_from, t("input"), t("cached"), t("output"), stale ? null : review.withheld.important === 0 && !review.coverage?.incomplete ? 1 : 0, r.id);
      if (stale) return;
      for (const found of review.findings) {
        if (carried.has(found.id)) continue;
        // A reopened finding goes in as the report had it: its reopen note is written below, only when its claim really reopens.
        // A finding this run reports again without reopening it keeps the report's own note: the reopen history is read from the
        // newest row that carries a reopen (below), never from the newest row, so a restatement cannot hide it or move its line.
        const o = original.get(found.id), f = o ? { ...found, why: o.why, line: o.line, title: o.title } : found;
        // Reported again: a finding a recheck found fixed opens again; one its author answered (a claim) stays closed: only a
        // recheck that flags the claim unsafe reopens it.
        const claimed = one<{ outcome: string; claim: string; outcome_at: string }>("SELECT outcome, claim, outcome_at FROM findings WHERE repo = ? AND number = ? AND id = ? AND claim IS NOT NULL AND outcome IS NOT NULL ORDER BY rowid DESC LIMIT 1", r.repo, r.number, f.id);
        // A recheck never touches an answer recorded after it started (a correction made while it ran): that one stands and the next review reads it.
        if (!claimed && run("UPDATE findings SET outcome = NULL, outcome_at = NULL, claim = NULL WHERE repo = ? AND number = ? AND id = ? AND outcome IN ('fixed', 'dismissed')", r.repo, r.number, f.id).changes)
          dispose([f.id], r, "open", "reported again", `run:${r.id}`);
        run("INSERT OR IGNORE INTO findings (run, id, repo, number, severity, path, line, title, why, evidence, outcome, outcome_at, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", r.id, f.id, r.repo, r.number, f.severity, f.path, f.line, f.title, f.why.slice(0, 1500), f.evidence.slice(0, 1500), claimed?.outcome ?? null, claimed?.outcome_at ?? null, claimed?.claim ?? null);
      }
      // A claim the mandatory recheck found unsafe or malicious (it hides the problem, or the fix adds one): open again.
      for (const u of reopens) if (run("UPDATE findings SET outcome = NULL, outcome_at = NULL, claim = NULL WHERE repo = ? AND number = ? AND id = ? AND claim IS NOT NULL AND outcome_at <= ?", r.repo, r.number, u.id, r.started ?? "").changes) {
        dispose([u.id], r, "open", "the recheck found the answer's fix or reason unsafe", `run:${r.id}`);
        // The finding's own newest row keeps the reason and the line it named, so the next recheck reads them as its current note:
        // the row this run stored for it when it reported the finding again, else the row it already had.
        const row = reopenedRows.get(u.id);
        if (row) run("UPDATE findings SET why = ?, line = ? WHERE repo = ? AND number = ? AND id = ? AND rowid = (SELECT MAX(rowid) FROM findings WHERE repo = ? AND number = ? AND id = ?)",
          row.why.slice(0, 1500), row.line, r.repo, r.number, u.id, r.repo, r.number, u.id);
      }
      // What the recheck confirmed gone at this head: fixed, wherever it was found (and not found again by this run). A gating
      // finding is closed only by a mandatory run's recheck.
      const again = new Set(review.findings.map((f) => f.id));
      const gate = new Set(openGating(r.repo, r.number).map((f) => f.id));
      const fixed = (review.fixed ?? []).filter((x) => typeof x === "string" && !again.has(x) && (r.mandatory || !gate.has(x)));
      for (const id of fixed) run("UPDATE findings SET outcome = 'fixed', outcome_at = ?, claim = NULL WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), r.repo, r.number, id);
      dispose(fixed, r, "fixed", "a recheck at this head found it gone", `run:${r.id}`);
    });
    if (!stale) cover(r);
    // A run that posts says nothing here: afterPost writes its state, its reason and (when it is filed again) its retry deadline
    // together, once the post's outcome is known.
    const done = (status: Status, why: string | null) => {
      run("UPDATE runs SET status = ?, why = ?, ended = ?, duration_ms = ? WHERE id = ?", status, why, iso(), r.started ? now() - Date.parse(r.started) : null, r.id);
      end(runRow(r.id)!);
    };
    // A run whose PR moved on (a push) while it ran is superseded: it never posts over the newer head. One closed unmerged is
    // dropped; a merged one is still reviewed and posted (a review of merged code is useful, and was paid for).
    if (stale) return done("skipped", "superseded: a newer head is being reviewed");
    if (gh && !gh.open && !gh.merged) return done("skipped", "closed");
    const posted = await publish(r, review);
    afterPost(runRow(r.id)!, posted, { at: iso(), ms: r.started ? now() - Date.parse(r.started) : null });
  }
  /**
   * A repo review's run is in: its review and its findings stored (one per option observation, under the option that found it),
   * never posted and never marking anything fixed; deepsec's set-up files filed as a setup PR; the report once the batch is done.
   */
  async function finishTree(r: RunRow, res: Review, cost: number) {
    const { tokens, setup, fixed: _f, unsafe: _u, ...rest } = res;
    const review: Review = { ...rest, repo: r.repo, pr: 0, head: r.head, base: r.head, target: "tree", ...comboOf(r), cost_usd: cost };
    const count = (s: string) => review.findings.filter((f) => f.severity === s).length;
    const t = (k: "input" | "cached" | "output") => (Number.isInteger(tokens?.[k]) ? tokens![k] : null);
    const lens = new Map(catalog().map((o) => [o.id, o.lens]));
    // The box's output is data: a finding's option is one this run was asked for (else the run's own), its lens the catalog's for that option.
    const asked = new Set(r.option!.split(","));
    review.findings = review.findings.map((f) => {
      const option = typeof f.option === "string" && asked.has(f.option) ? f.option : r.option!.slice(0, 80);
      return { ...f, option, lens: lens.get(option) };
    });
    tx(() => {
      run("INSERT OR REPLACE INTO reviews (run, json) VALUES (?, ?)", r.id, JSON.stringify(review));
      run("UPDATE runs SET status = 'done', why = NULL, cost_usd = ?, ended = ?, important = ?, nit = ?, pre_existing = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, complete = ?, duration_ms = ? WHERE id = ?",
        cost, iso(), count("important"), count("nit"), count("pre_existing"), t("input"), t("cached"), t("output"), review.withheld?.important === 0 && !review.coverage?.incomplete && !review.coverage?.failed?.length ? 1 : 0, r.started ? now() - Date.parse(r.started) : null, r.id);
      for (const f of review.findings) {
        run("INSERT OR IGNORE INTO findings (run, id, repo, number, severity, path, line, title, why, evidence, option, lens) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
          r.id, f.id, r.repo, f.severity, f.path, f.line, f.title, String(f.why ?? "").slice(0, 1500), String(f.evidence ?? "").slice(0, 1500), f.option, typeof f.lens === "string" ? f.lens : null);
      }
      markSeen(r, review);
    });
    // The setup PR waits for its approval (minutes): off the tick, so the report and other reviews go on.
    if (setup && r.engine === "deepsec") void fileSetup(r, setup).catch((e) => log("deepsec setup PR not filed", { repo: r.repo, err: String((e as Error).message).slice(0, 200) }));
    await batchEnded(r.batch);
  }

  /** An area run that finished: the files it confirms reading (coverage.reviewed) are seen by its option, model and effort at this commit's blob and mode, for
   * the next review to compare. A run that reports gaps (incomplete) or no reads marks nothing: its area stays due. A whole-repo option (deepsec keeps its own
   * records) and the tools run have none. Rows of deleted files go once no surviving file is last seen by the same run. */
  function markSeen(r: RunRow, review: Review) {
    const b = batchRow(r.batch), o = catalog().find((x) => x.id === r.option);
    if (!b?.plan || !b.blobs || r.profile !== "code-review" || !o || o.scope === "repo" || review.coverage?.incomplete) return;
    const blobs = JSON.parse(b.blobs) as Record<string, string>, read = new Set(review.coverage?.reviewed ?? []), combo = comboKey(r);
    for (const p of filesOf(JSON.parse(b.plan) as Plan, blobs, r.area)) if (read.has(p) && blobs[p]) run("INSERT OR REPLACE INTO area_seen (repo, option, combo, path, blob, run, sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", r.repo, r.option, combo, p, blobs[p], r.id, r.head, iso());
    const rows = all<{ path: string; run: string }>("SELECT path, run FROM area_seen WHERE repo = ? AND option = ? AND combo = ?", r.repo, r.option, combo), live = new Set(rows.filter((x) => x.path in blobs).map((x) => x.run));
    for (const x of rows) if (!(x.path in blobs) && !live.has(x.run)) run("DELETE FROM area_seen WHERE repo = ? AND option = ? AND combo = ? AND path = ?", r.repo, r.option, combo, x.path);
  }
  /** What a run's option was reviewed with: area_seen's rows count only for the same model and effort. */
  const comboKey = (r: { model: string; effort: string }) => `${r.model}|${r.effort}`;

  // ---- repo reviews: the batch, its report, deepsec's setup PR ----------------------------------------------------------------

  const batchRow = (id: string) => one<BatchRow>("SELECT * FROM batches WHERE id = ?", id);
  /** The catalog's stack tags and the globs that find each (the planner tags a folder-split area by them). */
  const stacksOf = (opts: Option[]) => { const out: Record<string, string[]> = {}; for (const o of opts) if (o.stack) out[o.stack] = [...new Set([...(out[o.stack] ?? []), ...o.when])]; return out; };
  /** A plan's areas as a whole-repo option is given them: names, their top folders and tags, within a spec field. */
  const areaMap = (plan: Plan) => {
    const tops = (a: Plan["areas"][number], n: number) => [...new Set(Object.keys(a.files).map((d) => d.split("/").slice(0, 3).join("/") || "(root)"))].slice(0, n);
    for (const n of [8, 3, 1]) {
      const map = { areas: plan.areas.map((a) => ({ name: a.name, files: a.count, folders: tops(a, n), tags: a.tags })) };
      if (JSON.stringify(map).length <= 15_000) return map;
    }
    return { areas: plan.areas.slice(0, 100).map((a) => ({ name: a.name, files: a.count })) };
  };
  /** The model options of a batch that wait for its plan (every one but `scope: repo`), in the catalog's order; an option the
   * catalog no longer has is an id alone (its run fails saying so). */
  const deferredOf = (b: BatchRow) => {
    const ids = Object.keys(JSON.parse(b.combo) as Record<string, unknown>), cat = catalog();
    return [...cat.filter((o) => ids.includes(o.id) && o.scope !== "repo"), ...ids.filter((id) => !cat.some((o) => o.id === id)).map((id) => ({ id, gone: true as const }))];
  };
  const engineOf = (o: Option) => (o.kind === "engine" ? String(o.run.engine ?? o.id) : `skill:${o.id}`);
  /** The plan's runs, filed in one step with the plan itself: each waiting option per area (one area: once, whole), a stack
   * option on its stack's areas (none: a skipped run), a map option once with the areas. An area none of whose files changed since
   * the option's last review of it (area_seen, by blob sha) is a skipped run carrying that review's findings, unless the batch is a Full one. */
  function filePlan(r: RunRow, plan: Plan, blobs: Record<string, string>, cost: number) {
    const b = batchRow(r.batch)!;
    const combos = JSON.parse(b.combo) as Record<string, { model: string; effort: string }>;
    const one = plan.areas.length === 1;
    tx(() => {
      run("UPDATE runs SET status = 'done', why = NULL, cost_usd = ?, ended = ?, complete = 1, duration_ms = ? WHERE id = ?", cost, iso(), r.started ? now() - Date.parse(r.started) : null, r.id);
      run("UPDATE batches SET plan = ?, blobs = ? WHERE id = ?", JSON.stringify(plan), JSON.stringify(blobs), b.id);
      for (const o of deferredOf(b)) {
        if ("gone" in o) { addTree(b, "gone", combos[o.id]!.model, combos[o.id]!.effort, o.id, "code-review", null, { status: "failed", why: `couldn't start: ${o.id} isn't in the option catalog` }); continue; }
        const c = combos[o.id] ?? optionCombo(o), engine = engineOf(o);
        const areas = o.scope === "map" || one ? [null] : plan.areas.filter((a) => !o.stack || a.tags.includes(o.stack)).map((a) => a.id);
        if (!areas.length) addTree(b, engine, c.model, c.effort, o.id, "code-review", null, { status: "skipped", why: `${NO_CODE}${o.stack} code in any of the ${plan.areas.length} areas` });
        const index = b.full ? undefined : seenIndex(b.repo, o.id, comboKey(c), blobs);
        for (const a of areas) {
          const same = index && unchanged(index, filesOf(plan, blobs, a), blobs);
          addTree(b, engine, c.model, c.effort, o.id, "code-review", a, same && { status: "skipped", why: `unchanged since ${same.sha.slice(0, 7)} (${same.at.slice(0, 10)})` }, same && JSON.stringify(same));
        }
      }
    });
  }
  /** The files an area covers (null: the whole repo, every eligible file of the plan's blobs). */
  const filesOf = (plan: Plan, blobs: Record<string, string>, area: string | null) => {
    const a = area ? plan.areas.find((x) => x.id === area) : undefined;
    return a ? Object.entries(a.files).flatMap(([d, names]) => names.map((n) => (d ? `${d}/${n}` : n))) : Object.keys(blobs);
  };
  /** An option's seen files (for its model and effort), read once for a plan's areas: each file's row, and the runs that last read a file this commit no longer has (their other files are
   * affected by the deletion). */
  function seenIndex(repo: string, option: string, combo: string, blobs: Record<string, string>) {
    const rows = new Map(all<{ path: string; blob: string; run: string; sha: string; at: string }>("SELECT path, blob, run, sha, at FROM area_seen WHERE repo = ? AND option = ? AND combo = ?", repo, option, combo).map((x) => [x.path, x]));
    const hit = new Set([...rows.values()].filter((x) => !(x.path in blobs)).map((x) => x.run));
    return { rows, hit };
  }
  type SeenIndex = ReturnType<typeof seenIndex>;
  /** The files' last review by this option when none has changed (every file seen at its blob sha and mode now, none last read by a run that read a file since deleted): where
   * it was, and the findings of the runs that read them that are still open, each for its own files only. Else undefined: the area is reviewed. */
  function unchanged(idx: SeenIndex, files: string[], blobs: Record<string, string>) {
    const rows = files.map((p) => idx.rows.get(p));
    if (!files.length || rows.some((x, k) => !x || x.blob !== blobs[files[k]!] || idx.hit.has(x.run))) return undefined;
    const last = rows.reduce((a, x) => (x!.at > a.at ? x! : a), rows[0]!);
    const findings = [...new Set(rows.map((x) => x!.run))].flatMap((id) => {
      const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", id), mine = new Set(rows.filter((x) => x!.run === id).map((x) => x!.path)), from = rows.find((x) => x!.run === id)!.sha;
      return v ? (JSON.parse(v.json) as Review).findings.filter((f) => mine.has(f.path)).map((f) => ({ ...f, from, src: id })) : [];
    });
    return { sha: last.sha, at: last.at, findings };
  }
  /** Carried findings the owner or a later review has not closed: a finding with a recorded outcome in the run it came from is no longer open. */
  const openCarried = <T extends { id: string; src?: string }>(fs: T[]) => fs.filter((f) => !f.src || !one<{ outcome: string | null }>("SELECT outcome FROM findings WHERE run = ? AND id = ? AND outcome IS NOT NULL", f.src, f.id));
  /** A due area's files to read first on a rerun (what the run's focus is): those changed since this option last read them (with this model and effort), then those it never read,
   * cut to what a check's spec field holds. None on a Full review, a first review (nothing seen: all of it is new) or when nothing is unseen. */
  function unseenOf(b: BatchRow, r: RunRow, files: string[], blobs: Record<string, string>) {
    if (b.full) return undefined;
    const idx = seenIndex(b.repo, r.option!, comboKey(r), blobs), seen = idx.rows;
    if (!seen.size) return undefined;
    // Changed since read, or last read by a run that also read a file since deleted (the deletion may break them).
    const changed = files.filter((p) => seen.has(p) && (seen.get(p)!.blob !== blobs[p] || idx.hit.has(seen.get(p)!.run))), fresh = files.filter((p) => !seen.has(p)), all_ = [...changed, ...fresh];
    const kept: string[] = [];
    let size = 100;
    for (const p of all_) { size += JSON.stringify(p).length + 1; if (size > 15_000) break; kept.push(p); }
    return all_.length ? { files: kept, changed: Math.min(changed.length, kept.length), more: all_.length - kept.length } : undefined;
  }

  /** One run of a repo review: queued, or ended at once (`end`: skipped or failed, with why). */
  const addTree = (b: BatchRow, engine: string, model: string, effort: string, option: string, profile: string, area: string | null, end?: { status: "skipped" | "failed"; why: string }, carried?: string) => run(`INSERT INTO runs (id, repo, number, head, base, engine, model, effort, kind, status, why, ended, full, due, created, author, batch, target, option, profile, area, carried)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'oneoff', ?, ?, ?, 1, ?, ?, ?, ?, 'tree', ?, ?, ?, ?)`, `cr-${randomBytes(6).toString("hex")}`, b.repo, b.sha, b.sha, engine, model, effort, end?.status ?? "queued", end?.why.slice(0, 500) ?? null, end ? iso() : null, now(), now(), b.author, b.id, option, profile, area, carried ?? null);
  /** The plan failed for good: each option that waited for it fails with its reason (inside the caller's transaction). */
  function failPlan(r: RunRow, why: string) {
    const b = batchRow(r.batch)!;
    const combos = JSON.parse(b.combo) as Record<string, { model: string; effort: string }>;
    for (const o of deferredOf(b)) { const c = combos[o.id]!; addTree(b, "gone" in o ? "gone" : engineOf(o), c.model, c.effort, o.id, "code-review", null, { status: "failed", why: `the area plan failed: ${why}` }); }
  }
  /** A plan run's result, checked: every area named, its tags the catalog's, its file list within a check's spec field. */
  function planOf(r: RunRow, v: Record<string, unknown>): { plan: Plan; blobs: Record<string, string> } | string {
    if (String(v.repo ?? "").toLowerCase() !== r.repo || v.head !== r.head) return "the plan isn't for this run's repo and commit";
    const tags = new Set(Object.keys(stacksOf(catalog())));
    const areas = v.areas as Plan["areas"];
    if (!Array.isArray(areas) || !areas.length || areas.length > 2000) return "the plan has no list of areas";
    const ids = new Set<string>();
    for (const a of areas) {
      if (!a || typeof a.id !== "string" || !/^a\d{2,4}$/.test(a.id) || ids.has(a.id) || typeof a.name !== "string" || !a.name || a.name.length > 120 || !Array.isArray(a.tags) || a.tags.some((t) => !tags.has(t))
        || !a.files || typeof a.files !== "object" || Object.values(a.files).some((n) => !Array.isArray(n) || n.some((x) => typeof x !== "string")) || !Number.isInteger(a.count) || !Number.isInteger(a.lines)) return "an area isn't in the plan's shape";
      if (areas.length > 1 && JSON.stringify({ id: a.id, name: a.name, files: a.files }).length > 16_000) return `area ${a.id} is more than a check's spec field holds`;
      ids.add(a.id);
    }
    // The eligible files' blob shas (their content, what an incremental review compares); a file without one is always reviewed.
    const blobs: Record<string, string> = {};
    if (v.blobs && typeof v.blobs === "object") for (const [p, h] of Object.entries(v.blobs)) if (typeof h === "string" && /^\d{6}:[0-9a-f]{40,64}$/.test(h)) blobs[p] = h;
    return { blobs, plan: { eligible: Number(v.eligible) || 0, lines: Number(v.lines) || 0, planned_by: v.planned_by === "model" || v.planned_by === "folders" ? v.planned_by : "one", note: typeof v.note === "string" ? v.note.slice(0, 500) : null, areas } };
  }
  /** The option catalog: the one way it is read, a bad one a request error (a run that needs it fails, or waits, loudly). */
  const catalog = () => { try { return d.catalog(); } catch (e) { throw new RequestError(`the option catalog can't be read: ${String((e as Error).message).slice(0, 200)}`); } };

  /** Once a repo review's last run has ended: its verdict and report, stored, then sent to Primer (a version of the repo's document). */
  async function batchEnded(id: string) {
    const b = batchRow(id);
    if (!b || b.status !== "running" || one("SELECT 1 FROM runs WHERE batch = ? AND status IN ('queued', 'running')", id)) return;
    let out: ReturnType<typeof render>;
    try {
      const lens = new Map(catalog().map((o) => [o.id, o.lens]));
      const plan = b.plan ? (JSON.parse(b.plan) as Plan) : null;
      const areas = new Map((plan?.areas ?? []).map((a) => [a.id, a]));
      const runs = all<RunRow>("SELECT * FROM runs WHERE batch = ? ORDER BY rowid", id).map((r) => {
        const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", r.id);
        const tools = r.profile === "code-review-tools", a = r.area ? areas.get(r.area) : undefined;
        return { option: tools ? "tools" : r.option!, ...(tools ? { options: r.option!.split(",") } : {}), lens: tools ? null : lens.get(r.option!) ?? null, status: r.status, why: r.why, cost_usd: r.cost_usd, review: v ? (JSON.parse(v.json) as Review) : null,
          ...(a ? { area: { name: a.name, files: a.count } } : {}), ...(r.profile === PLAN ? { plan: true as const } : {}), ...(r.status === "skipped" && r.why?.startsWith(NO_CODE) ? { none: true as const } : {}), ...(r.carried ? { unchanged: ((c) => ({ ...c, findings: openCarried(c.findings) }))(JSON.parse(r.carried) as { sha: string; at: string; findings: (Finding & { src?: string })[] }) } : {}) };
      });
      out = render({ repo: b.repo, sha: b.sha, created: new Date(b.created).toISOString(), runs, lensOf: (o) => lens.get(o) ?? "correctness",
        plan: plan && { planned_by: plan.planned_by, note: plan.note, eligible: plan.eligible, lines: plan.lines, areas: plan.areas.map((x) => ({ name: x.name, count: x.count, lines: x.lines, tags: x.tags })) } });
    } catch (e) {
      // Never a stuck tick: the batch stays running and the sweep tries again (loudly) each tick.
      return void log("repo review report not rendered", { batch: id, err: String((e as Error).message).slice(0, 200) });
    }
    run("UPDATE batches SET status = 'done', verdict = ?, report = ?, ended = ? WHERE id = ?", out.verdict, out.markdown, iso(), id);
    await publishReport(id);
  }
  /**
   * Sends a finished batch's report to Primer. A batch with no record, no link and no refusal has not been sent (the service
   * stopped between its end and its record): the sweep sends it, each tick, until one of the three is there.
   */
  async function publishReport(id: string) {
    const b = batchRow(id)!;
    try {
      // The note names the batch: a write that threw is read back by it, and no other review's note can stand for this one.
      const o = await d.publisher.file({ repo: b.repo, title: `Repo review: ${b.repo}`, content: b.report!, versionNote: `${b.sha.slice(0, 7)} ${b.id}` });
      run("UPDATE batches SET report_write = ? WHERE id = ?", o.write, id);
      published(id, o);
    } catch (e) {
      // A refusal the kernel answered (a 4xx) is final; one it couldn't answer now (unreachable, 5xx) is tried again by the next sweep.
      if (!permanent(e)) return void log("repo review report not sent yet; the next tick tries again", { batch: id, err: String((e as Error).message).slice(0, 200) });
      published(id, { state: "refused", write: "", why: String((e as Error).message).slice(0, 300) });
    }
  }
  /** The report's publish record settled: its document saved for the repo (later reviews add versions to it), or why it isn't in Primer. */
  function published(id: string, o: Awaited<ReturnType<Publisher["outcome"]>>) {
    if (o.state === "pending") return;
    const b = batchRow(id)!;
    if (o.state === "refused") {
      log("repo review report not published to Primer", { batch: id, why: String(o.why ?? "").slice(0, 200) });
      return void run("UPDATE batches SET report_write = NULL, report_why = ? WHERE id = ?", `not in Primer: ${String(o.why ?? "refused").slice(0, 300)}`, id);
    }
    // report_url is "" for a report Primer took without a link: published, so never sent again.
    run("UPDATE batches SET report_write = NULL, report_url = ?, report_version = ? WHERE id = ?", o.url ?? "", o.version ?? null, id);
  }

  /**
   * deepsec set the repo up in a run: its set-up files (deepsec's allowlisted `.deepsec/` files only) are asked for as one setup PR
   * through the code host (github files and reviews its own write, on a new branch off the default branch's head; an earlier setup
   * PR is closed). Never while the branch its last answer named has an open PR (runs scan with its files), and
   * once a day at most while it doesn't yet.
   */
  /** The branch the repo's last setup answer named (its PR is open on it), if any. */
  function setupBranchOf(repo: string): string | undefined {
    try { const b = JSON.parse(one<{ answer: string | null }>("SELECT answer FROM setups WHERE repo = ?", repo)?.answer ?? "").branch; return typeof b === "string" ? b : undefined; } catch { return undefined; }
  }
  async function fileSetup(r: RunRow, raw: Record<string, string>) {
    const files = Object.fromEntries(Object.entries(raw ?? {}).filter(([p, c]) => SETUP_PATH.test(p) && typeof c === "string"));
    if (!Object.keys(files).length || batchRow(r.batch)?.setup_tip) return;
    // The branch the last answer named still has an open PR (one that can't be read counts as open): no second request, which would close it.
    // A PR closed unmerged is asked for again at once; a request that was refused or is still with the reviewer waits out SETUP_RETRY.
    const named = setupBranchOf(r.repo);
    if (named && await d.codehost.setupBranch(r.repo, named).then((x) => x !== undefined, () => true)) return;
    // A concurrent batch claimed the request while the lookup ran: its row is the one to follow.
    if (setupBranchOf(r.repo) !== named) return;
    const asked = one<{ asked: number }>("SELECT asked FROM setups WHERE repo = ?", r.repo)?.asked;
    if (!named && asked !== undefined && now() - asked < SETUP_RETRY) return;
    // The slot is taken in the same step as the look above (a request takes minutes), so a concurrent batch asks for no second PR.
    run("INSERT INTO setups (repo, asked, answer) VALUES (?, ?, 'asking') ON CONFLICT (repo) DO UPDATE SET asked = excluded.asked, answer = excluded.answer", r.repo, now());
    let answer: string;
    try {
      const j = (await d.codehost.setup({ repo: r.repo, files })) as { pr_url?: unknown; branch?: unknown; tip?: unknown };
      answer = JSON.stringify({ pr_url: j.pr_url, branch: j.branch, tip: j.tip });
    } catch (e) {
      answer = `refused: ${String((e as Error).message).slice(0, 300)}`;
      log("deepsec setup PR not asked for", { repo: r.repo, err: answer });
    }
    run("UPDATE setups SET answer = ? WHERE repo = ?", answer, r.repo);
  }

  const retries = (r: RunRow, o: Posted) => o.state === "refused" && !!o.retry && (!r.post_tries || (r.post_tries < POST_TRIES && !!prRow(r.repo, r.number)?.open));

  /** Files the run's post (a Tier 1 write): its review, on the head it reviewed. */
  async function publish(r: RunRow, review: Review): Promise<Posted> {
    const previous = lastPosted(r);
    let posted: Posted;
    try {
      const own = all<{ comment: number }>("SELECT comment FROM comments WHERE repo = ? AND number = ? ORDER BY comment DESC LIMIT 1000", r.repo, r.number).map((c) => c.comment);
      posted = await d.poster.post({ run: r.id, target: { repo: r.repo, number: r.number, head: r.head, once: ownTask(r) }, review, previous: previous ? JSON.parse(previous.json) : null, gated: !!repoCfg(r.repo) && !!r.mandatory, own, first: !previous, ...(riskOf(r) ? { tier: riskOf(r) } : {}) });
    } catch (e) {
      posted = { state: "refused", why: String((e as Error).message).slice(0, 200), retry: true };
    }
    if (posted.write) run("UPDATE runs SET write_id = ? WHERE id = ?", posted.write, r.id);
    return posted;
  }

  /** A post's outcome, written whole in one statement: its state, its reason, a refusal's notice intent, and — for one refused by
   * something other than a decision — its attempt count and the time it is due. A completed review is never dropped for a restart
   * or a GitHub hiccup, and nothing here can be half-written: a `retry` row always has a deadline a later tick will reach, and a
   * refusal always has its notice intent, so a restart between two statements can leave neither a stranded post nor a silent one.
   * A refused post is never silent: the run row keeps the reason, and the PR's notice says (in fixed words) that this head's
   * review was not posted. The PR's task is quiet, so it is not where an author would see it; a per-push run has no author to
   * tell, so the pull request is the place. */
  function afterPost(r: RunRow, o: Posted, ended?: { at: string; ms: number | null }) {
    // Filed and not decided yet: the run is done, and the post is settled by the id later.
    if (o.state === "pending") {
      run("UPDATE runs SET posted = 'pending', status = 'done', why = NULL, ended = COALESCE(?, ended), duration_ms = COALESCE(?, duration_ms) WHERE id = ?", ended?.at ?? null, ended?.ms ?? null, r.id);
      if (ended) end(runRow(r.id)!);
      return;
    }
    const again = retries(r, o);
    const refused = o.state === "refused" && !again;
    if (again) log("review post refused; filing it once more", { run: r.id, why: String(o.why ?? "").slice(0, 200) });
    const why = o.state === "posted" ? null : again ? `posting again: ${String(o.why ?? "refused").slice(0, 300)}` : `not posted: ${o.why ?? "refused"}`;
    // The need is this outcome's, never an earlier one's: a retry that settled (posted, or refused for another reason) replaces the
    // need the failed attempt left, so the summary never names a Grant link for a connection that is fine now.
    run(`UPDATE runs SET posted = ?, status = ?, why = ?, post_tries = ?, post_due = ?, need = ?, notice = CASE WHEN ? THEN COALESCE(notice, 'pending') ELSE notice END,
      ended = COALESCE(?, ended), duration_ms = COALESCE(?, duration_ms) WHERE id = ?`,
      again ? "retry" : o.state, again || o.state === "posted" ? "done" : "failed", why, again ? (r.post_tries ?? 0) + 1 : r.post_tries ?? 0,
      again ? now() + POST_RETRY * 2 ** Math.min(r.post_tries ?? 0, 4) : null, o.state === "refused" && o.need ? JSON.stringify(o.need) : null, refused ? 1 : 0, ended?.at ?? null, ended?.ms ?? null, r.id);
    // A run that has just posted is finished now: its fact says where it ended (superseded and closed runs never get here).
    if (ended) end(runRow(r.id)!);
    if (refused || o.state === "posted") settled(r, o);
    // A mandatory review's findings gate once posted: replies left unread until then are read now.
    if (o.state === "posted" && r.mandatory) claimsDue.add(`${r.repo}#${r.number}`);
  }

  /** A post due to be filed again. */
  async function repost(r: RunRow) {
    const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", r.id);
    if (!v) {
      // Same one statement as a refusal: the reason and the notice's intent land together.
      run("UPDATE runs SET status = 'failed', posted = 'refused', why = 'not posted: its review is gone', notice = COALESCE(notice, 'pending') WHERE id = ?", r.id);
      return;
    }
    const o = await publish(r, JSON.parse(v.json) as Review);
    afterPost(runRow(r.id)!, o);
  }

  /** The notice writes a refused post's fixed words reach the pull request, retried while pending. It goes through the same
   * one-acknowledgement-per-PR path as every other notice: while another notice is in flight and the comment's id isn't known
   * yet (two would each make one), this one waits for the next tick. A notice is Tier 0, filed as `claimed`: its outcome is read
   * back, and only a done one counts as sent. */
  const delivering = new Set<string>();
  async function deliver(r: RunRow) {
    if (r.notice !== "pending" || delivering.has(r.id)) return;
    // The guard is taken before the first await: two ticks (or a tick and a settle) that both saw this run pending must not both
    // deliver it, or both would read "no notice filed yet" and each file one.
    delivering.add(r.id);
    try {
      // The pull request moved on while this notice waited: the head it speaks for is gone, so the notice is too. Otherwise a
      // delayed refusal for head A would later edit the one acknowledgement to say A's review was not posted, wiping the newer
      // head's own (a done notice or a queued one), and ask for a review of a head nobody is looking at. A review of the newer
      // head that is refused has its own notice. Its head is the one GitHub has now where the watcher doesn't watch it: a one-off's
      // row is a snapshot from when the review was asked for, so a push after it would otherwise pass this check unseen.
      // Read once where nothing polls the repo: that read also says whether the PR is closed (gone() below takes it whole).
      const live = repoCfg(r.repo) ? undefined : await d.source.get(r.repo, r.number).catch(() => undefined);
      const now = live ?? prRow(r.repo, r.number);
      if (now?.open && now.head !== r.head) {
        // A write already filed can't be cancelled: GitHub may still land it. Its record stays on the row (and its PR slot stays
        // taken, by the write's id) until its outcome is read, so a notice for the newer head can't make a second comment while
        // A's is still live and have it edited out from under it. Only a notice nothing was filed for releases the slot now.
        if (r.notice_write) {
          run("UPDATE runs SET notice = 'failed', notice_due = NULL WHERE id = ?", r.id);
          return log("refused post's notice dropped: the pull request moved to a newer head; its filed write is still tracked", { repo: r.repo, pr: r.number, run: r.id, head: r.head.slice(0, 12), now: now.head.slice(0, 12) });
        }
        run("UPDATE runs SET notice = 'failed', notice_due = NULL WHERE id = ?", r.id);
        release(r.repo, r.number);
        return log("refused post's notice dropped: the pull request moved to a newer head", { repo: r.repo, pr: r.number, run: r.id, head: r.head.slice(0, 12), now: now.head.slice(0, 12) });
      }
      // A pull request closed before its notice landed: there is no head to ask again on, so that one is the end of it.
      if (await gone(r, live)) {
        run("UPDATE runs SET notice = 'failed' WHERE id = ?", r.id);
        // This notice held the PR's slot: whatever was queued behind it goes now, not when some later answer happens to come.
        release(r.repo, r.number);
        return log("refused post's notice not posted: the pull request closed first", { repo: r.repo, pr: r.number, run: r.id });
      }
      await deliverOnce(r);
    } finally {
      delivering.delete(r.id);
    }
  }
  /** Whether a run's pull request is gone (closed unmerged) before its notice landed, from the row and GitHub: `fresh` is the
   * live read the delivery already made for an unwatched repo, so a delivery asks GitHub once. A watched repo's feed keeps its
   * row current; nothing polls an unwatched repo's PR (a one-off elsewhere, a repo since dropped), so there the row is only a
   * snapshot and GitHub's own answer decides. A row written before this service recorded merges says `open = 0` for a merged PR
   * too, and a merged PR still takes its notice; a PR that can't be read is not given up on. */
  async function gone(r: RunRow, fresh?: PullRequest): Promise<boolean> {
    const p = fresh ?? prRow(r.repo, r.number);
    // A watched repo's feed keeps its row current, so a row that says the PR still stands (open, or merged: which still takes a
    // notice) is the answer. Nothing seen yet means nothing about a close.
    // A row that says closed without merged is not proof: the watcher's own detail read can fail just as the PR leaves the open
    // list, and a merged PR still takes its notice. GitHub is asked once more there (and for a row written before this service
    // recorded merges at all); a read that fails leaves the notice pending, never dropped on a guess.
    if (repoCfg(r.repo)) return !!p && !p.open && (p.merged ? false : away(r));
    // Nothing polls an unwatched repo's PR (a one-off elsewhere, a repo since dropped): its row is a snapshot from when the
    // review was asked for, so GitHub's answer now decides (`fresh`, or a read of it).
    return fresh ? !fresh.open && !fresh.merged : away(r);
  }
  /** Read from GitHub now: the PR is closed without merging, so it takes no notice (a merged one still does). Unknown when it
   * can't be read (never "gone" on a guess). */
  async function away(r: RunRow): Promise<boolean> {
    const fresh = await d.source.get(r.repo, r.number).catch(() => undefined);
    return !!fresh && !fresh.open && !fresh.merged;
  }

  async function deliverOnce(r: RunRow) {
    const ack = ackOf(r.repo, r.number);
    const mine = r.notice_write;
    if (!ack && [...acking.values()].some((t) => t.repo === r.repo && t.number === r.number) && (!mine || !acking.has(mine))) return; // another notice holds the PR's slot: the next tick goes
    let o: Posted | undefined;
    if (mine) {
      // Filed on an earlier tick: its outcome now decides. The shared queue may already have read it; that is idempotent.
      o = await d.poster.outcome(mine).catch(() => ({ state: "pending" as const }));
      if (o.state !== "pending") acking.delete(mine);
    } else {
      // Filed now, holding the PR's slot so no second notice makes a second acknowledgement comment.
      const slot = `slot:${r.id}`;
      acking.set(slot, { repo: r.repo, number: r.number });
      try {
        o = await d.poster.ack(withTier({ repo: r.repo, number: r.number, head: r.head, state: "failed", run: r.id, combo: comboOf(r), why: r.why ?? "not posted: refused", ...(ack ? { ack } : {}) }));
      } catch (e) {
        acking.delete(slot);
        // A notice queued behind this one must not wait for an answer that never comes: the delivery gave up its slot.
        release(r.repo, r.number);
        return noticeFailed(r, e);
      }
      acking.delete(slot);
    }
    if (o?.state === "posted") {
      // The record that made this comment is kept on the row first: if recording its id below is lost (a crash, a full disk), the
      // next tick reads that same record back and learns the id, instead of filing a second acknowledgement comment.
      if (o.write && r.notice_write !== o.write) run("UPDATE runs SET notice_write = ? WHERE id = ?", o.write, r.id);
      // The write that made the comment is this run's own when its outcome names none: the slot must stay under that id, or the
      // next tick's guard (another notice holds the PR's slot) could block the very notice whose id is still unrecorded.
      if (!acked(r.repo, r.number, o, o.write ?? mine ?? undefined)) return void run("UPDATE runs SET notice_due = ? WHERE id = ?", now() + NOTICE_RETRY, r.id);
      return void run("UPDATE runs SET notice = 'sent', notice_write = NULL, notice_due = NULL WHERE id = ?", r.id);
    }
    // Its outcome says whether filing it again could change anything: a rejection or a cancel is final, a stale or failed
    // record may post when it is filed again.
    if (o?.state === "refused") return noticeFailed(r, o.why ?? "refused", o.retry === true);
    // Pending: its record's outcome is read on a later tick, by this delivery and by the shared queue. No poster answer (a
    // fake, or a notice with nothing to file) is nothing left to wait for.
    if (!o) return void run("UPDATE runs SET notice = 'sent', notice_write = NULL, notice_due = NULL WHERE id = ?", r.id);
    if (o.write) {
      run("UPDATE runs SET notice_write = ? WHERE id = ?", o.write, r.id);
      acking.set(o.write, { repo: r.repo, number: r.number });
    }
  }
  /** A failed delivery waits longer each time (NOTICE_RETRY doubling up to NOTICE_RETRY_CAP) and is asked again while its pull
   * request is open: a kernel or GitHub that can't answer now must not leave it silent for good. As long as a failure can change
   * (a 5xx, a timeout, a write that is stale until the kernel files it again), waiting is not failing, so that never ends. But a
   * refusal that cannot change by asking again — a 4xx that isn't a lost answer, an outcome the kernel calls final, a notice the
   * executor refuses on a PR that isn't open or merged — must not be asked every fifteen minutes for as long as the PR stands: it
   * is asked a few times, then ends with its reason on the run row and in the log. */
  const PERMANENT_NOTICE_TRIES = 3;
  function noticeFailed(r: RunRow, err: unknown, retry?: boolean) {
    const why = String((err as Error)?.message ?? err).slice(0, 300);
    // Whatever this delivery did with the PR's slot, it is not holding it any more: an acknowledgement queued behind it goes now
    // (and finds the comment's id if one was recorded), never waiting for an answer that will not come.
    release(r.repo, r.number);
    // The executor refuses a notice on a pull request that isn't open or merged: it has nowhere left to go, so asking again can
    // only be refused again. That is the end of it (as for a PR whose close this service saw first), never a retry forever.
    if (/isn't open or merged/.test(why)) {
      run("UPDATE runs SET notice = 'failed', notice_write = NULL, notice_due = NULL WHERE id = ?", r.id);
      return log("refused post's notice not posted: the pull request closed first", { repo: r.repo, pr: r.number, run: r.id, err: why.slice(0, 200) });
    }
    const n = (r.notice_tries ?? 0) + 1;
    // A refusal the kernel's record already called final (a rejection or a cancel, not a stale or failed one it may file again), or
    // a 4xx that isn't a lost answer, is the same every time: a few tries and then done, loudly.
    const final = retry === false || (retry === undefined && permanent(err));
    if (final && n >= PERMANENT_NOTICE_TRIES) {
      run("UPDATE runs SET notice = 'failed', notice_tries = ?, notice_write = NULL, notice_due = NULL WHERE id = ?", n, r.id);
      return log("refused post's notice was refused outright and is not asked again", { repo: r.repo, pr: r.number, run: r.id, tries: n, err: why.slice(0, 200) });
    }
    // The first failure asks again on the very next tick (a kernel restart, a blip); later ones wait progressively longer.
    const wait = n === 1 ? 0 : Math.min(NOTICE_RETRY * 2 ** (n - 2), NOTICE_RETRY_CAP);
    run("UPDATE runs SET notice_tries = ?, notice_due = ?, notice_write = NULL, notice = 'pending' WHERE id = ?", n, now() + wait, r.id);
    log("refused post's notice not posted; asking again", { repo: r.repo, pr: r.number, run: r.id, tries: n, err: why.slice(0, 200) });
  }

  /** Records why findings changed state: their ids, the head, the reason and who decided (a run, an answer on its thread, the owner). */
  function dispose(ids: string[], at: { repo: string; number: number; head: string }, state: string, reason: string, by: string, evidence: string | null = null) {
    for (const id of ids) run("INSERT INTO dispositions (finding, repo, number, head, state, reason, evidence, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, at.repo, at.number, at.head, state, reason.slice(0, 2000), evidence?.slice(0, 2000) ?? null, by, iso());
  }

  /**
   * A head is covered once every mandatory reviewer that reviewed it (reviewers()) has its review stored whole, each over a range
   * that starts at the merge base (a full review) or at a covered head. A one-off never counts (its runs are never mandatory).
   */
  function cover(r: RunRow) {
    if (!repoCfg(r.repo) || !r.mandatory) return;
    const since = activeSince(r);
    const at = reviewers(r.repo, r.number, r.head, r.policy, since);
    if (!at.length || !at.every((x) => x.complete === 1 && (x.incremental_from === null || isCovered(x.repo, x.number, x.incremental_from, r.policy, since)))) return;
    // Covered under the run's policy: a head reviewed under another tier or other mandatory reviewers isn't covered under this one.
    run("INSERT OR REPLACE INTO covered (repo, number, head, base, at, policy) VALUES (?, ?, ?, ?, ?, ?)", r.repo, r.number, r.head, r.base, iso(), r.policy);
  }

  /** A post's outcome is in: a posted one is the PR's baseline and keeps its link; a one-off's task is done either way. */
  function settled(r: RunRow, o: Posted) {
    if (o.state === "posted") {
      // The comments it opened: what makes a thread Aiden's own (an answer, a resolve), never a marker read back from GitHub.
      for (const c of o.comments ?? []) run("INSERT OR IGNORE INTO comments (repo, number, comment, run) VALUES (?, ?, ?, ?)", r.repo, r.number, c, r.id);
      run("UPDATE runs SET review_url = ?, resolved = ?, identity = ? WHERE id = ?", o.url ?? null, o.resolved ?? null, o.identity ?? null, r.id);
      landed(r);
      // The review's own summary says what the acknowledgement would, so a PR with no acknowledgement yet (an automatic review) gets
      // none; one already asked for (a command's queued notice) is updated with the outcome. A review of an older head leaves it to the newer one's.
      if ((ackOf(r.repo, r.number) || acking_(r.repo, r.number)) && prRow(r.repo, r.number)?.head === r.head) void ack({ repo: r.repo, number: r.number, head: r.head, state: "done", run: r.id, combo: comboOf(r), counts: { important: r.important, nit: r.nit, pre_existing: r.pre_existing, cost_usd: round(r.cost_usd), ...(r.complete === 0 ? { partial: true } : {}) }, ...(o.url ? { review: o.url } : {}) });
    }
    if (r.write_id && ownTask(r)) void d.poster.close(r.repo, r.number, "The one-off review's post is settled.", r.id).catch((e) => log("review task not closed", { run: r.id, err: String((e as Error).message).slice(0, 200) }));
    if (r.kind === "oneoff") summarise(r.batch, r.id);
  }

  /** One line for what fixes a refusal only the owner can fix, from the need github-mcp's review route carried (runs.need). */
  function fixOf(needJson: string | null | undefined): string | undefined {
    let need: { cause?: unknown; org?: unknown; url?: unknown; scope?: unknown } | undefined;
    try { need = JSON.parse(String(needJson ?? "")) as typeof need; } catch {}
    if (!need || typeof need.cause !== "string") return undefined;
    const cause = need.cause;
    if (cause === "restricted") return `the Grant link: ${typeof need.url === "string" ? need.url : "GitHub's settings, Connections, Applications"}${typeof need.org === "string" ? ` (press Grant next to ${need.org})` : ""}`;
    if (cause === "sso") return `the SSO authorization link: ${typeof need.url === "string" ? need.url : "the board's GitHub card"}`;
    if (cause === "expired" || cause === "not_connected") return "Reconnect GitHub on the board (Settings, Connections)";
    if (cause === "scope") return `Reconnect GitHub on the board to grant \`${typeof need.scope === "string" ? need.scope : "the missing permission"}\``;
    return undefined;
  }
  /**
   * One summary per one-off ask, once the runs it asked for have settled: posted, refused, skipped for budget, or failed,
   * naming the PR, what happened and the one action that fixes it. Each asker hears the summary of the runs its own request
   * queued, once: a wake notice on their task (its agent hears it, and its task can act), or to the owner when the request was
   * the board's, or to the owner when their task has closed and the summary carries an action only the owner can take (see
   * sendSummaries). Never one message per run.
   */
  function summarise(batch: string, runId?: string) {
    // The askers of this run's batch, and any ask whose own runs include it even when they also came from an earlier batch.
    const asked = runId
      ? all<Ask>("SELECT batch, task, setkey, runs FROM askers WHERE batch = ? OR runs LIKE ?", batch, `%${JSON.stringify(runId)}%`)
      : all<Ask>("SELECT batch, task, setkey, runs FROM askers WHERE batch = ?", batch);
    for (const a of asked) summariseFor(a.batch, a.task, a.setkey, a.runs);
  }

  function summariseFor(batch: string, task: string, setkey: string, asked: string) {
    let ids: string[] = [];
    try { const v = JSON.parse(asked || "[]"); if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === "string"); } catch {}
    // An asker recorded before the runs were kept (a database from the first shape of this table): the whole batch is its ask.
    const runs = ids.length ? all<RunRow>(`SELECT * FROM runs WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created`, ...ids)
      : all<RunRow>("SELECT * FROM runs WHERE batch = ? AND kind = 'oneoff' ORDER BY created", batch);
    if (!runs.length) return;
    // A run waiting on the install's spend limit is not on its way yet: it is reported as such (the one action is the limit), so
    // the batch is summarised now rather than never. Everything else still to come waits: a queued or running run, or a post
    // filed again (a refusal that wasn't a decision), so the summary tells what happened to it, not the state in between.
    const spent = (r: RunRow) => SPEND_LIMIT.test(String(r.why ?? ""));
    if (runs.some((r) => !spent(r) && (r.status === "queued" || r.status === "running" || (r.status === "done" && (r.posted === "pending" || r.posted === "retry"))))) return;
    const first = runs[0]!;
    // Each run lands in one of these: posted, refused (a write the reviewer or owner turned down, or a post the executor
    // refused for a need only the owner can fix), skipped for budget, or failed (no result, or one not bound to the run).
    const posted = runs.filter((r) => r.status === "done" && r.posted !== "refused");
    const refused = runs.filter((r) => r.status === "failed" && (r.posted === "refused" || !!r.write_id));
    // A run that never started because the install's spend limit is reached: the gateway's cap, not the run's own (the day cap
    // is gone). A queued one waits for the limit to lift; a failed one gave up. Both are the same outcome to the asker.
    const spend = runs.filter((r) => spent(r) && r.status !== "done" && !refused.includes(r));
    const skipped = runs.filter((r) => !spent(r) && r.status === "skipped" && /^budget/.test(String(r.why ?? "")));
    const failed = runs.filter((r) => r.status === "failed" && !refused.includes(r) && !spend.includes(r));
    // A run skipped for a reason of its own (superseded, closed) is named too, never left out of the counts.
    const other = runs.filter((r) => r.status === "skipped" && !skipped.includes(r) && !spend.includes(r));
    const parts = [posted.length ? `${posted.length} posted` : "", refused.length ? `${refused.length} refused` : "",
      spend.length ? `${spend.length} skipped for the spend limit` : "", skipped.length ? `${skipped.length} skipped for budget` : "",
      failed.length ? `${failed.length} failed` : "", other.length ? `${other.length} skipped (${String(other[0]!.why ?? "no reason").slice(0, 80)})` : ""].filter(Boolean);
    const what = parts.length ? parts.join(", ") : "no run ended";
    // The one action that fixes it, most useful first: the Grant link (or Reconnect) of a refusal's need, the spend limit's reset,
    // the budget's reset, then a re-run for a refusal or failure with no owner-fixable cause.
    const grant = refused.map((r) => fixOf(r.need)).find(Boolean);
    const fix = grant
      ?? (spend.length ? "the install's spend limit resets (Settings, spend_day_usd or spend_month_usd)" : undefined)
      ?? (skipped.length ? "budget resets at 00:00 UTC" : undefined)
      ?? (refused.length || failed.length ? "re-run it with code_review_run" : undefined);
    const text = `**One-off review settled:** ${first.repo}#${first.number} at ${first.head.slice(0, 7)}: ${runs.length} ${runs.length === 1 ? "run" : "runs"}, ${what}.${fix ? ` To fix it: ${fix}.` : ""}`;
    // The outcomes of these runs, and whether the owner can act on them (a Grant or Reconnect link, or the spend limit): the stamp
    // is the summary's identity, so a closed asker's summary is routed by the same snapshot it was rendered from.
    const bodyStamp = JSON.stringify({ runs: Object.fromEntries(runs.map((r) => [r.id, `${r.status}|${r.posted ?? ""}|${r.why ?? ""}|${r.need ?? ""}`])), owner: !!grant || spend.length > 0 });
    // The same outcomes, already summarised and not sent yet (a tick's deliver is about to), needs nothing: a finished run is
    // summarised twice (its post's pending write, then its outcome), and the second look is this read.
    const had = one<{ pending: string | null }>("SELECT pending FROM askers WHERE batch = ? AND task = ? AND setkey = ?", batch, task, setkey);
    if (had?.pending === bodyStamp) return;
    // Stored before anything goes, so a kernel that can't take it now is tried again on a later tick (deliver): a settlement
    // message is never lost to a restart. A request whose runs ended differently after a first summary is summarised once more,
    // and the same one is never re-sent.
    run("UPDATE askers SET text = ?, pending = ? WHERE batch = ? AND task = ? AND setkey = ?", text, bodyStamp, batch, task, setkey);
  }

  /**
   * Sends each stored, unsent summary to its asker. One whose task has closed goes to the owner only when it carries an action
   * the owner can take (the stamp's owner flag), once per batch; otherwise nobody needs it and it is marked sent.
   */
  async function sendSummaries() {
    const todo = all<{ batch: string; task: string; setkey: string; requester: string; text: string | null; pending: string; sent: string | null; claim: string | null }>(
      "SELECT batch, task, setkey, requester, text, pending, sent, claim FROM askers WHERE text IS NOT NULL AND (sent IS NULL OR sent != pending) AND claim IS NULL ORDER BY rowid");
    // Tasks that hear nothing (gone, done or cancelled), by the batch and the run set they asked about: the owner is told
    // instead when there is something to fix, once. Askers of one run set share a stamp (`pending`), so they are one message; a distinct run set of the same
    // batch keeps its own, never another ask's — even when its runs happened to render the same text.
    const closed = new Map<string, { batch: string; stamp: string; text: string; asks: { task: string; setkey: string }[]; who: string[] }>();
    for (const a of todo) {
      // The send is claimed first, in a compare-and-set on the stamp it is for: two ticks can't both send it, and one that changed
      // mid-send keeps its new stamp for the next send. A wake carries the key as the notice's `id`, which the kernel reads back
      // from the task's thread, so a summary sent again after a crash that lost its answer still wakes the agent once. `claim`, not
      // `sent`, marks it: a crash mid-send leaves the claim and the next start clears it, so the summary is sent again rather than
      // dropped. A failed send hands the claim back, so the next tick tries again.
      if (run("UPDATE askers SET claim = ? WHERE batch = ? AND task = ? AND setkey = ? AND pending = ? AND claim IS NULL AND (sent IS NULL OR sent != pending)", a.pending, a.batch, a.task, a.setkey, a.pending).changes !== 1) continue;
      const key = `code-review:ask:${a.batch}:${a.task || "owner"}:${createHash("sha256").update(a.pending).digest("hex").slice(0, 16)}`;
      try {
        if (a.task && (await d.poster.notify({ task: a.task, text: a.text!, dedupe_key: key })) === "closed") {
          // The task is done with this ask: it is not asked again, but the row stays unsent until the owner's notice below lands, or
          // a crash between the two would leave `sent` set with the owner never told. Its `claim` is handed back for that send.
          run("UPDATE askers SET claim = NULL WHERE batch = ? AND task = ? AND setkey = ? AND claim = ?", a.batch, a.task, a.setkey, a.pending);
          const k = `${a.batch}\u0000${a.pending}`;
          const c = closed.get(k) ?? { batch: a.batch, stamp: a.pending, text: a.text!, asks: [], who: [] };
          closed.set(k, { ...c, asks: [...c.asks, { task: a.task, setkey: a.setkey }], who: [...c.who, a.requester || "an agent"] });
          continue;
        }
        if (!a.task) await d.poster.notify({ text: a.text!, dedupe_key: key });
        run("UPDATE askers SET sent = ?, claim = NULL WHERE batch = ? AND task = ? AND setkey = ? AND claim = ?", a.pending, a.batch, a.task, a.setkey, a.pending);
      } catch (e) {
        run("UPDATE askers SET claim = NULL WHERE batch = ? AND task = ? AND setkey = ? AND claim = ?", a.batch, a.task, a.setkey, a.pending);
        log("one-off summary not sent; the next tick tries again", { batch: a.batch, task: a.task, err: String((e as Error).message).slice(0, 200) });
      }
    }
    // A closed task hears nothing: a plain outcome ends here, and one with an owner-fixable action goes to the owner, naming
    // every asker whose task is closed, under its own key.
    for (const { batch, stamp, text, asks, who } of closed.values()) {
      // A stamp from before the flag existed has none: it is told to the owner, as it was then.
      if ((JSON.parse(stamp) as { owner?: boolean }).owner === false) {
        log("one-off summary: an asker's task is closed and nothing needs the owner; dropped", { batch, askers: who });
        for (const x of asks) run("UPDATE askers SET sent = pending, claim = NULL WHERE batch = ? AND task = ? AND setkey = ?", batch, x.task, x.setkey);
        continue;
      }
      log("one-off summary: an asker's task is closed; it goes to the owner", { batch, askers: who });
      // Its own key, of its own run set *and* its own askers: two closed asks of one batch are one message only when they asked the
      // same runs and are the same asks, so a second asker whose runs ended the same way (or an asker joining that set later) is
      // not dropped for having rendered the same words. A key of the stamp alone would lose the second one.
      const set = createHash("sha256").update(`${stamp}\u0000${asks.map((x) => `${x.task}\u0000${x.setkey}`).sort().join("\u0001")}`).digest("hex").slice(0, 16);
      const key = `code-review:ask:${batch}:closed:${set}`;
      try {
        await d.poster.notify({ text: `${text} (asked by ${who.join(", ")})`, dedupe_key: key });
      } catch (e) {
        // The owner wasn't told, so these asks stay unsent: the next tick asks the task again (it may be open now) or tells the owner.
        log("one-off summary not sent; the next tick tries again", { batch, err: String((e as Error).message).slice(0, 200) });
        continue;
      }
      // Told: each of these asks is done with. Only now is it marked, so a crash anywhere above leaves it to be sent again.
      for (const x of asks) run("UPDATE askers SET sent = pending, claim = NULL WHERE batch = ? AND task = ? AND setkey = ?", batch, x.task, x.setkey);
    }
  }

  /** A posted review is the PR's baseline for the next incremental run; one only filed (or refused) never is. */
  function landed(r: RunRow) {
    // A delayed post of an older run never rolls the baseline back past one a newer run set.
    run(`UPDATE prs SET last_reviewed_head = ?, last_reviewed_base = ? WHERE repo = ? AND number = ?
      AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.repo = prs.repo AND x.number = prs.number AND x.head = prs.last_reviewed_head AND x.posted IN ('posted', 'carried') AND x.created > ?)`, r.head, r.base, r.repo, r.number, r.created);
  }
  /** A filed post's outcome, once the AI reviewer and the executor are done with it. */
  async function settle(r: RunRow) {
    const o = await d.poster.outcome(r.write_id!).catch(() => ({ state: "pending" as const }));
    if (o.state === "pending") return;
    // afterPost writes the outcome, its reason, the notice's intent and a retry's deadline in one statement: a restart between
    // them must never leave the pull request silent about a review that wasn't posted, nor strand a retry nothing polls. A post
    // filed once more says nothing to the pull request yet (its next attempt may post it); only a refusal that stands asks for
    // the notice. The need is this outcome's, never an earlier one's: a retry that settled (posted, or refused for another reason)
    // replaces the need the failed attempt left, or the summary would name a Grant link for a connection that is fine now.
    afterPost(runRow(r.id)!, o);
  }

  // ---- triggers and commands ------------------------------------------------------------------------------------------------

  /** The head's tier's trigger for a new PR, a policy change (`open`, `full`: the whole PR from its merge base) or a push (`push`):
   * a batch of the tier's combos for that moment. */
  function trigger(cfg: Repo, p: PullRequest, which: "open" | "push", full = false) {
    const row = prRow(p.repo, p.number)!;
    let list = which === "open" ? cfg.on_open : cfg.on_push;
    // `aiden review stop` stops the advice only: a mandatory combo (the merge waits on it) still reviews each head. Anyone who can
    // post as the owner can write a command, so no command lessens what gates a merge.
    if (row.mode === "stop") list = list.filter((c) => c.mandatory);
    if (row.mode === "always" && !list.length) list = cfg.on_push.length ? cfg.on_push : cfg.on_open.length ? cfg.on_open : ADVICE;
    // With no mandatory on_push, a push's review is advice: `always` never adds a gate.
    if (which === "push" && openOnlyPr(cfg, p.number)) list = list.map((c) => ({ ...c, mandatory: false }));
    if (!list.length) return;
    // `aiden review always` is a writer's standing ask for every push: it runs past the cap, as advice once the cap is reached.
    if (which === "push" && row.mode !== "always" && capped(cfg, p.number)) return skip(p, list[0]!, "auto", `push review cap reached: ${cfg.push_rounds} push review${cfg.push_rounds === 1 ? "" : "s"} done; later pushes are gated by the findings still open, or say \`aiden review\``);
    if (p.draft && !cfg.drafts) return skip(p, list[0]!, "auto", "draft: drafts are reviewed when marked ready, or when someone with write access asks");
    // `aiden review always` is a writer's ask, so a fork's PR under it is reviewed like any other.
    if (p.fork && cfg.forks === "manual" && row.mode !== "always") {
      // A gated repo's mandatory combos review a fork's PR by themselves (its merge waits on them); the others wait to be asked.
      const must = list.filter((c) => c.mandatory);
      if (!must.length) return skip(p, list[0]!, "auto", "fork: a PR from a fork is reviewed when someone with write access asks (`aiden review`)");
      list = must;
    }
    queue(p, list, "auto", { due: which === "push" ? now() + DEBOUNCE : now(), focus: row.focus, moment: which, full });
  }

  /**
   * A head whose policy (tier, the tier's mandatory combos, base branch, ignore globs) started a new run of heads (policy_since) gets
   * the tier's full opening batch until one completed under that policy at policy_since or later (every mandatory on_open combo done
   * or failed past its retries), queued once per head and policy; a push meanwhile supersedes it with the same batch at the new head,
   * never with an on_push run. True while that branch holds the PR (the ordinary triggers wait); false once it is done, or when the
   * tier has no mandatory opening combo (nothing gates on one).
   */
  function opening(c: Repo, p: PullRequest, policy: string, at: number): boolean {
    const must = c.on_open.filter((x) => x.mandatory);
    // A tier whose opening reviewers are all advice: its opening batch runs once when the run of heads starts, and holds nothing.
    // Any run queued under the policy since (a push batch that replaced it too) means it was asked for: never queued again.
    if (!must.length) {
      if (!c.on_open.length || one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND policy = ? AND kind != 'oneoff' AND created >= ?", p.repo, p.number, policy, at)) return false;
      trigger(c, p, "open", true);
      return true;
    }
    const has = (x: Combo, states: string) => !!one(`SELECT 1 FROM runs WHERE repo = ? AND number = ? AND policy = ? AND kind != 'oneoff' AND mandatory = 1 AND COALESCE(moment, 'open') = 'open' AND engine = ? AND model = ? AND effort = ? AND status IN (${states}) AND created >= ?`, p.repo, p.number, policy, x.engine, x.model, x.effort, at);
    if (must.every((x) => has(x, "'done', 'failed'"))) return false;
    if (!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND policy = ? AND kind != 'oneoff' AND mandatory = 1 AND COALESCE(moment, 'open') = 'open' AND status IN ('queued', 'running')", p.repo, p.number, p.head, policy))
      trigger(c, p, "open", true);
    return true;
  }

  async function command(cfg: Entry, c: { id: string; number: number; author: string; body: string }) {
    const cmd: Command | undefined = parseCommand(c.body);
    if (!cmd) return;
    // A failed read throws: the comment stays unhandled and is asked about again next tick.
    const perm = await d.source.permission(cfg.repo, c.author);
    if (!WRITERS.has(perm)) return log("a review command from someone without write access: ignored", { repo: cfg.repo, pr: c.number, author: c.author.slice(0, 40), permission: perm });
    let row = prRow(cfg.repo, c.number);
    if (!row || !row.open) {
      const p = await d.source.get(cfg.repo, c.number);
      if (!p.open) return;
      upsertPr(p);
      row = prRow(cfg.repo, c.number)!;
    }
    const p = { repo: row.repo, number: row.number, head: row.head, base: row.base, author: row.author };
    const a = (state: Ack["state"], o: Partial<Ack> = {}) => ack({ repo: p.repo, number: p.number, head: p.head, state, ...o });
    switch (cmd.cmd) {
      case "review": {
        // The head's tier's opening reviewers; a head not classified yet is asked about again next tick (never a guessed tier).
        const t = current(p.repo, p.number, p.head);
        if (!t) throw new Error(`${p.repo}#${p.number} at ${p.head.slice(0, 12)} isn't classified yet`);
        const runs = queue(p, t.c.on_open.length ? t.c.on_open : ADVICE, "command", { full: cmd.full, focus: row.focus, moment: "open" });
        return void a("queued", { run: runs[0]!.id, combo: comboOf(runs[0]!) });
      }
      case "always":
      case "stop":
        run("UPDATE prs SET mode = ? WHERE repo = ? AND number = ?", cmd.cmd, p.repo, p.number);
        if (cmd.cmd === "stop") for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued' AND kind = 'auto' AND mandatory = 0", p.repo, p.number)) skipQueued(q.id, "stopped: aiden review stop");
        if (cmd.cmd === "stop") return void a("skipped", { why: "stopped: aiden review stop" });
        return void a("answered", { answer: "always" });
      case "focus":
        run("UPDATE prs SET focus = ? WHERE repo = ? AND number = ?", cmd.text || null, p.repo, p.number);
        return void a("answered", { answer: cmd.text ? "focus" : "focus_cleared" });
      case "status": {
        // The acknowledgement shows where the PR's last run is: its phase, reviewer, findings and cost.
        const last = lastRunAck(p.repo, p.number);
        return void (last ? ack(last) : a("answered", { answer: "no_review" }));
      }
      default:
        return void a("answered", { answer: "help" });
    }
  }

  /**
   * A head's risk tier, when any input changed since its last classification (head, base, author kind or association, the repo's
   * class and rules): one consistent read of its files (the snapshot), the repo's rules, stored on its row with those inputs. A read
   * that fails or a PR that moved meanwhile leaves it pending; it is read again after AGAIN_MS.
   */
  async function classifyPr(cfg: Entry, p: PullRequest) {
    const row = prRow(p.repo, p.number);
    if (row?.cls === JSON.stringify(inputsOf(p, cfg))) return;
    // Changed inputs make the stored tier stale at once: pending until a snapshot of the new inputs lands, never the old tier.
    if (row?.cls) (run("UPDATE prs SET tier = NULL, rule = NULL, why = NULL, facts = NULL, cls = NULL WHERE repo = ? AND number = ?", p.repo, p.number), mirrorDue = true);
    let s: Awaited<ReturnType<PrSource["snapshot"]>>;
    try { s = await d.source.snapshot(p.repo, p.number); } catch (e) { return void log("a pull request's files couldn't be read; its tier is read again later", { repo: p.repo, pr: p.number, err: String((e as Error).message).slice(0, 200) }); }
    if ("moved" in s || s.pr.head !== p.head) return;
    const i = inputsOf(s.pr, cfg);
    const facts = factsOf(s.files, { author: i.author as Facts["author"], base: s.pr.base_ref, repo_class: cfg.repo_class });
    const c = s.changed_files > TOO_MANY_FILES ? tooMany(s.changed_files) : classify(facts, cfg.rules);
    run("UPDATE prs SET tier = ?, rule = ?, why = ?, facts = ?, cls = ? WHERE repo = ? AND number = ?", c.tier, c.rule, c.why.slice(0, 500),
      JSON.stringify({ ...facts, paths: facts.paths.slice(0, 50), paths_total: facts.paths.length }), JSON.stringify(i), p.repo, p.number);
    mirrorDue = true;
  }

  /**
   * The comment says the tier on every PR, edited in place. Reconciled on each look at the PR and each idle pass: a head or tier the comment hasn't said (stored in
   * `noted` once its write is taken) is said now, so a failed write, a restart or an upgrade all end with it said. Only when the PR's
   * slot is free (never over a waiting notice); a rule edit that changes only the why leaves the comment be.
   */
  async function noteTier(p: PullRequest) {
    const row = prRow(p.repo, p.number);
    const key = `${p.head}:${row?.tier}`;
    // A review says its own risk in its header, so the comment is for a PR no review will speak on (tier skip), or one that has it already
    // (kept current, edited in place): a reviewed PR gets no comment of its own.
    if (backlog(p) || !row?.tier || row.head !== p.head || row.noted === key || acking_(p.repo, p.number) || (row.tier !== "skip" && !ackOf(p.repo, p.number))) return;
    // A head a run already reported on keeps that run's notice (its phase, counts and review link): the run's own notices carry the tier line.
    const reported = lastRunAck(p.repo, p.number)?.head === p.head;
    if (reported || await ack({ repo: p.repo, number: p.number, head: p.head, state: "classified" })) run("UPDATE prs SET noted = ? WHERE repo = ? AND number = ? AND head = ?", key, p.repo, p.number, p.head);
  }

  /**
   * One PR as GitHub has it now (an event's read, or the bootstrap's list): its row, its tier (classified when an input changed), then
   * decide(). A head whose tier stays pending (its files couldn't be read, or the head moved during the read) is read again after
   * AGAIN_MS.
   */
  async function observe(cfg: Entry, p: PullRequest) {
    const was = prRow(p.repo, p.number);
    upsertPr(p);
    mirrorDue = true;
    await classifyPr(cfg, p);
    void noteTier(p); // not awaited: a slow comment write never delays queueing a review (the PR's slot, taken inside, guards a second)
    if (!decide(cfg, p, was)) again.set(`${p.repo}#${p.number}`, now() + AGAIN_MS);
    else again.delete(`${p.repo}#${p.number}`);
  }
  /**
   * The triggers for an open PR against its row before this look (`was`): a new PR or head, a draft marked ready, a PR never
   * reviewed, and a gated head missing a mandatory reviewer. With `was` the row itself (nothing changed on GitHub) only the last
   * two can act: the idle pass runs that every IDLE_MS, as a run settling or failing can change them. False while the head's tier
   * is pending: nothing is queued, never on a guessed tier.
   */
  function decide(cfg: Entry, p: PullRequest, was: PrRow | undefined): boolean {
    const t = current(p.repo, p.number, p.head);
    if (!t) return false;
    // The head the triggers last ran for: a push seen while its tier was pending is still a push once it is classified.
    const seen = was?.handled ?? was?.head;
    run("UPDATE prs SET handled = ? WHERE repo = ? AND number = ?", p.head, p.repo, p.number);
    const row = prRow(p.repo, p.number)!;
    // A head whose policy differs from the head before it starts a new run of heads under that policy.
    if (row.policy !== t.policy) {
      run("UPDATE prs SET policy = ?, policy_since = ?, policy_at = ? WHERE repo = ? AND number = ?", t.policy, p.head, now(), p.repo, p.number);
      t.at = now();
    }
    // Backlog (after the policy window is set, so a review asked for later counts under it): no automatic trigger.
    if (backlog(p)) return true;
    const c = t.c;
    // A draft too, where the repo reviews drafts.
    if ((!p.draft || c.drafts) && opening(c, p, t.policy, t.at)) return true;
    if (!was) trigger(c, p, "open");
    else if (seen !== p.head) trigger(c, p, pushed(p) ? "push" : "open");
    else if (was.draft && !p.draft && !runsOn(p)) trigger(c, p, "open");
    else if (!p.draft && !anyRun(p)) trigger(c, p, "open");
    // A gated tier's open head missing a mandatory reviewer under its policy gets it.
    else if (!p.draft && gated(c)) missing(c, p, t.policy, t.at);
    return true;
  }
  /** A PR's row as the PullRequest decide() takes: what the triggers read of it. */
  const rowPr = (r: PrRow): PullRequest => ({ repo: r.repo, number: r.number, head: r.head, base: r.base, base_ref: "", draft: !!r.draft, fork: !!r.fork, author: r.author, open: !!r.open, url: `https://github.com/${r.repo}/pull/${r.number}` });
  /** A PR that left the open list: its findings' outcome (merged: open at merge; else open at close), queued runs skipped, its review task's close due. */
  function closePr(repo: string, n: number, merged: boolean | undefined) {
    if (one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND outcome IS NULL", repo, n) && merged !== undefined)
      run("UPDATE findings SET outcome = ?, outcome_at = ? WHERE repo = ? AND number = ? AND outcome IS NULL", merged ? "open_at_merge" : "open_at_close", iso(), repo, n);
    for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND status = 'queued'", repo, n)) skipQueued(q.id, "closed");
    // Its review task held only its posts' approvals: done with the PR. The close is tried each tick until it lands (closeTasks).
    run("UPDATE prs SET open = 0, merged = COALESCE(?, merged), close_due = EXISTS (SELECT 1 FROM runs WHERE repo = ? AND number = ? AND write_id IS NOT NULL) WHERE repo = ? AND number = ?", merged === undefined ? null : merged ? 1 : 0, repo, n, repo, n);
    again.delete(`${repo}#${n}`);
    mirrorDue = true;
  }
  /** One PR named by the feed (or due again): read once, then observed while open, closed otherwise. */
  async function prEvent(cfg: Entry, n: number) {
    const p = await d.source.get(cfg.repo, n);
    if (p.open) await observe(cfg, p);
    else if (prRow(cfg.repo, n)?.open) closePr(cfg.repo, n, !!p.merged);
  }
  /** One PR conversation comment, once (its id, recorded once handled): a command from someone with write access. A transient
   * failure throws (the comment stays unhandled); a refusal (a 4xx) is final: the comment is seen and passed over. */
  async function comment(cfg: Entry, c: PrComment) {
    if (one("SELECT 1 FROM seen WHERE repo = ? AND comment = ?", cfg.repo, c.id)) return;
    try {
      await command(cfg, c);
    } catch (e) {
      if (!permanent(e)) throw e;
      log("review command refused by GitHub; passed over", { repo: cfg.repo, pr: c.number, err: String((e as Error).message).slice(0, 200) });
    }
    run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, c.id);
  }

  /**
   * One watched repo read whole (the feed's catch-up: this service's start, a gap in the kernel's log, the feed's resync of the
   * repo, or an event whose handling failed): its open PRs' heads (each classified first), the PRs that left the list, the comments
   * since the last bootstrap, and the answers on every PR with findings. The first look reviews what is open like a new PR.
   */
  async function bootstrap(cfg: Entry) {
    const cursor = one<{ comments: string }>("SELECT comments FROM cursors WHERE repo = ?", cfg.repo);
    const open = await d.source.open(cfg.repo);
    // The first look: every PR open now but its newest is backlog, recorded as they are. A PR number above one of them that is open
    // later is a PR opened after the look, and is reviewed; one of these closed and reopened stays backlog until it is asked for.
    if (!cursor) {
      const newest = Math.max(0, ...open.map((p) => p.number));
      for (const p of open) if (p.number !== newest) run("INSERT OR IGNORE INTO cutoffs (repo, number) VALUES (?, ?)", cfg.repo, p.number);
      // The cursor goes in with the snapshot: a retry after a failed read is no first look, so the set stays the one first seen.
      run("INSERT OR IGNORE INTO cursors (repo, comments) VALUES (?, ?)", cfg.repo, iso());
    }
    const seenNow = new Set(open.map((p) => p.number));
    for (const p of open) await observe(cfg, p);
    for (const gone of all<{ number: number }>("SELECT number FROM prs WHERE repo = ? AND open = 1", cfg.repo)) {
      if (seenNow.has(gone.number)) continue;
      // Read once: still open (the list shifted between pages) is observed, a merge or close says whether its findings are open at a
      // merge or at a close. A read that fails throws: the repo is read whole again, never closed on a guess.
      await prEvent(cfg, gone.number).catch((e) => { if (!permanent(e)) throw e; closePr(cfg.repo, gone.number, undefined); });
    }
    if (cursor) {
      const got = await d.source.comments(cfg.repo, cursor.comments);
      // One that fails stops here: the cursor stays, and the repo is read again from it (what was handled is skipped by id).
      for (const c of got.comments) await comment(cfg, c);
      run("UPDATE cursors SET comments = ? WHERE repo = ?", got.cursor, cfg.repo);
    }
    // Every watched repo: an earlier mandatory run's finding may still hold a merge whatever the tiers now say, so its answers count.
    for (const p of all<{ number: number }>("SELECT number FROM prs WHERE repo = ? AND open = 1", cfg.repo)) await claims(cfg, p.number);
    idleAt = now();
  }

  /**
   * The feed: the kernel's log of the github change feed's events on the watched repos (module.yaml `subscribes:`), read each tick
   * after the last seq handled. Each PR it names is read once and observed; a comment is a command; a review reply reads that PR's
   * threads; a resync reads the repo whole. Nothing is lost when a handler fails: its repo is read whole on the next tick (a
   * refusal, a 4xx, is final and logged). The cursor is this process's: a start reads every repo whole (an apply restarts it, so a
   * settings change is read whole too), as does a gap in the log.
   */
  async function feed() {
    const repos = new Map(d.config().repos.map((c) => [c.repo, c]));
    if (after === undefined) {
      // A repo taken off the watched list forgets its first look: adding it again is a new first look.
      for (const r of all<{ repo: string }>("SELECT repo FROM cursors")) if (!repos.has(r.repo)) { run("DELETE FROM cursors WHERE repo = ?", r.repo); run("DELETE FROM cutoffs WHERE repo = ?", r.repo); }
      after = (await d.feed()).next;
      for (const r of repos.keys()) boot.add(r);
    }
    const page = await d.feed(after);
    if (page.gap) for (const r of repos.keys()) boot.add(r);
    // Coalesced: each PR once per page, each comment once, each PR's threads once.
    const prs = new Map<string, { cfg: Entry; n: number }>(), threads = new Map<string, { cfg: Entry; n: number }>();
    const comments: { cfg: Entry; c: PrComment }[] = [];
    for (const e of page.events) {
      const cfg = repos.get(e.resource.toLowerCase());
      if (!cfg) continue;
      const n = Number(e.data?.number);
      if (e.kind === "github.resync") boot.add(cfg.repo);
      else if (e.kind === "pull_request_review_comment.created") threads.set(`${cfg.repo}#${n}`, { cfg, n });
      else if (e.kind.startsWith("pull_request.")) prs.set(`${cfg.repo}#${n}`, { cfg, n });
      // A clipped comment (over 2,000 characters) is never a command: a command is one short line, and the rest can't be checked.
      else if (e.kind === "issue_comment.created" && e.data?.pr === true && !e.truncated)
        comments.push({ cfg, c: { id: e.id.replace(/^comment:/, ""), number: n, author: e.author ?? "", body: e.text ?? "", created_at: String(e.data?.created_at ?? iso()) } });
    }
    const failed = (repo: string, what: string, e: unknown) => {
      if (permanent(e)) return void log(`${what} refused by GitHub; passed over`, { repo, err: String((e as Error).message).slice(0, 200) });
      log(`${what} not handled; the repo is read whole next tick`, { repo, err: String((e as Error).message).slice(0, 200) });
      boot.add(repo);
    };
    for (const { cfg, n } of prs.values()) if (!boot.has(cfg.repo)) await prEvent(cfg, n).catch((e) => failed(cfg.repo, `pull request #${n}`, e));
    // A comment is kept until it is handled: one on a repo still to be read whole, or whose handling failed, is tried again each tick
    // (a bootstrap's comment read starts only where the last one ended, so it can't stand in for these).
    for (const x of comments) commentsDue.set(`${x.cfg.repo}:${x.c.id}`, x);
    for (const { cfg, n } of threads.values()) claimsDue.add(`${cfg.repo}#${n}`);
    after = page.next;
  }
  /** An open PR that was already open at its repo's first look (but not that look's newest, which it reviews) and that nothing has
   * reviewed or been asked to review: left alone. The recorded set decides, never the number, so one opened later is reviewed. */
  const backlog = (p: { repo: string; number: number }) => prRow(p.repo, p.number)?.mode !== "always" && !!one("SELECT 1 FROM cutoffs WHERE repo = ? AND number = ?", p.repo, p.number) && !anyRun(p);
  const anyRun = (p: PullRequest) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ?", p.repo, p.number);
  /** A new head is a push (on_push, from the baseline) once any review of the PR (but a one-off) completed, whatever became of
   * its post; until then (a push before it finished) the newest head gets the opening review. A skipped or superseded run never
   * counts, and nothing waits on coverage: a partial review is still a review. */
  const pushed = (p: PullRequest) => !!one("SELECT 1 FROM runs JOIN reviews ON reviews.run = runs.id WHERE repo = ? AND number = ? AND kind != 'oneoff' AND status != 'skipped' AND complete IS NOT NULL", p.repo, p.number);
  /** A gated repo's open head with no mandatory run at all (a PR open when its repo became gated) gets its trigger: its opening
   * review until a mandatory one reviewed the PR. A head that has one is never queued again here: a changed setting applies from
   * the next head. */
  function missing(cfg: Repo, p: PullRequest, policy: string, at: number) {
    const mandatory = (head?: string) => !!one(`SELECT 1 FROM runs WHERE repo = ? AND number = ? AND mandatory = 1 AND kind != 'oneoff' AND policy = ? AND created >= ?${head ? " AND head = ?" : ""}`, p.repo, p.number, policy, at, ...(head ? [head] : []));
    // No mandatory on_push: a later head needs no review of its own, only a PR never reviewed by a mandatory combo gets one.
    if (openOnlyPr(cfg, p.number)) {
      // Its opening review lacks a mandatory run (a push superseded one): the newest head gets each such combo (as a batch of its
      // own, so the push's queued advice stays); none at all yet (a PR open when its repo became gated): every mandatory combo. One
      // such batch still queued for an older head is superseded first.
      for (const q of all<RunRow>("SELECT * FROM runs WHERE repo = ? AND number = ? AND head != ? AND mandatory = 1 AND kind = 'command' AND COALESCE(moment, 'open') = 'open' AND status = 'queued'", p.repo, p.number, p.head)) skipQueued(q.id, "superseded: a newer push");
      if (one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND mandatory = 1 AND status IN ('queued', 'running')", p.repo, p.number)) return;
      const opening = gateRuns(cfg, p.repo, p.number, p.head, policy, at).filter((r) => (r.moment ?? "open") === "open");
      const lacking: Combo[] = opening.length ? opening.filter((r) => r.status === "skipped").map((r) => ({ engine: r.engine as Combo["engine"], model: r.model, effort: r.effort, mandatory: true })) : cfg.on_open.filter((c) => c.mandatory);
      if (lacking.length) queue(p, lacking, "command", { focus: prRow(p.repo, p.number)?.focus ?? null, moment: "open" });
      return;
    }
    if (!mandatory(p.head)) trigger(cfg, p, pushed(p) && mandatory() ? "push" : "open");
  }
  const runsOn = (p: PullRequest) => !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND status != 'skipped'", p.repo, p.number);

  const CLOSE_MS = 10_000;
  /** Closes the review tasks of PRs found closed, side by side and each bounded; one that fails or hangs is tried again next tick. */
  async function closeTasks() {
    await Promise.all(all<{ repo: string; number: number }>("SELECT repo, number FROM prs WHERE open = 0 AND close_due = 1").map(async (g) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([d.poster.close(g.repo, g.number, "The pull request is closed."), new Promise((_, no) => { timer = setTimeout(() => no(new Error("close timed out")), CLOSE_MS); })]);
      } catch (e) {
        log("review task not closed", { repo: g.repo, pr: g.number, err: String((e as Error).message).slice(0, 200) });
        if (!permanent(e)) return;
      } finally {
        clearTimeout(timer);
      }
      run("UPDATE prs SET close_due = 0 WHERE repo = ? AND number = ?", g.repo, g.number);
    }));
  }

  const errors = new Map<string, string>();
  const said = (key: string, msg: string, what: string, f: Record<string, unknown>) => { if (errors.get(key) !== msg) log(what, { ...f, err: msg }); errors.set(key, msg); };
  /** Something a verdict reads changed since the status mirror last ran (the tick runs it then, and every IDLE_MS for its retries). */
  let mirrorDue = true, mirroredAt = 0;
  /** The feed's cursor (the last log seq handled; undefined until this process's first read), the repos to read whole, the PRs
   * whose tier is pending (read again when due) and the PRs whose review threads are to be read. */
  let after: number | undefined;
  const boot = new Set<string>(), again = new Map<string, number>(), claimsDue = new Set<string>(), commentsDue = new Map<string, { cfg: Entry; c: PrComment }>();
  /** When the idle pass (decide() on every open PR from its row: no GitHub read) last ran. */
  let idleAt = 0;
  /**
   * One tick (every 10 seconds): the feed's events and the repos it asks to read whole, then what the kernel answers (finished
   * checks, filed posts, due runs) and the status mirror.
   */
  async function tick() {
    try {
      await tickWork();
    } finally {
      await closeTasks();
    }
  }
  async function tickWork() {
    const repos = new Map(d.config().repos.map((c) => [c.repo, c]));
    try { await feed(); errors.delete("feed"); } catch (e) { said("feed", String((e as Error).message).slice(0, 200), "the feed's log not read; the next tick asks again", {}); }
    for (const r of [...boot]) {
      const cfg = repos.get(r);
      if (!cfg) { boot.delete(r); continue; }
      try { await bootstrap(cfg); boot.delete(r); errors.delete(r); } catch (e) { said(r, String((e as Error).message).slice(0, 200), "repo not read; the next tick asks again", { repo: r }); }
    }
    for (const [k, { cfg, c }] of [...commentsDue]) {
      if (!repos.has(cfg.repo)) { commentsDue.delete(k); continue; }
      if (boot.has(cfg.repo)) continue;
      try { await comment(cfg, c); commentsDue.delete(k); } catch (e) { log("review command not handled; tried again next tick", { repo: cfg.repo, pr: c.number, err: String((e as Error).message).slice(0, 200) }); }
    }
    for (const [k, due] of [...again]) {
      if (due > now()) continue;
      const [r, n] = [k.slice(0, k.lastIndexOf("#")), Number(k.slice(k.lastIndexOf("#") + 1))];
      const cfg = repos.get(r);
      if (!cfg) { again.delete(k); continue; }
      again.set(k, now() + AGAIN_MS);
      await prEvent(cfg, n).catch((e) => { if (permanent(e)) again.delete(k); log("a pull request not read; asked again later", { repo: r, pr: n, err: String((e as Error).message).slice(0, 200) }); });
    }
    for (const k of [...claimsDue]) {
      const r = k.slice(0, k.lastIndexOf("#")), cfg = repos.get(r);
      if (cfg) await claims(cfg, Number(k.slice(k.lastIndexOf("#") + 1)));
      else claimsDue.delete(k);
    }
    if (now() - idleAt >= IDLE_MS) {
      idleAt = now();
      // The tier comment too: one whose write failed is said again here.
      for (const r of all<PrRow>("SELECT * FROM prs WHERE open = 1")) { const cfg = repos.get(r.repo); if (cfg) { decide(cfg, rowPr(r), r); void noteTier(rowPr(r)); } }
    }
    await replies();
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'pending' AND write_id IS NOT NULL")) await settle(r);
    // A `retry` row's deadline is written with its state; one without a deadline (a row this service left before it wrote both)
    // is filed again now rather than never.
    for (const r of all<RunRow>("SELECT * FROM runs WHERE posted = 'retry' AND (post_due IS NULL OR post_due <= ?)", now())) await repost(r);
    for (const [write, t] of [...acking]) {
      if (write.startsWith("slot:")) continue;
      const o = await d.poster.outcome(write).catch(() => ({ state: "pending" as const }));
      if (o.state === "pending") continue;
      acking.delete(write);
      acked(t.repo, t.number, o, write);
    }
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'running' AND check_job IS NOT NULL")) {
      waiting.delete(r.id);
      const res = await d.runner.result(r.check_job!).catch((e) => ({ state: "running" as const, err: e }));
      if (res.box_at && !("err" in res)) run("UPDATE runs SET box_at = COALESCE(box_at, ?) WHERE id = ?", res.box_at, r.id);
      if (res.state !== "running") {
        // One run that can't be applied now (the catalog unreadable, deepsec's records not readable from the kernel) is asked again
        // next tick; it never stops the others.
        await (async () => { if (r.engine === "deepsec") await absorbDeepsec(r); await finish(r, res); })()
          .catch((e) => void log("a finished run couldn't be applied; the next tick asks again", { run: r.id, err: String((e as Error).message).slice(0, 200) }));
      } else {
        if (res.waiting && !("err" in res)) waiting.add(r.id);
        if (res.billed_usd !== undefined && !("err" in res)) live.set(r.id, res.billed_usd);
        else live.delete(r.id);
      }
    }
    for (const b of all<{ id: string; report_write: string }>("SELECT id, report_write FROM batches WHERE report_write IS NOT NULL"))
      published(b.id, await d.publisher.outcome(b.report_write).catch(() => ({ state: "pending" as const, write: b.report_write })));
    for (const b of all<{ id: string }>("SELECT id FROM batches WHERE status = 'done' AND report IS NOT NULL AND report_write IS NULL AND report_url IS NULL AND report_why IS NULL")) await publishReport(b.id);
    // A repo review whose last run ended before a restart (or whose report didn't render) gets its report now.
    for (const b of all<{ id: string }>("SELECT id FROM batches WHERE status = 'running'")) await batchEnded(b.id);
    for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'queued' AND due <= ? ORDER BY created, rowid", now())) {
      // An automatic review starts only for the head it was queued for, under the policy it was queued under: a newer push or a
      // changed policy (a new tier's reviewers, a settings edit) supersedes it; a head whose tier is pending waits.
      if (r.target === "pr" && r.kind === "auto" && repoCfg(r.repo)) {
        const p = prRow(r.repo, r.number);
        if (p?.open && p.head !== r.head) { skipQueued(r.id, "superseded: a newer push"); continue; }
        const t = p?.open ? current(r.repo, r.number, r.head) : undefined;
        if (p?.open && !t) continue;
        if (t && r.policy && t.policy !== r.policy) { skipQueued(r.id, "superseded: the head's review policy changed"); continue; }
      }
      // A repo review's runs start together, each its own check in its own box (metered by the gateway like any run), up to
      // TREE_RUNNING at once.
      if (r.target === "tree" && one<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE target = 'tree' AND status = 'running'")!.n >= TREE_RUNNING) continue;
      const started = admit(r);
      if (started) await startRun(started);
      else if (r.target === "tree") await batchEnded(r.batch);
    }
    // Last, and in one pass: every refusal this tick is recorded by now (a settled post, a re-filed one, a run that finished), so
    // each pending notice is delivered exactly once this tick, by the only path that does it.
    for (const r of all<RunRow>("SELECT * FROM runs WHERE notice = 'pending' AND (notice_due IS NULL OR notice_due <= ?)", now())) await deliver(r);
    if (mirrorDue || now() - mirroredAt >= IDLE_MS) { mirrorDue = false; mirroredAt = now(); await mirror(); }
    // Every one-off summary a request settled in this tick (or an earlier tick couldn't send) goes now, one per asker.
    await sendSummaries();
  }

  // ---- the verdict on GitHub: the commit status aidenhq/review ---------------------------------------------------------------

  /** What the status says for a PR's head: verdict()'s first reason (pending ones come first), the open gating findings and the
   * mandatory reviewers still to finish. */
  function mirrored(repo: string, n: number, head: string): Mirror {
    const v = verdict(repo, n, head);
    const busy = all<{ model: string; effort: string; status: string }>("SELECT model, effort, status FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND status IN ('queued', 'running') ORDER BY created", repo, n, head);
    // A pass with a mandatory reviewer it needs whose latest run at the head failed past its retries (no review stored) says so: it
    // passes without that review, never looks reviewed.
    const t = current(repo, n, head);
    const runs = t && gated(t.c) ? gateRuns(t.c, repo, n, head, t.policy, t.at) : [];
    const failed = !v.reasons.length && runs.some((r) => r.status === "failed" && !one("SELECT 1 FROM reviews WHERE run = ?", r.id));
    const code = v.reasons[0]?.code ?? (failed ? "failed" : "pass");
    const reason = code === "running" && !busy.some((r) => r.status === "running") ? "queued" : code;
    // Partial coverage (a file no finder read whole, a withheld finding, an unchecked recheck) is information: shown, never waited on.
    const partial = t && openOnlyPr(t.c, n) ? runs.some((r) => r.complete === 0)
      : !!one("SELECT 1 FROM runs WHERE repo = ? AND number = ? AND head = ? AND mandatory = 1 AND complete = 0 AND policy IS ?", repo, n, head, t?.policy ?? null);
    return { repo, number: n, head, reason, important: openGating(repo, n).length, running: busy.map((r) => ({ model: r.model, effort: r.effort })), ...(partial ? { partial: true } : {}) };
  }
  /** Status writes GitHub or the kernel refused, by repo and head: tried again after STATUS_RETRY or once the verdict changes. */
  const statusFailed = new Map<string, { key: string; at: number }>();
  /** Status writes filed and not settled yet, by repo and head: the key is saved only once GitHub has it. */
  const statusFiled = new Map<string, { key: string; write: string }>();
  const STATUS_RETRY = 5 * 60_000;
  const PENDING = new Set(["queued", "running", "not_started", "moved"]);
  /**
   * Mirrors each gated repo's open PRs' verdict to their head's commit status, written only when it changes (prs.status_key):
   * the only writer of aidenhq/review. A draft gets none (it isn't merged).
   */
  async function mirror() {
    // A repo no longer gated (or no longer watched) retires the statuses it published: success, saying so, once.
    const gatedRepos = new Set(d.config().repos.filter(gatesAny).map((c) => c.repo));
    for (const p of all<{ repo: string; number: number; head: string }>("SELECT repo, number, head FROM prs WHERE open = 1 AND status_key IS NOT NULL AND status_key != 'retired'")) {
      if (gatedRepos.has(p.repo)) continue;
      // Filed and pending: settled on later ticks (its write id kept), never filed again meanwhile.
      const id = `${p.repo}@${p.head}`;
      let filed = statusFiled.get(id);
      // A verdict status still in flight from before: settled first, then the retirement filed.
      if (filed && filed.key !== "retired") {
        if ((await d.poster.outcome(filed.write).catch(() => ({ state: "pending" as const }))).state === "pending") continue;
        statusFiled.delete(id);
        filed = undefined;
      }
      const o: Posted = filed ? await d.poster.outcome(filed.write).catch(() => ({ state: "pending" as const }))
        : await d.poster.status({ repo: p.repo, number: p.number, head: p.head, reason: "ungated", important: 0, running: [] }).catch(() => ({ state: "refused" as const }));
      if (o.state === "pending" && (o.write ?? filed?.write)) { statusFiled.set(id, { key: "retired", write: (o.write ?? filed?.write)! }); continue; }
      statusFiled.delete(id);
      if (o.state === "posted") run("UPDATE prs SET status_key = 'retired' WHERE repo = ? AND number = ?", p.repo, p.number);
    }
    for (const cfg of d.config().repos) {
      if (!gatesAny(cfg)) continue;
      // A status is per commit: PRs sharing a head get one, the least ready of their verdicts (a failure, then a backlog needing an
      // ask, then a review in progress, then a pass with a failed review's warning, then pass).
      const prs = all<{ number: number; head: string; status_key: string | null }>("SELECT number, head, status_key FROM prs WHERE repo = ? AND open = 1 AND draft = 0", cfg.repo);
      const heads = new Map<string, Mirror>();
      // Least ready wins: a failure, then backlog (it needs an ask), then a review in progress, then a pass with a failed review, then a pass.
      const rank = (m: Mirror) => (m.reason === "pass" ? 4 : m.reason === "failed" ? 3 : PENDING.has(m.reason) ? 2 : m.reason === "backlog" ? 1 : 0);
      for (const p of prs) { const m = mirrored(cfg.repo, p.number, p.head), had = heads.get(p.head); if (!had || rank(m) < rank(had)) heads.set(p.head, m); }
      for (const p of prs) {
        const id = `${cfg.repo}@${p.head}`;
        const saved = (key: string, o: Posted) => {
          if (o.state === "pending") {
            // A pending outcome read back carries no write id: keep the one filed. None known: nothing to settle, filed again later.
            const write = o.write ?? statusFiled.get(id)?.write;
            return void (write ? statusFiled.set(id, { key, write }) : statusFiled.delete(id));
          }
          statusFiled.delete(id);
          if (o.state === "refused") return void (statusFailed.set(id, { key, at: now() }), log("review status not set", { repo: cfg.repo, pr: p.number, why: String(o.why ?? "").slice(0, 200) }));
          statusFailed.delete(id);
          run("UPDATE prs SET status_key = ? WHERE repo = ? AND head = ? AND open = 1", key, cfg.repo, p.head);
          for (const q of prs) if (q.head === p.head) q.status_key = key;
        };
        const filed = statusFiled.get(id);
        if (filed) {
          saved(filed.key, await d.poster.outcome(filed.write).catch(() => ({ state: "pending" as const, write: filed.write })));
          if (statusFiled.has(id)) continue;
        }
        const s = heads.get(p.head)!;
        // One status per head: its verdict. The stages before it (queued, reviewing) are not written, unless the head shows an earlier
        // verdict (red or green) that is being reviewed again: that one pending write replaces it; an unreported check already waits.
        // (the saved verdict may be an earlier head's: upsertPr moves the head and keeps the key)
        const saved_ = p.status_key?.startsWith("{") ? (JSON.parse(p.status_key) as Mirror) : undefined;
        const shown = saved_?.head === p.head ? saved_.reason : undefined;
        if (PENDING.has(s.reason) && (!shown || PENDING.has(shown))) continue;
        const key = JSON.stringify(s), failed = statusFailed.get(id);
        if (key === p.status_key || (failed?.key === key && now() - failed.at < STATUS_RETRY)) continue;
        saved(key, await d.poster.status(s).catch((e) => ({ state: "refused" as const, why: String((e as Error).message).slice(0, 200) })));
      }
    }
  }

  // ---- answers: a reply on a gating finding's thread closes it ---------------------------------------------------------------

  /** A reply that answers a finding: its first word (fixed, disputed, by design, won't fix) and the reason after it. */
  const ANSWER = /^\s*(fixed|disputed|by design|won['’]?t fix)\b[\s:,.;\-–—]*([\s\S]*)$/i;
  /** A resolution word (and its separator) a reason starts with, repeated. */
  /** An answer's word as it is stored and shown: lower case, no apostrophe, `won't fix`. */
  const wordOf = (w: string) => w.toLowerCase().replace(/['’]/g, "").replace("wont", "won't");
  const LEADING_WORD = /^(?:\s*(?:fixed|disputed|by design|won['’]?t fix)(?::|\s+[-–—])\s*)+/i;
  /** The answer in a reply: its word and its reason, which must say something (letters, not only punctuation or a signature). */
  const answerOf = (body: string) => {
    if (body.includes("<!-- aidenhq-")) return undefined; // our own posts (a mirrored answer, a review) never answer a finding
    const m = ANSWER.exec(body.split("\n").filter((l) => !/\]\(https:\/\/aidenhq\.ai\b/.test(l)).join("\n"));
    const reason = m?.[2]?.trim() ?? "";
    return m && /\p{L}{2,}/u.test(reason) ? { word: m[1]!, reason } : undefined;
  };
  /** The one way an answer closes an open finding (fixed, else dismissed), whatever carried it (a thread reply, an agent's call): kept as the finding's claim. */
  function answer(at: { repo: string; number: number; head: string }, id: string, word: string, reason: string, by: string, evidence: string | null, label: string) {
    const w = wordOf(word);
    const claim = `${w}: ${reason.replace(LEADING_WORD, "")}`.slice(0, 1500), outcome = w === "fixed" ? "fixed" : "dismissed";
    // Every answer closes the finding at once; a later review reopens it only if it finds the fix or the reason unsafe.
    const changed = tx(() => {
      const c = run("UPDATE findings SET outcome = ?, outcome_at = ?, claim = ? WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", outcome, iso(), claim, at.repo, at.number, id).changes;
      if (c) dispose([id], at, outcome, `${label}: ${claim}`, by, evidence);
      return c;
    });
    if (changed) mirrorDue = true;
    return changed;
  }

  /** An agent's answer to an open finding, recorded in the store with no GitHub write: the same words and reason a thread reply carries. */
  function resolve(b: { repo?: unknown; number?: unknown; id?: unknown; word?: unknown; reason?: unknown; by?: unknown }) {
    const repo = String(b.repo ?? "").toLowerCase(), n = Number(b.number), id = String(b.id ?? "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(n) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RequestError("give repo, number and the finding's id");
    // The reason is what the answer says after its word: one that repeats the word ("fixed: the check now …") is read without it, so the
    // thread shows `fixed: the check now …`, never `fixed: fixed: …`.
    const word = String(b.word ?? "").trim(), reason = typeof b.reason === "string" ? b.reason.trim().replace(LEADING_WORD, "") : "";
    if (!/^(fixed|disputed|by design|won['’]?t fix)$/i.test(word)) throw new RequestError("word is one of fixed, disputed, by design or won't fix");
    if (!/\p{L}{2,}/u.test(reason) || reason.length > 1500) throw new RequestError("reason says what changed or why (letters, at most 1500 characters)");
    const p = prRow(repo, n);
    if (!p) throw new RequestError(`no reviewed pull request ${repo}#${n}`);
    const severity = one<{ severity: string }>("SELECT severity FROM findings WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL ORDER BY rowid DESC LIMIT 1", repo, n, id)?.severity;
    if (!answer(p, id, word, reason, String(b.by ?? "agent").slice(0, 100), null, "answered by an agent")) throw new RequestError(`finding ${id} isn't open on ${repo}#${n}`);
    // An important finding's answer is also replied on its thread (so it shows closed): queued here (a newer answer replaces an older queued one), posted by `replies` and never holding the outcome. A nit gets none.
    if (severity === "important") run("INSERT OR REPLACE INTO replies (repo, number, finding, body, due) VALUES (?, ?, ?, ?, ?)", repo, n, id, `${wordOf(word)}: ${reason}`.slice(0, 1600), now());
    return { resolved: id };
  }

  /** The queued thread replies of recorded answers: filed once the finding's thread is known, their outcome read, a refusal filed again
   * later (POST_RETRY doubling, POST_TRIES times) while the PR is open; then dropped. Nothing here ever changes a finding's outcome. */
  async function replies() {
    for (const q of all<{ repo: string; number: number; finding: string; body: string; write: string | null; tries: number }>("SELECT repo, number, finding, body, write, tries FROM replies WHERE due <= ?", now())) {
      const key = [q.repo, q.number, q.finding];
      const open = !!prRow(q.repo, q.number)?.open;
      let o: Posted;
      try {
        if (q.write) o = await d.poster.outcome(q.write);
        else {
          const t = (await d.source.threads(q.repo, q.number)).find((x) => x.finding === q.finding);
          // The agent already gave this answer on the thread itself (a reply that starts with the word and gives a reason): one answer per thread, so no mirror.
          if (t?.replies.some((x) => { const m = answerOf(x.body); return m && wordOf(m.word) === q.body.split(":")[0]; })) { run("DELETE FROM replies WHERE repo = ? AND number = ? AND finding = ?", ...key); continue; }
          if (!t) o = { state: "refused", why: "its thread isn't on the pull request (yet)", retry: true };
          else o = await d.poster.reply({ repo: q.repo, number: q.number, head: prRow(q.repo, q.number)!.head, comment: t.comment, body: q.body });
          if (o.write) run("UPDATE replies SET write = ? WHERE repo = ? AND number = ? AND finding = ?", o.write, ...key);
        }
      } catch (e) {
        o = { state: "refused", why: String((e as Error).message).slice(0, 200), retry: true };
      }
      if (o.state === "pending") continue;
      if (o.state === "posted" || !open || !o.retry || q.tries + 1 >= POST_TRIES) { run("DELETE FROM replies WHERE repo = ? AND number = ? AND finding = ?", ...key); continue; }
      log("answer reply not posted; filing it once more", { repo: q.repo, pr: q.number, why: String(o.why ?? "").slice(0, 200) });
      run("UPDATE replies SET write = NULL, tries = tries + 1, due = ? WHERE repo = ? AND number = ? AND finding = ?", now() + POST_RETRY * 2 ** Math.min(q.tries, 4), ...key);
    }
  }

  /**
   * A gated repo's open PRs with open gating findings: a reply on Aiden's own thread for one (the service recorded the thread's
   * first comment from its post, or from the marker of a thread posted before it recorded them) from the PR's author (not a fork's: an outsider) or someone with write access now, starting
   * with fixed, disputed, by design or won't fix and giving a reason, closes the finding (fixed, else dismissed) with that claim.
   * The next mandatory recheck reads each claim and opens the finding again only if it finds the fix or the reason unsafe. Any
   * other reply is conversation. Each reply is read once.
   */
  async function claims(cfg: Entry, n: number) {
    claimsDue.delete(`${cfg.repo}#${n}`);
    for (const p of all<{ number: number; author: string; fork: number; head: string }>("SELECT number, author, fork, head FROM prs WHERE repo = ? AND number = ? AND open = 1", cfg.repo, n)) {
      const open = new Set(openGating(cfg.repo, p.number).map((f) => f.id));
      // Only a PR with an important finding a mandatory run made: an answer to anything else can't move a merge.
      if (!one("SELECT 1 FROM findings f JOIN runs r ON r.id = f.run WHERE f.repo = ? AND f.number = ? AND f.severity = 'important' AND r.mandatory = 1", cfg.repo, p.number)) continue;
      // A read that fails is asked again on a later tick.
      const threads = await d.source.threads(cfg.repo, p.number).catch((e) => (claimsDue.add(`${cfg.repo}#${p.number}`), log("a pull request's threads couldn't be read; its replies are read again next tick", { repo: cfg.repo, pr: p.number, err: String((e as Error).message).slice(0, 200) }), [] as Thread[]));
      for (const t of threads) {
        // Each reply is read once, whether or not its finding is open now: one that arrives while the finding is closed is consumed
        // as nothing, so only a reply posted after it reopens can close it again.
        if (!t.finding || !one("SELECT 1 FROM findings WHERE repo = ? AND number = ? AND id = ?", cfg.repo, p.number, t.finding)) continue;
        // A thread posted before the service recorded its posts' comments (deployed 2026-11-21): its first comment's marker names
        // an open finding of this PR, so it is recorded as that finding's thread. The marker only maps a reply to its finding: who
        // may answer is still the author or a writer. Its replies were never read (never seen), so each is handled below.
        if (!one("SELECT 1 FROM comments WHERE repo = ? AND comment = ?", cfg.repo, t.comment)) {
          const by = one<{ run: string }>("SELECT run FROM findings WHERE repo = ? AND number = ? AND id = ? ORDER BY rowid DESC LIMIT 1", cfg.repo, p.number, t.finding);
          run("INSERT OR IGNORE INTO comments (repo, number, comment, run) VALUES (?, ?, ?, ?)", cfg.repo, p.number, t.comment, by!.run);
        }
        for (const r of t.replies) {
          const key = `reply:${r.id}`;
          if (one("SELECT 1 FROM seen WHERE repo = ? AND comment = ?", cfg.repo, key)) continue;
          if (!open.has(t.finding)) {
            // Not gating: consumed, unless it is an important finding of a mandatory run whose post hasn't settled (left unread: its
            // post settling reads the PR's threads again).
            if (!one("SELECT 1 FROM findings f JOIN runs x ON x.id = f.run WHERE f.repo = ? AND f.number = ? AND f.id = ? AND f.outcome IS NULL AND f.severity = 'important' AND x.mandatory = 1 AND x.posted != 'posted'", cfg.repo, p.number, t.finding)) run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, key);
            continue;
          }
          const m = answerOf(r.body);
          let may = !!m && r.author.toLowerCase() === p.author && !p.fork;
          // A writer's role read that fails leaves the reply unread (the PR's threads are read again next tick); a refusal is no write access.
          if (m && !may) { try { may = WRITERS.has(await d.source.permission(cfg.repo, r.author)); } catch (e) { if (!permanent(e)) { claimsDue.add(`${cfg.repo}#${p.number}`); log("an answer's author couldn't be checked; read again next tick", { repo: cfg.repo, pr: p.number, err: String((e as Error).message).slice(0, 200) }); return; } } }
          if (m && !may) log("an answer from someone who isn't the PR's author and has no write access: ignored", { repo: cfg.repo, pr: p.number, author: r.author.slice(0, 40) });
          if (m && may) {
            answer({ repo: cfg.repo, number: p.number, head: p.head }, t.finding, m.word, m.reason, `reply:${r.author.slice(0, 40)}`, r.body, `answered by ${r.author.slice(0, 40)}`);
            open.delete(t.finding);
          }
          run("INSERT OR IGNORE INTO seen (repo, comment) VALUES (?, ?)", cfg.repo, key);
        }
      }
    }
  }

  // ---- the merge gate's verdict and the owner's dismissal -----------------------------------------------------------------------

  type Reason = { code: string; text: string; unblock?: string };
  /** A failed attempt the install's spend limit refused (the gateway's 402, as the recipe words it). */
  const SPEND_LIMIT = /spend limit (?:was )?reached|spend cap reached|cap_reached/i;
  /** The tier the verdict serves (ship and the merge queue read it): classified with its rule and why, pending, or unwatched. */
  type TierView = { state: "unwatched" | "pending" } | { state: "classified"; tier: Tier; rule: number; why: string };
  type Verdict = { verdict: "pass" | "wait"; reasons: Reason[]; requires_review: boolean; tier: TierView; policy?: string };
  /**
   * Whether a watched repo's PR may merge at `head`, judged against the head's tier: pass once the head is covered under its policy and
   * no important finding a mandatory run made is open on the PR; else wait, with each reason in plain words and how it unblocks. A
   * tier with no mandatory combo needs no review (`requires_review` false): it passes unless an earlier mandatory run's important
   * finding is still open. A head not classified yet waits. There is no fail: the merge queue asks again until it passes, the PR
   * moves or it closes. `live`: the caller's own read of the PR (base branch, author association); one that differs from what the
   * tier came from is pending.
   */
  function verdict(repo: string, n: number, head: string, live: { base?: string; association?: string } = {}): Verdict {
    const t = tierState(repo, n, head, live);
    const tier: TierView = t.state === "classified" ? { state: t.state, tier: t.tier, rule: t.rule, why: t.why } : { state: t.state };
    const wait = (...reasons: Reason[]) => ({ verdict: "wait" as const, reasons, requires_review: t.state !== "classified" || gated(t.c), tier, ...(t.state === "classified" ? { policy: t.policy } : {}) });
    if (t.state === "unwatched") return { ...wait({ code: "config", text: `${repo} isn't watched by code review${d.config().errors.length ? ` (the setting has errors: ${d.config().errors.join("; ").slice(0, 300)})` : ""}`, unblock: "watch it on the Reviews page, or fix settings.code_review" }), requires_review: false };
    const p = prRow(repo, n);
    if (!p) return wait({ code: "not_started", text: "the review hasn't started: code review hasn't seen this pull request yet", unblock: "it starts by itself within a minute or two" });
    if (p.head !== head) return wait({ code: "moved", text: `code review sees the pull request at ${p.head.slice(0, 12)}, not ${head.slice(0, 12)}: the newer head is being reviewed`, unblock: "it resumes by itself once the head is reviewed" });
    if (t.state === "pending") return wait({ code: "not_started", text: `classifying: the risk tier of ${head.slice(0, 7)} isn't read yet`, unblock: "it resumes by itself within a minute or two" });
    const cfg = t.c;
    const reasons: Reason[] = [];
    const open = openGating(repo, n);
    const findings = () => reasons.push({ code: "findings", text: `${open.length} important finding${open.length === 1 ? "" : "s"} open: ${open.slice(0, 10).map((f) => `${f.title.slice(0, 80)} (${f.path}:${f.line}, id ${f.id})`).join("; ")}${open.length > 10 ? "; …" : ""}`,
      unblock: `${capped(cfg, n) ? "fix and push, then record each with code_review_resolve (pushes past the push review cap get no review of their own)" : "fix and push (the next review rechecks each)"}, or record each outcome with the code_review_resolve tool ({ repo, number, id, word: fixed, disputed, by design or won't fix, reason }; the reply on the finding's thread is posted for you, and a reply you post there starting with the word works too); the owner may also dismiss it on the board's Reviews page: https://github.com/${repo}/pull/${n}` });
    // A tier no mandatory combo gates: no review is required, only what earlier mandatory runs left open.
    if (!gated(cfg)) {
      if (open.length) findings();
      return reasons.length ? wait(...reasons) : { verdict: "pass", reasons: [], requires_review: false, tier, policy: t.policy };
    }
    // Each mandatory reviewer that reviewed the head (reviewers()) has a run there that is done (whole or partial: a partial review
    // is still a review, a carried one too) or failed past its retries; queued or running ones wait. None yet: the watcher starts it.
    const latest = gateRuns(cfg, repo, n, head, t.policy, t.at);
    const busy = latest.filter((r) => r.status === "queued" || r.status === "running");
    // A review whose first post is still being decided: its findings gate once they have threads, so the merge waits for it. A
    // post refused once (filed again in the background) holds nothing: its findings are pending, never blocking.
    const posting = latest.filter((r) => r.status === "done" && r.posted === "pending" && !r.post_tries);
    // Backlog is waited on by nobody: its own code, so the commit status says how to start it rather than "Review starting" forever.
    if (!latest.length && backlog({ repo, number: n })) reasons.push({ code: "backlog", text: `the review of ${head.slice(0, 7)} hasn't started: this pull request was already open when the repo was first watched`, unblock: "comment `aiden review` on it to start one" });
    else if (!latest.length) reasons.push({ code: "not_started", text: `the review of ${head.slice(0, 7)} hasn't started`, unblock: "it starts by itself within a minute or two" });
    else if (latest.some((r) => (r.status === "queued" || r.status === "running" || r.status === "failed") && SPEND_LIMIT.test(r.why ?? ""))) reasons.push({ code: "spend_limit", text: `install spend limit reached: the mandatory review of ${head.slice(0, 7)} can't run (${String(latest.find((r) => SPEND_LIMIT.test(r.why ?? ""))!.why).slice(0, 200)})`, unblock: "the owner raises spend_day_usd or spend_month_usd in Settings, or the limit resets; a failed review then runs again on `aiden review`" });
    else if (busy.length) reasons.push({ code: "running", text: `the mandatory review of ${head.slice(0, 7)} is ${busy.some((r) => r.status === "running") ? "running" : "queued"}`, unblock: "it resumes by itself when the review finishes" });
    else if (posting.length) reasons.push({ code: "running", text: `the mandatory review of ${head.slice(0, 7)} is being posted to GitHub`, unblock: "it resumes by itself once the post lands (a refused post is filed again)" });
    else if (latest.some((r) => r.status === "skipped")) reasons.push({ code: "not_reviewed", text: `${head.slice(0, 7)} hasn't been reviewed by every mandatory reviewer (${String(latest.find((r) => r.status === "skipped")!.why ?? "").slice(0, 200)})`, unblock: "say `aiden review` on the pull request" });
    if (open.length) findings();
    return reasons.length ? wait(...reasons) : { verdict: "pass", reasons: [], requires_review: true, tier, policy: t.policy };
  }

  /**
   * What a verdict at `head` stands on (ship's approval evidence): `completed` when the head itself is covered (reviewed whole, or a
   * bare rebase's review carried to it); `skipped` when a mandatory reviewer skipped it; else `exhausted`: the verdict stands on an
   * earlier head's review (push rounds used up, no mandatory on_push, or a run failed past its retries). `reviewed` is the newest
   * covered head, which ship compares the PR's own change against (a later head with the same change carries its review).
   */
  function evidence(repo: string, n: number, head: string): { reviewed: string | null; kind: "completed" | "exhausted" | "skipped" | "none" } {
    // Only coverage under the head's current policy: a review under another tier or other mandatory reviewers is not this one.
    const t = current(repo, n, head);
    if (t && !gated(t.c)) return { reviewed: null, kind: "none" };
    const reviewed = t ? one<{ head: string }>("SELECT head FROM covered WHERE repo = ? AND number = ? AND policy IS ? AND at >= ? ORDER BY at DESC LIMIT 1", repo, n, t.policy, isoAt(t.at))?.head ?? null : null;
    if (t && isCovered(repo, n, head, t.policy, t.at)) return { reviewed: head, kind: "completed" };
    return { reviewed, kind: t && gateRuns(t.c, repo, n, head, t.policy, t.at).some((r) => r.status === "skipped") ? "skipped" : "exhausted" };
  }

  /** The owner's dismissal of an open finding (the board, in the owner's signed-in session). */
  function dismiss(b: { repo?: unknown; number?: unknown; id?: unknown; reason?: unknown; by?: unknown }) {
    const repo = String(b.repo ?? "").toLowerCase(), n = Number(b.number), id = String(b.id ?? "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(n) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RequestError("give repo, number and the finding's id");
    if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 1000) throw new RequestError("say why in reason (at most 1000 characters)");
    const p = prRow(repo, n);
    if (!p) throw new RequestError(`no reviewed pull request ${repo}#${n}`);
    const changed = tx(() => {
      const c = run("UPDATE findings SET outcome = 'dismissed', outcome_at = ?, claim = NULL WHERE repo = ? AND number = ? AND id = ? AND outcome IS NULL", iso(), repo, n, id).changes;
      if (c) dispose([id], p, "dismissed", b.reason as string, String(b.by ?? "owner").slice(0, 100));
      return c;
    });
    if (!changed) throw new RequestError(`finding ${id} isn't open on ${repo}#${n}`);
    mirrorDue = true;
    return { dismissed: id };
  }

  // ---- the API's reads and one-offs -----------------------------------------------------------------------------------------

  /** A repo at a commit (none: its default branch's head) through the code host's snapshot: the commit it resolved and its paths. */
  /**
   * A repo's snapshot listing, read once and kept for two minutes under its commit. A default-branch read is shared only while it is
   * in flight and its commit is not yet resolved: once it finishes it is kept under the commit it resolved, and a new ask for the head reads afresh. A cold read of a
   * big repo can outlast the board's deadline: the request then names the commit (known as soon as the code host answers) so the
   * board asks again for that commit, which finds the same read; before the commit is known, asking again joins the read.
   */
  type TreeRead = { p: Promise<{ sha: string; paths: string[] }>; at: number; sha?: string };
  const treeReads = new Map<string, TreeRead>();
  const usable = (e: TreeRead | undefined): e is TreeRead => e !== undefined && now() - e.at <= 120_000;
  async function treeOf(repo: string, ref: string) {
    const key = `${repo}@${ref}`;
    let e = treeReads.get(key);
    // A head read whose commit is already resolved was started for an earlier ask, and the branch may have moved since: only one
    // not yet resolved is joined.
    if (!usable(e) || (ref === "HEAD" && e.sha)) {
      // `at` is when the read settled: one still under way never expires.
      const entry: TreeRead = { p: undefined as never, at: Infinity };
      entry.p = d.codehost.tree(repo, ref, (sha) => { entry.sha = sha.toLowerCase(); if (ref === "HEAD" && !usable(treeReads.get(`${repo}@${entry.sha}`))) treeReads.set(`${repo}@${entry.sha}`, entry); });
      e = entry;
      treeReads.set(key, entry);
      entry.p.then((t) => {
        entry.at = now();
        if (ref === "HEAD") { if (treeReads.get(key) === entry) treeReads.delete(key); treeReads.set(`${repo}@${t.sha.toLowerCase()}`, entry); }
      }, () => { for (const [k, v] of treeReads) if (v === entry) treeReads.delete(k); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((r) => { timer = setTimeout(() => r("slow"), TREE_WAIT_MS); });
    const t = await Promise.race([e.p, slow]).finally(() => clearTimeout(timer));
    if (t === "slow") throw new Error(`it is still being read: ask again${e.sha ? ` for commit ${e.sha}` : " in a few seconds"}`);
    return t;
  }
  async function readTree(repoIn: unknown, commit: unknown) {
    const repo = String(repoIn ?? "").toLowerCase();
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo)) throw new RequestError("repo is owner/name");
    if (commit !== undefined && commit !== null && commit !== "" && !(typeof commit === "string" && /^[0-9a-f]{40}$/i.test(commit))) throw new RequestError("commit is a full 40-character commit sha (or leave it out for the default branch's head)");
    const ref = commit ? String(commit).toLowerCase() : "HEAD";
    let tree: { sha: string; paths: string[] };
    try { tree = await treeOf(repo, ref); } catch (e) { throw new RequestError(`${repo} can't be read at ${ref === "HEAD" ? "its default branch" : ref.slice(0, 12)}: ${String((e as Error).message).slice(0, 200)} (a repo snapshot needs the github or codehost-local module)`); }
    if (ref !== "HEAD" && !tree.sha.startsWith(ref)) throw new RequestError(`the snapshot of ${repo} is of ${tree.sha.slice(0, 12)}, not ${ref.slice(0, 12)}`);
    return { repo, tree };
  }

  const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})\/?$/;
  async function readPr(url: unknown) {
    const m = PR_URL.exec(String(url ?? "").trim());
    if (!m) throw new RequestError("pr_url is a GitHub pull request link (https://github.com/owner/repo/pull/123)");
    let p: PullRequest;
    try { p = await d.source.get(m[1]!.toLowerCase(), Number(m[2])); } catch (e) { throw new RequestError(`that PR can't be read: ${String((e as Error).message).slice(0, 200)}`); }
    if (!p.open && !p.merged) throw new RequestError("that PR was closed without merging"); // a merged one is reviewed (a backtest)
    // Only where a review can post: as the owner, once GitHub is connected.
    const can = await d.source.postable(p.repo).catch((e) => { throw new RequestError(`can't tell who would post on ${p.repo}: ${String((e as Error).message).slice(0, 200)}`); });
    if (!can.identity) throw new RequestError(`reviews can't post on ${p.repo}: GitHub isn't connected`);
    upsertPr(p);
    return p;
  }

  return {
    tick,
    verdict,
    evidence,
    dismiss,
    resolve,
    /** The PR's open important findings with their ids (what a merge wait's cut text may leave out). */
    openFindings(repo: string, number: number) { return openGating(repo.toLowerCase(), number).map((f) => ({ id: f.id, path: f.path, line: f.line, title: f.title.slice(0, 120) })); },
    /** A run's repo, PR and head: what a post of it must name (the executor's plan checks it). */
    binding(id: string) {
      const r = runRow(id);
      return r ? { repo: r.repo, number: r.number, head: r.head } : undefined;
    },
    /**
     * A one-off review of any open or merged PR the instance can read, by each combo asked for (default: the repo's on_open); posted
     * like any other. `asker` is who hears its batch's one summary, from the caller the service verified (never the request body);
     * absent, it is the board's ask and the owner hears it.
     */
    async oneoff(b: { pr_url?: unknown; combos?: unknown; focus?: unknown; full?: unknown }, asker?: Asker) {
      if (b.focus !== undefined && (typeof b.focus !== "string" || b.focus.length > 300)) throw new RequestError("focus is a short text");
      const asked = b.combos === undefined ? undefined : parseCombos(b.combos, "combos");
      if (asked && "error" in asked) throw new RequestError(asked.error);
      if (asked && !asked.length) throw new RequestError("combos names at least one { engine, model, effort }");
      const p = await readPr(b.pr_url);
      // Default: the opening reviewers of the head's tier, where it is classified; else one cheap review.
      const t = current(p.repo, p.number, p.head);
      const list = asked ?? (t?.c.on_open.length ? t.c.on_open : ADVICE);
      // The asker is the service's verified caller (api.ts; never a body field), but what it names still only reaches a notice's
      // target and the owner's alert text: a name is one line, and a task is an id or it is dropped (the owner hears it instead).
      const name = String(asker?.requester ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      const task = asker?.task && /^[A-Za-z0-9_-]{1,100}$/.test(asker.task) ? asker.task : undefined;
      const who: Asker | undefined = asker ? { requester: name || "an agent", ...(task ? { task } : {}) } : undefined;
      return queue(p, list, "oneoff", { full: b.full !== false, focus: (b.focus as string) || null, ...(who ? { asker: who } : {}) });
    },
    /** Ship's ask for a fresh review of an adopted PR's head (a model fix past the push review cap): the repo's opening reviewers,
     * queued as a writer's `aiden review` is, so the run gates the merge and covers the head. Only at the head ship judged. */
    async fresh(b: { pr_url?: unknown; head?: unknown }) {
      const p = await readPr(b.pr_url);
      if (p.head !== b.head) throw new RequestError(`the pull request is at ${p.head.slice(0, 12)}, not ${String(b.head).slice(0, 12)}`);
      if (!repoCfg(p.repo)) throw new RequestError(`${p.repo} isn't watched by code review`);
      const t = current(p.repo, p.number, p.head);
      if (!t) throw new RequestError(`${p.repo}#${p.number} at ${p.head.slice(0, 12)} isn't classified yet: ask again in a minute`);
      if (!gated(t.c)) throw new RequestError(`${p.repo}#${p.number} is ${t.tier}, a tier with no mandatory review`);
      return queue(p, t.c.on_open, "command", { focus: prRow(p.repo, p.number)?.focus ?? null, moment: "open" });
    },
    runs(q: { repo?: string; status?: string; target?: string; limit?: number }) {
      const where: string[] = [], args: unknown[] = [];
      // `target=pr` is a PR history: repo review option runs (their batches list them) are left out before the limit, never after.
      if (q.target === "pr") where.push("target = 'pr'");
      if (q.repo) (where.push("repo = ?"), args.push(q.repo.toLowerCase()));
      if (q.status) (where.push("status = ?"), args.push(q.status));
      return all<RunRow & { title: string | null }>(`SELECT r.*, p.title FROM runs r LEFT JOIN prs p ON p.repo = r.repo AND p.number = r.number ${where.length ? `WHERE ${where.map((w) => `r.${w}`).join(" AND ")}` : ""} ORDER BY r.created DESC LIMIT ?`, ...args, Math.min(Math.max(1, q.limit ?? 50), 500)).map((r) => view(r, waiting.has(r.id)));
    },
    run(id: string) {
      const r = runRow(id);
      if (!r) return undefined;
      const v = one<{ json: string }>("SELECT json FROM reviews WHERE run = ?", id);
      const findings = all<{ id: string; severity: string; path: string; line: number; title: string; outcome: string | null }>("SELECT id, severity, path, line, title, outcome FROM findings WHERE run = ? ORDER BY rowid", id).map((f) => ({ ...f }));
      // An area skipped as unchanged shows the findings of the review it carries them from.
      if (r.carried) findings.push(...openCarried((JSON.parse(r.carried) as { findings: (Finding & { src?: string })[] }).findings).map((f) => ({ id: f.id, severity: f.severity, path: f.path, line: f.line, title: f.title, outcome: null })));
      // On a watched repo, the PR's merge verdict at its current head (with its tier and why) and its open gating findings (what the
      // owner may dismiss).
      const cfg = repoCfg(r.repo), p = prRow(r.repo, r.number);
      const gate = cfg && p?.open ? { ...verdict(r.repo, r.number, p.head), head: p.head, open: openGating(r.repo, r.number).map((f) => ({ id: f.id, path: f.path, line: f.line, title: f.title })) } : null;
      return { run: view({ ...r, title: p?.title ?? null }, waiting.has(r.id)), review: v ? (JSON.parse(v.json) as Review) : null, findings, gate };
    },
    repos() {
      const c = d.config();
      return { day_spent_usd: round(spent()), errors: c.errors,
        repos: c.repos.map((r) => {
          // Who posts there: the identity its last posted review went out as (the owner's sign-in).
          const identity = one<{ identity: string }>("SELECT identity FROM runs WHERE repo = ? AND identity IS NOT NULL ORDER BY ended DESC LIMIT 1", r.repo)?.identity ?? null;
          // Each open PR's tier, the rule that named it and why, with its facts (pending until its head is classified).
          const prs = all<PrRow>("SELECT * FROM prs WHERE repo = ? AND open = 1 ORDER BY number DESC LIMIT 100", r.repo).map((p) => {
            const t = tierState(r.repo, p.number, p.head);
            return { number: p.number, title: p.title, head: p.head, draft: !!p.draft, ...(t.state === "classified" ? { tier: t.tier, rule: t.rule, why: t.why, facts: t.facts } : { tier: null }) };
          });
          return { ...r, day_spent_usd: round(spent(r.repo)), error: errors.get(r.repo) ?? null, identity, prs };
        }) };
    },
    /** Repos the GitHub identity can read whose name holds q (the board's picker). */
    async available(q: string) {
      try { return await d.source.repos(q.slice(0, 100)); } catch (e) { throw new RequestError(`GitHub can't list repos: ${String((e as Error).message).slice(0, 200)}`); }
    },
    /** The engines a combo may name, with their efforts, offered models and default run cap. */
    engines() { return ENGINES; },
    /** The options a repo's tree fits at a commit (default: its default branch's head, resolved now), and the commit. */
    async catalogFor(q: { repo?: unknown; commit?: unknown }) {
      const { repo, tree } = await readTree(q.repo, q.commit);
      const { available, recommended } = detect(tree.paths, catalog(), "one_off");
      // What past repo reviews cost, per option, model and effort (finished runs of one option; the board's cost hint reads it).
      const past = new Map<string, { model: string; effort: string; n: number; usd: number }[]>();
      // An option's cost in one review: every run of it there (one per area, failed ones' billing too), where any finished.
      for (const r of all<{ option: string; model: string; effort: string; n: number; usd: number }>("SELECT option, model, effort, COUNT(*) n, AVG(usd) usd FROM (SELECT batch, option, model, effort, SUM(cost_usd) usd FROM runs WHERE target = 'tree' GROUP BY batch, option, model, effort HAVING SUM(status = 'done') > 0 AND SUM(cost_usd) > 0) GROUP BY option, model, effort")) {
        past.set(r.option, [...(past.get(r.option) ?? []), { model: r.model, effort: r.effort, n: r.n, usd: r.usd }]);
      }
      // Every option, the ones that can't run here with why (the board lists them last, greyed).
      return { repo, sha: tree.sha, recommended, options: catalog().map((o) => ({ id: o.id, name: o.name, description: o.description, lens: o.lens, kind: o.kind, runs_code: o.runs_code, cost: o.cost, recommended: recommended.includes(o.id), source: o.source, ...(o.kind !== "tool" ? optionCombo(o) : {}), ...(past.has(o.id) ? { past: past.get(o.id) } : {}), ...(whyNot(o, tree.paths, "one_off") ? { unavailable: whyNot(o, tree.paths, "one_off") } : {}) })) };
    },
    /**
     * A repo review: `target` { repo, commit? } (no commit: the default branch's head, resolved once now and kept), its options
     * (default: the recommended ones the tree fits), and an optional combo that overrides every model option's own default (model, effort).
     */
    async repoReview(b: { target?: unknown; options?: unknown; combo?: unknown; author?: unknown; full?: unknown }) {
      const t = (b.target ?? {}) as { repo?: unknown; commit?: unknown };
      const c = (b.combo ?? {}) as { model?: unknown; effort?: unknown };
      // An explicit combo overrides every model option; without one each option runs its own catalog default.
      const asked = { ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}) };
      const comboFor = (o: Option) => ({ ...optionCombo(o), ...asked });
      if ((asked.model !== undefined && (typeof asked.model !== "string" || !/^~?[\w.-]+\/[\w.:~-]+$/.test(asked.model))) || (asked.effort !== undefined && !EFFORTS.includes(asked.effort as string))) throw new RequestError(`combo is { model: an OpenRouter id, effort: ${EFFORTS.join("|")} }`);
      if (b.options !== undefined && !(Array.isArray(b.options) && b.options.length <= 50 && b.options.every((o) => typeof o === "string"))) throw new RequestError("options lists catalog option ids");
      const { repo, tree } = await readTree(t.repo, t.commit);
      const { available, recommended } = detect(tree.paths, catalog(), "one_off");
      // Sorted: the same set in another order is the same review (what is stored and what a duplicate is looked up by).
      const ids = [...new Set((b.options as string[] | undefined) ?? recommended)].sort();
      const unknown = ids.filter((id) => !available.some((o) => o.id === id));
      if (unknown.length) throw new RequestError(`not offered for ${repo}: ${unknown.join(", ").slice(0, 300)} (code_review_catalog lists what its tree fits)`);
      if (!ids.length) throw new RequestError(`pick at least one option for ${repo}`);
      const picked = available.filter((o) => ids.includes(o.id));
      // The effort each model option's engine takes (recipe/engines.ts: deepsec up to xhigh; a skill runs on its harness), checked now, not when its run is refused.
      for (const o of picked.filter((o) => o.kind !== "tool")) {
        const key = o.kind === "engine" ? o.run.engine : o.run.harness;
        const efforts: readonly string[] = key === "deepsec" ? DEEPSEC_EFFORTS : (ENGINES[key as keyof typeof ENGINES]?.efforts ?? []);
        const effort = comboFor(o).effort as string;
        if (!efforts.includes(effort)) throw new RequestError(`${o.id} takes an effort of ${efforts.join(", ")}, not ${effort}`);
      }
      // What the batch runs, per model option: what a duplicate ask is looked up by, whether the combo was given or defaulted.
      const resolved = Object.fromEntries(picked.filter((o) => o.kind !== "tool").map((o) => [o.id, comboFor(o)]));
      const asBatch = (batch: string) => ({ batch, repo, sha: tree.sha, options: ids, runs: all<RunRow>("SELECT * FROM runs WHERE batch = ? ORDER BY rowid", batch).map((r) => view(r)) });
      if (b.full !== undefined && typeof b.full !== "boolean") throw new RequestError("full is true or false");
      const full = b.full ? 1 : 0;
      const id = `b-${randomBytes(6).toString("hex")}`;
      const author = String(b.author ?? "").toLowerCase().slice(0, 100);
      // deepsec scans when the commit has any of its files; else a pending setup branch's files (its PR not merged yet) are scanned with.
      const deepsec = tree.paths.some((p) => p.startsWith(".deepsec/")) ? 1 : 0;
      const pending = !deepsec && picked.some((o) => o.kind === "engine" && o.run.engine === "deepsec") && setupBranchOf(repo) ? await d.codehost.setupBranch(repo, setupBranchOf(repo)!).catch((e) => void log("deepsec setup branch not read", { repo, err: String((e as Error).message).slice(0, 200) })) : undefined;
      const made = tx(() => {
        // The same review asked again while it runs (a request the board gave up on, asked once more) is that review, never a second
        // one: looked for in the same step as the insert, after every await above.
        const same = one<{ id: string }>("SELECT id FROM batches WHERE repo = ? AND sha = ? AND options = ? AND combo = ? AND full = ? AND status = 'running'", repo, tree.sha, JSON.stringify(ids), JSON.stringify(resolved), full);
        if (same) return same.id;
        run("INSERT INTO batches (id, repo, sha, options, combo, status, created, author, deepsec, setup_tip, setup_files, full) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)", id, repo, tree.sha, JSON.stringify(ids), JSON.stringify(resolved), now(), author, deepsec, pending?.tip ?? null, pending ? JSON.stringify(pending.files) : null, full);
        const b = batchRow(id)!;
        // The tools first (free), then each whole-repo model option in the catalog's order, and the area plan the others wait for.
        const tools = picked.filter((o) => o.kind === "tool").map((o) => o.id);
        if (tools.length) addTree(b, "tools", "", "", tools.join(","), "code-review-tools", null);
        for (const o of picked.filter((o) => o.kind !== "tool" && o.scope === "repo")) { const c = comboFor(o); addTree(b, engineOf(o), c.model as string, c.effort as string, o.id, "code-review", null); }
        if (picked.some((o) => o.kind !== "tool" && o.scope !== "repo")) addTree(b, "plan", PLAN_MODEL, "low", "plan", PLAN, null);
        return id;
      });
      return asBatch(made);
    },
    /** Repo reviews, newest first (the board's TreeBatch): commit, spend, status and why, and once ended the verdict, the report
     * the service serves and its Primer document. */
    batches(q: { repo?: string; limit?: number }) {
      // The options by their names (an unreadable catalog, or an option since removed, leaves its id).
      const names = new Map<string, string>();
      try { for (const o of d.catalog()) names.set(o.id, o.name); } catch { /* ids */ }
      const named = (ids: string) => ids.split(",").map((id) => names.get(id) ?? id);
      return all<BatchRow & { cost: number }>(`SELECT b.*, (SELECT COALESCE(SUM(cost_usd), 0) FROM runs r WHERE r.batch = b.id) cost FROM batches b ${q.repo ? "WHERE b.repo = ?" : ""} ORDER BY b.created DESC LIMIT ?`, ...(q.repo ? [q.repo.toLowerCase()] : []), Math.min(Math.max(1, q.limit ?? 50), 500))
        .map((b) => ({ id: b.id, repo: b.repo, sha: b.sha, sha7: b.sha.slice(0, 7), verdict: b.verdict, cost_usd: round(b.cost), status: b.status, why: b.report_why,
          started: new Date(b.created).toISOString(), ended: b.ended, options: JSON.parse(b.options) as string[], option_names: named((JSON.parse(b.options) as string[]).join(",")), combo: JSON.parse(b.combo),
          // `published`: the report's Primer outcome is in (a link or a refusal); the board follows the batch until then.
          published: b.report_url !== null || b.report_why !== null,
          // Each run, a per-area one with its area's name (the board rolls an option's areas up); the plan run is the area plan.
          runs: ((areas) => all<{ id: string; option: string; status: string; why: string | null; important: number; nit: number; pre_existing: number; area: string | null; cost_usd: number; profile: string | null; carried: string | null }>("SELECT id, option, status, why, important, nit, pre_existing, area, cost_usd, profile, carried FROM runs WHERE batch = ? ORDER BY rowid", b.id)
            .map(({ profile, area, carried, why, ...r }) => ({ ...r, ...(carried ? { unchanged: why } : {}), cost_usd: round(r.cost_usd), names: profile === PLAN ? ["Area plan"] : named(r.option), ...(area ? { area: areas.get(area) ?? area } : {}) })))(new Map(b.plan ? (JSON.parse(b.plan) as Plan).areas.map((a) => [a.id, a.name]) : [])),
          ...(b.plan ? { areas: (JSON.parse(b.plan) as Plan).areas.length } : {}), ...(b.full ? { full: true } : {}),
          ...(b.status === "done" ? { report_url: `/reviews/${b.id}/report` } : {}), ...(b.report_url ? { primer_url: b.report_url } : {}) }));
    },
    /** A finished repo review's report (markdown), as Primer has it. */
    report(id: string) { return batchRow(id)?.report ?? undefined; },
  };
}
export type Engine = ReturnType<typeof createEngine>;

/** The model and effort a repo review runs a model option on unless the request names its own: the one resolver for the run and the catalog. */
const optionCombo = (o: Option) => ({ model: o.model ?? DEFAULT_MODEL, effort: o.effort ?? "medium" });
const round = (n: number) => Math.round(n * 10_000) / 10_000;
/** A run as the API shows it: the contract's fields (its engine, model and effort, billed cost, tokens, duration), the PR's title (a stranger's words:
 * plain text only) and, once posted, the review's link and the threads it resolved. */
/** `waiting`: the run is started but its check job has no computer yet (the pool is full): shown as "waiting", not "running". */
function view(r: RunRow & { title?: string | null }, waiting = false) {
  return { id: r.id, repo: r.repo, number: r.number, head: r.head, engine: r.engine, model: r.model, effort: r.effort, kind: r.kind, status: waiting ? "waiting" : r.status, why: r.why, cost_usd: round(r.cost_usd),
    tokens_in: r.tokens_in, tokens_cached: r.tokens_cached, tokens_out: r.tokens_out, duration_ms: r.duration_ms,
    important: r.important, nit: r.nit, pre_existing: r.pre_existing, started: r.started, ended: r.ended, box_at: r.box_at, check_job: r.check_job,
    full: !!r.full, incremental_from: r.incremental_from, posted: r.posted, target: r.target, batch: r.batch, ...(r.option ? { option: r.option } : {}), ...(r.area ? { area: r.area } : {}),
    url: r.target === "tree" ? `https://github.com/${r.repo}/tree/${r.head}` : `https://github.com/${r.repo}/pull/${r.number}`,
    ...(r.title ? { title: r.title } : {}), ...(r.review_url ? { review_url: r.review_url } : {}), ...(r.resolved != null ? { resolved: r.resolved } : {}) };
}
