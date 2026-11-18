// One durable, idempotent write to the control plane: `once(key, write)` runs `write` once per key and returns the first
// run's result ever after (outcomes.ts, cp.ts and lane.ts all post through it). The key is written pending before the call
// and completed after it. A write that fails for certain (a refusal) clears its key. One whose outcome is unknown (the
// error's code is "unknown": a 5xx, a timeout, a crash after Paperclip's 201) stays pending, and its retry is told
// (`retry`) to look for what the first try wrote before writing again.
import type { DatabaseSync } from "node:sqlite";

export function createOnce(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS pc_writes (key TEXT PRIMARY KEY, result TEXT, at INTEGER NOT NULL)");
  const row = db.prepare("SELECT result FROM pc_writes WHERE key = ?");
  return async function once<R>(key: string, write: (retry: boolean) => Promise<R>): Promise<{ value: R; again: boolean }> {
    const had = row.get(key) as { result: string | null } | undefined;
    if (had?.result) return { value: JSON.parse(had.result) as R, again: true };
    if (!had) db.prepare("INSERT INTO pc_writes (key, at) VALUES (?, ?)").run(key, Date.now());
    let value: R;
    try {
      value = await write(Boolean(had));
    } catch (e) {
      if ((e as { code?: string }).code !== "unknown") db.prepare("DELETE FROM pc_writes WHERE key = ? AND result IS NULL").run(key);
      throw e;
    }
    db.prepare("UPDATE pc_writes SET result = ? WHERE key = ?").run(JSON.stringify(value ?? null), key);
    return { value, again: Boolean(had) };
  };
}
export type Once = ReturnType<typeof createOnce>;
