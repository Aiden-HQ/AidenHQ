// The grading module's HTTP API, read by the board (modules/grading owns the grade rows, the completion gate and every
// write). Types mirror the module's Grade. An unreachable or erroring module throws: each caller decides how to fail.
import { readFileSync } from "node:fs";

export type GradeState = "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "not_graded";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report" | "issue";
  ref: string;
}
export interface Verdict {
  at: string;
  version: string;
  model: string;
  verdict: "satisfied" | "needs_revision" | "cannot_judge" | "accepted";
  by?: string;
  criteria: { id: string; met: "yes" | "no" | "unknown"; evidence: string }[];
}
export interface Grade {
  issueId: string;
  rubric: string[];
  deliverable: Deliverable;
  attempts: number;
  state: GradeState;
  verdicts: Verdict[];
  failures: number;
  failedAt: string | null;
  delegators: string[] | null;
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
}
/**
 * `grades`: every task asked about, by id: its row, or null when it has none. An id missing from `grades` is unknown (never asked, or not answered), which is never "ungraded".
 */
export interface GradesView {
  grades: Record<string, Grade | null>;
  /** The module's standard criteria for each deliverable kind a returned row with an empty rubric uses. */
  templates?: Record<string, string[]>;
}

/** True when the module said the task has no row, or its row is satisfied. Unknown: false (fail closed). */
export const gradePassed = (view: GradesView, id: string): boolean => Object.hasOwn(view.grades, id) && (view.grades[id] === null || view.grades[id]!.state === "satisfied");
/** The module's answer per request: at most this many ids. */
export const GRADES_BATCH = 500;

export interface Grading {
  grades(ids: string[]): Promise<GradesView>;
  settle(id: string, reason: string): Promise<Grade | null>;
}

export function createGrading({ url = process.env.GRADING_URL ?? "http://grading:8096", keyFile = process.env.GRADING_BOARD_KEY_FILE, fetchFn = fetch }: { url?: string; keyFile?: string; fetchFn?: typeof fetch } = {}): Grading {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!keyFile) throw new Error("GRADING_BOARD_KEY_FILE is not set");
    const res = await fetchFn(`${url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${readFileSync(keyFile, "utf8").trim()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`grading ${method} ${path}: ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    // Every id, in batches the module takes; one failed batch fails the whole read (callers fail closed).
    grades: async (ids) => {
      const out: GradesView = { grades: {} };
      for (let i = 0; i < ids.length; i += GRADES_BATCH) {
        const v = await call<GradesView>("POST", "/board/grades", { ids: ids.slice(i, i + GRADES_BATCH) });
        Object.assign(out.grades, v.grades);
        Object.assign((out.templates ??= {}), v.templates);
      }
      return out;
    },
    settle: async (id, reason) => (await call<{ grade: Grade | null }>("POST", `/board/grades/${encodeURIComponent(id)}/settle`, { reason })).grade,
  };
}
