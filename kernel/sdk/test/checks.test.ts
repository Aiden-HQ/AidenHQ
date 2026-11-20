import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_CHECK, namedChecks, skippedImageScan } from "../src/checks.ts";

const run = (name, status, conclusion = null) => ({ __typename: "CheckRun", name, status, conclusion });
const rollup = (...nodes) => ({ contexts: { nodes } });

test("checks are read as named results; the design review is advisory; an image scan skip needs an image change", () => {
  const checks = namedChecks(rollup(
    run(GATE_CHECK, "COMPLETED", "SUCCESS"), run("lint", "COMPLETED", "FAILURE"), run("build", "IN_PROGRESS"), run("docs", "COMPLETED", "SKIPPED"),
    { __typename: "StatusContext", context: "legacy", state: "PENDING" }, run("design-review", "COMPLETED", "FAILURE"),
  ));
  assert.deepEqual(checks.map((c) => [c.name, c.ok, c.pending]), [[GATE_CHECK, true, false], ["lint", false, false], ["build", false, true], ["docs", true, false], ["legacy", false, true]]);
  assert.equal(checks.find((c) => c.name === "docs").skipped, true);

  const pr = (path, extra = {}) => ({ commits: { nodes: [{ commit: { statusCheckRollup: rollup(run("image-scan", "COMPLETED", "SKIPPED")) } }] }, files: { nodes: [{ path }] }, ...extra });
  assert.equal(skippedImageScan(pr("services/x/Dockerfile")), true);
  assert.equal(skippedImageScan(pr("src/a.ts")), false);
  assert.equal(skippedImageScan(pr("src/a.ts", { files: { pageInfo: { hasNextPage: true }, nodes: [] } })), true);
});
