// A job's last plan-time write refusal: the words it gave, its rule's stable code, the kind it was asking for and the module
// whose kind that is. Both
// sides of the kernel use it — writes.ts records and clears a refusal, jobs.ts reads it into JobView — so it lives here, in its
// own module, and neither has to import the other's schema to open it.
import type { DatabaseSync } from "node:sqlite";

/** The refusal table, with the rule's `code`, the `kind` asked for and the `source` module whose kind refused it. */
export const REFUSALS_DDL = "CREATE TABLE IF NOT EXISTS job_refusals (job TEXT PRIMARY KEY, why TEXT NOT NULL, code TEXT, kind TEXT, source TEXT)";

/** A refusal as writes.ts records it and jobs.ts shows it. */
export type Refusal = { why: string; code: string | null; kind: string | null; source: string | null };

/** How many times a busy lock is waited out before the setup fails, and how long between tries. */
const SETUP_TRIES = 200;
const SETUP_RETRY_MS = 25;
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Another opener holds the write lock: the code SQLite puts on the error (a "database is locked" message is the same thing). */
const busyError = (e: unknown) => (e as { errcode?: number }).errcode === 5 || (e as { errstr?: string }).errstr === "SQLITE_BUSY" || /database is locked/i.test(String((e as Error).message));
/** The columns a database built before the code and its source lacks: read inside the caller's own transaction. */
export const refusalColumns = (db: DatabaseSync) => {
  const have = new Set((db.prepare("PRAGMA table_info(job_refusals)").all() as { name: string }[]).map((c) => c.name));
  if (!have.has("code")) db.exec("ALTER TABLE job_refusals ADD COLUMN code TEXT");
  if (!have.has("kind")) db.exec("ALTER TABLE job_refusals ADD COLUMN kind TEXT");
  if (!have.has("source")) db.exec("ALTER TABLE job_refusals ADD COLUMN source TEXT");
};

/**
 * The refusal table and its columns, for a service that files writes without creating jobs (writes.ts): one BEGIN IMMEDIATE,
 * retried while another opener holds the lock, so two openers never both alter (the second finds the columns).
 */
export function openRefusals(db: DatabaseSync) {
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(REFUSALS_DDL);
      refusalColumns(db);
      db.exec("COMMIT");
      return;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      if (busyError(e) && attempt < SETUP_TRIES) { pause(SETUP_RETRY_MS); continue; }
      throw e;
    }
  }
}

/** A job's last refusal, when nothing later went through: written by writes.ts, cleared by a write that goes through. */
export const refusalOf = (db: DatabaseSync, job: string) => db.prepare("SELECT why, code, kind, source FROM job_refusals WHERE job = ?").get(job) as Refusal | undefined;
/** Record a job's refusal, or clear it with `why` null: one row per job. */
export const markRefusal = (db: DatabaseSync, job: string, why: string | null, code?: string, kind?: string, source?: string) =>
  why
    ? db.prepare("INSERT INTO job_refusals (job, why, code, kind, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET why = excluded.why, code = excluded.code, kind = excluded.kind, source = excluded.source").run(job, why, code ?? null, kind ?? null, source ?? null)
    : db.prepare("DELETE FROM job_refusals WHERE job = ?").run(job);
