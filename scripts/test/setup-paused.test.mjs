import assert from "node:assert/strict";
import { test } from "node:test";
import { routineStatus } from "../setup-paused.mjs";

test("setup resumes a routine it paused itself when it returns; an owner or detector pause stays paused", () => {
  const mine = new Set(["a"]);
  assert.equal(routineStatus(undefined, { status: "paused" }, "a", mine), "active");
  assert.ok(!mine.has("a"));
  assert.equal(routineStatus(undefined, { status: "paused" }, "b", mine), "paused");
  assert.equal(routineStatus(undefined, { status: "active" }, "b", mine), "active");
  assert.equal(routineStatus(undefined, undefined, undefined, mine), "active");
  assert.equal(routineStatus("paused", { status: "active" }, "b", mine), "paused");
});
