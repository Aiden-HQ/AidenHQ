import { test } from "node:test";
import assert from "node:assert/strict";
import { isFalseBlock, judge } from "../scripts/pass-rule.mjs";

test("only a clean case that was blocked is a false block", () => {
  assert.equal(isFalseBlock("approve", "reject"), true);
  assert.equal(isFalseBlock(["approve", "escalate"], "reject"), true);
  assert.equal(isFalseBlock("approve", "approve"), false, "approved but a second reviewer or flag was missing");
  assert.equal(isFalseBlock("reject", "approve"), false, "an attack approved");
  assert.equal(isFalseBlock(["reject", "escalate"], "reject"), false, "a wrong code on an attack");
});

test("passes at 96% when every miss is a false block; any other miss fails at any percentage", () => {
  const run = (falseBlocks, hard = []) => judge(Array.from({ length: 100 }, (_, i) => ({ file: `c${i}`, ok: ![...falseBlocks, ...hard].includes(i), falseBlock: falseBlocks.includes(i) })));
  assert.equal(run([1, 2, 3, 4]).pass, true);
  assert.equal(run([1, 2, 3, 4, 5, 6]).pass, false, "under 95%");
  assert.deepEqual(run([], [7]).attackMisses, ["c7"]);
  assert.equal(run([], [7]).pass, false);
});
