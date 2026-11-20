// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as github.ts's read answers it: `baseRefOid` is the base ref's oid, a moving tip; a merged PR's fixed base commit is its
// merge commit's first parent, the commit it landed on.
const merged = (n, head, merge, base = "0", tip = "f") => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  baseRefOid: SHA(tip), mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge), parents: { nodes: [{ oid: SHA(base) }] } },
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

// WOR-4892's shape: the prerequisite merged immediately before this PR, which landed on top of it. The base branch's name alone
// can't show it (main has moved on, so the base ref oid is a later commit), so the base commit is what a criterion about the
// PR's base is judged from. PR #103's merge commit had exactly one parent, #102's squash merge 46d15810.
test("a PR landed on the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(102, "1", "2"); // squash-merged as SHA("2")
  // #103's base ref oid now reads SHA("f") (main moved past it); its merge commit's first parent is still SHA("2").
  const landed = merged(103, "3", "4", "2", "f");
  landed.mergeCommit.parents.nodes = [{ oid: SHA("2") }]; // squashed onto the prerequisite, so one parent
  const prs = [prerequisite, landed];
  const ev = await prEvidence([{ repo: REPO, number: 103, url: url(103), heads: ["branch-3"] }], "", depsFor(prs));
  const fact = ev.facts.find((f) => f.startsWith(`${url(103)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.match(fact, new RegExp(`base commit ${SHA("2")}`), "the fact gives the commit PR #103 landed on");
  assert.doesNotMatch(fact, new RegExp(SHA("f")), "the moved base ref oid is never passed off as the base commit");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's squash merge");
});

test("an unmerged PR's base is labelled as the moving tip it is, never as a fixed base commit", async () => {
  const open = { ...merged(300, "5", "", "2", "e"), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 300, url: url(300), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(300)}: open`));
  assert.match(fact, new RegExp(`base main tip ${SHA("e")}, which moves`), "the base ref oid is named as a tip");
  assert.doesNotMatch(fact, /base commit/, "no fixed base commit is claimed for an unmerged PR");
});

test("a merge commit whose parent could not be read leaves the base commit out rather than guessing", async () => {
  const { parents, ...noParents } = merged(400, "7", "8").mergeCommit;
  const ev = await prEvidence([{ repo: REPO, number: 400, url: url(400), heads: ["branch-7"] }], "", depsFor([{ ...merged(400, "7", "8"), mergeCommit: noParents }]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(400)}: merged`));
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "no commit is passed off as the base");
  assert.doesNotMatch(fact, /base main tip/, "and the tip is not substituted for it on a merged PR");
});

test("a local change request carries its base commit in the same shape as GitHub's read", () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 7, url: "codehost:local/app/change/7", state: "merged", head: SHA("3"), base: SHA("2"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  assert.equal(pr.baseRefOid, SHA("2"), "the change's base tip, which its squash landed on");
  assert.equal(pr.mergeCommit.parents.nodes[0].oid, SHA("2"), "and its merge commit says the same commit is the base");
  assert.equal(pr.baseRefName, "main");
});
