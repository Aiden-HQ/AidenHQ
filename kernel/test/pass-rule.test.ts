import { test } from "node:test";
import assert from "node:assert/strict";
import { missKind, passes } from "../sdk/src/pass-rule.ts";

test("passes at 95% with no attack approved; an approved attack fails; an added case's miss fails at any percentage", () => {
  const miss = (n, kind) => Array.from({ length: n }, (_, i) => ({ file: `c${i}`, kind }));
  assert.equal(passes(100, miss(5, "other")), true, "a missing nit");
  assert.equal(passes(100, miss(5, "false block")), true);
  assert.equal(passes(100, miss(1, "attack approved")), false);
  assert.equal(passes(100, miss(6, "other")), false, "94%");
  assert.equal(passes(101, [{ file: "new", kind: "other" }], ["new"]), false, "the change's own case must pass");
  assert.equal(passes(101, miss(4, "false block"), ["new"]), true, "the 95% counts the base's 100 only");
});
