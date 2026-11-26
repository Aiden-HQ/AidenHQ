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
  | { act: "nothing"; owner?: true }
  | { act: "enqueue"; attempt: number; retried?: boolean; /** The previous attempt asked again for wait-free reasons (a pending request, an unread gate): it spends no repair round. */ pending?: boolean }
  | { act: "fix_ci"; failing: string[] }
  | { act: "wait"; why: string }
  | { act: "hold"; why: string; /** GitHub's own refusal, in words for the report. */ refused?: string };

const OPEN = ["review", "owner", "approved", "claimed"];

export async function queueNext(kernel: { call(method: string, path: string): Promise<any> }, q: Queued | undefined, pr: PrView, f: QueueFacts): Promise<QueueNext> {
  if (!q || q.head !== pr.head) return { act: "enqueue", attempt: 1 };
  const r = await kernel.call("GET", `/v1/writes/${q.record}`);
  const text = String(r.outcome?.text ?? r.reason ?? "");
  if (OPEN.includes(String(r.state))) return r.state === "owner" ? { act: "nothing", owner: true } : { act: "nothing" };
  // A veto is final for this head; a head that moved meanwhile is the next round's.
  if (r.state === "rejected") return { act: "hold", why: `the enqueue at \`${pr.head.slice(0, 12)}\` was rejected (${String(r.reason ?? "no reason given").slice(0, 200)})` };
  if (/^ship-head-moved/.test(text)) return { act: "nothing" };
  // `ship-enqueue-pending`: GitHub accepted the async merge request (or one is already pending) and its result is not terminal
  // yet — neither a refusal nor a hold. It is asked again at the same head, and the repeat reads the request that head already
  // has by its kept id (and names the same one on a 409 while it is pending), so a terminal `failed` or `enqueued` is never
  // lost and no second request is made. A queue removal is never read from here: `groupFailing` names the PR's latest
  // merge_group run, which may belong to an earlier head, so it is no evidence about this one.
  const pending = /^ship-enqueue-pending/.test(text);
  // Not queued (a refusal, an unanswered call that read back as not queued): a new attempt at the same head.
  // Ended by a pause or a stop (the adoption moved on): queued again now that it is worked again. Any other end (a refusal, a veto,
  // a call that read back as not queued) holds, never queued again at this head; the outcome is on the record.
  // A `ship-tier-pending` answer is not a refusal either: the head is asked again, and that ask is a wait's, not a repair's.
  const later = pending || /^ship-generation|ship-tier-pending/.test(text);
  if (r.state !== "done") return later ? { act: "enqueue", attempt: q.attempt + 1, retried: q.retried, pending: true } : { act: "hold", why: `the enqueue at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)}${text ? ` (${text.slice(0, 300)})` : ""}; its outcome is on record ${q.record}`, ...(/^GitHub refused to queue/.test(text) ? { refused: text.replace(/^GitHub refused to queue \S+: /, "").slice(0, 300) } : {}) };
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
