// The grading module's HTTP API, read by the board (modules/grading owns the grade rows, the completion gate and every
// write). Types mirror the module's Grade. An unreachable or erroring module throws: each caller decides how to fail.
import { readFileSync } from "node:fs";

export type GradeState = "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "escalated" | "not_graded";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report";
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
/** `on`: the grading kill switch (false: every grade check passes); `grades`: the rows that exist, by task id. */
export interface GradesView {
  on: boolean;
  grades: Record<string, Grade>;
}
export const noGrades: GradesView = { on: true, grades: {} };

/** True when grading is off, the task has no row, or its row is satisfied. */
export const gradePassed = (view: GradesView, id: string): boolean => !view.on || !view.grades[id] || view.grades[id]!.state === "satisfied";

export interface Grading {
  grades(ids: string[]): Promise<GradesView>;
  stale(): Promise<Grade[]>;
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
    grades: (ids) => (ids.length ? call("POST", "/board/grades", { ids: ids.slice(0, 500) }) : Promise.resolve(noGrades)),
    stale: async () => (await call<{ grades: Grade[] }>("GET", "/board/grades/stale")).grades,
    settle: async (id, reason) => (await call<{ grade: Grade | null }>("POST", `/board/grades/${encodeURIComponent(id)}/settle`, { reason })).grade,
  };
}
