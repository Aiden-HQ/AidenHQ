// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCommitOf, localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as the code host's read answers it: `baseRefOid` is the base ref's commit GitHub records on the PR. `baseRef.target` is
// the base branch's current tip, which moves and is never the base commit.
const merged = (n, head, merge, base = "0") => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge) }, baseRefOid: SHA(base),
  baseRef: { target: { oid: SHA("9") } },
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

// The prerequisite-then-pin shape: a PR based on the commit its prerequisite just merged. The fixture is a prerequisite
// squash-merged as SHA("2") and a PR whose recorded base ref commit is that merge, so the criterion asks about a base that is
// named rather than "not established".
test("a PR whose base is the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(201, "1", "2"); // squash-merged as SHA("2")
  const landed = merged(202, "3", "4", "2");
  const ev = await prEvidence([{ repo: REPO, number: 202, url: url(202), heads: ["branch-3"] }], "", depsFor([prerequisite, landed]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(202)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the fact gives the prerequisite's merge commit, not 'not established'");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's squash merge");
  assert.match(fact, /base commit [0-9a-f]{40} \(the recorded base ref commit\)/, "and the label says what the value is");
});

// The base commit is the PR's recorded base ref commit, never the base branch's current tip and never the git merge base.
test("the base commit is the recorded base ref commit, not the base branch's moving tip", async () => {
  const pr = { ...merged(601, "3", "4", "2"), baseRef: { target: { oid: SHA("7") } } };
  assert.equal(baseCommitOf(pr), SHA("2"), "the recorded base ref commit is named");
  const ev = await prEvidence([{ repo: REPO, number: 601, url: url(601), heads: ["branch-3"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(601)}: merged`));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"));
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("7")}`), "the base branch's tip is not passed off as the base commit");
});

// The base commit is part of the graded version: a criterion about it is judged from the value, so a PR that keeps its head and
// description but is re-based onto another commit is a new version to grade, not the same one rejected again.
test("the graded version changes when the PR's recorded base commit changes", async () => {
  const onBase = (base) => prEvidence([{ repo: REPO, number: 610, url: url(610), heads: ["branch-3"] }], "", depsFor([merged(610, "3", "4", base)]));
  const a = await onBase("2"), b = await onBase("5");
  assert.notEqual(a.version, b.version, "another base commit is another version");
  assert.match(a.version, new RegExp(`\\.${SHA("2")}$`), "the version names the base commit it graded");
  assert.equal((await onBase("2")).version, a.version, "the same base and head and text is the same version");
});

// A PR that is not merged yet still carries its recorded base commit: the fact states it rather than claiming nothing is known.
test("an open PR's fact names its recorded base commit too", async () => {
  const open = { ...merged(611, "5", "0", "2"), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 611, url: url(611), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(611)}: open`));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the recorded base ref commit is named before the merge");
});

test("a read with no base ref commit, or one that is not a commit id, establishes nothing", async () => {
  for (const [label, pr] of Object.entries({
    "no base ref commit": { ...merged(602, "3", "4"), baseRefOid: undefined },
    "not a commit id": { ...merged(603, "3", "4"), baseRefOid: "main" },
    "no PR read at all": undefined,
  })) {
    if (pr === undefined) { assert.equal(baseCommitOf(undefined), "", `${label}: nothing is claimed`); continue; }
    assert.equal(baseCommitOf(pr), "", `${label}: nothing is claimed`);
    const ev = await prEvidence([{ repo: REPO, number: pr.number, url: url(pr.number), heads: [`branch-${pr.headRefOid[0]}`] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(pr.number)}: merged`));
    assert.match(fact, /base commit not established/, `${label}: the fact says so`);
    assert.doesNotMatch(fact, /base commit [0-9a-f]/, `${label}: and no sha is shown`);
  }
});

test("a local change request's recorded base ref commit is its base commit, never its merge base", async () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 7, url: "codehost:local/app/change/7", state: "merged", head: SHA("3"), base: SHA("2"), baseRef: SHA("5"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  assert.equal(pr.baseRefOid, SHA("5"), "the recorded base ref commit is carried as the base commit");
  assert.equal(pr.baseRefName, "main");
  const ev = await prEvidence([{ repo: REPO, number: 7, url: "codehost:local/app/change/7", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/7"));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("5"), "the recorded base ref commit is named");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("2")}`), "its merge base is not the base");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("4")}`), "and its merge commit is not passed off as the base");
});

test("a local change read with no recorded base ref establishes no base commit", async () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 8, url: "codehost:local/app/change/8", state: "merged", head: SHA("3"), base: SHA("2"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  const ev = await prEvidence([{ repo: REPO, number: 8, url: "codehost:local/app/change/8", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/8"));
  assert.match(fact, /base commit not established/, "nothing is claimed");
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "and no sha is shown");
});
