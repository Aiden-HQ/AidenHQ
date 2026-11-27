// The grading module's HTTP API, read by the board (modules/grading owns the rubric rows and the one check after close).
// Types mirror the module's Row. An unreachable or erroring module throws: each caller decides how to fail.
import { readFileSync } from "node:fs";

export type GradeState = "open" | "met" | "unmet" | "failed";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report" | "issue";
  ref: string;
}
export interface Grade {
  task: string;
  /** The criteria as checked: the delegator's, or the kind's standard list. */
  rubric: string[];
  deliverable: Deliverable;
  state: GradeState;
  criteria: { id: string; met: "yes" | "no"; reason: string }[];
  /** Why the check could not be made (state failed). */
  reason: string;
  checkedAt: string | null;
}
/** `grades`: every task asked about, by id: its row, or null when it has none. An id missing from `grades` is unknown (never asked, or not answered). */
export interface GradesView {
  grades: Record<string, Grade | null>;
}
/** The module's answer per request: at most this many ids. */
export const GRADES_BATCH = 500;

export interface Grading {
  grades(ids: string[]): Promise<GradesView>;
}

export function createGrading({ url = process.env.GRADING_URL ?? "http://grading:8096", keyFile = process.env.GRADING_BOARD_KEY_FILE, fetchFn = fetch }: { url?: string; keyFile?: string; fetchFn?: typeof fetch } = {}): Grading {
  async function call<T>(path: string, body: unknown): Promise<T> {
    if (!keyFile) throw new Error("GRADING_BOARD_KEY_FILE is not set");
    const res = await fetchFn(`${url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${readFileSync(keyFile, "utf8").trim()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`grading POST ${path}: ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    // Every id, in batches the module takes; one failed batch fails the whole read.
    grades: async (ids) => {
      const out: GradesView = { grades: {} };
      for (let i = 0; i < ids.length; i += GRADES_BATCH) Object.assign(out.grades, (await call<GradesView>("/board/grades", { ids: ids.slice(i, i + GRADES_BATCH) })).grades);
      return out;
    },
  };
}
