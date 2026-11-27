// A delegated task's rubric and the one check of it after the task closed: one row per task, in this module's own SQLite file.
// open: filed, the task not closed yet (or its check is to be tried again). met / unmet: the check read the agent's report.
// failed: the check could not be made (MAX_TRIES model calls failed). A cancelled task's row is deleted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export type State = "open" | "met" | "unmet" | "failed";
export interface Deliverable { kind: string; ref: string }
export interface Criterion { id: string; met: "yes" | "no"; reason: string }
export interface Row {
  task: string;
  filer: string;
  /** The criteria as filed: the delegator's, or the kind's standard list. */
  rubric: string[];
  deliverable: Deliverable;
  state: State;
  criteria: Criterion[];
  model: string;
  reason: string;
  tries: number;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Model calls a check gets before it is recorded failed. */
export const MAX_TRIES = 3;
export const KINDS = ["pr", "app", "apply", "file", "report", "issue"];

/** Where a body breaks the contract: a 400. */
export class Invalid extends Error {}
/** Where a filing conflicts with the row there: a 409. */
export class Conflict extends Error {}
const bad = (msg: string): never => { throw new Invalid(msg); };

/** A filing's rubric and deliverable: 3-8 criteria of 3-200 characters (none: the kind's standard list, filed as its text), and {kind, ref}. */
export function parseFiling(b: unknown): { rubric: string[]; deliverable: Deliverable } {
  const o = (b ?? {}) as { rubric?: unknown; deliverable?: { kind?: unknown; ref?: unknown } };
  const rubric = (Array.isArray(o.rubric) ? o.rubric : bad("rubric: a list")).map((c) => (typeof c === "string" && c.trim().length >= 3 && c.trim().length <= 200 ? c.trim() : bad("rubric: each criterion 3-200 characters")));
  if (rubric.length && (rubric.length < 3 || rubric.length > 8)) bad("rubric: 3-8 criteria, or none for the standard list");
  const kind = String(o.deliverable?.kind ?? "");
  if (!KINDS.includes(kind)) bad(`deliverable.kind: one of ${KINDS.join(", ")}`);
  const ref = o.deliverable?.ref === undefined ? "" : typeof o.deliverable.ref === "string" && o.deliverable.ref.length <= 500 ? o.deliverable.ref : bad("deliverable.ref: a string of at most 500 characters");
  return { rubric: rubric.length ? rubric : template(kind), deliverable: { kind, ref } };
}

/** The standard criteria for a deliverable kind: the `- ` lines of rubrics/<kind>.md. */
export function template(kind: string, dir: string = fileURLToPath(new URL("../rubrics", import.meta.url))): string[] {
  const file = join(dir, `${kind}.md`);
  if (!/^[a-z]+$/.test(kind) || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}

type Raw = { task: string; filer: string; rubric: string; kind: string; ref: string; state: string; criteria: string; model: string; reason: string; tries: number; checked_at: string | null; created_at: string; updated_at: string };
const fromRaw = (r: Raw): Row => ({ task: r.task, filer: r.filer, rubric: JSON.parse(r.rubric), deliverable: { kind: r.kind, ref: r.ref }, state: r.state as State, criteria: JSON.parse(r.criteria), model: r.model, reason: r.reason, tries: r.tries, checkedAt: r.checked_at, createdAt: r.created_at, updatedAt: r.updated_at });

export class Store {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA busy_timeout = 5000");
    // The rows of the graded-done gate this replaced are not carried over (data_version 1).
    for (const t of ["grades", "grade_failures", "grade_filers", "loop_state"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(`CREATE TABLE IF NOT EXISTS rubrics (
      task TEXT PRIMARY KEY, filer TEXT NOT NULL, rubric TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open', criteria TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      tries INTEGER NOT NULL DEFAULT 0, checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  get(task: string): Row | undefined {
    const r = this.db.prepare("SELECT * FROM rubrics WHERE task = ?").get(task) as Raw | undefined;
    return r && fromRaw(r);
  }

  open(): Row[] {
    return (this.db.prepare("SELECT * FROM rubrics WHERE state = 'open' ORDER BY updated_at").all() as unknown as Raw[]).map(fromRaw);
  }

  /**
   * Files a task's rubric, or replaces it while the task is still open, by the same filer only. A byte-identical filing is a
   * retry and writes nothing. Returns whether the row is new.
   */
  file(task: string, filer: string, rubric: string[], deliverable: Deliverable): boolean {
    const have = this.get(task);
    if (have && have.filer === filer && JSON.stringify(have.rubric) === JSON.stringify(rubric) && JSON.stringify(have.deliverable) === JSON.stringify(deliverable)) return false;
    if (have && have.filer !== filer) throw new Conflict(`only ${have.filer}, which filed this task's rubric, may replace it`);
    if (have && have.state !== "open") throw new Conflict("this task was already checked: its rubric stays as it was checked");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO rubrics (task, filer, rubric, kind, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task) DO UPDATE SET rubric = excluded.rubric, kind = excluded.kind, ref = excluded.ref, updated_at = excluded.updated_at`)
      .run(task, filer, JSON.stringify(rubric), deliverable.kind, deliverable.ref, now, now);
    return !have;
  }

  /** The check's result: met or unmet with each criterion's reason. */
  record(task: string, rubric: string[], criteria: Criterion[], model: string) {
    const now = new Date().toISOString();
    const state = criteria.some((c) => c.met === "no") ? "unmet" : "met";
    // Only onto the rubric the check read: a refiling that landed meanwhile is checked on the next pass.
    this.db.prepare("UPDATE rubrics SET state = ?, criteria = ?, model = ?, reason = '', checked_at = ?, updated_at = ? WHERE task = ? AND rubric = ?").run(state, JSON.stringify(criteria), model, now, now, task, JSON.stringify(rubric));
  }

  /** A check that could not be made: tried again on the next pass, recorded failed after MAX_TRIES. */
  failed(task: string, reason: string) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE rubrics SET tries = tries + 1, reason = ?, state = CASE WHEN tries + 1 >= ${MAX_TRIES} THEN 'failed' ELSE state END, updated_at = ? WHERE task = ?`).run(reason.slice(0, 300), now, task);
  }

  drop(task: string) {
    this.db.prepare("DELETE FROM rubrics WHERE task = ?").run(task);
  }
}
