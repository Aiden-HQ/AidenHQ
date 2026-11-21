// Graded done (wave 1): a delegated task's rubric and grading state, kept here in the grading module's own storage (never
// the task's editable description), and the completion gate its finish check answers for a task with a row. Moved from the
// board unchanged (lean-core 3h); the runner still claims pending rows, gathers evidence and asks the grader.
import type { DatabaseSync } from "node:sqlite";

/**
 * open: filed with the delegation, the task not finished yet. pending: a completion path hit the gate, waiting for the
 * runner. awaiting_evidence: checks, a deploy or an approval still running. Then satisfied, needs_revision (back to the
 * assignee), grading_failed (the grader failed or returned no usable criteria: retried on a bounded ladder, never the
 * owner's) or escalated (3 rejected versions, or one resubmitted unchanged: the delegator decides, accepting by closing the task
 * or reopening it with what to change). A grader that is down, can't judge or can't verify settles the row satisfied: the task
 * closes done, ungraded. not_graded: the task was cancelled or otherwise closed before
 * the grader settled it, so there is nothing left to grade.
 */
export type GradeState = "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "escalated" | "not_graded";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report" | "issue";
  ref: string;
}
/** One grader verdict, bound to the exact deliverable version it graded (PR head SHA, deployed SHA, apply record). */
export interface Verdict {
  at: string;
  version: string;
  model: string;
  /** accepted: an escalated grade its delegator closed, which settles it in place of a rubric verdict. */
  verdict: "satisfied" | "needs_revision" | "cannot_judge" | "accepted";
  /** The delegator that accepted it (an accepted verdict has no grader model and no criteria). */
  by?: string;
  criteria: { id: string; met: "yes" | "no" | "unknown"; evidence: string }[];
}
export interface Grade {
  issueId: string;
  /** 3-8 checkable criteria, each at most 200 characters; none: the template for the deliverable's kind. */
  rubric: string[];
  deliverable: Deliverable;
  /** Distinct deliverable versions rejected so far. */
  attempts: number;
  state: GradeState;
  verdicts: Verdict[];
  /** Failed grader passes since the last real verdict; the retry ladder starts over at 0. */
  failures: number;
  /** When the last grader pass failed (null until one does). */
  failedAt: string | null;
  /** The agents the escalation was addressed to, saved when the grade escalated (null: escalated before this was saved). */
  delegators: string[] | null;
  /** Why the row ended not_graded (the task was cancelled or closed before the grader settled it); null otherwise. */
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  issue_id: string;
  rubric: string;
  deliverable: string;
  attempts: number;
  state: string;
  verdicts: string;
  failures: number;
  failed_at: string | null;
  delegators: string | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Rejected versions before the grade escalates to the delegator (owner decision, wave 1). */
export const MAX_LOOPS = 3;
/** The waits after successive failed grader passes (1, 5, 15 then 60 minutes); the pass after the last wait is the 5th. */
export const GRADER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Failed grader passes before the grade escalates; the retry ladder has one wait fewer. */
export const MAX_GRADER_FAILURES = 5;
/** How long after the `failures`-th failed pass the runner retries it. */
export const graderRetryDelay = (failures: number) => GRADER_RETRY_MS[Math.min(Math.max(failures, 1), GRADER_RETRY_MS.length) - 1]!;

/** Where a body breaks the contract: a 400 with its field. */
export class Invalid extends Error {}
/** Where a filing conflicts with the row already there (a settled row, or a filer that may not replace it): a 409. */
export class Conflict extends Error {}
const bad = (msg: string): never => { throw new Invalid(msg); };
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[], at: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${at}${k}: not allowed`); };
const str = (v: unknown, max: number, at: string, min = 0) => (typeof v === "string" && v.length >= min && v.length <= max ? v : bad(`${at}: a string of ${min}-${max} characters`));
const oneOf = <T extends string>(v: unknown, values: readonly T[], at: string): T => (values.includes(v as T) ? (v as T) : bad(`${at}: one of ${values.join(", ")}`));

export const ISSUE_REF = /^[\w.-]+\/[\w.-]+#\d+$/;
export const KINDS = ["pr", "app", "apply", "file", "report", "issue"] as const;
/** A delegation's rubric: 3-8 checkable criteria, or none (the grader then uses modules/grading/rubrics/<kind>.md). */
export function parseFiling(b: unknown): { issue: string; rubric: string[]; deliverable: Deliverable } {
  if (!isMap(b)) return bad("send {issue, rubric, deliverable}");
  only(b, ["issue", "rubric", "deliverable"], "");
  const rubric = (Array.isArray(b.rubric) ? b.rubric : bad("rubric: a list")).map((c, i) => str(typeof c === "string" ? c.trim() : c, 200, `rubric.${i}`, 3));
  if (rubric.length > 8 || (rubric.length > 0 && rubric.length < 3)) bad("rubric: 3-8 criteria, or none for the template");
  const d = isMap(b.deliverable) ? b.deliverable : bad("deliverable: {kind, ref}");
  only(d, ["kind", "ref"], "deliverable.");
  const deliverable = { kind: oneOf(d.kind, KINDS, "deliverable.kind"), ref: d.ref === undefined ? "" : str(d.ref, 500, "deliverable.ref") };
  if (deliverable.kind === "issue" && !ISSUE_REF.test(deliverable.ref)) bad("deliverable.ref: owner/name#number for an issue");
  return { issue: str(b.issue, 100, "issue", 1), rubric, deliverable };
}
const OUTCOMES = ["awaiting_evidence", "satisfied", "needs_revision", "cannot_judge", "grading_failed", "error"] as const;
export type VerdictInput = { version: string; outcome: (typeof OUTCOMES)[number]; model: string; criteria: Verdict["criteria"]; reason?: string };
/** The runner's outcome of one grading pass: still waiting on evidence, or the grader's verdict on `version` (grading_failed: the grader failed and is retried; error: evidence that never came or every model refused). */
export function parseVerdict(b: unknown): VerdictInput {
  if (!isMap(b)) return bad("send {version, outcome}");
  only(b, ["version", "outcome", "model", "criteria", "reason"], "");
  const criteria = b.criteria === undefined ? [] : Array.isArray(b.criteria) && b.criteria.length <= 8 ? b.criteria : bad("criteria: at most 8");
  return {
    reason: typeof b.reason === "string" ? b.reason.slice(0, 300) : undefined,
    version: str(b.version, 200, "version"), outcome: oneOf(b.outcome, OUTCOMES, "outcome"), model: b.model === undefined ? "" : str(b.model, 100, "model"),
    criteria: criteria.map((c, i) => { const m = isMap(c) ? c : bad(`criteria.${i}`); only(m, ["id", "met", "evidence"], `criteria.${i}.`); return { id: str(m.id, 20, `criteria.${i}.id`), met: oneOf(m.met, ["yes", "no", "unknown"] as const, `criteria.${i}.met`), evidence: str(m.evidence, 1000, `criteria.${i}.evidence`) }; }),
  };
}

/** The kernel's known repos (its codehostRepos, GET /v1/agents): the product repo, the agents orgs, github_orgs and maintainer_repos. */
export type KnownRepos = { product?: string; agentsOrgs?: string[]; orgs?: string[]; maintained?: string[] };
/** Whether a PR deliverable's ref may be filed: none (the task's own PRs), or a repo or PR the instance reaches (`KnownRepos`) or the local org (`codehost:local/<repo>[/change/<n>]`). Unknown repos refuse, as tiering does. */
export function prRefAllowed(ref: string, t: KnownRepos): boolean {
  if (!ref) return true;
  // The org `local` is this server's own (codehost-local): a repo or change request there is as much the fleet's as the agents org's.
  // Only in its explicit, canonical form (the stored ref is this exact string); a bare `local/x` would read as a GitHub owner/name.
  if (/^codehost:local\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/change\/\d+)?$/.test(ref)) return true;
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pull\/\d+|#\d+)?\/?$/.exec(ref.trim());
  if (!m) return false;
  const [org, repo] = [m[1]!.toLowerCase(), `${m[1]}/${m[2]}`.toLowerCase()];
  const lower = (l?: string[]) => (l ?? []).map((x) => x.toLowerCase());
  return [...lower(t.agentsOrgs), ...lower(t.orgs)].includes(org) || [...lower(t.maintained), ...lower(t.product ? [t.product] : [])].includes(repo);
}

const fromRow =(r: Row): Grade => ({ issueId: r.issue_id, rubric: JSON.parse(r.rubric), deliverable: JSON.parse(r.deliverable), attempts: r.attempts, state: r.state as GradeState, verdicts: JSON.parse(r.verdicts), failures: r.failures ?? 0, failedAt: r.failed_at ?? null, delegators: r.delegators ? JSON.parse(r.delegators) : null, closedReason: r.closed_reason ?? null, createdAt: r.created_at, updatedAt: r.updated_at });

/** A verdict whose criteria are met or unknown, at least one unknown, none shown unmet: the grader couldn't verify, not "no". */
export const unverifiedOnly = (criteria: { met: string }[]) => criteria.some((c) => c.met === "unknown") && !criteria.some((c) => c.met === "no");

export class Grades {
  private events?: { emit: (topic: string, id: string) => void };
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    // Two openers can run this at once (the service and a one-shot move): one BEGIN IMMEDIATE makes the CREATE TABLEs one
    // step, and the busy timeout waits for the other rather than failing on a locked database. The per-column ALTER checks
    // stay as they were: they run inside the same transaction, after the CREATEs, and each sees the table it just made.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS grades (
        issue_id TEXT PRIMARY KEY, rubric TEXT NOT NULL, deliverable TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, verdicts TEXT NOT NULL DEFAULT '[]', failures INTEGER NOT NULL DEFAULT 0, failed_at TEXT,
        closed_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      const columns = (db.prepare("PRAGMA table_info(grades)").all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes("failures")) db.exec("ALTER TABLE grades ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
      if (!columns.includes("failed_at")) db.exec("ALTER TABLE grades ADD COLUMN failed_at TEXT");
      if (!columns.includes("delegators")) db.exec("ALTER TABLE grades ADD COLUMN delegators TEXT");
      if (!columns.includes("closed_reason")) db.exec("ALTER TABLE grades ADD COLUMN closed_reason TEXT");
      // An escalated task finished again: graded again only once the runner finds a new deliverable version (resubmit).
      // Why the grader's latest pass on a task failed (the Fleet Steward reads it to tell one component down from many tasks failing).
      db.exec("CREATE TABLE IF NOT EXISTS grade_failures (issue_id TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS grade_resubmits (issue_id TEXT PRIMARY KEY, at TEXT NOT NULL)");
      // Who filed each row's rubric, in its own table rather than a column on `grades`. A fresh start, not a migration: a row
      // written before this table existed has no record and is treated as such by file() below.
      db.exec("CREATE TABLE IF NOT EXISTS grade_filers (issue_id TEXT PRIMARY KEY, filer TEXT NOT NULL)");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A failed grader pass's reason, kept until a later pass on the task gets any other outcome. */
  noteFailure(issueId: string, reason: string, at = new Date().toISOString()) { this.db.prepare("INSERT OR REPLACE INTO grade_failures (issue_id, at, reason) VALUES (?, ?, ?)").run(issueId, at, reason.slice(0, 300)); }
  clearFailure(issueId: string) { this.db.prepare("DELETE FROM grade_failures WHERE issue_id = ?").run(issueId); }
  failuresSince(at: string): { task: string; at: string; reason: string }[] { return this.db.prepare("SELECT issue_id AS task, at, reason FROM grade_failures WHERE at >= ? ORDER BY at DESC LIMIT 200").all(at) as { task: string; at: string; reason: string }[]; }

  get(issueId: string): Grade | undefined {
    const r = this.db.prepare("SELECT * FROM grades WHERE issue_id = ?").get(issueId) as Row | undefined;
    return r && fromRow(r);
  }

  /**
   * Files a delegation's rubric, or replaces it while the grade is unsettled. `filer` is the caller as the row records it:
   * `agent:<id>` from the agent route, `module:<name>` from the kernel's module route (grades.test / settle.test write direct).
   *
   * A byte-identical filing is a retry: the stored row comes back and nothing is written. A filing that differs (another
   * deliverable kind or ref, or another rubric) replaces both and restarts the row: open, no attempts, no verdicts, no
   * delegators, no close reason. Only the row's recorded filer may do that, so a delegator's correction lands on the task
   * it already filed instead of needing a new task.
   *
   * A row with no filer record was filed before `grade_filers` existed, and it is deliberately not adopted, backfilled or
   * upgraded: the product takes fresh starts over migrating old data unless the owner asks for a migration. Such a row
   * still refuses a differing filing, and the work is filed as a new task instead. A satisfied or not_graded row is
   * settled and keeps refusing a differing filing.
   *
   * `closed` is the caller's read of the task's own status (done or cancelled). A closed task's rubric is never replaced,
   * even while its row is still `open` and the five-minute sweep has not settled it yet: the row would restart and grade
   * work the owner has already closed or cancelled. A byte-identical filing is still a retry that touches nothing.
   */
  file(issueId: string, rubric: string[], deliverable: Deliverable, filer?: string, { closed = false }: { closed?: boolean } = {}): { created: boolean; grade: Grade } {
    // One transaction over the read and the write: two filings of one task can't both see no row and both insert, and a
    // check that refuses rolls back without touching anything.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const have = this.get(issueId);
      const want = JSON.stringify(deliverable), wantRubric = JSON.stringify(rubric);
      if (have) {
        if (JSON.stringify(have.rubric) === wantRubric && JSON.stringify(have.deliverable) === want) {
          this.db.exec("COMMIT");
          return { created: false, grade: have };
        }
        if (have.state === "satisfied" || have.state === "not_graded") throw new Conflict("this task already has another rubric");
        // Between a task closing and the sweep settling its row, the row still reads open: the task's own status decides.
        if (closed) throw new Conflict("this task is already closed: its rubric is not replaced, and a closed task's grade is left as it settled");
        const recorded = (this.db.prepare("SELECT filer FROM grade_filers WHERE issue_id = ?").get(issueId) as { filer: string } | undefined)?.filer;
        if (!recorded) throw new Conflict("this task's rubric was filed before filers were recorded, so its deliverable cannot be re-bound: file the work as a new task");
        if (!filer || recorded !== filer) throw new Conflict(`only ${recorded}, which filed this task's rubric, may replace it`);
        this.db.prepare("UPDATE grades SET rubric = ?, deliverable = ?, attempts = 0, state = 'open', verdicts = '[]', failures = 0, failed_at = NULL, delegators = NULL, closed_reason = NULL, updated_at = ? WHERE issue_id = ?")
          .run(wantRubric, want, new Date().toISOString(), issueId);
        // A restarted row has no pending resubmission and no failure worth carrying: both describe the version it replaced.
        this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
        this.db.prepare("DELETE FROM grade_failures WHERE issue_id = ?").run(issueId);
      } else {
        const now = new Date().toISOString();
        this.db.prepare("INSERT INTO grades (issue_id, rubric, deliverable, attempts, state, verdicts, created_at, updated_at) VALUES (?, ?, ?, 0, 'open', '[]', ?, ?)")
          .run(issueId, wantRubric, want, now, now);
        if (filer) this.db.prepare("INSERT OR REPLACE INTO grade_filers (issue_id, filer) VALUES (?, ?)").run(issueId, filer);
      }
      this.db.exec("COMMIT");
      this.events?.emit("grades", issueId);
      return { created: !have, grade: this.get(issueId)! };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The rows the runner grades: a completion path hit the gate, the evidence was still coming, or the grader failed (no verdict yet) and its next retry is due. */
  due(now = Date.now()): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state IN ('pending', 'awaiting_evidence', 'grading_failed') ORDER BY updated_at").all() as unknown as Row[])
      .map(fromRow)
      .filter((g) => g.state !== "grading_failed" || !g.failedAt || Date.parse(g.failedAt) + graderRetryDelay(g.failures) <= now);
  }

  /** Escalated rows, newest first (the Fleet Ops `grade` check flags one waiting over a day). */
  escalated(): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state = 'escalated' ORDER BY updated_at DESC LIMIT 50").all() as unknown as Row[]).map(fromRow);
  }

  /**
   * Every row that is not settled yet: what a task closing has to settle. One row per grade state, for a task already
   * `done` or `cancelled`:
   *
   * open             settles: the delegation was never finished, so nothing is left to grade or to claim.
   * pending          settles: the gate was waiting for a runner that will never be asked again.
   * awaiting_evidence settles: the evidence will not be read for a closed task.
   * needs_revision   settles: there is nothing left to revise.
   * grading_failed   settles: the retry ladder has no task to retry.
   * escalated        settles: the delegator's decision is moot once the task is closed any other way.
   * satisfied        never swept: a real verdict stands, and a settled row keeps its `satisfied` (the close did not undo it).
   * not_graded       never swept: already terminal, and the first reason is kept.
   *
   * So the sweep takes everything except the two settled states, which is what the query says. It reads each task's status
   * first, so a task still open keeps its row whatever its state, and the detector's own reporting is unchanged (`due()` and
   * `escalated()` are the only states it counts).
   */
  unsettled(): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state NOT IN ('satisfied', 'not_graded') ORDER BY updated_at").all() as unknown as Row[]).map(fromRow);
  }

  /**
   * Escalated rows with no saved delegators: escalated before the column was populated (NULL), or with an empty list. The
   * backfill fills these in from the task's creator; nothing else is read.
   */
  escalatedWithoutDelegators(): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state = 'escalated' AND (delegators IS NULL OR delegators = '[]' OR delegators = '') ORDER BY updated_at").all() as unknown as Row[]).map(fromRow);
  }

  /**
   * Saves the delegators of a row that still has none: an escalated row only, and only while its list is NULL or empty, so a
   * second run writes nothing. `updated_at` is left alone: the row's escalation did not move.
   */
  saveDelegators(issueId: string, delegators: string[]): boolean {
    const r = this.db
      .prepare("UPDATE grades SET delegators = ? WHERE issue_id = ? AND state = 'escalated' AND (delegators IS NULL OR delegators = '[]' OR delegators = '')")
      .run(JSON.stringify(delegators), issueId);
    if (Number(r.changes) > 0) this.events?.emit("grades", issueId);
    return Number(r.changes) > 0;
  }

  /** Escalated rows finished again since, with when: the runner checks each for a new deliverable version. */
  resubmitted(): (Grade & { resubmittedAt: string })[] {
    return (this.db.prepare("SELECT g.*, r.at AS resubmitted_at FROM grades g JOIN grade_resubmits r ON r.issue_id = g.issue_id WHERE g.state = 'escalated'").all() as unknown as (Row & { resubmitted_at: string })[])
      .map((r) => ({ ...fromRow(r), resubmittedAt: r.resubmitted_at }));
  }

  /**
   * Escalated rows not finished again since (or whose new version was checked), with no verdict move still owed (the grade loop's
   * `owed:` rows: a grader-failure block needs its hold): the delegator's alone, held by nothing.
   */
  escalatedUnmarked(): Grade[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS loop_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); // the grade loop's (kernel-loop.ts)
    return (this.db.prepare("SELECT g.* FROM grades g WHERE g.state = 'escalated' AND NOT EXISTS (SELECT 1 FROM grade_resubmits r WHERE r.issue_id = g.issue_id) AND NOT EXISTS (SELECT 1 FROM loop_state l WHERE l.k = 'owed:' || g.issue_id AND l.v != '') ORDER BY updated_at").all() as unknown as Row[]).map(fromRow);
  }

  /** Marks an escalated task as finished again (the completion gate); its state stays the delegator's. */
  markResubmitted(issueId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO grade_resubmits (issue_id, at) VALUES (?, ?)").run(issueId, new Date().toISOString());
  }

  /**
   * The runner's check of a resubmitted escalated task: a deliverable version other than the last one graded goes back to
   * the grader; the same version stays escalated (the delegator or the owner resolves it). The mark is cleared either way.
   */
  resubmit(issueId: string, version: string): Grade | undefined {
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    const g = this.get(issueId);
    if (!g || g.state !== "escalated") return g;
    // A new round: the grader's failures count afresh (they are consecutive failures).
    if (version && version !== g.verdicts.at(-1)?.version) this.set(issueId, "pending", g.attempts, g.verdicts, 0, null);
    return this.get(issueId);
  }

  /**
   * The task closed before the grader settled its row (cancelled, or done another way): there is nothing left to grade, so
   * the row ends `not_graded` with the reason. A satisfied row keeps its verdict; a row already settled keeps its first
   * reason. Called wherever a close is seen, and by the detector for a close it wasn't (a cancel in Paperclip itself).
   */
  settle(issueId: string, reason: string, now = Date.now()): Grade | undefined {
    const g = this.get(issueId);
    if (!g || g.state === "satisfied" || g.state === "not_graded") return g;
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    this.db.prepare("UPDATE grades SET state = 'not_graded', closed_reason = ?, updated_at = ? WHERE issue_id = ?").run(reason.slice(0, 300), new Date(now).toISOString(), issueId);
    this.events?.emit("grades", issueId);
    return this.get(issueId);
  }

  private set(issueId: string, state: GradeState, attempts: number, verdicts: Verdict[], failures: number, failedAt: string | null, now = Date.now(), delegators?: string[]): Grade {
    // The delegators belong to the escalation: written in the same UPDATE that escalates, cleared when the grade leaves it.
    this.db
      .prepare("UPDATE grades SET state = ?, attempts = ?, verdicts = ?, failures = ?, failed_at = ?, closed_reason = NULL, updated_at = ?, delegators = CASE WHEN ? = 'escalated' THEN COALESCE(?, delegators) ELSE NULL END WHERE issue_id = ?")
      .run(state, attempts, JSON.stringify(verdicts), failures, failedAt, new Date(now).toISOString(), state, delegators ? JSON.stringify(delegators) : null, issueId);
    this.events?.emit("grades", issueId);
    return this.get(issueId)!;
  }

  /**
   * An escalated grade accepted by the task's delegator (closing it): the row is settled, its verdicts kept, and one more
   * bound to the version it settles says who accepted it. The grader already declined to decide, so this takes the place
   * of a rubric verdict rather than claiming one.
   */
  accept(issueId: string, by: string, now = Date.now()): void {
    const g = this.get(issueId)!;
    const verdict: Verdict = { at: new Date(now).toISOString(), version: g.verdicts.at(-1)?.version ?? "", model: "", verdict: "accepted", by, criteria: [] };
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    this.set(issueId, "satisfied", g.attempts, [...g.verdicts, verdict].slice(-20), 0, null, now);
  }

  /** An escalation nobody answered, finished again by the assignee: back to the grader for a fresh verdict (never an acceptance). */
  regrade(issueId: string): void {
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    this.pend(issueId);
  }

  /** Waiting for the grader again (the completion gate). */
  pend(issueId: string): void {
    const g = this.get(issueId)!;
    this.set(issueId, "pending", g.attempts, g.verdicts, g.failures, g.failedAt);
  }

  /**
   * One grading pass's outcome. A rejected version counts once (loops are distinct versions). A version rejected before and
   * handed in again unchanged, and the MAX_LOOPS-th rejected version, escalate to the delegator: criteria explicitly unmet are
   * the only escalation. A verdict with criteria unverified but none unmet, cannot_judge, a grader refusal and evidence that
   * never came (error) settle the row satisfied (the task closes done, ungraded). A grader that failed or returned no usable
   * criteria (grading_failed) is retried on the 1-5-15-60 minute ladder and settles the same way after MAX_GRADER_FAILURES passes
   * in a row; any real verdict, or a new round, clears that count.
   */
  record(issueId: string, v: VerdictInput, now = Date.now(), delegators?: string[]): Grade {
    const set = (state: GradeState, attempts: number, verdicts: Verdict[], failures: number, failedAt: string | null, at: number) => this.set(issueId, state, attempts, verdicts, failures, failedAt, at, delegators);
    const g = this.get(issueId);
    if (!g) throw new Error("no grade for this task");
    if (v.outcome === "awaiting_evidence") return set("awaiting_evidence", g.attempts, g.verdicts, g.failures, g.failedAt, now);
    // A verdict that marks a criterion unmet is a rejection whatever its outcome says, in the history too.
    const unmet = ["cannot_judge", "error"].includes(v.outcome) && v.criteria.some((c) => c.met === "no");
    const verdict: Verdict = { at: new Date(now).toISOString(), version: v.version, model: v.model, verdict: unmet ? "needs_revision" : ["error", "grading_failed"].includes(v.outcome) ? "cannot_judge" : (v.outcome as Verdict["verdict"]), criteria: v.criteria };
    const verdicts = [...g.verdicts, verdict].slice(-20);
    if (v.outcome === "satisfied") return set("satisfied", g.attempts, verdicts, 0, null, now);
    // Grader infrastructure failing, cannot_judge, missing evidence and unverified-only close the task done, ungraded (the loop's note says why).
    if (v.outcome === "grading_failed") {
      const failures = g.failures + 1;
      if (failures >= MAX_GRADER_FAILURES) return set("satisfied", g.attempts, verdicts, 0, null, now);
      return set("grading_failed", g.attempts, verdicts, failures, new Date(now).toISOString(), now);
    }
    if ((v.outcome !== "needs_revision" && !unmet) || unverifiedOnly(v.criteria)) return set("satisfied", g.attempts, verdicts, 0, null, now);
    if (g.verdicts.some((x) => x.verdict === "needs_revision" && x.version === v.version)) return set("escalated", g.attempts, verdicts, 0, null, now);
    const attempts = g.attempts + 1;
    return set(attempts >= MAX_LOOPS ? "escalated" : "needs_revision", attempts, verdicts, 0, null, now);
  }
}

/**
 * Whether a board-side cascade (closing a task's crew parts when the task closes) may close one done: an ungraded task
 * passes, and so does one whose grade is satisfied. Anything else waits for the grader, so a cascade never satisfies a
 * rubric by itself.
 */
export function gradePassed(grades: Grades, issueId: string): boolean {
  const g = grades.get(issueId);
  return !g || g.state === "satisfied";
}

/**
 * A task closed before the grader settled its row has nothing left to grade: settle each such row `not_graded`, with the
 * close as the reason. Runs on the board's timer and in the detector's check, so a close made anywhere (the board, the tasks
 * bridge, Paperclip itself) resolves the row; a row whose task can't be read is left alone.
 */
export async function settleClosedGrades(grades: Grades, issue: (id: string) => Promise<{ status: string } | undefined>, now = Date.now()): Promise<Grade[]> {
  const settled: Grade[] = [];
  for (const g of grades.unsettled()) {
    const i = await Promise.resolve()
      .then(() => issue(g.issueId))
      .catch(() => undefined);
    if (!i || (i.status !== "done" && i.status !== "cancelled")) continue;
    const row = grades.settle(g.issueId, `the task was ${i.status} before the grader settled it`, now);
    if (row) settled.push(row);
  }
  return settled;
}

/**
 * An escalated row with no saved delegators (it escalated before the column was populated) falls back to its task's creator:
 * the guard reads that creator live, and this stores it on the row so the answer stops depending on a mutable task record.
 * The creator is Paperclip's structured `createdByAgentId`; nothing is read from text, and a task with no creator is left
 * alone (that row keeps failing closed). Idempotent: a filled row is never selected, and `updated_at` is not touched.
 */
export async function backfillEscalatedDelegators(grades: Grades, issue: (id: string) => Promise<{ createdByAgentId?: string | null } | undefined>): Promise<Grade[]> {
  const filled: Grade[] = [];
  for (const g of grades.escalatedWithoutDelegators()) {
    const i = await Promise.resolve()
      .then(() => issue(g.issueId))
      .catch(() => undefined);
    const creator = i?.createdByAgentId;
    if (!creator) continue;
    if (grades.saveDelegators(g.issueId, [creator])) filled.push(grades.get(g.issueId)!);
  }
  return filled;
}

/**
 * How long an escalation waits for its delegator. Past it, the task's own assignee finishing it again sends the row back to
 * the grader (never an acceptance): a delegator that was never woken by the escalation (its parent closed, or none) would
 * otherwise leave the row, and the task in review, escalated for good.
 */
export const ESCALATION_WAIT_MS = 24 * 60 * 60_000;

/** A held task's scheduled check sits at the runner's evidence deadline, well past a normal grader pass. */
export const GRADE_CHECK_MS = 24 * 60 * 60_000;
/** Every way a task reaches done: the tasks bridge's task_finish, the runner's finishTurn and finishMerges. */
export type CompletionPath = "task_finish" | "finish_turn" | "finish_merges";
/**
 * pass: the path may close the task as it would have. Otherwise the task goes to in_review with the `grading` label and the
 * row has this state (escalated: it waits for the delegator; grading_failed: the runner retries it).
 */
export type GateResult = { pass: true } | { pass: false; state: "pending" | "awaiting_evidence" | "needs_revision" | "grading_failed" | "escalated"; label: "grading" };

/**
 * The completion gate, idempotent. A task without a rubric passes, and so does a satisfied one
 * that is already done (another path closing it again). Satisfied is not sticky: a satisfied task reopened and finished
 * again is graded again (each verdict is bound to its deliverable version). An escalated task stays the delegator's: finishing
 * it again only marks it, and the runner sends it back to the grader once there is a new deliverable version.
 */
export function completionGate(grades: Grades, issueId: string, _via: CompletionPath, { done = false }: { done?: boolean } = {}): GateResult {
  const g = grades.get(issueId);
  // Settled rows: satisfied (graded) and not_graded (closed before the grader settled it) pass a task that is already done.
  if (!g || (done && (g.state === "satisfied" || g.state === "not_graded"))) return { pass: true };
  if (g.state === "pending" || g.state === "awaiting_evidence" || g.state === "grading_failed") return { pass: false, state: g.state, label: "grading" };
  if (g.state === "needs_revision") {
    // Unmet criteria are never a close: wait for the runner to grade a new deliverable version.
    grades.pend(issueId);
    return { pass: false, state: "needs_revision", label: "grading" };
  }
  if (g.state === "escalated") {
    grades.markResubmitted(issueId);
    return { pass: false, state: "escalated", label: "grading" };
  }
  grades.pend(issueId);
  return { pass: false, state: "pending", label: "grading" };
}

/**
 * What the AI reviewer reads of a task's grade (POST /check/grade, the kernel's own call): the latest verdict, only when it sent
 * the work back with a criterion not shown met. Each criterion is its rubric number and code's met; an unmet one carries the
 * rubric's own text (the delegating agent's words when it filed the task, or the kind's template). Never the grader's evidence:
 * that is model output over what the PR itself wrote.
 */
export type GraderNote = { attempt: number; at: string; version: string; criteria: { id: string; met: "yes" | "no" | "unknown"; rubric?: string }[] };
export function graderNote(g: Grade | undefined, template: (kind: string) => string[]): GraderNote | null {
  const v = g?.verdicts.at(-1);
  if (!g || v?.verdict !== "needs_revision") return null;
  const rubric = g.rubric.length ? g.rubric : template(g.deliverable.kind);
  // The grader numbers the rubric 1..N; any other id is not a criterion of this rubric.
  const criteria = v.criteria.filter((c) => /^[1-9]\d?$/.test(c.id) && Number(c.id) <= rubric.length)
    .map((c) => ({ id: c.id, met: c.met, ...(c.met === "yes" ? {} : { rubric: rubric[Number(c.id) - 1]! }) }));
  if (!criteria.some((c) => c.met !== "yes")) return null;
  return { attempt: g.attempts, at: v.at, version: v.version, criteria };
}
