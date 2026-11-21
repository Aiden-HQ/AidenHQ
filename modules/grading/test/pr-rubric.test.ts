// A merged PR's description is frozen, so proof that can only exist after the merge (its merge commit, a check green on its
// head) lives in the task's completion comment. The `pr` rubric and the grader prompt each say so; without that, a merged PR
// is sent back for evidence no agent could have put in its body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradePrompt, template } from "../service/src/grader/grade.ts";

const RUBRICS = fileURLToPath(new URL("../rubrics", import.meta.url));
const SERVICE_RUBRICS = fileURLToPath(new URL("../service/rubrics", import.meta.url));

test("the pr template's Evidence criterion accepts proof in the task's completion comment after a merge", () => {
  const evidence = template("pr", RUBRICS).find((c) => c.startsWith("The description's Evidence section"));
  assert.ok(evidence, "the pr template has its Evidence criterion");
  assert.match(evidence, /after the PR (?:merged|merges)/);
  assert.match(evidence, /completion comment/);
  assert.match(evidence, /merged PR is never failed for not carrying a fact that only exists after its merge/);
  assert.match(evidence, /before\/after screenshots/);
  assert.match(evidence, /before\/after numbers/);
  assert.match(evidence, /gap to note in the grade, not a failed criterion/);
});

test("both rubric copies are byte-identical", () => {
  assert.equal(readFileSync(`${SERVICE_RUBRICS}/pr.md`, "utf8"), readFileSync(`${RUBRICS}/pr.md`, "utf8"));
});

test("the grader prompt says a merged PR's body cannot be edited and names where post-merge facts are judged", () => {
  const { system } = gradePrompt({ rubric: [], deliverable: { kind: "pr" }, facts: [], data: {} });
  assert.match(system, /A merged PR's description cannot be changed by the agent/);
  assert.match(system, /merge commit[^.]*TASK_COMMENTS/);
  assert.match(system, /never a no for being absent from the PR body/);
  assert.match(system, /Before the merge the body is the PR's own record/);
});

// The base-commit fact is a graph fact: the parent of the PR's oldest commit. It proves where the PR's current history starts,
// not where the branch was cut, so the prompt must not let a historical "cut from" or "was on the base" criterion be answered
// yes from it.
test("the grader prompt treats the base commit as the start of the PR's history, never as the cut point", () => {
  const { system } = gradePrompt({ rubric: [], deliverable: { kind: "pr" }, facts: [], data: {} });
  assert.match(system, /base commit is the parent of the PR's oldest commit/);
  assert.match(system, /not proof of where the branch was originally cut/);
  assert.match(system, /stays unknown unless another trusted fact proves that ordering/);
  assert.match(system, /never answer it yes from the base commit alone/);
  assert.doesNotMatch(system, /is judged from that base commit[^.]*was cut from a commit a prerequisite produced/);
});
