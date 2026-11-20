// GitHub objects AidenHQ's own writes made, so "is this ours" is a lookup in our records and never a guess from GitHub: a
// successful write outcome carries the refs it created or changed (writes.ts outcomeOf), and a code host's Flow facts carry
// `data.objects` for background writes (facts.ts record). The refs, lower-cased:
//   github:<owner>/<repo>#<n>                  an issue or PR
//   github:<owner>/<repo>@<sha40>              a commit
//   github:<owner>/<repo>#<n>/comment/<id>     a comment
// Attribution only: nothing here is authority (the owner's authority reaches the fleet through AidenHQ, never through GitHub).
import type { DatabaseSync } from "node:sqlite";

const REF = /^github:[\w.-]+\/[\w.-]+(?:#\d{1,9}(?:\/comment\/\d{1,15})?|@[0-9a-f]{40})$/;
const MAX_REFS = 200;

export function ensureObjects(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS write_objects (ref TEXT PRIMARY KEY, record TEXT NOT NULL, at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS write_objects_at ON write_objects (at);");
}
/** The well-formed refs in `v`, lower-cased and at most MAX_REFS; anything else is dropped. */
export const cleanRefs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()).filter((x) => REF.test(x)).slice(0, MAX_REFS) : []);
/** Remembers `refs` as made by `record` (a write record's id, or `fact:<type>`); the first record to name a ref keeps it. */
export function addObjects(db: DatabaseSync, record: string, refs: unknown, at: string) {
  const insert = db.prepare("INSERT OR IGNORE INTO write_objects (ref, record, at) VALUES (?, ?, ?)");
  for (const ref of cleanRefs(refs)) insert.run(ref, record, at);
}
export const objectOf = (db: DatabaseSync, ref: string) => db.prepare("SELECT record, at FROM write_objects WHERE ref = ?").get(ref.toLowerCase()) as { record: string; at: string } | undefined;
/** Issue and PR refs (`…#<n>`, no comment part) recorded since `since`, oldest first. */
export const objectsSince = (db: DatabaseSync, since: string) =>
  (db.prepare("SELECT ref FROM write_objects WHERE at >= ? AND ref NOT LIKE '%/comment/%' AND ref NOT LIKE '%@%' ORDER BY at LIMIT 5000").all(since) as { ref: string }[]).map((r) => r.ref);
