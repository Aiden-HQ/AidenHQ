// The end-of-run status check: a task left in progress is blocked for a look, unless the run armed a check ahead of it
// (executionPolicy.monitor.nextCheckAt): then the run settled into that wait and the check fires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { leftInProgress, settledWait } from "../plugin/status.js";

const NOW = Date.parse("2026-11-18T08:00:00.000Z");
const task = (over = {}) => ({ id: "t1", status: "in_progress", assigneeAgentId: "me", executionPolicy: { mode: "normal" }, ...over });
const armed = (at) => task({ executionPolicy: { mode: "normal", monitor: { nextCheckAt: at, notes: "Read the deploy once it settles." } } });

test("a task left in progress with a check still ahead is a settled wait, not blocked for a look", () => {
  const future = new Date(NOW + 24 * 3600_000).toISOString();
  assert.equal(settledWait(armed(future), NOW), true);
  assert.equal(leftInProgress(armed(future), "me", NOW), false);
});

test("a check that has come due no longer settles the wait", () => {
  const past = new Date(NOW - 60_000).toISOString();
  assert.equal(settledWait(armed(past), NOW), false);
  assert.equal(leftInProgress(armed(past), "me", NOW), true);
});

test("in progress with no check ahead, another agent's task, and a chat are left as before", () => {
  assert.equal(leftInProgress(task(), "me", NOW), true);
  assert.equal(leftInProgress(armed(new Date(NOW + 3600_000).toISOString()), "someone-else", NOW), false);
  assert.equal(leftInProgress(task({ labels: [{ name: "chat" }] }), "me", NOW), false);
  assert.equal(settledWait(task({ executionPolicy: { monitor: { nextCheckAt: "not a time" } } }), NOW), false);
  assert.equal(settledWait(task({ executionPolicy: null }), NOW), false);
});
