// Shipping through GitHub's merge queue (item 28): a ready PR on a queue branch is enqueued (github.enqueue, bound to the head and
// base) instead of merged. Once queued, ship only watches: decide says "wait" while the PR is in the queue and "done" once it lands.
// A removal is a normal round event, read from facts (never from GitHub's free-text reason): the PR was queued at this head, its
// enqueue record is done, and it is out of the queue and still open again. Conflicts and a branch behind are decide's `repair`
// (a new head, then a fresh enqueue). A red required check on the merge_group run is `fix_ci` only when it isn't red on the base
// too; failing there as well, the PR is enqueued once more and then waits visibly. Any other removal is a visible wait.
import type { PrView } from "./handoff.ts";

/** The enqueue ship filed for a head: its kernel record, the base it was bound to, and whether the one re-enqueue is spent. */
export type Queued = { head: string; base: string; attempt: number; record: string; retried?: boolean };

/** Round facts the queue reads: required checks red on this PR's merge_group run, and red on the base's latest run. */
export interface QueueFacts { groupFailing?: string[]; onBase?: string[] }

export type QueueNext =
  | { act: "nothing" }
  | { act: "enqueue"; attempt: number; retried?: boolean }
  | { act: "fix_ci"; failing: string[] }
  | { act: "wait"; why: string }
  | { act: "hold"; why: string };

const OPEN = ["review", "owner", "approved", "claimed"];

export async function queueNext(kernel: { call(method: string, path: string): Promise<any> }, q: Queued | undefined, pr: PrView, f: QueueFacts): Promise<QueueNext> {
  if (!q || q.head !== pr.head) return { act: "enqueue", attempt: 1 };
  const r = await kernel.call("GET", `/v1/writes/${q.record}`);
  const text = String(r.outcome?.text ?? r.reason ?? "");
  if (OPEN.includes(String(r.state))) return { act: "nothing" };
  // A veto is final for this head; a head that moved meanwhile is the next round's.
  if (r.state === "rejected") return { act: "hold", why: `the enqueue at \`${pr.head.slice(0, 12)}\` was rejected (${String(r.reason ?? "no reason given").slice(0, 200)})` };
  if (/^ship-head-moved/.test(text)) return { act: "nothing" };
  // Not queued (a refusal, an unanswered call that read back as not queued): a new attempt at the same head.
  // Ended by a pause or a stop (the adoption moved on): queued again now that it is worked again. Any other end (a refusal, a veto,
  // a call that read back as not queued) holds, never queued again at this head; the outcome is on the record.
  if (r.state !== "done") return /^ship-generation/.test(text) ? { act: "enqueue", attempt: q.attempt + 1, retried: q.retried } : { act: "hold", why: `the enqueue at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)}; its outcome is on record ${q.record}` };
  // Queued, and open and out of the queue again: removed.
  const onBase = new Set(f.onBase ?? []);
  const own = (f.groupFailing ?? []).filter((n) => !onBase.has(n));
  // Once re-queued for a base that was red too, its merge_group failures (the last run's, even after the base is fixed) are a wait.
  if (own.length && !q.retried) return { act: "fix_ci", failing: own };
  if (f.groupFailing?.length) {
    return q.retried
      ? { act: "wait", why: `removed from the merge queue again: ${f.groupFailing.map((n) => `\`${n}\``).join(", ")} fails on \`${pr.defaultBranch}\` too: a person queues it again (or a push does) once the base is green` }
      : { act: "enqueue", attempt: q.attempt + 1, retried: true };
  }
  return { act: "wait", why: "removed from the merge queue and waiting for a person to queue it again or push" };
}
