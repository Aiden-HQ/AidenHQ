// The reviewer's code list (service/src/evalgate.ts REVIEWER_CODE), which decides when CI runs the reviewer eval.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { REVIEWER_CODE, touchesReviewer } from "../service/src/evalgate.ts";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

// Only the reviewer's own code runs the eval.
it("the reviewer's own code is reviewer code; the gates around it are not", () => {
  assert.deepEqual(["modules/ai-reviewer/policy.md", "kernel/sdk/src/reviewer.ts", "kernel/src/review-loop.ts", "kernel/src/reviews.ts"].filter((p) => !touchesReviewer([p])), []);
  assert.deepEqual(["kernel/src/tier.ts", "kernel/src/writes.ts", "modules/github/service/src/plan.ts", "scripts/modules.ts"].filter((p) => touchesReviewer([p])), []);
});

// A stale pattern (a .mjs that became .ts) would take the renamed file out of the eval and out of its reuse key.
it("every REVIEWER_CODE pattern matches a tracked file", () => {
  const root = join(import.meta.dirname, "../../..");
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  assert.deepEqual(REVIEWER_CODE.filter((r) => !tracked.some((f) => r.test(f))).map(String), []);
});
