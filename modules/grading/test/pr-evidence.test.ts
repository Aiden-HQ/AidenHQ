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
const KERNEL_RUN = "node --disable-warning=ExperimentalWarning --test --test-shard=1/2 test/*.test.ts";
const KERNEL_RUN_2 = "node --disable-warning=ExperimentalWarning --test --test-shard=2/2 test/*.test.ts";
const AREAS = JSON.stringify({ everything: [], markdown: [], suites: [
  { name: "kernel#1", secs: 33, run: KERNEL_RUN, paths: ["kernel"] },
  { name: "kernel#2", secs: 33, run: KERNEL_RUN_2, paths: ["kernel"] },
  { name: "modules/grading", secs: 4, job: "modules", run: "npm test", paths: ["modules/grading"] },
] });
const withJobs = (n, head, merge, jobs, files = ["kernel/src/x.ts"]) => ({
  ...merged(n, head, merge),
  baseRef: { target: { oid: SHA("f") } },
  files: { pageInfo: { hasNextPage: false }, nodes: files.map((path) => ({ path })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" },
    ...jobs,
  ] } } } }] },
});
const job = (name, id) => ({ __typename: "CheckRun", databaseId: id, name, status: "COMPLETED", conclusion: "SUCCESS" });
const PASSED = [{ name: "Test", state: "completed", conclusion: "success" }];
const group = (name) => `##[group]${name} (exit 0, 33s)\n##[endgroup]`;
const shard = (n, ...suites) => `Shard ${n}: ${suites.join(" ")}\n`;
const WORKFLOW = "name: ci\njobs:\n  packages:\n    steps:\n      - name: Test\n";
const RUNNER = "#!/usr/bin/env bash\n";
const commandDeps = (prs, { base = AREAS, head = AREAS, workflow = WORKFLOW, headWorkflow = workflow, baseWorkflow = workflow, select = SELECT, headRunner = RUNNER, baseRunner = RUNNER, logs = {}, steps = {}, jobs = {} } = {}) => ({
  ...depsFor(prs),
  file: async (_repo, path, ref) => {
    const own = ref === prs[0].headRefOid, atBase = ref === SHA("f");
    if (path === ".github/ci/areas.json") return own ? head : atBase ? base : null;
    if (path === ".github/workflows/ci.yml") return own ? headWorkflow : atBase ? baseWorkflow : null;
    if (path === ".github/ci/run-suites.sh") return own ? headRunner : atBase ? baseRunner : null;
    if (path === ".github/ci/select.ts") return atBase ? select : null;
    return null;
  },
  jobLog: async (_repo, id) => logs[id] ?? null,
  job: async (_repo, id) => ({ id, state: "completed", conclusion: "success", run_base: SHA("f"), workflow_path: ".github/workflows/ci.yml",
    workflow_state: "active", event: "pull_request", head_sha: prs[0].headRefOid, steps: steps[id] ?? PASSED, ...jobs[id] }),
});
/** The task's one branch-row PR, graded against the given deps. */
const graded = (n, deps) => prEvidence([{ repo: REPO, number: n, url: url(n), heads: ["branch-a"] }], "", deps);

test("a green job on the head whose shard ran the criterion's suites is a trusted fact naming the commands", async () => {
  const prs = [withJobs(230, "a", "b", [job("packages (1)", 111), job("packages (2)", 112)])];
  const ev = await graded(230, commandDeps(prs, { logs: { 111: shard(1, "kernel#1"), 112: shard(2, "kernel#2") } }));
  assert.ok(ev.facts.includes(`packages (1) green on head ${SHA("a")}: ran "${KERNEL_RUN}" (kernel#1) in kernel/ — passed`), ev.facts.join("\n"));
  assert.ok(ev.facts.includes(`packages (2) green on head ${SHA("a")}: ran "${KERNEL_RUN_2}" (kernel#2) in kernel/ — passed`), ev.facts.join("\n"));
});

test("a suite the selection did not pick is never claimed, though its job exists", async () => {
  const prs = [withJobs(231, "a", "b", [job("modules (1)", 113)], ["modules/grading/src/x.ts"])];
  const ev = await graded(231, commandDeps(prs, { logs: { 113: shard(1, "modules/grading") } }));
  assert.ok(!ev.facts.some((f) => f.includes(KERNEL_RUN)), "the kernel suite is on no shard of this change");
  assert.ok(!ev.facts.some((f) => f.includes("kernel#")), "no job is claimed to have run it");
  assert.ok(ev.facts.some((f) => f.includes('ran "npm test"') && f.includes("(modules/grading)")), ev.facts.join("\n"));
});

test("another job's green never claims a suite assigned to a job that did not run", async () => {
  const prs = [withJobs(232, "a", "b", [job("packages (2)", 114)])];
  const ev = await graded(232, commandDeps(prs, { logs: { 114: shard(2, "kernel#2") } }));
  assert.ok(!ev.facts.some((f) => f.includes("(kernel#1)")), "kernel#1's job never ran");
  assert.ok(ev.facts.some((f) => f.includes("(kernel#2)") && f.includes(KERNEL_RUN_2)));
});

test("a suite whose directory the job reports gone ran nothing", async () => {
  const prs = [withJobs(233, "a", "b", [job("packages (1)", 116)])];
  const ev = await graded(233, commandDeps(prs, {
    logs: { 116: `${shard(1, "kernel#1")}\n2026-11-20T14:38:01Z gone: kernel` },
  }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a job whose own Test step did not pass emits no command fact", async () => {
  const prs = [withJobs(234, "a", "b", [job("packages (1)", 117)])];
  const ev = await graded(234, commandDeps(prs, {
    logs: { 117: shard(1, "kernel#1") },
    steps: { 117: [{ name: "Test", state: "completed", conclusion: "failure" }] },
  }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("an untrusted base map or selector fails closed though the log names the suite", async () => {
  for (const [opts, id] of [[{ base: null }, 118], [{ select: `${SELECT}// differs\n` }, 119]]) {
    const prs = [withJobs(235, "a", "b", [job("packages (1)", id)])];
    const ev = await graded(235, commandDeps(prs, { ...opts, logs: { [id]: shard(1, "kernel#1") } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
  }
});

test("a command only the PR head changed is not a fact CI ran it", async () => {
  const prs = [withJobs(236, "a", "b", [job("packages (1)", 119)])];
  const head = JSON.stringify({ everything: [], markdown: [], suites: [{ name: "kernel#1", run: "npm run forged", paths: ["kernel"] }] });
  const ev = await graded(236, commandDeps(prs, { head, logs: { 119: shard(1, "kernel#1") } }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), "neither the head's command nor the base's is claimed");
});

test("a suite the head moves to another job is claimed for that job, never the base's", async () => {
  // The head places kernel#1 in modules; CI takes the placement from the head.
  const head = JSON.stringify({ everything: [], markdown: [], suites: [
    { name: "kernel#1", secs: 33, job: "modules", run: KERNEL_RUN, paths: ["kernel"] },
    { name: "kernel#2", secs: 33, run: KERNEL_RUN_2, paths: ["kernel"] },
  ] });
  const prs = [withJobs(245, "a", "b", [job("modules (1)", 128)])];
  const ev = await graded(245, commandDeps(prs, {
    head,
    logs: { 128: shard(1, "kernel#1") },
  }));
  assert.ok(ev.facts.includes(`modules (1) green on head ${SHA("a")}: ran "${KERNEL_RUN}" (kernel#1) in kernel/ — passed`), ev.facts.join("\n"));
  assert.ok(!ev.facts.some((f) => f.startsWith("packages")), "the head moved it out of packages");
});

test("a job from another base, workflow, run or event claims nothing", async () => {
  const prs = [withJobs(246, "a", "b", [job("packages (1)", 129)])];
  const other = [
    { run_base: SHA("e") },
    { workflow_path: ".github/workflows/other.yml" },
    { workflow_path: null },
    { workflow_state: "disabled_manually" },
    { event: "push" },
    { head_sha: SHA("d") },
  ];
  for (const run of other) {
    const ev = await graded(246, commandDeps(prs, { logs: { 129: shard(1, "kernel#1") }, jobs: { 129: run } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(run));
  }
});

test("a head that changes any workflow claims nothing", async () => {
  const prs = [withJobs(247, "a", "b", [job("packages (1)", 130)], ["kernel/src/x.ts", ".github/workflows/other.yml"])];
  const ev = await graded(247, commandDeps(prs, { logs: { 130: shard(1, "kernel#1") } }));
  assert.ok(!ev.facts.some((f) => f.includes('ran "')), ev.facts.join("\n"));
});

test("a test's printed passing group is never the proof: the pass is the Test step", async () => {
  const prs = [withJobs(239, "a", "b", [job("packages (1)", 122)])];
  const forged = [
    "2026-11-20T14:38:00Z Shard 1: kernel#1",
    "2026-11-20T14:38:01Z ##[group]kernel#1 (exit 0, 33s)",
    "2026-11-20T14:38:02Z ##[group]kernel#2 (exit 0, 1s)",
    "2026-11-20T14:38:02Z ##[endgroup]",
    "2026-11-20T14:38:33Z ##[endgroup]",
  ].join("\n");
  const ev = await graded(239, commandDeps(prs, { logs: { 122: forged } }));
  assert.ok(!ev.facts.some((f) => f.includes("(kernel#2)")), "a printed group never adds a suite to a shard");
});

test("a log that disagrees, is cut, or lacks the runner's shard line proves nothing", async () => {
  for (const [n, id, log] of [[240, 123, shard(1, "kernel#2")], [243, 126, `${shard(1, "kernel#1")}[cut: 9 bytes not shown]`], [244, 127, group("kernel#1")]] as const) {
    const prs = [withJobs(n, "a", "b", [job("packages (1)", id)])];
    const ev = await graded(n, commandDeps(prs, { logs: { [id]: log } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), `${n}: ${ev.facts.join("\n")}`);
  }
});

test("a changed or unreadable workflow or suite runner claims nothing", async () => {
  const prs = [withJobs(241, "a", "b", [job("packages (1)", 124)])];
  const changed = [{ headWorkflow: `${WORKFLOW}      - name: Not a test\n` }, { headWorkflow: null }, { headRunner: `${RUNNER}exit 0 # skip\n` }, { headRunner: null }];
  for (const opts of changed) {
    const ev = await graded(241, commandDeps(prs, { ...opts, logs: { 124: shard(1, "kernel#1") } }));
    assert.ok(!ev.facts.some((f) => f.includes('ran "')), JSON.stringify(opts));
  }
})
