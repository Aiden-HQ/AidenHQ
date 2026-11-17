// Notices inform; only an outcome wakes an agent (owner, 2026-11-15). Every notice the runner posts about a sub-task is one
// of these kinds. An outcome is the last word on the work, one someone must act on: it goes to the parent task, and the
// comment wakes the delegator. Progress is a step the runner, the Engineer or the grader still carries on from: it stays on
// the sub-task, where it wakes nobody (Paperclip never wakes a runner Engineer, and the runner ignores its own marked
// comments), and the outcome that follows sums it up. In 24 hours of the live fleet, 293 runs were woken by progress posted
// on a parent and only 29% of them advanced anything.

/** Outcomes: the sub-task ended in a state its delegator acts on. */
const OUTCOMES = new Set<string>([
  "done", // closed (graded satisfied, or closed ungraded), or finished with nothing left for the runner or a grader
  "parked", // the runner stopped retrying (the AI reviewer's rejections ran out)
  "escalated", // the grader gave the decision to the delegator
  "failed", // it failed and nothing retries it by itself
  "decision", // it needs the delegator's word (a "pr" go-ahead, a brief two reviewers found unclear)
]);
/** Progress: something on the way that the runner, the Engineer or the grader still carries on from. */
const PROGRESS = new Set<string>([
  "rejected", // a card rejected and sent back to its Engineer (the runner dispatches it with the note)
  "applied", // an approved card ran, with a grade still to follow
  "merged", // the merges ran, with a grade still to follow
  "finished", // an Engineer's turn ended, with a grade still to follow
]);

/** Whether a notice of this kind goes to the parent (an outcome) or stays on the sub-task (progress). */
/** A notice the runner posts about a sub-task. */
export type NoticeKind = "done" | "parked" | "escalated" | "failed" | "decision" | "rejected" | "applied" | "merged" | "finished";

export function wakesParent(kind: string): boolean {
  if (OUTCOMES.has(kind)) return true;
  if (PROGRESS.has(kind)) return false;
  throw new Error(`unknown notice kind: ${kind}`);
}

/**
 * Whether a task's grade (its board state; none when ungraded) still has its say: then the grader's outcome follows, and
 * the task's progress is not news. A satisfied, escalated or settled grade has said it already.
 */
export const graderSpeaks = (state: string | null | undefined): boolean => ["open", "pending", "awaiting_evidence", "needs_revision", "grading_failed"].includes(state as string);

/**
 * The kind of the summary posted when a parent's Engineer sub-tasks have all finished a turn (prompt.ts subtaskSummary's
 * rows, each with `graded`: a grade will still speak for it, so not one already escalated to the delegator). Progress only when every row ended its turn, is graded, and asks
 * nothing (each committed change already has its card): the grade says the rest. Otherwise it is the outcome: work that
 * failed or stopped, a "pr" the delegator has to reply, or ungraded work whose result is now the delegator's to judge.
 */
/** One finished Engineer sub-task in a parent's summary (prompt.ts subtaskSummary). */
export interface SummaryRow {
  status?: string;
  job?: string;
  committed?: boolean;
  cards?: unknown[];
  published?: boolean; // its PR merged, or its task closed: no "pr" to ask for
  graded?: boolean;
}

export function summaryKind(rows: SummaryRow[]): NoticeKind {
  if (rows.some((r) => r.status !== "cancelled" && r.job !== "done")) return "failed";
  // Published work (its PR merged, or the task closed) asks for no "pr": the summary says so without waking the delegator.
  if (rows.some((r) => r.committed && !(r.cards ?? []).length && !r.published)) return "decision";
  return rows.every((r) => r.status === "cancelled" || r.graded) ? "finished" : "done";
}

/**
 * What follows a card the AI reviewer rejected on a runner Engineer's task. The Engineer is dispatched with the note
 * (`dispatch`): nobody else wakes it, since its task wakes no Paperclip agent. At MAX_REJECTS reviewer rejections of that
 * branch or PR the runner stops sending it back, and the delegator is told, never the Engineer (another branch of the task
 * is still reviewed on its own). Two reviewers unsure may mean the brief is the fix, which is the delegator's: it is told
 * too. A card whose head moved (stale) needs nothing: a newer one follows.
 */
export function afterRejection({ code, rejects, maxRejects, unsure }: { code: string | null | undefined; rejects: number; maxRejects: number; unsure: string }): { dispatch: boolean; tell?: NoticeKind } {
  if (code === "stale_head") return { dispatch: false };
  if (rejects >= maxRejects) return { dispatch: false, tell: "parked" };
  return { dispatch: true, ...(code === unsure ? { tell: "decision" } : {}) };
}
