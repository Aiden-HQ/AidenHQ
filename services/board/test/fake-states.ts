// A stand-in for the kernel's GET /v1/tasks/state: the rows a test sets, served by id or as the open list.
import type { StateQuery, TaskStates } from "../src/task-state.js";
import type { StateRead, StateRow } from "../src/aidenhq-sdk/task-state-types.js";

export const row = (task: string, o: Partial<StateRow> = {}): StateRow => ({
  task, identifier: o.identifier ?? null, kind: "idle", reason: "orphaned", since: "2026-11-20T10:00:00.000Z", holder: null, attention: [], lane: "idle", idle_wakes: 0, ...o,
});
const needs = (r: StateRow, p: (a: StateRow["attention"][number]) => boolean) => r.attention.some(p);

export function fakeStates(rows: StateRow[] = []): TaskStates & { rows: StateRow[]; reads: StateQuery[] } {
  const me = {
    rows,
    reads: [] as StateQuery[],
    async read(q: StateQuery): Promise<StateRead> {
      me.reads.push(q);
      const tasks = (q.open ? me.rows.filter((r) => r.kind !== "done" || (q.closed_since !== undefined && r.since >= q.closed_since)) : me.rows.filter((r) => q.ids?.includes(r.task) || q.ids?.includes(r.identifier ?? ""))).sort((a, b) => Number(b.attention.length > 0) - Number(a.attention.length > 0) || a.since.localeCompare(b.since));
      return {
        as_of: new Date().toISOString(),
        tasks,
        counts: {
          needs_you: tasks.filter((r) => needs(r, (a) => a.who === "owner")).length,
          failed: tasks.filter((r) => needs(r, (a) => a.why === "failed")).length,
          unexplained_idle: tasks.filter((r) => needs(r, (a) => ["unpolled", "orphaned", "unknown", "history_expired"].includes(a.why))).length,
        },
      };
    },
  };
  return me;
}
