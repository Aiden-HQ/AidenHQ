// Graded done (wave 1): a delegated task's rubric and grading state, kept here in the grading module's own storage (never
// the task's editable description), and the completion gate its finish check answers for a task with a row. Moved from the
// board unchanged (lean-core 3h); the runner still claims pending rows, gathers evidence and asks the grader.
import type { DatabaseSync } from "node:sqlite";

/**
 * open: filed with the delegation, the task not finished yet. pending: a completion path hit the gate, waiting for the
 * runner. awaiting_evidence: checks, a deploy or an approval still running. Then satisfied, needs_revision (back to the
 * assignee), grading_failed (the grader failed or returned no usable criteria: retried on a bounded ladder, never the
 * owner's) or escalated (3 rejected versions, cannot_judge, or 5 failed grader passes: the delegator decides, accepting
 * by closing the task or reopening it with what to change). not_graded: the task was cancelled or otherwise closed before
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

/** Whether a PR deliverable's ref may be filed: none (the task's own PRs), or a repo or PR in the agents org or the local org (`codehost:local/<repo>[/change/<n>]`) or the product repo. Unknown repos refuse, as tiering does. */
export function prRefAllowed(ref: string, t: { agents_org?: string; product_repo?: string }): boolean {
  if (!ref) return true;
  // The org `local` is this server's own (codehost-local): a repo or change request there is as much the fleet's as the agents org's.
  // Only in its explicit, canonical form (the stored ref is this exact string); a bare `local/x` would read as a GitHub owner/name.
  if (/^codehost:local\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/change\/\d+)?$/.test(ref)) return true;
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pull\/\d+|#\d+)?\/?$/.exec(ref.trim());
  if (!m) return false;
  const [org, repo] = [m[1]!.toLowerCase(), `${m[1]}/${m[2]}`.toLowerCase()];
  return Boolean((t.agents_org && org === t.agents_org.toLowerCase()) || (t.product_repo && repo === t.product_repo.toLowerCase()));
}

const fromRow =(r: Row): Grade => ({ issueId: r.issue_id, rubric: JSON.parse(r.rubric), deliverable: JSON.parse(r.deliverable), attempts: r.attempts, state: r.state as GradeState, verdicts: JSON.parse(r.verdicts), failures: r.failures ?? 0, failedAt: r.failed_at ?? null, delegators: r.delegators ? JSON.parse(r.delegators) : null, closedReason: r.closed_reason ?? null, createdAt: r.created_at, updatedAt: r.updated_at });

/** A verdict whose criteria are met or unknown, at least one unknown, none shown unmet: the grader couldn't verify, not "no". */
export const unverifiedOnly = (criteria: { met: string }[]) => criteria.some((c) => c.met === "unknown") && !criteria.some((c) => c.met === "no");

export class Grades {
  private events?: { emit: (topic: string, id: string) => void };
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
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
  }

  /** A failed grader pass's reason, kept until a later pass on the task gets any other outcome. */
  noteFailure(issueId: string, reason: string, at = new Date().toISOString()) { this.db.prepare("INSERT OR REPLACE INTO grade_failures (issue_id, at, reason) VALUES (?, ?, ?)").run(issueId, at, reason.slice(0, 300)); }
  clearFailure(issueId: string) { this.db.prepare("DELETE FROM grade_failures WHERE issue_id = ?").run(issueId); }
  failuresSince(at: string): { task: string; at: string; reason: string }[] { return this.db.prepare("SELECT issue_id AS task, at, reason FROM grade_failures WHERE at >= ? ORDER BY at DESC LIMIT 200").all(at) as { task: string; at: string; reason: string }[]; }

  get(issueId: string): Grade | undefined {
    const r = this.db.prepare("SELECT * FROM grades WHERE issue_id = ?").get(issueId) as Row | undefined;
    return r && fromRow(r);
  }

  /** Files a delegation's rubric once: a second call (a retried delegation) returns the first row unchanged. */
  file(issueId: string, rubric: string[], deliverable: Deliverable): { created: boolean; grade: Grade } {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("INSERT OR IGNORE INTO grades (issue_id, rubric, deliverable, attempts, state, verdicts, created_at, updated_at) VALUES (?, ?, ?, 0, 'open', '[]', ?, ?)")
      .run(issueId, JSON.stringify(rubric), JSON.stringify(deliverable), now, now);
    if (Number(r.changes) > 0) this.events?.emit("grades", issueId);
    return { created: Number(r.changes) > 0, grade: this.get(issueId)! };
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

  /** Escalated rows finished again since: the runner checks each for a new deliverable version. */
  resubmitted(): Grade[] {
    return (this.db.prepare("SELECT g.* FROM grades g JOIN grade_resubmits r ON r.issue_id = g.issue_id WHERE g.state = 'escalated'").all() as unknown as Row[]).map(fromRow);
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
   * handed in again unchanged, the MAX_LOOPS-th rejected version, a verdict with criteria unverified but none unmet,
   * cannot_judge, a grader refusal and evidence that never came (error) escalate to the delegator. A grader that failed or returned no usable criteria (grading_failed) is retried on the
   * 1-5-15-60 minute ladder and escalates after MAX_GRADER_FAILURES passes in a row (the grade loop then blocks the task); any
   * real verdict, or a new round, clears that count.
   */
  record(issueId: string, v: VerdictInput, now = Date.now(), delegators?: string[]): Grade {
    const set = (state: GradeState, attempts: number, verdicts: Verdict[], failures: number, failedAt: string | null, at: number) => this.set(issueId, state, attempts, verdicts, failures, failedAt, at, delegators);
    const g = this.get(issueId);
    if (!g) throw new Error("no grade for this task");
    if (v.outcome === "awaiting_evidence") return set("awaiting_evidence", g.attempts, g.verdicts, g.failures, g.failedAt, now);
    const verdict: Verdict = { at: new Date(now).toISOString(), version: v.version, model: v.model, verdict: ["error", "grading_failed"].includes(v.outcome) ? "cannot_judge" : (v.outcome as Verdict["verdict"]), criteria: v.criteria };
    const verdicts = [...g.verdicts, verdict].slice(-20);
    if (v.outcome === "satisfied") return set("satisfied", g.attempts, verdicts, 0, null, now);
    if (v.outcome === "grading_failed") {
      const failures = g.failures + 1;
      const state = failures >= MAX_GRADER_FAILURES ? "escalated" : "grading_failed";
      return set(state, g.attempts, verdicts, failures, new Date(now).toISOString(), now);
    }
    if (v.outcome !== "needs_revision") return set("escalated", g.attempts, verdicts, 0, null, now);
    // Nothing shown unmet, only unverified: no rework (the assignee can't make evidence the grader isn't given). The delegator
    // gets one question about what couldn't be verified, and closing the task accepts it (accept()).
    if (unverifiedOnly(v.criteria)) return set("escalated", g.attempts, verdicts, 0, null, now);
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
/**
 * Paperclip's execution policy with a one-shot scheduled check for a task held for grading. The grader is that check; without
 * a saved review path Paperclip wakes the assignee to repair the review instead of leaving it for the grader.
 */
export function gradingReviewPolicy(policy: Record<string, unknown> | null | undefined, now = Date.now()): Record<string, unknown> {
  return { ...(policy ?? {}), monitor: { nextCheckAt: new Date(now + GRADE_CHECK_MS).toISOString(), notes: "The grader checks this task against its rubric." } };
}

/** Every way a task reaches done: the tasks bridge's task_finish and task_set_status(done), the runner's finishTurn and finishMerges. */
export type CompletionPath = "task_finish" | "task_set_status" | "finish_turn" | "finish_merges";
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
