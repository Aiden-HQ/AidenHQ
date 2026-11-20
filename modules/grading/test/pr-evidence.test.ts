// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as github.ts's read answers it. The merge commit's parents are the only source of a merged PR's base, and only two of
// them prove a merge commit: GitHub gives one parent for both a squash and a rebase, which this read cannot tell apart.
// `baseRefOid` is the base ref's moving tip (no longer selected) and is never read as the base.
const merged = (n, head, merge, base = "0", tip = "f", { parents = [{ oid: SHA(base) }, { oid: SHA(head) }] } = {}) => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  baseRefOid: SHA(tip), mergedAt: "2026-11-19T22:45:53Z",
  mergeCommit: { oid: SHA(merge), parents: { totalCount: parents.length, nodes: parents } },
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

// WOR-4892's shape: a prerequisite merged immediately before this PR, which landed on top of it. #103 was merge-committed, so its
// merge commit's two parents are #102's squash commit (the base branch's tip at the merge) and #103's own head.
test("a PR landed on the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(102, "1", "2"); // squash-merged as SHA("2")
  const landed = merged(103, "3", "4", "2", "f", { parents: [{ oid: SHA("2") }, { oid: SHA("3") }] });
  const ev = await prEvidence([{ repo: REPO, number: 103, url: url(103), heads: ["branch-3"] }], "", depsFor([prerequisite, landed]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(103)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the fact gives the commit PR #103 merged onto");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's squash merge");
  assert.match(fact, /base commit [0-9a-f]{40} \(the base branch's tip when it merged, its merge commit's first parent\)/, "and it says exactly what that id is, never implying the original cut point");
});

// A merged PR's base is claimed only where the read proves the merge method: a merge commit's two parents (base, then head). One
// parent is what GitHub gives for both a squash and a rebase, and nothing here tells them apart, so neither establishes a base.
test("a one-parent merge claims no base commit, whatever shape it has", async () => {
  const squash = { oid: "4", parents: [{ oid: SHA("2") }] };
  const rebaseOfOne = { oid: "3", parents: [{ oid: SHA("2") }] };
  const rebaseOfMany = { oid: "3", parents: [{ oid: SHA("a") }] };
  const selfParent = { oid: "3", parents: [{ oid: SHA("3") }] };
  for (const [label, shape] of Object.entries({ squash, "rebase of one commit": rebaseOfOne, "rebase of several commits": rebaseOfMany, "a parent that is the head itself": selfParent })) {
    const pr = { ...merged(500, "3", shape.oid, "2", "d"), mergeCommit: { oid: SHA(shape.oid), parents: { totalCount: shape.parents.length, nodes: shape.parents } } };
    const ev = await prEvidence([{ repo: REPO, number: 500, url: url(500), heads: ["branch-3"] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(500)}: merged`));
    assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], undefined, `${label}: no commit is claimed as the base`);
    assert.match(fact, /base commit not established/, `${label}: and the fact says so`);
    assert.doesNotMatch(fact, new RegExp(SHA("d")), `${label}: the base ref's moving tip is never the base`);
  }
});

test("a merge commit whose parents are not both read still establishes no base", async () => {
  for (const parents of [{ totalCount: 2 }, { totalCount: 2, nodes: [] }, { totalCount: 2, nodes: [{ oid: "not-a-commit" }, { oid: SHA("3") }] }]) {
    const pr = { ...merged(501, "3", "4", "2", "d"), mergeCommit: { oid: SHA("4"), parents } };
    const ev = await prEvidence([{ repo: REPO, number: 501, url: url(501), heads: ["branch-3"] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(501)}: merged`));
    assert.match(fact, /base commit not established/, "an unread or malformed parent is not a base");
    assert.doesNotMatch(fact, /base commit [0-9a-f]/, "no commit is claimed");
  }
});

test("an unmerged PR has no base commit yet, and its moving base ref tip is not named as one", async () => {
  const open = { ...merged(300, "5", "", "2", "e"), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 300, url: url(300), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(300)}: open`));
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "no base commit is claimed before the merge");
  assert.doesNotMatch(fact, new RegExp(SHA("e")), "the base ref tip is not passed off as the base");
});

test("a local change request carries no base commit, and its merge base is not passed off as one", async () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 7, url: "codehost:local/app/change/7", state: "merged", head: SHA("3"), base: SHA("2"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  assert.equal(pr.baseRefOid, undefined, "the change's moving merge base is not carried as anything");
  assert.equal(pr.baseCommitOid, undefined, "and it is never claimed as the base commit, which this read cannot show");
  assert.equal(pr.baseRefName, "main");
  const ev = await prEvidence([{ repo: REPO, number: 7, url: "codehost:local/app/change/7", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/7"));
  assert.match(fact, /base commit not established/, "the local read never establishes a base commit either");
  assert.doesNotMatch(fact, new RegExp(SHA("2")), "its merge base is not the base");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("4")}`), "and its merge commit is not passed off as the base");
});
