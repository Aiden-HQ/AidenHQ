// A stand-in for the kernel's GET /v1/tasks/state: the rows a test sets, served by id or as the open list.
import type { StateRead, StateRow, TaskStates } from "../src/task-state.js";

export const row = (task: string, o: Partial<StateRow> = {}): StateRow => ({
  task, identifier: o.identifier ?? null, kind: "idle", reason: "orphaned", since: "2026-11-20T10:00:00.000Z", holder: null, attention: [], idle_wakes: 0, ...o,
});
const needs = (r: StateRow, p: (a: StateRow["attention"][number]) => boolean) => r.attention.some(p);

export function fakeStates(rows: StateRow[] = []): TaskStates & { rows: StateRow[]; reads: { ids?: string[]; open?: boolean }[] } {
  const me = {
    rows,
    reads: [] as { ids?: string[]; open?: boolean }[],
    async read(q: { ids?: string[]; open?: boolean }): Promise<StateRead> {
      me.reads.push(q);
      const tasks = (q.open ? me.rows.filter((r) => r.kind !== "done") : me.rows.filter((r) => q.ids?.includes(r.task) || q.ids?.includes(r.identifier ?? ""))).sort((a, b) => Number(b.attention.length > 0) - Number(a.attention.length > 0) || a.since.localeCompare(b.since));
      return {
        as_of: new Date().toISOString(),
        tasks,
        counts: {
          needs_you: tasks.filter((r) => needs(r, (a) => a.who === "owner")).length,
          failed: tasks.filter((r) => needs(r, (a) => a.why === "failed")).length,
          unexplained_idle: tasks.filter((r) => needs(r, (a) => ["orphaned", "unknown", "history_expired"].includes(a.why))).length,
        },
      };
    },
  };
  return me;
}
