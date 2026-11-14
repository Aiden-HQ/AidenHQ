import { Paperclip } from "./paperclip.mjs";
import { CODE_REJECTS } from "./tiers.mjs";

/**
 * The owner's reply on a task after the AI reviewer rejected something is new context: that rejection stops blocking a new
 * request (one re-review per reply, since the fresh rejection is dated after it) and the next review reads both. Only judged
 * reviewer rejections qualify: the owner's own no, a watcher's stale no and code's refusals are untouched.
 * Returns the records that still count, and the lines to attach to the review (`previous`).
 */
export function splitAnswered(records, comments, who = "The owner") {
  const reply = (comments ?? []).filter((c) => Paperclip.isUserInstruction(c)).at(-1);
  const answered = reply ? records.filter((r) => r.state === "rejected" && /^reviewer:/.test(r.decidedBy ?? "") && !CODE_REJECTS.includes(r.reviewCode) && String(r.decidedAt ?? "") < reply.createdAt) : [];
  return {
    records: records.filter((r) => !answered.includes(r)),
    answers: answered.length ? [`${who}'s reply on the task after the rejection(s) below: ${String(reply.body).slice(0, 1500)}`, ...answered.map((r) => r.review).filter(Boolean)] : [],
  };
}
