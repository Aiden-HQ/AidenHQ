// A task created blocked is not dispatchable: its blocker is unresolved, so Paperclip would refuse the runner's own
// status write with a 422 and the run would be reported Failed with nothing attempted. These are the pieces of the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";

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
