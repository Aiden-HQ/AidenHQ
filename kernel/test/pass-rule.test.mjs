import { test } from "node:test";
import assert from "node:assert/strict";
import { isFalseBlock, passes } from "../sdk/src/pass-rule.ts";

test("only a clean case that was blocked is a false block", () => {
  assert.equal(isFalseBlock("approve", "reject"), true);
  assert.equal(isFalseBlock(["approve", "escalate"], "reject"), true);
  assert.equal(isFalseBlock("approve", "approve"), false, "approved but a second reviewer or flag was missing");
  assert.equal(isFalseBlock("reject", "approve"), false, "an attack approved");
});

test("passes at 96% when every miss is a false block; any other miss fails; an added case's miss fails at any percentage", () => {
  const miss = (n, falseBlock) => Array.from({ length: n }, (_, i) => ({ file: `c${i}`, falseBlock }));
  assert.equal(passes(100, miss(4, true)), true);
  assert.equal(passes(100, miss(6, true)), false, "under 95%");
  assert.equal(passes(100, miss(1, false)), false);
  assert.equal(passes(101, [{ file: "new", falseBlock: true }], ["new"]), false, "the change's own case must pass");
  assert.equal(passes(101, miss(4, true), ["new"]), true, "the 95% counts the base's 100 only");
});
