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

test("an Engineer's prompt names test-request, with the owner's named test user and app", () => {
  const p = buildPrompt(args("engineer"));
  assert.match(p, /`aidenhq test-request <app> <method> <path>/);
  assert.match(p, /settings\.edge\.test_user/);
  assert.match(p, /session never leaves the kernel/);
  assert.doesNotMatch(buildPrompt(args("crew")), /aidenhq test-request/);
});

test("down connections are listed in fresh and resumed prompts", () => {
  const down = [{ connection: "google_workspace", module: "google", cause: "not_connected", since: "2026-11-20T08:00:00Z" }];
  for (const resumed of [false, true]) {
    const p = buildPrompt({ ...args("crew"), resumed, down });
    assert.match(p, /## Connections down/);
    assert.match(p, /google_workspace: not connected since 2026-11-20/);
    assert.doesNotMatch(buildPrompt({ ...args("crew"), resumed, down: [] }), /## Connections down/);
  }
});
