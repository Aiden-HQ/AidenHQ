// Stale owner tasks (owner, 2026-11-27): a task of the owner's left in New (Triage) with no activity for 14 days gets one
// mention in the daily brief (the chief of staff's `task_stale` read records it), then moves to the top of Later once a brief
// published after that mention exists. Never closed. Activity (any comment or change: Paperclip's lastActivityAt) or the
// owner's own move first drops the mention. A paused brief mentions nothing, so nothing moves.
import { BRIEF_LABEL, REPORT_LABEL } from "./board.js";
import type { Issue } from "./paperclip.js";
import type { Store } from "./store.js";

export const STALE_DAYS = 14;
const DAY = 86_400_000;
export const STALE_REASON = `No activity for ${STALE_DAYS} days`;

const idleDays = (i: Issue, now: number) => Math.floor((now - Date.parse(i.lastActivityAt ?? i.updatedAt)) / DAY);

/** The owner's open tasks still in New and idle for STALE_DAYS or more, oldest activity first. */
export function staleTasks(open: Issue[], store: Store, me: string, now = Date.now()): { issue: Issue; idle_days: number }[] {
  const placed = store.placements();
  const scheduled = store.schedules();
  return open
    .filter((i) => !scheduled.has(i.id) && i.assigneeUserId === me && !i.assigneeAgentId && !["done", "cancelled"].includes(i.status) && (placed.get(i.id)?.bucket ?? "triage") === "triage")
    .filter((i) => !(i.labels ?? []).some((l) => l.name === BRIEF_LABEL || l.name === REPORT_LABEL))
    .map((issue) => ({ issue, idle_days: idleDays(issue, now) }))
    .filter((x) => x.idle_days >= STALE_DAYS)
    .sort((a, b) => b.idle_days - a.idle_days);
}

/** Moves the mentioned stale tasks once a brief written after their mention exists; drops mentions that no longer apply. */
export function moveStale(open: Issue[], briefs: Issue[], store: Store, me: string, now = Date.now()): string[] {
  const mentions = store.staleMentions();
  if (!mentions.size) return [];
  const still = new Set(staleTasks(open, store, me, now).map((x) => x.issue.id));
  const moved: string[] = [];
  for (const [id, at] of mentions) {
    if (!still.has(id)) {
      store.clearStale(id);
      continue;
    }
    // A brief published (or republished: the chief of staff updates the day's brief) after the mention.
    if (!briefs.some((b) => (b.updatedAt ?? b.createdAt) > at)) continue;
    store.place(id, "backlog", STALE_REASON, "Board");
    store.clearStale(id);
    moved.push(id);
  }
  return moved;
}
