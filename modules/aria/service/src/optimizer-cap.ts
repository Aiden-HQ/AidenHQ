// The nightly tidy-up's move cap, counted from the kernel's own write records (GET /v1/work?since=, role kernel.work-read), so a
// retry, a restarted run or a second task in the same night cannot go over it. The records do not name the tool, so every
// reviewed (tier 1 or 2) calendar write Aria filed since the night began counts: Aria's only reviewed writes are her four calendar
// tools, and counting them all errs on the side of fewer moves. A write that failed, was rejected, went stale or was cancelled moved
// nothing and does not count; one still in review, approved or of unknown outcome does.
// The service cannot intercept Google's write, so this is a count the skill must ask for before every move (aria_move_budget), not a gate.
export interface WorkRecord { kind: string; state: string; requester: string | null; created_at: string }
const NOT_A_MOVE = new Set(["failed", "rejected", "stale", "cancelled"]);
const CONN_TOOL = "conn.tool";

/** Moves made since `since` by `agent`, from `GET /v1/work?since=`'s `records`. */
export function movesSince(records: WorkRecord[], agent: string, since: string): number {
  return records.filter((r) => r.kind === CONN_TOOL && r.requester === agent && r.created_at >= since && !NOT_A_MOVE.has(r.state)).length;
}

/** What may still move tonight; `ok` is false at the cap. */
export function budget(records: WorkRecord[], agent: string, since: string, maxMoves: number) {
  const used = movesSince(records, agent, since);
  return { used, max_moves: maxMoves, remaining: Math.max(0, maxMoves - used), ok: used < maxMoves };
}
