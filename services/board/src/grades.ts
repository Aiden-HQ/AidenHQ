// Graded done (wave 1): a delegated task's rubric and grading state, kept here in trusted storage (never the task's
// editable description), and the one completion gate every path to `done` calls for a task with a row. The board owns
// this state; the runner claims pending rows, gathers evidence and asks the grader.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Events } from "./events.js";

/**
 * open: filed with the delegation, the task not finished yet. pending: a completion path hit the gate, waiting for the
 * runner. awaiting_evidence: checks, a deploy or an approval still running. Then satisfied, needs_revision (back to the
 * assignee), grading_failed (the grader returned no usable criteria: retried in place, never the owner's) or escalated
 * (3 rejected versions or cannot_judge).
 */
export type GradeState = "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "escalated";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report";
  ref: string;
}
/** One grader verdict, bound to the exact deliverable version it graded (PR head SHA, deployed SHA, apply record). */
export interface Verdict {
  at: string;
  version: string;
  model: string;
  verdict: "satisfied" | "needs_revision" | "cannot_judge";
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
  created_at: string;
  updated_at: string;
}

/** Rejected versions before the owner decides (owner decision, wave 1). */
export const MAX_LOOPS = 3;
/** A grader pass that produced no usable verdict is retried this long after it, in place. */
export const GRADE_RETRY_MS = 60_000;

export const DeliverableSchema = z.object({ kind: z.enum(["pr", "app", "apply", "file", "report"]), ref: z.string().max(500).default("") }).strict();
/** A delegation's rubric: 3-8 checkable criteria, or none (the grader then uses modules/core/rubrics/<kind>.md). */
export const FileGradeSchema = z
  .object({
    issue: z.string().min(1).max(100),
    rubric: z.array(z.string().trim().min(3).max(200)).max(8).refine((r) => r.length === 0 || r.length >= 3, "3-8 criteria, or none for the template"),
    deliverable: DeliverableSchema,
  })
  .strict();
export const GateSchema = z.object({ via: z.enum(["task_finish", "task_set_status", "finish_turn", "finish_merges"]) }).strict();
/** The runner's outcome of one grading pass: still waiting on evidence, or the grader's verdict on `version` (error: the grader failed). */
export const VerdictSchema = z
  .object({
    version: z.string().max(200),
    outcome: z.enum(["awaiting_evidence", "satisfied", "needs_revision", "cannot_judge", "grading_failed", "error"]),
    model: z.string().max(100).default(""),
    criteria: z.array(z.object({ id: z.string().max(20), met: z.enum(["yes", "no", "unknown"]), evidence: z.string().max(1000) }).strict()).max(8).default([]),
  })
  .strict();

/** The kill switch (instance setting `grading`, in the grants table next to `autonomy`): off = every gate passes. Read fresh. */
export function gradingOn(grantsFile = process.env.AIDENHQ_GRANTS_FILE): boolean {
  try {
    return JSON.parse(readFileSync(grantsFile ?? "", "utf8"))?.grading !== "off";
  } catch {
    return true;
  }
}

/**
 * Whether a PR deliverable's ref may be filed: none (the task's own PRs), or a repo or PR in the agents org or the product
 * repo (`agents_org`, `product_repo` in the grants table, read fresh). Unknown repos refuse, as tiering does.
 */
export function prRefAllowed(ref: string, grantsFile = process.env.AIDENHQ_GRANTS_FILE): boolean {
  if (!ref) return true;
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pull\/\d+|#\d+)?\/?$/.exec(ref.trim());
  if (!m) return false;
  let t: { agents_org?: string; product_repo?: string } = {};
  try {
    t = JSON.parse(readFileSync(grantsFile ?? "", "utf8")) ?? {};
  } catch {}
  const [org, repo] = [m[1]!.toLowerCase(), `${m[1]}/${m[2]}`.toLowerCase()];
  return Boolean((t.agents_org && org === t.agents_org.toLowerCase()) || (t.product_repo && repo === t.product_repo.toLowerCase()));
}

const fromRow =(r: Row): Grade => ({ issueId: r.issue_id, rubric: JSON.parse(r.rubric), deliverable: JSON.parse(r.deliverable), attempts: r.attempts, state: r.state as GradeState, verdicts: JSON.parse(r.verdicts), createdAt: r.created_at, updatedAt: r.updated_at });

export class Grades {
  constructor(
    private db: DatabaseSync,
    private events?: Events,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS grades (
      issue_id TEXT PRIMARY KEY, rubric TEXT NOT NULL, deliverable TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, verdicts TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // An escalated task finished again: graded again only once the runner finds a new deliverable version (resubmit).
    db.exec("CREATE TABLE IF NOT EXISTS grade_resubmits (issue_id TEXT PRIMARY KEY, at TEXT NOT NULL)");
  }

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

  /** The rows the runner grades: a completion path hit the gate, the evidence was still coming, or the grader failed and is due a retry. */
  due(now = Date.now()): Grade[] {
    const retryBefore = new Date(now - GRADE_RETRY_MS).toISOString();
    return (
      this.db.prepare("SELECT * FROM grades WHERE state IN ('pending', 'awaiting_evidence') OR (state = 'grading_failed' AND updated_at <= ?) ORDER BY updated_at").all(retryBefore) as unknown as Row[]
    ).map(fromRow);
  }

  /** Escalated rows, newest first: the owner channel tells the owner of each once. */
  escalated(): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state = 'escalated' ORDER BY updated_at DESC LIMIT 50").all() as unknown as Row[]).map(fromRow);
  }

  /** Escalated rows finished again since: the runner checks each for a new deliverable version. */
  resubmitted(): Grade[] {
    return (this.db.prepare("SELECT g.* FROM grades g JOIN grade_resubmits r ON r.issue_id = g.issue_id WHERE g.state = 'escalated'").all() as unknown as Row[]).map(fromRow);
  }

  /** Marks an escalated task as finished again (the completion gate); its state stays the owner's. */
  markResubmitted(issueId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO grade_resubmits (issue_id, at) VALUES (?, ?)").run(issueId, new Date().toISOString());
  }

  /**
   * The runner's check of a resubmitted escalated task: a deliverable version other than the last one graded goes back to
   * the grader; the same version stays escalated (only the owner resolves it). The mark is cleared either way.
   */
  resubmit(issueId: string, version: string): Grade | undefined {
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    const g = this.get(issueId);
    if (!g || g.state !== "escalated") return g;
    if (version && version !== g.verdicts.at(-1)?.version) this.pend(issueId);
    return this.get(issueId);
  }

  /** Grading switched off: the runner let the task go, and its row goes (filed again only with a new delegation). */
  release(issueId: string): void {
    this.db.prepare("DELETE FROM grades WHERE issue_id = ?").run(issueId);
    this.db.prepare("DELETE FROM grade_resubmits WHERE issue_id = ?").run(issueId);
    this.events?.emit("grades", issueId);
  }

  private set(issueId: string, state: GradeState, attempts: number, verdicts: Verdict[]): Grade {
    this.db.prepare("UPDATE grades SET state = ?, attempts = ?, verdicts = ?, updated_at = ? WHERE issue_id = ?").run(state, attempts, JSON.stringify(verdicts), new Date().toISOString(), issueId);
    this.events?.emit("grades", issueId);
    return this.get(issueId)!;
  }

  /** Waiting for the grader again (the completion gate). */
  pend(issueId: string): void {
    const g = this.get(issueId)!;
    this.set(issueId, "pending", g.attempts, g.verdicts);
  }

  /**
   * One grading pass's outcome. A rejected version counts once (loops are distinct versions). A version rejected before and
   * handed in again unchanged, the MAX_LOOPS-th rejected version, cannot_judge and a grader error all escalate to the owner.
   * A grader pass with no usable criteria (grading_failed) is retried, never counted as a verdict on the work.
   */
  record(issueId: string, v: z.infer<typeof VerdictSchema>): Grade {
    const g = this.get(issueId);
    if (!g) throw new Error("no grade for this task");
    if (v.outcome === "awaiting_evidence") return this.set(issueId, "awaiting_evidence", g.attempts, g.verdicts);
    const verdict: Verdict = { at: new Date().toISOString(), version: v.version, model: v.model, verdict: ["error", "grading_failed"].includes(v.outcome) ? "cannot_judge" : (v.outcome as Verdict["verdict"]), criteria: v.criteria };
    const verdicts = [...g.verdicts, verdict].slice(-20);
    if (v.outcome === "satisfied") return this.set(issueId, "satisfied", g.attempts, verdicts);
    if (v.outcome === "grading_failed") return this.set(issueId, "grading_failed", g.attempts, verdicts);
    if (v.outcome !== "needs_revision") return this.set(issueId, "escalated", g.attempts, verdicts);
    if (g.verdicts.some((x) => x.verdict === "needs_revision" && x.version === v.version)) return this.set(issueId, "escalated", g.attempts, verdicts);
    const attempts = g.attempts + 1;
    return this.set(issueId, attempts >= MAX_LOOPS ? "escalated" : "needs_revision", attempts, verdicts);
  }
}

/**
 * Whether a board-side cascade (closing a task's crew parts when the task closes) may close one done: an ungraded task
 * passes, and so does one whose grade is satisfied. Anything else waits for the grader, so a cascade never satisfies a
 * rubric by itself.
 */
export function gradePassed(grades: Grades, issueId: string, on = gradingOn()): boolean {
  if (!on) return true;
  const g = grades.get(issueId);
  return !g || g.state === "satisfied";
}

/** Every way a task reaches done: the tasks bridge's task_finish and task_set_status(done), the runner's finishTurn and finishMerges. */
export type CompletionPath = z.infer<typeof GateSchema>["via"];
/**
 * pass: the path may close the task as it would have. Otherwise the task goes to in_review with the `grading` label and the
 * row has this state (escalated: it waits for the owner; grading_failed: the runner retries it).
 */
export type GateResult = { pass: true } | { pass: false; state: "pending" | "awaiting_evidence" | "needs_revision" | "grading_failed" | "escalated"; label: "grading" };

/**
 * The completion gate, idempotent. A task without a rubric or with grading switched off passes, and so does a satisfied one
 * that is already done (another path closing it again). Satisfied is not sticky: a satisfied task reopened and finished
 * again is graded again (each verdict is bound to its deliverable version). An escalated task stays the owner's: finishing
 * it again only marks it, and the runner sends it back to the grader once there is a new deliverable version.
 */
export function completionGate(grades: Grades, issueId: string, _via: CompletionPath, { done = false, on = gradingOn() }: { done?: boolean; on?: boolean } = {}): GateResult {
  const g = on ? grades.get(issueId) : undefined;
  if (!g || (g.state === "satisfied" && done)) return { pass: true };
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
