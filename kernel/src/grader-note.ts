// The task grader's latest verdict that sent the work back, as the AI reviewer reads it (reviewer@1 `grader_note`), so a
// follow-up is judged against what the grade still asks for. Read only from the grading store, structured (checks.ts grade:
// the finish check's `grade:` URL with its own key), never from task comments: a comment under the owner's id can be relayed
// or agent-written text. The read is checked here, and the block is rendered by code: each criterion's number and met are
// code's, the rubric text (the delegating agent's words, or the kind's template) is one line with `%`, `<` and `>` encoded.
import { encodeName } from "./siblings.ts";

export type GraderNote = { attempt: number; at: string; version: string; criteria: { id: string; met: "yes" | "no" | "unknown"; rubric?: string }[] };

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A grading module's answer: null is no note; anything not the contract's shape throws (the reviewer then reads no note). */
export function parseGraderNote(v: unknown): GraderNote | undefined {
  if (v === null || v === undefined) return undefined;
  const bad = () => { throw new Error("the grade read is not {attempt, at, version, criteria}"); };
  if (!isMap(v) || !Number.isInteger(v.attempt) || typeof v.at !== "string" || typeof v.version !== "string" || !Array.isArray(v.criteria) || v.criteria.length > 8) return bad();
  const criteria = v.criteria.map((c) => {
    if (!isMap(c) || typeof c.id !== "string" || !/^[1-9]\d?$/.test(c.id) || !["yes", "no", "unknown"].includes(c.met as string) || (c.rubric !== undefined && typeof c.rubric !== "string")) return bad();
    return { id: c.id, met: c.met as "yes" | "no" | "unknown", ...(typeof c.rubric === "string" ? { rubric: c.rubric } : {}) };
  });
  return { attempt: v.attempt as number, at: v.at, version: v.version, criteria };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/%/g, "%25").replace(/</g, "%3C").replace(/>/g, "%3E").trim().slice(0, 300);

/** One line per criterion, after the graded version: unmet ones with the rubric's own text. */
export function graderBlock(n: GraderNote): string {
  const at = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(n.at) ? `, ${n.at}` : "";
  const head = `Graded version ${encodeName(n.version, "branch").slice(0, 200)} (rejected versions so far: ${n.attempt}${at}):`;
  const line = (c: GraderNote["criteria"][number]) =>
    c.met === "yes" ? `- criterion ${c.id}: met at that version` : `- criterion ${c.id}: ${c.met === "no" ? "not met" : "not shown met"}: ${oneLine(c.rubric ?? "(text not read)")}`;
  return [head, ...n.criteria.map(line)].join("\n");
}
