// A task created blocked is not dispatchable: its blocker is unresolved, so Paperclip would refuse the runner's own
// status write with a 422 and the run would be reported Failed with nothing attempted. These are the pieces of the gate
// the flow (flow-blocked.test.mjs) drives end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedRefusal, unresolvedBlockers } from "../src/paperclip.ts";
import { park, parkedJobs, unpark } from "../src/parked.ts";

const memory = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
};

test("a task with an unresolved blocker is not dispatchable; a resolved one is", () => {
  assert.deepEqual(unresolvedBlockers({ blockedBy: [{ id: "b", status: "in_progress" }] }).map((b) => b.id), ["b"]);
  assert.deepEqual(unresolvedBlockers({ blockedBy: [{ id: "b", status: "blocked" }] }).map((b) => b.id), ["b"]);
  assert.deepEqual(unresolvedBlockers({ blockedBy: [{ id: "a", status: "done" }, { id: "b", status: "cancelled" }] }), []);
  assert.deepEqual(unresolvedBlockers({ blockedBy: [] }), []);
  assert.deepEqual(unresolvedBlockers({}), [], "a task without the field has no blockers");
});

test("Paperclip's refusal on an unresolved blocker is recognised; anything else is not", () => {
  assert.ok(blockedRefusal(new Error('Paperclip PATCH /api/issues/x → 422: {"error":"Issue is blocked by unresolved blockers"}')));
  assert.ok(!blockedRefusal(new Error("Paperclip PATCH /api/issues/x → 422: {\"error\":\"Entering blocked requires a blocker\"}")));
  assert.ok(!blockedRefusal(new Error("Paperclip PATCH /api/issues/x → 500: boom")));
});

test("a parked job is kept until its blocker resolves, and a later request replaces it", () => {
  const s = memory();
  park(s, { issueId: "i1", instructions: "first" });
  park(s, { issueId: "i1", instructions: "second" });
  park(s, { issueId: "i2", instructions: "other" });
  assert.deepEqual(parkedJobs(s), [{ issueId: "i1", instructions: "second" }, { issueId: "i2", instructions: "other" }]);
  unpark(s, "i1");
  assert.deepEqual(parkedJobs(s), [{ issueId: "i2", instructions: "other" }]);
  assert.deepEqual(parkedJobs(memory()), [], "nothing parked is no job");
});
