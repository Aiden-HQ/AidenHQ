// A task created blocked is not dispatchable: its blocker is unresolved, so Paperclip would refuse the runner's own
// status write with a 422 and the run would be reported Failed with nothing attempted. These are the pieces of the gate
// the flow (flow-blocked.test.mjs) drives end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedRefusal, unresolvedBlockers } from "../src/paperclip.ts";
import { State } from "../src/state.ts";

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
  const state = new State(mkdtempSync(join(tmpdir(), "parked-")));
  state.park({ issueId: "i1", instructions: "first" });
  state.park({ issueId: "i1", instructions: "second" });
  state.park({ issueId: "i2", instructions: "other" });
  assert.deepEqual(state.parked(), [{ issueId: "i1", instructions: "second" }, { issueId: "i2", instructions: "other" }]);
  state.unpark("i1");
  assert.deepEqual(state.parked(), [{ issueId: "i2", instructions: "other" }]);
  assert.equal(new State(mkdtempSync(join(tmpdir(), "parked-"))).parked().length, 0, "nothing parked is no job");
  state.db.close();
});
