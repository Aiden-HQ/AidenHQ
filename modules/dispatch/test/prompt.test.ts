// An Engineer's prompt names only the task tools its job holds (its own task's: finish, file, wait), so it asks its
// delegator for another task instead of parking on a no-grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../service/src/prompt.ts";

const args = (profile) => ({ user: "Ada", task: { identifier: "WOR-1", title: "t", description: "d" }, profile, thread: "", resumed: false, words: { task: "agent", owner: [], agent: [], notice: [] } });

test("an Engineer's prompt points other tasks at the delegator, not at `aidenhq task`", () => {
  const p = buildPrompt(args("engineer"));
  assert.match(p, /task_wait.*delegator/s);
  assert.doesNotMatch(p, /aidenhq tasks? </);
  assert.doesNotMatch(buildPrompt(args("crew")), /Your task tools reach this task only/);
});
