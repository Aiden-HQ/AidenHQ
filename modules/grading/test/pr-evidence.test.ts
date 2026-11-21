// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCommitOf, localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as the code host's read answers it. `chain` is GitHub's list of the PR's own commits (the head branch's commits not in the
// base branch), oldest first here as the read returns them; the base commit is the parent of the one commit starting that history.
const chainOf = (list, more = false) => ({ pageInfo: { hasNextPage: more }, nodes: list.map((c) => ({ commit: { oid: SHA(c.oid), parents: { totalCount: c.parents.length, nodes: c.parents.slice(0, 1).map((x) => ({ oid: SHA(x) })) } } })) });
const merged = (n, head, merge, base = "0", { chain = chainOf([{ oid: head, parents: [base] }]) } = {}) => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge) }, chain,
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

// The prerequisite-then-pin shape: a PR whose history starts on the commit its prerequisite just merged. The fixture is a
// prerequisite squash-merged as SHA("2") and a single-commit PR whose parent is that merge, so the base the criterion asks about
// is named rather than "not established". That is the shape of a branch cut after the prerequisite merged; a branch cut before
// it keeps the older parent, which is why the fact labels the value "parent of the PR's oldest commit" and never claims a cut
// point.
test("a PR whose history starts on the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(201, "1", "2"); // squash-merged as SHA("2")
  const landed = merged(202, "3", "4", "2", { chain: chainOf([{ oid: "3", parents: ["2"] }]) });
  const ev = await prEvidence([{ repo: REPO, number: 202, url: url(202), heads: ["branch-3"] }], "", depsFor([prerequisite, landed]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(202)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the fact gives the prerequisite's merge commit, not 'not established'");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's squash merge");
  assert.match(fact, /base commit [0-9a-f]{40} \(parent of the PR's oldest commit\)/, "and the label states only what the parent edge proves");
});

// The derivation itself, without the evidence around it: the one commit whose first parent is outside the list is the start of
// the history, and only its single parent is the base.
test("baseCommitOf names the parent of the single commit that starts the PR's history", () => {
  assert.equal(baseCommitOf(merged(601, "3", "4", "2")), SHA("2"), "a one-commit history names its parent");
  assert.equal(baseCommitOf({ ...merged(602, "3", "4"), chain: chainOf([{ oid: "3", parents: ["b"] }, { oid: "b", parents: ["2"] }]) }), SHA("2"), "the start is found by the parent edges, not by the list's order");
  // A node repeated in the list is one commit, not two starting commits.
  assert.equal(baseCommitOf({ ...merged(603, "3", "4"), chain: chainOf([{ oid: "3", parents: ["2"] }, { oid: "3", parents: ["2"] }]) }), SHA("2"), "a repeated commit does not read as two starts");
  assert.equal(baseCommitOf({ ...merged(604, "3", "4"), state: "OPEN" }), "", "an unmerged PR has no base yet");
  assert.equal(baseCommitOf({ ...merged(605, "3", "4"), chain: undefined }), "", "a read with no commit list establishes nothing");
  assert.equal(baseCommitOf({ ...merged(606, "3", "4"), chain: { nodes: [{ commit: { oid: SHA("3"), parents: { totalCount: 1, nodes: [{ oid: SHA("3") }] } } }], pageInfo: { hasNextPage: false } } }), "", "a commit that starts nothing establishes nothing");
});

// The oldest commit is found by the graph, not by the list's order: GitHub documents neither the connection's order nor that one page
// holds every commit, so a list given newest first must still yield the same single starting commit.
test("the oldest commit is the one whose parent is outside the list, whatever order the list is in", async () => {
  const newestFirst = { pageInfo: { hasNextPage: false }, nodes: [["3", "b"], ["b", "a"], ["a", "2"]].map(([oid, parent]) => ({ commit: { oid: SHA(oid), parents: { totalCount: 1, nodes: [{ oid: SHA(parent) }] } } })) };
  const pr = { ...merged(502, "3", "4"), chain: newestFirst };
  const ev = await prEvidence([{ repo: REPO, number: 502, url: url(502), heads: ["branch-3"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(502)}: merged`));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the list's last entry is the start of the history");
});

// Everything the parent edge cannot prove alone establishes nothing: two starts, a merged commit among them, a cut-off list, a
// starting commit with no parent or more than one, and no list at all.
test("a base is stated only when exactly one commit starts the PR's own history", async () => {
  const cases = {
    "no commits": { pageInfo: { hasNextPage: false }, nodes: [] },
    "a cut-off list": chainOf([{ oid: "3", parents: ["2"] }], true),
    "two starting commits": chainOf([{ oid: "3", parents: ["a"] }, { oid: "b", parents: ["2"] }]),
    "a starting commit with no parent": chainOf([{ oid: "3", parents: [] }]),
    "only a merge commit starts the history": chainOf([{ oid: "3", parents: ["2", "9"] }]),
    "a merge commit started history beside a plain starting commit": chainOf([{ oid: "3", parents: ["2", "9"] }, { oid: "a", parents: ["8"] }]),
    "an unreadable parent": { pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: SHA("3"), parents: { totalCount: 1, nodes: [{ oid: "nope" }] } } }] },
    "no chain read at all": undefined,
  };
  for (const [label, chain] of Object.entries(cases)) {
    const pr = { ...merged(503, "3", "4") };
    if (chain === undefined) delete pr.chain; else pr.chain = chain;
    const ev = await prEvidence([{ repo: REPO, number: 503, url: url(503), heads: ["branch-3"] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(503)}: merged`));
    assert.match(fact, /base commit not established/, `${label}: nothing is claimed`);
    assert.doesNotMatch(fact, /base commit [0-9a-f]/, `${label}: and no sha is shown`);
  }
});

test("an unmerged PR has no base commit yet", async () => {
  const open = { ...merged(300, "5", ""), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 300, url: url(300), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(300)}: open`));
  assert.match(fact, /base commit not established/, "no base commit is claimed before the merge");
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "and none is named");
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
  assert.deepEqual(pr.chain.nodes, [], "the local read has no list of the change's commits to start from");
  const ev = await prEvidence([{ repo: REPO, number: 7, url: "codehost:local/app/change/7", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/7"));
  assert.match(fact, /base commit not established/, "the local read never establishes a base commit either");
  assert.doesNotMatch(fact, new RegExp(SHA("2")), "its merge base is not the base");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("4")}`), "and its merge commit is not passed off as the base");
});
