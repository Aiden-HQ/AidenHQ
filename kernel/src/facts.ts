// Flow's fact log (docs/design/flow.md §1): what happened to each piece of work, when, and who did it, appended as it happens
// by the kernel (in the same transaction as the change it describes) and by modules (POST /v1/facts). Facts only: stages,
// idle time and their reasons are derived from them (flow.ts), so a definition can change without re-instrumenting.
// The id is `<type>:<subject>:<version>`: a duplicate delivery, a poll that sees the same change, or a re-run backfill
// records once.
import type { DatabaseSync } from "node:sqlite";

export type Fact = {
  type: string;
  subject: string;
  /** The source's own version of this change (a statusVersion, a job state, a head + attempt); makes the id deterministic. */
  version: string;
  /** When it happened at the source (ISO). */
  at: string;
  /** Who did it, set by the kernel: agent:<key>, account:<id>, module:<name>, kernel, github:<login>, unknown. */
  actor: string;
  task?: string | null;
  source?: "live" | "poll" | "backfill";
  data?: Record<string, unknown>;
};
export type FactRow = Fact & { seq: number; id: string; seen_at: string; task: string | null; source: "live" | "poll" | "backfill"; data: Record<string, unknown> };

const DAY = 864e5;

export function openFacts(db: DatabaseSync, now = () => new Date()) {
  db.exec(`CREATE TABLE IF NOT EXISTS facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      subject TEXT NOT NULL, version TEXT NOT NULL, task TEXT, at TEXT NOT NULL, seen_at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live',
      data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS facts_task ON facts (task, at);
    CREATE INDEX IF NOT EXISTS facts_type ON facts (type, at);
    CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject);`);
  const insert = db.prepare("INSERT OR IGNORE INTO facts (id, type, subject, version, task, at, seen_at, actor, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (r: any): FactRow => ({ ...r, data: JSON.parse(r.data) });
  return {
    /** Records one fact; true when it is new. Never call it outside the transaction of the change it describes, when there is one. */
    record(f: Fact): boolean {
      return insert.run(`${f.type}:${f.subject}:${f.version}`, f.type, f.subject, f.version, f.task ?? null, f.at, now().toISOString(), f.actor, f.source ?? "live", JSON.stringify(f.data ?? {})).changes === 1;
    },
    /** Facts after `seq`, in ingestion order (incremental readers). */
    since(seq: number, limit = 1000): FactRow[] {
      return (db.prepare("SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as any[]).map(row);
    },
    /** One task's facts, oldest first. */
    forTask(task: string): FactRow[] {
      return (db.prepare("SELECT * FROM facts WHERE task = ? ORDER BY at, seq").all(task) as any[]).map(row);
    },
    /** Drops facts older than `days` (the kernel's daily sweep); returns how many. */
    prune(days = 400): number {
      return Number(db.prepare("DELETE FROM facts WHERE at < ?").run(new Date(now().getTime() - days * DAY).toISOString()).changes);
    },
  };
}
export type Facts = ReturnType<typeof openFacts>;
