// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

const merged = (n, head, merge) => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] }, history: { nodes: [] },
});

// The superseded branch: closed unmerged, with the failing checks the failed grade quoted.
const closed = (n, head) => ({
  number: n, url: url(n), state: "CLOSED", title: `Superseded ${head}`, body: `Superseded by a new branch.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: null, mergeCommit: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "StatusContext", context: "tests", state: "FAILURE" }] } } } }] }, history: { nodes: [] },
});

const depsFor = (prs, { taskMerged } = {}) => ({
  pr: async (_repo, n) => ({ repository: { pullRequest: prs.find((p) => p.number === n) } }),
  diff: async () => "diff --git a/x b/x\n+landed",
  ownRepo: () => true,
  ...(taskMerged ? { taskMerged: async () => taskMerged } : {}),
});

test("a branch-row PR closed without merging is an evidence wait, never a graded version", async () => {
  const prs = [closed(223, "a")];
  const ev = await prEvidence([{ repo: REPO, number: 223, url: url(223), heads: ["branch-a"] }], "", depsFor(prs));
  assert.equal(ev.awaiting, `${url(223)} was closed without merging`);
  assert.equal(ev.missing, undefined, "the PR exists: this is pending evidence, not a missing deliverable");
  assert.equal(ev.version, undefined, "no version is graded, so nothing is sent back as a revision");
  assert.equal(ev.facts, undefined);
  assert.equal(ev.prs, undefined);
});

test("a task naming a closed PR and the merged PR that landed the work grades the merged one", async () => {
  const prs = [closed(223, "a"), merged(224, "b", "c")];
  const ev = await prEvidence([
    { repo: REPO, number: 223, url: url(223), heads: ["branch-a"] },
    { repo: REPO, number: 224, url: url(224), heads: ["branch-b"] },
  ], "", depsFor(prs));
  assert.match(ev.version, /#224@/, "the merged PR is the version graded");
  assert.doesNotMatch(ev.version, /#223/, "the superseded branch is not read");
  assert.deepEqual(ev.prs.map((p) => p.number), [224]);
  assert.equal(ev.prs[0].merge, SHA("c"));
  assert.ok(ev.facts.every((f) => !f.includes("/pull/223")), "nothing of the closed branch is a fact");
  assert.ok(ev.facts.some((f) => f.startsWith(`${url(224)}: merged`)));
  assert.doesNotMatch(ev.data.DIFF + ev.data.PR_DESCRIPTION, /223/);
});

test("the same holds when the task's merge records, not its branch rows, name both PRs", async () => {
  const prs = [closed(223, "a"), merged(224, "b", "c")];
  const records = [
    { repo: REPO, number: 223, url: url(223), headRef: "branch-a" },
    { repo: REPO, number: 224, url: url(224), headOid: SHA("b"), merges: [SHA("c")] },
  ];
  const ev = await prEvidence([], "", depsFor(prs, { taskMerged: records }));
  assert.ok(ev.version, "the merged record's PR is graded");
  assert.match(ev.version, /#224@/);
  assert.deepEqual(ev.prs.map((p) => p.number), [224]);
});

test("when every PR the task names is closed, the hold applies: no verdict either way", async () => {
  const prs = [closed(223, "a")];
  const ev = await prEvidence([{ repo: REPO, number: 223, url: url(223), heads: ["branch-a"] }], "", depsFor(prs, { taskMerged: [{ repo: REPO, number: 223, url: url(223), headRef: "branch-a" }] }));
  assert.equal(ev.awaiting, `${url(223)} was closed without merging`);
  assert.equal(ev.version, undefined);
});

import { readFileSync } from "node:fs";
const SELECT = readFileSync(new URL("../service/src/ci-select.ts", import.meta.url), "utf8");
test("grading's copy of CI's selector is byte-identical", () => {
  assert.equal(SELECT, readFileSync(new URL("../../../.github/ci/select.ts", import.meta.url), "utf8"), "copy .github/ci/select.ts over it");
});
const KERNEL_RUN = "node --disable-warning=ExperimentalWarning --test --test-shard=1/2 test/*.test.ts";
const KERNEL_RUN_2 = "node --disable-warning=ExperimentalWarning --test --test-shard=2/2 test/*.test.ts";
const AREAS = JSON.stringify({ everything: [], markdown: [], suites: [
  { name: "kernel#1", secs: 33, run: KERNEL_RUN, paths: ["kernel"] }, { name: "kernel#2", secs: 33, run: KERNEL_RUN_2, paths: ["kernel"] },
  { name: "modules/grading", secs: 4, job: "modules", run: "npm test", paths: ["modules/grading"] },
] });
const withJobs = (n, head, merge, jobs, files = ["kernel/src/x.ts"], suites = []) => ({
  ...merged(n, head, merge), baseRef: { target: { oid: SHA("f") } },
  files: { pageInfo: { hasNextPage: false }, nodes: files.map((path) => ({ path })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }, ...jobs, ...suites,
  ] } } } }] },
});
const job = (name, id) => ({ __typename: "CheckRun", databaseId: id, name, status: "COMPLETED", conclusion: "SUCCESS" });
/** A per-suite record CI posts: a completed check named the suite, whose external_id names the job that ran it. */
const suite = (name, externalId, conclusion = "SUCCESS") => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, externalId });
/** The external_id of a suite's check on shard `n` of `job` (packages/modules) in the one run the fixture reports. */
const ext = (n, key) => `7/${key}/${n}`;
const PASSED = [{ name: "Test", state: "completed", conclusion: "success" }];
const WORKFLOW = "name: ci\njobs:\n  packages:\n    steps:\n      - name: Test\n";
const RUNNER = "#!/usr/bin/env bash\n";
const commandDeps = (prs, { base = AREAS, head = AREAS, workflow = WORKFLOW, headWorkflow = workflow, baseWorkflow = workflow, select = SELECT, headRunner = RUNNER, baseRunner = RUNNER, steps = {}, jobs = {}, bases = [SHA("f")] } = {}) => ({
  ...depsFor(prs),
  // Every read the command facts make goes through `file`; a job's log is not a dependency at all.
  file: async (_repo, path, ref) => {
    const own = ref === prs[0].headRefOid, atBase = !own && bases.includes(ref);
    if (path === ".github/ci/areas.json") return own ? head : atBase ? base : null;
    if (path === ".github/workflows/ci.yml") return own ? headWorkflow : atBase ? baseWorkflow : null;
    if (path === ".github/ci/run-suites.sh") return own ? headRunner : atBase ? baseRunner : null;
    if (path === ".github/ci/select.ts") return atBase ? select : null;
    return null;
  },
  job: async (_repo, id) => ({ id, run_id: 7, state: "completed", conclusion: "success", run_base: SHA("f"), workflow_path: ".github/workflows/ci.yml",
    workflow_state: "active", event: "pull_request", head_sha: prs[0].headRefOid, steps: steps[id] ?? PASSED, ...jobs[id] }),
});
const graded = (n, deps) => prEvidence([{ repo: REPO, number: n, url: url(n), heads: ["branch-a"] }], "", deps);
const ran = (facts, shardName, suiteName, run) => facts.some((f) => f.startsWith(`${shardName} green`) && f.includes(`(${suiteName})`) && f.includes(`ran "${run}"`));

test("a green shard whose suites CI recorded as passed is a trusted fact naming the commands", async () => {
  const prs = [withJobs(230, "a", "b", [job("packages (1)", 111), job("packages (2)", 112)], undefined, [suite("kernel#1", ext(1, "packages")), suite("kernel#2", ext(2, "packages"))])];
  const ev = await graded(230, commandDeps(prs));
  assert.ok(ev.facts.includes(`packages (1) green on head ${SHA("a")}: ran "${KERNEL_RUN}" (kernel#1) in kernel/ — passed`), ev.facts.join("\n"));
  assert.ok(ev.facts.includes(`packages (2) green on head ${SHA("a")}: ran "${KERNEL_RUN_2}" (kernel#2) in kernel/ — passed`), ev.facts.join("\n"));
});

test("a suite the selection did not pick is never claimed", async () => {
  const prs = [withJobs(231, "a", "b", [job("modules (1)", 113)], ["modules/grading/src/x.ts"], [suite("modules/grading", ext(1, "modules"))])];
  const ev = await graded(231, commandDeps(prs));
  assert.ok(!ev.facts.some((f) => f.includes(KERNEL_RUN)), "the kernel suite is on no shard of this change");
  assert.ok(!ev.facts.some((f) => f.includes("kernel#")), "no job is claimed to have run it");
  assert.ok(ran(ev.facts, "modules (1)", "modules/grading", "npm test"), ev.facts.join("\n"));
});

test("a check whose external_id names another job is never that job's fact", async () => {
  // packages (2) is green, and a check named kernel#2 exists, but it names packages (1)'s job.
  const prs = [withJobs(232, "a", "b", [job("packages (2)", 114)], undefined, [suite("kernel#2", ext(1, "packages"))])];
  const ev = await graded(232, commandDeps(prs));
  assert.ok(!ev.facts.some((f) => f.includes("(kernel#2)")), ev.facts.join("\n"));
  // And one from another run of the same job is no fact either.
  const other = [withJobs(232, "a", "b", [job("packages (2)", 114)], undefined, [suite("kernel#2", `8/packages/2`)])];
  const none = await graded(232, commandDeps(other));
  assert.ok(!none.facts.some((f) => f.includes('ran "')), none.facts.join("\n"));
});

test("a suite with no check run (the reused shard) is never claimed", async () => {
  // kernel#1 ran but only kernel#2 has a record: the runner reused kernel#1's result, so nothing vouches for it here.
  const prs = [withJobs(233, "a", "b", [job("packages (1)", 116)], undefined, [suite("kernel#2", ext(1, "packages"))])];
  const ev = await graded(233, commandDeps(prs));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a check named the suite but failed, or a Test step that failed, claims nothing", async () => {
  const failedCheck = await graded(234, commandDeps([withJobs(234, "a", "b", [job("packages (1)", 117)], undefined, [suite("kernel#1", ext(1, "packages"), "FAILURE")])]));
  assert.ok(!failedCheck.facts.some((f) => f.includes('ran "')), failedCheck.facts.join("\n"));
  const failedStep = await graded(234, commandDeps([withJobs(234, "a", "b", [job("packages (1)", 117)], undefined, [suite("kernel#1", ext(1, "packages"))])], { steps: { 117: [{ name: "Test", state: "completed", conclusion: "failure" }] } }));
  assert.ok(!failedStep.facts.some((f) => f.includes('ran "')), failedStep.facts.join("\n"));
});

test("an untrusted base map or selector, or a changed workflow, claims nothing", async () => {
  const suites = [suite("kernel#1", ext(1, "packages"))];
  const untrusted = [{ base: null }, { select: `${SELECT}// x\n` }];
  for (const opts of untrusted) {
    const ev = await graded(235, commandDeps([withJobs(235, "a", "b", [job("packages (1)", 118)], undefined, suites)], opts));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(opts));
  }
  const edited = [withJobs(247, "a", "b", [job("packages (1)", 130)], ["kernel/src/x.ts", ".github/workflows/other.yml"], suites)];
  const ev = await graded(247, commandDeps(edited));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a command only the head changed is not a fact CI ran it", async () => {
  const head = JSON.stringify({ everything: [], markdown: [], suites: [{ name: "kernel#1", run: "npm run forged", paths: ["kernel"] }] });
  const ev = await graded(236, commandDeps([withJobs(236, "a", "b", [job("packages (1)", 119)], undefined, [suite("kernel#1", ext(1, "packages"))])], { head }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), "neither the head's command nor the base's is claimed");
});

test("a suite the head moves to another job is claimed for that job", async () => {
  const head = JSON.stringify({ everything: [], markdown: [], suites: [
    { name: "kernel#1", secs: 33, job: "modules", run: KERNEL_RUN, paths: ["kernel"] },
    { name: "kernel#2", secs: 33, run: KERNEL_RUN_2, paths: ["kernel"] },
  ] });
  const prs = [withJobs(245, "a", "b", [job("modules (1)", 128)], undefined, [suite("kernel#1", ext(1, "modules"))])];
  const ev = await graded(245, commandDeps(prs, { head }));
  assert.ok(ev.facts.includes(`modules (1) green on head ${SHA("a")}: ran "${KERNEL_RUN}" (kernel#1) in kernel/ — passed`), ev.facts.join("\n"));
  assert.ok(!ev.facts.some((f) => f.startsWith("packages")), "the head moved it out of packages");
});

test("a job from another workflow, state, event or head claims nothing", async () => {
  const prs = [withJobs(246, "a", "b", [job("packages (1)", 129)], undefined, [suite("kernel#1", ext(1, "packages"))])];
  const other = [{ workflow_path: ".github/workflows/other.yml" }, { workflow_path: null }, { workflow_state: "disabled_manually" }, { event: "push" }, { head_sha: SHA("d") }];
  for (const run of other) {
    const ev = await graded(246, commandDeps(prs, { jobs: { 129: run } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(run));
  }
});

test("the base is the run's own, not main's tip, and a job with none claims nothing", async () => {
  const prs = [withJobs(248, "a", "b", [job("packages (1)", 131)], undefined, [suite("kernel#1", ext(1, "packages"))])];
  prs[0].baseRef = { target: { oid: SHA("c") } };
  const ev = await graded(248, commandDeps(prs, { bases: [SHA("f")] }));
  assert.ok(ev.facts.includes(`packages (1) green on head ${SHA("a")}: ran "${KERNEL_RUN}" (kernel#1) in kernel/ — passed`), ev.facts.join("\n"));
  const none = await graded(248, commandDeps(prs, { jobs: { 131: { run_base: null } } }));
  assert.ok(!none.facts.some((f) => f.includes('ran "')), none.facts.join("\n"));
});

test("a check list GitHub truncated claims nothing", async () => {
  const prs = [withJobs(242, "a", "b", [job("packages (1)", 125)], undefined, [suite("kernel#1", ext(1, "packages"))])];
  prs[0].commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true };
  const ev = await graded(242, commandDeps(prs));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), "a record the page may cut off is no evidence");
});

test("no job log is read at all: the fact comes from the checks alone", async () => {
  const prs = [withJobs(239, "a", "b", [job("packages (1)", 122)], undefined, [suite("kernel#1", ext(1, "packages"))])];
  const deps = commandDeps(prs);
  assert.equal("jobLog" in deps, false, "the log is gone from grading's dependencies");
  // A log-shaped line in the PR's output is not even read: only the check's own record mints the fact.
  const ev = await graded(239, deps);
  assert.ok(ran(ev.facts, "packages (1)", "kernel#1", KERNEL_RUN), ev.facts.join("\n"));
});

test("a changed or unreadable workflow or runner claims nothing", async () => {
  const prs = [withJobs(241, "a", "b", [job("packages (1)", 124)], undefined, [suite("kernel#1", ext(1, "packages"))])];
  const changed = [{ headWorkflow: `${WORKFLOW}  x\n` }, { headWorkflow: null }, { headRunner: `${RUNNER}exit 0\n` }, { headRunner: null }];
  for (const opts of changed) {
    const ev = await graded(241, commandDeps(prs, opts));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(opts));
  }
});
