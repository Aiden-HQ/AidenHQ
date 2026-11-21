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

const KERNEL_RUN = "node --disable-warning=ExperimentalWarning --test --test-shard=1/2 test/*.test.ts";
const KERNEL_RUN_2 = "node --disable-warning=ExperimentalWarning --test --test-shard=2/2 test/*.test.ts";
const AREAS = JSON.stringify({ everything: [], markdown: [], suites: [
  { name: "kernel#1", secs: 33, run: KERNEL_RUN, paths: ["kernel"] },
  { name: "kernel#2", secs: 33, run: KERNEL_RUN_2, paths: ["kernel"] },
  { name: "modules/grading", secs: 4, job: "modules", run: "npm test", paths: ["modules/grading"] },
] });
/** A PR head whose check list is `checks` and whose changed files are `files` (each an ADDED path unless given). */
const withJobs = (n, head, merge, checks, files = ["kernel/src/x.ts"]) => ({
  ...merged(n, head, merge), baseRef: { target: { oid: SHA("f") } },
  files: { pageInfo: { hasNextPage: false }, nodes: files.map((path) => ({ path })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }, ...checks,
  ] } } } }] },
});
const PASSED = [{ name: "Test", state: "completed", conclusion: "success" }];
const WORKFLOW = "name: ci\njobs:\n  packages:\n    steps:\n      - name: Test\n";
/**
 * The command facts' dependencies. `job` answers `/actions/jobs/{id}` — null is the 404 a check with no job behind it gets
 * (a check a PR posted itself); a job is a runner's own record. `file` answers the two evidence paths at the head and at the
 * run's base; `dir` proves a suite's directory is present at the graded head (`absent` names dirs it reports missing). No log
 * read exists at all.
 */
const commandDeps = (prs, { base = AREAS, headWorkflow = WORKFLOW, baseWorkflow = WORKFLOW, jobs = {}, bases = [SHA("f")], absent = [], dirResult } = {}) => {
  const head = prs[0].headRefOid;
  return {
    ...depsFor(prs),
    dir: async (_repo, path, ref) => dirResult ? dirResult(path, ref) : { path, present: !absent.includes(path) },
    file: async (_repo, path, ref) => {
      if (path === ".github/ci/areas.json") return ref === head ? base : bases.includes(ref) ? base : null;
      if (path === ".github/workflows/ci.yml") return ref === head ? headWorkflow : bases.includes(ref) ? baseWorkflow : null;
      return null;
    },
    job: async (_repo, id) => {
      const j = jobs[id];
      if (j === null) return null; // the check has no Actions job: a posted check
      return { id, name: "kernel#1", run_id: 7, state: "completed", conclusion: "success", run_base: SHA("f"),
        workflow_path: ".github/workflows/ci.yml", workflow_state: "active", event: "pull_request", head_sha: head, ...j };
    },
  };
};
const graded = (n, deps) => prEvidence([{ repo: REPO, number: n, url: url(n), heads: ["branch-a"] }], "", deps);
const check = (name, id, conclusion = "SUCCESS") => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, databaseId: id });
const fact = (name, run, dir) => `${name} green on head ${SHA("a")}: ran "${run}" in ${dir}/ — passed`;

test("a green per-suite job with its directory present is the trusted fact naming the command", async () => {
  const prs = [withJobs(230, "a", "b", [check("kernel#1", 111), check("kernel#2", 112)], ["kernel/src/x.ts"])];
  const ev = await graded(230, commandDeps(prs, { jobs: { 111: {}, 112: { name: "kernel#2" } } }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
  assert.ok(ev.facts.includes(fact("kernel#2", KERNEL_RUN_2, "kernel")), ev.facts.join("\n"));
});

test("a check with no Actions job behind it (a check a PR posted) mints nothing", async () => {
  const prs = [withJobs(232, "a", "b", [check("kernel#1", 114)], ["kernel/src/x.ts"])];
  const ev = await graded(232, commandDeps(prs, { jobs: { 114: null } }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a job of another name is never that suite's fact", async () => {
  const prs = [withJobs(233, "a", "b", [check("kernel#1", 115)], ["kernel/src/x.ts"])];
  const ev = await graded(233, commandDeps(prs, { jobs: { 115: { name: "kernel#2" } } }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a suite with no check run (one that did not run on this head) is never claimed", async () => {
  // kernel#2's job is green, but only it has a check: kernel#1 did not run, so nothing vouches for it.
  const prs = [withJobs(234, "a", "b", [check("kernel#2", 116)], ["kernel/src/x.ts"])];
  const ev = await graded(234, commandDeps(prs, { jobs: { 116: { name: "kernel#2" } } }));
  assert.ok(ev.facts.includes(fact("kernel#2", KERNEL_RUN_2, "kernel")), ev.facts.join("\n"));
  assert.ok(!ev.facts.some((f) => f.includes("(kernel#1)") || f.includes('" (kernel#1)')), "kernel#1 is not claimed");
  assert.ok(!ev.facts.some((f) => f.includes(`ran "${KERNEL_RUN}"`)), ev.facts.join("\n"));
});

test("a failed check, or a job that failed, claims nothing", async () => {
  const failedCheck = await graded(235, commandDeps([withJobs(235, "a", "b", [check("kernel#1", 117, "FAILURE")])]));
  assert.ok(!failedCheck.facts.some((f) => f.includes('ran "')), failedCheck.facts.join("\n"));
  const failedJob = await graded(235, commandDeps([withJobs(235, "a", "b", [check("kernel#1", 117)])], { jobs: { 117: { conclusion: "failure" } } }));
  assert.ok(!failedJob.facts.some((f) => f.includes('ran "')), failedJob.facts.join("\n"));
});

test("a job from another workflow, state, event or head claims nothing", async () => {
  const prs = [withJobs(236, "a", "b", [check("kernel#1", 118)])];
  const other = [{ workflow_path: ".github/workflows/other.yml" }, { workflow_path: null }, { workflow_state: "disabled_manually" }, { event: "push" }, { head_sha: SHA("d") }, { state: "in_progress" }];
  for (const run of other) {
    const ev = await graded(236, commandDeps(prs, { jobs: { 118: run } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(run));
  }
});

test("a head whose ci.yml differs from the run's base claims nothing", async () => {
  const prs = [withJobs(237, "a", "b", [check("kernel#1", 119)])];
  for (const opts of [{ headWorkflow: `${WORKFLOW}  x\n` }, { baseWorkflow: `${WORKFLOW}  y\n` }, { headWorkflow: null }]) {
    const ev = await graded(237, commandDeps(prs, opts));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(opts));
  }
});

test("a suite whose directory is absent at the graded head mints nothing", async () => {
  // run-suites.sh exits 0 over a missing directory: a green job there ran nothing.
  const prs = [withJobs(238, "a", "b", [check("kernel#1", 120)])];
  const ev = await graded(238, commandDeps(prs, { absent: ["kernel"] }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a suite whose directory was already absent at the run's base mints nothing", async () => {
  // Not a removal this PR made: the folder is simply not at head, so the job that ran it ran nothing.
  const prs = [withJobs(249, "a", "b", [check("kernel#1", 127)])];
  const ev = await graded(249, commandDeps(prs, { dirResult: () => ({ path: "kernel", present: false }) }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("an unreadable directory check claims nothing", async () => {
  const prs = [withJobs(250, "a", "b", [check("kernel#1", 128)])];
  const ev = await graded(250, commandDeps(prs, { dirResult: () => null }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("the base is the run's own, never the PR's moving base, and a job with none claims nothing", async () => {
  const prs = [withJobs(239, "a", "b", [check("kernel#1", 121)])];
  prs[0].baseRef = { target: { oid: SHA("c") } };
  const ev = await graded(239, commandDeps(prs, { bases: [SHA("f")] }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
  const none = await graded(239, commandDeps(prs, { jobs: { 121: { run_base: null } } }));
  assert.ok(!none.facts.some((f) => f.includes('ran "')), none.facts.join("\n"));
});

test("a check list or file list GitHub truncated claims nothing", async () => {
  const truncatedChecks = [withJobs(240, "a", "b", [check("kernel#1", 122)])];
  truncatedChecks[0].commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true };
  assert.ok(!(await graded(240, commandDeps(truncatedChecks))).facts.some((f) => f.includes('ran "')), "a cut check list is no evidence");
  const truncatedFiles = [withJobs(240, "a", "b", [check("kernel#1", 122)])];
  truncatedFiles[0].files.pageInfo = { hasNextPage: true };
  assert.ok(!(await graded(240, commandDeps(truncatedFiles))).facts.some((f) => f.includes('ran "')), "a cut file list is no evidence");
});

test("a PR that edits CI execution code claims nothing", async () => {
  // The workflow, the suite runner, the selector and the map are the inputs that decide what CI runs and what a suite's
  // command is: an edit to any of them means the fact could describe a run this PR shaped, so there is no fact.
  for (const edited of [ ".github/workflows/other.yml", ".github/ci/run-suites.sh", ".github/ci/select.ts", ".github/ci/areas.json" ]) {
    const prs = [withJobs(241, "a", "b", [check("kernel#1", 123)], ["kernel/src/x.ts", edited])];
    const ev = await graded(241, commandDeps(prs));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), `${edited}: ${ev.facts.join("\n")}`);
  }
  // The control: the same green job and check on a PR that touches nothing under `.github/` still mints the fact.
  const plain = [withJobs(241, "a", "b", [check("kernel#1", 123)], ["kernel/src/x.ts"])];
  const ev = await graded(241, commandDeps(plain));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("no job log is read at all: the fact comes from a suite's job record alone", async () => {
  const prs = [withJobs(244, "a", "b", [check("kernel#1", 122)])];
  const deps = commandDeps(prs);
  assert.equal("jobLog" in deps, false, "the log is gone from grading's dependencies");
  const ev = await graded(244, deps);
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("an unreadable base map claims nothing", async () => {
  const prs = [withJobs(242, "a", "b", [check("kernel#1", 125)])];
  const ev = await graded(242, commandDeps(prs, { base: "{not json" }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});
