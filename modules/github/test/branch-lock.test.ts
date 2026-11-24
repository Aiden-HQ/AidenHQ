// The publish/cleanup lock (branch-lock.ts): a cleanup may not delete a head branch between a publish's push and the PR write that
// records its new owner, and a step that takes the lock for the same branch again must not deadlock on itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withBranch } from "../service/src/branch-lock.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("two steps for one branch never interleave, and another branch is not held behind them", async () => {
  const log = [];
  const step = (repo, branch, name, hold) => withBranch(repo, branch, async () => {
    log.push(`start ${name}`); await sleep(hold); log.push(`end ${name}`);
  });
  await Promise.all([step("acme/app", "b1", "push", 20), step("acme/app", "b1", "delete", 0), step("acme/app", "b2", "other", 0)]);
  assert.deepEqual(log.filter((l) => !l.endsWith("other")), ["start push", "end push", "start delete", "end delete"], "the delete waits for the push and its ownership write, never inside it");
  assert.ok(log.indexOf("start other") < log.indexOf("end push"), "another branch runs at once");
});

test("a step that takes the lock again for the same branch continues instead of waiting on itself", async () => {
  const out = await withBranch("acme/app", "b1", async () => {
    const inner = await withBranch("acme/app", "b1", async () => "inner");
    return `outer+${inner}`;
  });
  assert.equal(out, "outer+inner");
});

test("a failing step releases the lock for the next one", async () => {
  await assert.rejects(withBranch("acme/app", "b1", async () => { throw new Error("bundle refused"); }), /bundle refused/);
  const ran = await withBranch("acme/app", "b1", async () => "ran");
  assert.equal(ran, "ran", "a refused publish does not block the branch forever");
});
