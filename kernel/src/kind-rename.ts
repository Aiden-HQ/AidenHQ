// A renamed module's finished records keep their history under its successor: when module X `replaces` Y, a stored `Y.<action>`
// becomes `X.<action>` once X's registry defines that kind, so readers that match the current kind see old records too. Idempotent
// (a renamed row no longer matches); open records are not touched (reconcile carries claimed ones, the rest are short-lived).
import type { DatabaseSync } from "node:sqlite";

export type Catalog = { name: string; enabled?: boolean; replaces?: string[] }[];

/** Rewrites the finished records of every replaced module to its successor's kinds; returns how many rows moved. */
export function renameKinds(db: DatabaseSync, catalog: Catalog, kinds: Record<string, unknown>): number {
  let moved = 0;
  const update = db.prepare("UPDATE records SET kind = ?, module = ?, executor = json_set(executor, '$.module', ?) WHERE kind = ? AND state IN ('done','failed','rejected','stale','cancelled','unknown')");
  for (const x of catalog) if (x.enabled) for (const y of x.replaces ?? []) {
    const old = db.prepare("SELECT DISTINCT kind FROM records WHERE kind LIKE ? ESCAPE '\\'").all(`${y.replace(/[\\%_]/g, "\\$&")}.%`) as { kind: string }[];
    for (const { kind } of old) {
      const to = `${x.name}${kind.slice(y.length)}`;
      if (to in kinds) moved += Number(update.run(to, x.name, x.name, kind).changes);
    }
  }
  return moved;
}
