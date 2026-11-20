// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";
import { createGithub } from "../service/src/github.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as github.ts's read answers it: `baseRefOid` is the base ref's oid, a moving tip; `baseCommitOid` is the merge base of
// the head and the base branch, read from compare. A merge commit's own parents differ by merge method, so they are never used.
const merged = (n, head, merge, base = "0", tip = "f") => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  baseRefOid: SHA(tip), baseCommitOid: SHA(base), mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge) },
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

// WOR-4892's shape: the prerequisite merged immediately before this PR, which was cut from it. The base branch's name alone
// can't show it (main has moved on, so the base ref oid is a later commit), so the base commit is what a criterion about the
// PR's base is judged from.
test("a PR cut from the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(102, "1", "2"); // merged as SHA("2")
  // #103's base ref oid now reads SHA("f") (main moved past it); its merge base is still SHA("2").
  const prs = [prerequisite, merged(103, "3", "4", "2", "f")];
  const ev = await prEvidence([{ repo: REPO, number: 103, url: url(103), heads: ["branch-3"] }], "", depsFor(prs));
  const fact = ev.facts.find((f) => f.startsWith(`${url(103)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.match(fact, new RegExp(`base commit ${SHA("2")}`), "the fact gives the commit PR #103 was cut from");
  assert.doesNotMatch(fact, new RegExp(SHA("f")), "the moved base ref oid is never passed off as the base commit");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's merge");
});

// The base commit does not depend on how the PR merged: a merge commit, a squash and a rebase all read the same field.
test("the base commit is the merge base whatever merge method produced the PR", async () => {
  for (const [label, mergeCommit] of [
    ["a merge commit", { oid: SHA("4"), parents: { nodes: [{ oid: SHA("2") }, { oid: SHA("3") }] } }],
    ["a squash merge", { oid: SHA("4"), parents: { nodes: [{ oid: SHA("2") }] } }],
    ["a rebase merge", { oid: SHA("3"), parents: { nodes: [{ oid: SHA("a") }] } }],
  ]) {
    const pr = { ...merged(500, "3", "4", "2", "f"), mergeCommit };
    const ev = await prEvidence([{ repo: REPO, number: 500, url: url(500), heads: ["branch-3"] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(500)}: merged`));
    const stated = /base commit ([0-9a-f]{40})/.exec(fact)?.[1];
    assert.equal(stated, SHA("2"), `${label}: the merge base is the base commit, never a merge-commit parent`);
  }
});

test("a PR whose base commit could not be established says so, and never names the moving base ref tip", async () => {
  const { baseCommitOid, ...unknown } = merged(400, "7", "8", "2", "d");
  const ev = await prEvidence([{ repo: REPO, number: 400, url: url(400), heads: ["branch-7"] }], "", depsFor([unknown]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(400)}: merged`));
  assert.match(fact, /base commit not established/, "the missing base is stated");
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "and no commit is passed off as it");
  assert.doesNotMatch(fact, new RegExp(SHA("d")), "the base ref tip is not substituted for it");
});

test("an unmerged PR gets the same merge-base base commit, not the moving base ref tip", async () => {
  const open = { ...merged(300, "5", "", "2", "e"), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 300, url: url(300), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(300)}: open`));
  assert.match(fact, new RegExp(`base commit ${SHA("2")}`), "the merge base is the base commit");
  assert.doesNotMatch(fact, new RegExp(SHA("e")), "the base ref tip is not claimed as the base");
});

test("a merged local change request carries its base commit in the same field as GitHub's read", () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 7, url: "codehost:local/app/change/7", state: "merged", head: SHA("3"), base: SHA("2"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  assert.equal(pr.baseCommitOid, SHA("2"), "a squashed local change's base is the tip it landed on");
  assert.equal(pr.baseRefName, "main");
});

// github.ts's read: the PR comes from GraphQL, and the base commit from REST's compare merge base, so it is the same whichever
// merge method produced the PR. A compare that fails leaves the field off, and evidence.ts then says it was not established.
const githubWith = (compare) => createGithub({
  kernel: async () => ({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
  fetchFn: async (u) => {
    const url = String(u);
    if (url.endsWith("/graphql")) return new Response(JSON.stringify({ data: { repository: { pullRequest: { number: 5, url: "https://github.com/acme-agents/app/pull/5", state: "MERGED", headRefOid: SHA("a"), headRefName: "fix", baseRefName: "main", mergeCommit: { oid: SHA("b") } } } } }), { status: 200 });
    if (compare === "fail") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(compare), { status: 200 });
  },
});

test("github.ts reads the base commit from compare's merge base, never from a merge-commit parent", async () => {
  const gh = githubWith({ merge_base_commit: { sha: SHA("2") }, base_commit: { sha: SHA("9") } });
  const pr = (await gh.pr(REPO, 5)).repository.pullRequest;
  assert.equal(pr.baseCommitOid, SHA("2"), "merge_base_commit is the base commit (base_commit is only the base ref tip)");
  const unread = (await githubWith("fail").pr(REPO, 5)).repository.pullRequest;
  assert.equal(unread.baseCommitOid, undefined, "a failed compare leaves it unset, never guessed");
});
