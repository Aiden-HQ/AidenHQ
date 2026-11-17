import type { State } from "./state.ts";

/**
 * A task whose blocker is unresolved stays asleep: Paperclip refuses its status write with a 422, so a run would only be
 * counted as a failure. Its job waits here, in the runner's state (a restart keeps it), until the blockers close.
 */
export interface ParkedJob {
  issueId: string;
  instructions: string;
  /** A refusal whose blocker the reads didn't show: tried again after this time, not on every poll. */
  retryAfter?: string;
}

type Store = Pick<State, "get" | "set">;

const KEY = "parked_jobs";

export const parkedJobs = (state: Store): ParkedJob[] => JSON.parse(state.get(KEY) || "[]");

/** Keep the job for a task until its blockers close; a later request on the same task replaces the earlier one. */
export function park(state: Store, job: ParkedJob) {
  const rest = parkedJobs(state).filter((p) => p.issueId !== job.issueId);
  state.set(KEY, JSON.stringify([...rest, job]));
}

export function unpark(state: Store, issueId: string) {
  state.set(KEY, JSON.stringify(parkedJobs(state).filter((p) => p.issueId !== issueId)));
}

/** Whether a parked job may be tried now (a refusal waits out its floor, so it is not retried every poll). */
export const ready = (job: ParkedJob, now = Date.now()) => !job.retryAfter || Date.parse(job.retryAfter) <= now;
