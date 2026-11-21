// An escalated grade is its delegator's: the finish gate's hold from its assignee finishing again goes back to the delegator once
// the runner found no new version (the tick), never while that check is still owed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGrading } from "../service/src/server.ts";
import { completionGate } from "../service/src/grades.ts";

test("an escalated task finished again is held until its version is checked, then released to its delegator", async () => {
  const released: string[] = [];
  const { grades, tick } = createGrading({
    db: new DatabaseSync(":memory:"), keys: { check: "c", board: "b" }, log: () => {},
    kernel: { issue: async (id) => ({ id, status: "in_review" }), repos: async () => ({}), release: async (id) => (released.push(id), true) },
  });
  grades.file("esc", [], { kind: "file", ref: "" }, "agent:cos");
  grades.record("esc", { version: "v1", outcome: "cannot_judge", model: "m", criteria: [] }, Date.now(), ["cos"]);
  assert.equal(grades.get("esc")!.state, "escalated");
  assert.deepEqual(completionGate(grades, "esc", "task_finish"), { pass: false, state: "escalated", label: "grading" }); // the assignee finishes again: held
  await tick();
  assert.deepEqual(released, [], "the runner's version check is still owed");
  assert.equal(grades.resubmit("esc", "v1")!.state, "escalated"); // the same version: still the delegator's
  await tick();
  assert.deepEqual(released, ["esc"]);
});
