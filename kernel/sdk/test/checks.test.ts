import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_CHECK, contextRank, latestChecks, namedChecks, skippedImageScan } from "../src/checks.ts";

const run = (name, status, conclusion = null) => ({ __typename: "CheckRun", name, status, conclusion });
const rollup = (...nodes) => ({ contexts: { nodes } });

test("checks are read as named results; code review is advisory; an image scan skip needs an image change", () => {
  const checks = namedChecks(rollup(
    run(GATE_CHECK, "COMPLETED", "SUCCESS"), run("lint", "COMPLETED", "FAILURE"), run("build", "IN_PROGRESS"), run("docs", "COMPLETED", "SKIPPED"),
    { __typename: "StatusContext", context: "legacy", state: "PENDING" },
    { __typename: "StatusContext", context: "aidenhq/review", state: "ERROR" },
  ));
  assert.deepEqual(checks.map((c) => [c.name, c.ok, c.pending]), [[GATE_CHECK, true, false], ["lint", false, false], ["build", false, true], ["docs", true, false], ["legacy", false, true]]);
  assert.equal(checks.find((c) => c.name === "docs").skipped, true);

  const pr = (path, extra = {}) => ({ commits: { nodes: [{ commit: { statusCheckRollup: rollup(run("image-scan", "COMPLETED", "SKIPPED")) } }] }, files: { nodes: [{ path }] }, ...extra });
  assert.equal(skippedImageScan(pr("services/x/Dockerfile")), true);
  assert.equal(skippedImageScan(pr("src/a.ts")), false);
  assert.equal(skippedImageScan(pr("src/a.ts", { files: { pageInfo: { hasNextPage: true }, nodes: [] } })), true);
  // The scan's newest run at the head is its judgement: a replacement run that scanned the Dockerfile clears an obsolete skip.
  const scanned = (conclusion, databaseId) => ({ commits: { nodes: [{ commit: { statusCheckRollup: rollup(
    { __typename: "CheckRun", name: "image-scan", databaseId: 30, status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "image-scan", databaseId, status: "COMPLETED", conclusion },
  ) } }] }, files: { nodes: [{ path: "services/x/Dockerfile" }] } });
  assert.equal(skippedImageScan(scanned("SUCCESS", 31)), false, "a newer scan that ran is not a skip");
  assert.equal(skippedImageScan(scanned("SKIPPED", 31)), true, "a newer skip is still a skip");
});

test("the newest run of a name is picked by its id, never by the order GitHub lists the contexts in", () => {
  const at = (name, conclusion, databaseId) => ({ __typename: "CheckRun", name, databaseId, status: "COMPLETED", conclusion });
  // An edit re-ran CI: the run before it was cancelled and stays on the head. The later run is the judgement.
  const latest = latestChecks(namedChecks(rollup(at("packages (1)", "CANCELLED", 10), at("packages (1)", "SUCCESS", 11))));
  assert.deepEqual(latest.map((c) => [c.name, c.status]), [["packages (1)", "SUCCESS"]], "the newer run wins");
  const reversed = latestChecks(namedChecks(rollup(at("packages (1)", "SUCCESS", 11), at("packages (1)", "CANCELLED", 10))));
  assert.deepEqual(reversed.map((c) => [c.name, c.status]), [["packages (1)", "SUCCESS"]], "whatever order they are listed in");
  // A name whose only run was cancelled keeps it: cancelled is its own result, never a newer pass.
  assert.deepEqual(latestChecks(namedChecks(rollup(at("build", "CANCELLED", 10)))).map((c) => [c.name, c.status]), [["build", "CANCELLED"]]);
  // A check run and a status that share a name are two judgements: neither collapses into the other.
  const both = latestChecks(namedChecks(rollup(at("ci", "SUCCESS", 3), { __typename: "StatusContext", context: "ci", state: "FAILURE", createdAt: "2026-01-01T00:00:00Z" })));
  assert.deepEqual(both.map((c) => [c.kind, c.status]).sort(), [["run", "SUCCESS"], ["status", "FAILURE"]]);
  // An entry with no rank proves no order, so it stays its own judgement rather than being folded away.
  assert.equal(latestChecks(namedChecks(rollup(at("build", "SUCCESS", 1), { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" }))).length, 2);
  // A status ranks by when it was created; a run by its databaseId, and by its completion time when it carries no id.
  assert.equal(contextRank({ __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-01-02T00:00:00Z" }), Date.parse("2026-01-02T00:00:00Z"));
  assert.equal(contextRank(at("build", "SUCCESS", 7)), 7);
  assert.equal(contextRank({ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-01-03T00:00:00Z" }), Date.parse("2026-01-03T00:00:00Z"));
  // Without an id, a run ranks by when it started, never by when it finished: a cancelled run finishes after the run that
  // replaced it has started, and completion order would make the superseded run look newer.
  const cancelled = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z" };
  const replacement = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:01:00Z", completedAt: "2026-01-01T00:04:00Z" };
  assert.deepEqual(latestChecks(namedChecks(rollup(cancelled, replacement))).map((c) => c.status), ["SUCCESS"]);
  // Two statuses of one name created in the same second prove no order: both stay judgements, so the worst of them counts.
  const at2 = (state) => ({ __typename: "StatusContext", context: "ci", state, createdAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(latestChecks(namedChecks(rollup(at2("SUCCESS"), at2("PENDING")))).map((c) => c.status).sort(), ["PENDING", "SUCCESS"]);
});
