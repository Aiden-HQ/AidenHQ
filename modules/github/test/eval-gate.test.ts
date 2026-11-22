// The reviewer's code list (service/src/evalgate.ts REVIEWER_CODE), which decides when CI runs the reviewer eval.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { REVIEWER_CODE, touchesReviewer } from "../service/src/evalgate.ts";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

// The check recipes and what wires them to a receipt are reviewer code: a change to one needs an eval receipt.
it("check recipes, their manifests and wiring are reviewer code", () => {
  const paths = ["modules/github/checks/tests.sh", "modules/platform/checks/contract.sh", "modules/github/module.yaml", "modules/platform/module.yaml", "scripts/modules.ts", "kernel/src/checkbox.ts", "kernel/src/checkjobs.ts"];
  assert.deepEqual(paths.filter((p) => !touchesReviewer([p])), []);
});

// A stale pattern (a .mjs that became .ts) would take the renamed file out of the eval and out of its reuse key.
it("every REVIEWER_CODE pattern matches a tracked file", () => {
  const root = join(import.meta.dirname, "../../..");
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  assert.deepEqual(REVIEWER_CODE.filter((r) => !tracked.some((f) => r.test(f))).map(String), []);
});
