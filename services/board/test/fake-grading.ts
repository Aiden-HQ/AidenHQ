import type { Grade, Grading } from "../src/grading.js";

/** A stand-in for the grading module's client: `rows` by task id, `staleRows` for fleet-ops, `settled` logs settle calls, `down` makes it unreachable. */
export function fakeGrading(rows: Record<string, Partial<Grade>> = {}, o: { on?: boolean; staleRows?: Partial<Grade>[] } = {}) {
  const g = {
    rows,
    on: o.on ?? true,
    staleRows: o.staleRows ?? [],
    settled: [] as { id: string; reason: string }[],
    down: false,
    async grades(ids: string[]) {
      if (g.down) throw new Error("grading module down");
      return { on: g.on, grades: Object.fromEntries(ids.filter((id) => g.rows[id]).map((id) => [id, { issueId: id, state: "open", updatedAt: "2026-01-01T00:00:00.000Z", ...g.rows[id] } as Grade])) };
    },
    async stale() {
      if (g.down) throw new Error("grading module down");
      return g.staleRows as Grade[];
    },
    async settle(id: string, reason: string) {
      g.settled.push({ id, reason });
      return null;
    },
  };
  return g satisfies Grading & Record<string, unknown>;
}
