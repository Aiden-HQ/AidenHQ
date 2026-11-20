// How the kernel's writers record a flow fact (facts.ts). A fact task state depends on (jobs, wakes, waits, records, the scan's
// task changes) is strict: written in its transition's transaction, and the transition fails if it can't be. An observed comment
// fact (cp.ts, outcomes.ts) never blocks the write it describes: one that can't be written is logged and the write goes on.
import type { DatabaseSync } from "node:sqlite";
import type { Fact, Facts } from "./facts.ts";

export type Log = (msg: string, f?: Record<string, unknown>) => void;
export const iso = (ms: number) => new Date(ms).toISOString();
export const factWriter = (facts: Facts | undefined, log: Log = () => {}) => (f: Fact): void => {
  if (!facts) return;
  try { facts.record(f); } catch (e) { log("fact not recorded", { type: f.type, subject: f.subject, err: (e as Error).message }); }
};
/** A fact that throws when it can't be written (a duplicate id is no error: it was recorded once already). */
export const strictFact = (facts: Facts) => (f: Fact): void => { facts.record(f); };
/** `fn` in one savepoint (inside an open transaction too): all of it lands, or none of it and the error is thrown. Never await in `fn`. */
export function inTx<T>(db: DatabaseSync, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw e;
  }
}
