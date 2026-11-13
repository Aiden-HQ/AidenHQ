import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePaused } from "../fleet-pause.mjs";

test("a second pause keeps what the first recorded (those routines are paused now, so it doesn't see them)", () => {
  const first = mergePaused(undefined, { pausedAt: "t1", routines: { c1: ["a", "b"] }, units: ["aidenhq-ci-runner@1.service"] });
  const second = mergePaused(first, { pausedAt: "t2", routines: { c1: [], c2: ["x"] }, units: [] });
  assert.deepEqual(second, { pausedAt: "t1", routines: { c1: ["a", "b"], c2: ["x"] }, units: ["aidenhq-ci-runner@1.service"] });
});
