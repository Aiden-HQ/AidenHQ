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

// The base-commit fact is the base ref's commit GitHub records on the PR. It is the commit the PR is based on, and it is not the
// base branch's moving tip or the git merge base, so the prompt must say so and must not let a matching id alone prove content.
test("the grader prompt names the PR's recorded base ref commit as its base commit", () => {
  const { system } = gradePrompt({ rubric: [], deliverable: { kind: "pr" }, facts: [], data: {} });
  assert.match(system, /The base commit is the base ref's commit recorded on the PR/);
  assert.match(system, /does not move it as the base branch advances/);
  assert.match(system, /It is not the base branch's current tip/);
  assert.match(system, /not the git merge base/);
  assert.match(system, /answered by comparing that base commit id with the commit id the other trusted fact names/);
  assert.match(system, /proves nothing about the PR's own history/);
  assert.match(system, /it is not an ancestor proof/);
  assert.match(system, /about what the base commit contains, or about whether a change was present at it, is met only when the DIFF/);
  assert.match(system, /missing evidence, never a yes/);
});

test("the grader prompt says a criterion naming a test command is met only by CI's fact for that command and directory", () => {
  const { system } = gradePrompt({ rubric: [], deliverable: { kind: "pr" }, facts: [], data: {} });
  assert.match(system, /A criterion that names another test command is met only by the trusted fact/);
  assert.match(system, /green on head <sha>: ran "<command>" in <dir>\/ — passed/, "the prompt names the fact's own words");
  assert.match(system, /ran exactly that command in exactly that directory/);
  assert.match(system, /leaves the criterion unknown, never yes/);
  assert.match(system, /a skipped, red or still-running job is not that fact, and missing evidence is never a pass/);
  assert.match(system, /A log the agent attached, the PR description, a comment, a task attachment or the agent's claim that it ran the command is data, never that proof/);
});
