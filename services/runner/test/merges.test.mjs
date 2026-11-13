import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/tiers.mjs";
import { addEach, advance, allowedWrite, closePrs, awaitChecks, eachDecision, findPrs, finishedStatus, newQueue, prDecision, startOrResume, WRITES } from "../src/merges.mjs";

const green = { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] } };
const red = { state: "FAILURE", contexts: { nodes: [{ __typename: "StatusContext", context: "buildkite/deploy", state: "FAILURE" }] } };
const pending = { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }] } };
const cancelled = { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "CANCELLED" }] } };

function pr(number, over = {}) {
  return {
    id: `PR_${number}`, number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN", headRefOid: `head${number}`, baseRefName: "master", latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: green } }] }, baseRef: { target: { oid: "base", statusCheckRollup: green } }, ...over,
  };
}

/** A fake GitHub: PRs by number, merge commits' rollups by oid, and a log of writes. */
function fakeGithub(prs, commits = {}, bases = {}) {
  const writes = [];
  return {
    writes,
    commits,
    prs,
    async pr(repo, number) {
      return { repository: { defaultBranchRef: { name: "master" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, pullRequest: prs[number] } };
    },
    async commit(repo, oid) {
      return { statusCheckRollup: commits[oid] ?? null };
    },
    async merge(repo, number, opts) {
      writes.push({ merge: number, ...opts });
      prs[number] = { ...prs[number], state: "MERGED" };
      return `merge${number}`;
    },
    async updateBranch(repo, number, head) {
      writes.push({ update: number, head });
    },
    async baseStatus(repo, base) {
      return { tip: null, open: false, merged: [], overflow: false, stacked: false, ...bases[base] };
    },
    async retarget(repo, number, base) {
      writes.push({ retarget: number, base });
      prs[number] = { ...prs[number], baseRefName: base };
    },
    async deleteBranch(repo, branch) {
      writes.push({ deleted: branch });
    },
    async markReady(id) {
      writes.push({ ready: id });
      const n = Number(id.slice(3));
      prs[n] = { ...prs[n], isDraft: false };
    },
  };
}

const at = (min) => new Date(Date.parse("2026-10-26T15:00:00Z") + min * 60_000);

describe("merge queue: reading the PRs", () => {

  it("starts fresh, resumes a stopped queue, and keeps what's merged when new PRs come", () => {
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    q.prs[0].status = "merged";
    q.state = "stopped";
    const resumed = startOrResume(q, [], {});
    assert.equal(resumed.state, "running");
    assert.equal(resumed.gapMinutes, 15);
    const replaced = startOrResume(q, findPrs("o/r#1 o/r#3"), {});
    assert.deepEqual(replaced.prs.map((p) => [p.number, p.status]), [[1, "merged"], [3, "pending"]]);
    assert.equal(startOrResume({ ...q, prs: [q.prs[0]] }, [], {}), undefined); // nothing left to resume
  });
});

describe("merge queue: deciding", () => {
  it("merges only approved, green, clean PRs onto a green base", () => {
    assert.equal(prDecision(pr(1)).do, "merge");
    assert.equal(prDecision(pr(1, { reviewDecision: "REVIEW_REQUIRED" })).do, "stop");
    assert.equal(prDecision(pr(1, { reviewDecision: "CHANGES_REQUESTED" })).do, "stop");
    assert.equal(prDecision(pr(1, { isDraft: true })).do, "ready");
    assert.equal(prDecision(pr(1, { isDraft: true, reviewDecision: "REVIEW_REQUIRED" })).do, "stop");
    assert.equal(prDecision(pr(1, { state: "CLOSED" })).do, "stop");
    assert.equal(prDecision(pr(1, { state: "MERGED" })).do, "skip");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "DIRTY" })).do, "stop");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "UNKNOWN" })).do, "wait");
    assert.equal(prDecision(pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: red } }] } })).do, "stop");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BLOCKED", commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } })).do, "wait");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BLOCKED" })).do, "stop");
    assert.equal(prDecision(pr(1, { baseRef: { target: { statusCheckRollup: red } } })).do, "stop");
    assert.equal(prDecision(pr(1, { baseRef: { target: { statusCheckRollup: pending } } })).do, "wait");
  });

  it("without required reviews, needs an approval and no change requests", () => {
    assert.equal(prDecision(pr(1, { reviewDecision: null })).do, "merge");
    assert.equal(prDecision(pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } })).do, "stop");
    assert.equal(prDecision(pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }] } })).do, "stop");
  });

  it("updates a branch that's behind once per head", () => {
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BEHIND" })).do, "update");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BEHIND" }), { updatedHead: "head1" }).do, "wait");
  });

  it("writes only merges, branch updates and closing a PR (comment, then state)", () => {
    assert.deepEqual(WRITES.map((w) => w.method), ["PUT", "PUT", "POST", "PATCH", "DELETE"]);
    assert.ok(WRITES.some((w) => w.path.test("repos/o/r/pulls/1/merge")));
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/pulls/1/reviews")));
    assert.ok(WRITES.some((w) => w.method === "DELETE" && w.path.test("repos/o/r/git/refs/heads/feat/x")));
    assert.ok(!WRITES.some((w) => w.method !== "DELETE" && w.path.test("repos/o/r/git/refs/heads/master")));
  });

  it("comments, PR edits and branch deletes only in the agents org; merges anywhere", () => {
    assert.ok(allowedWrite("PUT", "repos/acme/app/pulls/1/merge", "acme-agents"));
    assert.ok(allowedWrite("DELETE", "repos/Acme-Agents/app/git/refs/heads/feat/x", "acme-agents"));
    for (const [m, p] of [["POST", "repos/acme/app/issues/1/comments"], ["PATCH", "repos/acme/app/pulls/1"], ["DELETE", "repos/acme/app/git/refs/heads/feat/x"]]) {
      assert.ok(!allowedWrite(m, p, "acme-agents"), `${m} ${p}`);
      assert.ok(!allowedWrite(m, p.replace("acme/", "acme-agents/"), undefined), "no agents org: refused");
    }
    assert.ok(!allowedWrite("PUT", "repos/acme-agents/app/pulls/1/reviews", "acme-agents"));
    // The product repo: comments and PR edits (closing its Dependabot PRs), never a branch delete.
    assert.ok(allowedWrite("POST", "repos/acme/aidenhq/issues/1/comments", "acme-agents", "acme/aidenhq"));
    assert.ok(allowedWrite("PATCH", "repos/Acme/AidenHQ/pulls/1", "acme-agents", "acme/aidenhq"));
    assert.ok(!allowedWrite("DELETE", "repos/acme/aidenhq/git/refs/heads/dependabot/x", "acme-agents", "acme/aidenhq"));
    assert.ok(!allowedWrite("PATCH", "repos/acme/aidenhq-other/pulls/1", "acme-agents", "acme/aidenhq"));
  });
});

describe("merge queue: a run through", () => {
  it("merges one at a time, waits for CI and the gap, then finishes", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) });
    let q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    let step = await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ merge: 1, sha: "head1", method: "squash" }]);
    assert.equal(step.queue.prs[0].status, "merged");

    gh.commits.merge1 = pending;
    step = await advance(q, { github: gh, now: at(3) });
    assert.equal(step.say.length, 0);
    gh.commits.merge1 = green;
    step = await advance(q, { github: gh, now: at(6) });
    assert.match(step.say[0], /Merged https:\/\/github.com\/o\/r\/pull\/1 \(1 of 2\) and `master` is green/);
    assert.equal(gh.writes.length, 1); // the gap isn't over

    step = await advance(q, { github: gh, now: at(14) });
    assert.equal(gh.writes.length, 1);
    step = await advance(q, { github: gh, now: at(15) });
    assert.deepEqual(gh.writes.at(-1), { merge: 2, sha: "head2", method: "squash" });

    gh.commits.merge2 = green;
    step = await advance(q, { github: gh, now: at(21) });
    assert.equal(step.done, "done");
    assert.equal(step.queue.state, "done");
    assert.match(step.say.at(-1), /\*\*Done:\*\*/);
  });

  it("stops when CI goes red after a merge, and doesn't merge the next one", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: red });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI failed on `master` after merging #1: buildkite\/deploy/);
    assert.match(step.say[0], /continue from #2/);
    assert.equal(gh.writes.length, 1);
    assert.deepEqual(await advance(q, { github: gh, now: at(30) }), { queue: q, say: [] }); // stays stopped
  });

  it("judges the base's current tip when a newer push cancelled the merge commit's run", async () => {
    // The owner pushed to master while the merge commit's run was going, so GitHub cancelled it: no result on merge1,
    // but master's tip has the merge in it too, and it is green.
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: cancelled, tip: green }, { master: { tip: "tip" } });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    let step = await advance(q, { github: gh, now: at(3) });
    assert.equal(step.done, undefined);
    assert.equal(step.say.length, 0); // still settling, and the tip's checks count
    step = await advance(q, { github: gh, now: at(6) });
    assert.equal(step.done, undefined);
    assert.match(step.say[0], /Merged https:\/\/github.com\/o\/r\/pull\/1 \(1 of 2\) and `master` is green/);
  });

  it("still stops on a real failure on the merge commit when the base moved on", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: red, tip: green }, { master: { tip: "tip" } });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI failed on `master` after merging #1: buildkite\/deploy/);
  });

  it("skips a PR someone else merged and stops on one that isn't approved", async () => {
    const gh = fakeGithub({ 1: pr(1, { state: "MERGED", mergedBy: { login: "alice" } }), 2: pr(2, { reviewDecision: "REVIEW_REQUIRED" }) });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    const step = await advance(q, { github: gh, now: at(0) });
    assert.match(step.say[0], /Skipped https:\/\/github.com\/o\/r\/pull\/1: #1 was already merged by alice/);
    assert.equal(step.done, "stopped");
    assert.match(step.say.at(-1), /#2 isn't approved/);
    assert.equal(gh.writes.length, 0);
  });

  it("in the agents org the owner's merge card is the review: an unreviewed draft is readied and merged", async () => {
    const gh = fakeGithub({ 1: pr(1, { isDraft: true, reviewDecision: null, latestOpinionatedReviews: { nodes: [] } }) });
    const q = newQueue(findPrs("o/r#1").map((p) => ({ ...p, head: "head1" })), { gapMinutes: 15, now: at(0) });
    const cardIsReview = (repo) => repo === "o/r";
    await advance(q, { github: gh, now: at(0), cardIsReview });
    assert.deepEqual(gh.writes, [{ ready: "PR_1" }]);
    await advance(q, { github: gh, now: at(1), cardIsReview });
    assert.deepEqual(gh.writes.at(-1), { merge: 1, sha: "head1", method: "squash" });
    const other = fakeGithub({ 1: pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } }) });
    const q2 = newQueue(findPrs("x/y#1"), { gapMinutes: 15, now: at(0) });
    assert.equal((await advance(q2, { github: other, now: at(0), cardIsReview })).done, "stopped");
    const asked = fakeGithub({ 1: pr(1, { reviewDecision: "CHANGES_REQUESTED" }) });
    const q3 = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    assert.equal((await advance(q3, { github: asked, now: at(0), cardIsReview })).done, "stopped");
    // The card is bound to the commit it showed: a moved head, or no recorded head, stops the queue.
    const moved = fakeGithub({ 1: pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } }) });
    const q4 = newQueue(findPrs("o/r#1").map((p) => ({ ...p, head: "an-older-commit" })), { gapMinutes: 15, now: at(0) });
    const s4 = await advance(q4, { github: moved, now: at(0), cardIsReview });
    assert.equal(s4.done, "stopped");
    assert.match(s4.say.at(-1), /changed since/);
    const q5 = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    assert.equal((await advance(q5, { github: moved, now: at(0), cardIsReview })).done, "stopped");
    assert.equal(moved.writes.length, 0);
  });

  it("a reviewer-approved product merge readies the agent's draft, then merges it at the card's head once green", async () => {
    // main.mjs passes cardIsReview: ownRepo (the agents org or the product repo). Before 2026-11-13 the product repo was left
    // out, so its unreviewed drafts stopped at "isn't approved" (PR #7 sat as a green draft until the grader escalated it).
    const ownRepo = (repo) => repo.startsWith("acme-agents/") || repo === "acme/aidenhq";
    const draft = () => ({ 7: { ...pr(7, { isDraft: true, reviewDecision: null, latestOpinionatedReviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } }), url: "https://github.com/acme/aidenhq/pull/7" } });
    const card = () => Object.assign(newQueue(findPrs("acme/aidenhq#7").map((p) => ({ ...p, head: "head7" })), { gapMinutes: 0, now: at(0) }), { strict: true });
    const gh = fakeGithub(draft());
    const q = card();
    await advance(q, { github: gh, now: at(0), cardIsReview: ownRepo });
    assert.deepEqual(gh.writes, [{ ready: "PR_7" }]);
    await advance(q, { github: gh, now: at(1), cardIsReview: ownRepo });
    assert.equal(gh.writes.length, 1, "checks still running: no merge yet");
    gh.prs[7] = { ...gh.prs[7], commits: { nodes: [{ commit: { statusCheckRollup: green } }] } };
    await advance(q, { github: gh, now: at(2), cardIsReview: ownRepo });
    assert.deepEqual(gh.writes.at(-1), { merge: 7, sha: "head7", method: "squash" });
    const old = fakeGithub(draft());
    assert.equal((await advance(card(), { github: old, now: at(0), cardIsReview: (repo) => repo.startsWith("acme-agents/") })).done, "stopped", "the old predicate");
    assert.equal(old.writes.length, 0);
  });

  it("marks an approved draft ready, then merges it", async () => {
    const gh = fakeGithub({ 1: pr(1, { isDraft: true }) });
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ ready: "PR_1" }]);
    await advance(q, { github: gh, now: at(1) });
    assert.deepEqual(gh.writes.at(-1), { merge: 1, sha: "head1", method: "squash" });
  });

  it("gives up on a PR whose checks never finish", async () => {
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } }) });
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    assert.equal((await advance(q, { github: gh, now: at(0), timeoutMinutes: 30 })).done, undefined);
    assert.equal((await advance(q, { github: gh, now: at(20), timeoutMinutes: 30 })).done, undefined);
    const step = await advance(q, { github: gh, now: at(31), timeoutMinutes: 30 });
    assert.equal(step.done, "stopped");
    assert.match(step.queue.reason, /stuck for 30 minutes: #1's checks are running/);
  });

  it("stops with GitHub's words when a merge is refused", async () => {
    const gh = fakeGithub({ 1: pr(1) });
    gh.merge = async () => {
      throw Object.assign(new Error("failed"), { stderr: "gh: Head branch was modified. Review and try the merge again. (HTTP 409)" });
    };
    const step = await advance(newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) }), { github: gh, now: at(0) });
    assert.match(step.queue.reason, /GitHub refused to merge #1: .*Head branch was modified/);
  });
});

describe("finishedStatus", () => {
  const agentPart = { parentId: "p", createdByAgentId: "a", createdByUserId: null };
  const ownerTask = { parentId: null, createdByAgentId: null, createdByUserId: "u" };
  const prs = [{ repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1", status: "merged" }];
  it("closes an agent's sub-task once every PR merged; the owner's tasks and stopped queues stay in review", () => {
    assert.equal(finishedStatus(agentPart, { state: "done", prs }), "done");
    assert.equal(finishedStatus(agentPart, { state: "stopped", prs }), "in_review");
    assert.equal(finishedStatus(ownerTask, { state: "done", prs }), "in_review");
    assert.equal(finishedStatus(undefined, { state: "done", prs }), "in_review");
    // Its own PRs in the queue count as landed; another one still open keeps it for review.
    assert.equal(finishedStatus(agentPart, { state: "done", prs }, ["https://github.com/O/R/pull/1"]), "done");
    assert.equal(finishedStatus(agentPart, { state: "done", prs }, ["https://github.com/o/r/pull/2"]), "in_review");
  });
});

describe("a merge the AI reviewer approved", () => {
  it("needs named checks, all passed: no checks is not green", () => {
    const none = pr(7, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });
    assert.equal(prDecision(none).do, "merge", "the owner's merges: unchanged");
    // CI may not have started yet on a just-pushed head: never merged, waited for ten minutes at most.
    assert.deepEqual([prDecision(none, { strictChecks: true }).do, prDecision(none, { strictChecks: true }).limit], ["wait", 10]);
    assert.equal(prDecision(pr(8), { strictChecks: true }).do, "merge");
  });
});

describe("design review is advisory (owner, 2026-11-12)", () => {
  it("merges with design-review pending or failed once the other checks are green, and still waits for those", () => {
    const withDesign = (state, build = "SUCCESS") => ({
      state: state === "SUCCESS" && build === "SUCCESS" ? "SUCCESS" : state === "FAILURE" ? "FAILURE" : "PENDING",
      contexts: { nodes: [{ __typename: "CheckRun", name: "tests", status: build === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: build === "PENDING" ? null : build }, { __typename: "StatusContext", context: "design-review", state }] },
    });
    const head = (rollup) => pr(9, { mergeStateStatus: "UNSTABLE", commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } });
    assert.equal(prDecision(head(withDesign("PENDING")), { strictChecks: true }).do, "merge");
    assert.equal(prDecision(head(withDesign("FAILURE")), { strictChecks: true }).do, "merge");
    assert.equal(prDecision(head(withDesign("PENDING", "PENDING")), { strictChecks: true }).do, "wait");
    assert.equal(prDecision(head(withDesign("PENDING", "FAILURE")), { strictChecks: true }).do, "stop");
    assert.equal(prDecision(pr(10, { mergeStateStatus: "UNSTABLE" })).do, "stop", "UNSTABLE without design-review: as before");
  });
});

describe("awaitChecks", () => {
  it("waits for checks that appear after the first read, so the merge is Tier 0 rather than 'no named checks'", async () => {
    const state = (checks) => [{ repo: "acme-agents/roadmap", number: 3, files: ["src/a.ts"], checks, headMatches: true, ownHead: true, sensitive: false }];
    const reads = [state([]), state([]), state([{ name: "test", ok: true }])];
    let sleeps = 0;
    const prs = await awaitChecks(async () => reads.shift(), { every: 1, until: 100, sleep: async () => void sleeps++ });
    assert.equal(sleeps, 2);
    assert.equal(prs[0].checks.length, 1);
    const tier = (prs) => classify("merge", { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", requester: { platform: false }, taskStatus: "in_progress", prs }).tier;
    assert.equal(tier(prs), 0);
    assert.equal(tier(await awaitChecks(async () => state([]), { every: 1, until: 3, sleep: async () => {} })), 2, "gives up after the limit with whatever is there");
  });
});

describe("independent merges: Tier 0 in the agents org (owner, 2026-11-12)", () => {
  // Bound to each PR's head; no reviews on GitHub, and a red base doesn't matter.
  const own = (n, over = {}) => pr(n, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] }, baseRef: { target: { oid: "base", statusCheckRollup: red } }, ...over });
  const head = (rollup, extra = {}) => ({ commits: { nodes: [{ commit: { ...extra, statusCheckRollup: rollup } }] } });
  const queue = (...nums) => addEach(undefined, findPrs(nums.map((n) => `o/r#${n}`).join(" ")).map((p) => ({ ...p, head: `head${p.number}` })), { now: at(0) });

  it("merges every green PR in the same poll, without waiting for the base branch or each other", async () => {
    const gh = fakeGithub({ 1: own(1), 2: own(2) });
    const step = await advance(queue(1, 2), { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ merge: 1, sha: "head1", method: "squash" }, { merge: 2, sha: "head2", method: "squash" }]);
    assert.equal(step.done, "done");
    assert.match(step.say[0], /^Merged https:\/\/github.com\/o\/r\/pull\/1\.\nMerged https:\/\/github.com\/o\/r\/pull\/2\.$/);
  });

  it("a PR stacked on a merged parent is retargeted and sent back to tiering, never merged into the old base", async () => {
    const merged = [{ state: "MERGED", headRefOid: "tip", isCrossRepository: false }];
    const gh = fakeGithub({ 1: own(1, { baseRefName: "feat/a" }) }, {}, { "feat/a": { tip: "tip", merged } });
    const step = await advance(queue(1), { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ retarget: 1, base: "master" }]);
    assert.deepEqual(step.retier.map((r) => r.number), [1]);
  });

  it("never retargets a plain branch, a branch that moved on, or a fork's merged PR: it waits", async () => {
    const m = (over) => [{ state: "MERGED", headRefOid: "tip", isCrossRepository: false, ...over }];
    for (const base of [{}, { tip: "other", merged: m() }, { tip: "tip", merged: m({ isCrossRepository: true }) }, { overflow: true, merged: m() }]) {
      const gh = fakeGithub({ 1: own(1, { baseRefName: "feat/a" }) }, {}, { "feat/a": base });
      const step = await advance(queue(1), { github: gh, now: at(0) });
      assert.deepEqual(gh.writes, []);
      assert.deepEqual(step.retier, []);
    }
  });

  it("deletes a merged head only while it's still at the merged head with no open PR based on it", async () => {
    for (const [base, deleted] of [[{ tip: "head1" }, true], [{ tip: "moved" }, false], [{ tip: "head1", stacked: true }, false]]) {
      const gh = fakeGithub({ 1: own(1, { headRefName: "feat/b" }) }, {}, { "feat/b": base });
      await advance(queue(1), { github: gh, now: at(0) });
      assert.deepEqual(gh.writes, [{ merge: 1, sha: "head1", method: "squash" }, ...(deleted ? [{ deleted: "feat/b" }] : [])]);
    }
  });

  it("a PR stacked on a still-open parent waits and is not merged", async () => {
    const gh = fakeGithub({ 1: own(1, { baseRefName: "feat/a" }) }, {}, { "feat/a": { open: true } });
    const q = queue(1);
    await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, []);
    assert.equal(q.prs[0].status, "pending");
  });

  it("a failing PR is reported once and left; the others still merge", async () => {
    const gh = fakeGithub({ 1: own(1, head(red)), 2: own(2, head(pending)) });
    const q = queue(1, 2);
    let step = await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(step.say, ["**Not merged:** https://github.com/o/r/pull/1: buildkite/deploy failed."]);
    assert.equal(step.done, undefined);
    assert.deepEqual(await advance(q, { github: gh, now: at(1) }).then((s) => s.say), [], "said once");
    gh.prs[2] = own(2);
    step = await advance(q, { github: gh, now: at(4) });
    assert.deepEqual(gh.writes, [{ merge: 2, sha: "head2", method: "squash" }]);
    assert.equal(step.done, "stopped");
    assert.match(step.say.at(-1), /1 merged, 1 not/);
  });

  it("a conflict is updated once; the updated head goes back through tiering, any other new head waits", async () => {
    const gh = fakeGithub({ 1: own(1, { mergeStateStatus: "DIRTY" }) });
    const q = queue(1);
    await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ update: 1, head: "head1" }]);
    gh.prs[1] = own(1, { mergeStateStatus: "DIRTY" }); // GitHub hasn't moved the head yet: wait, not "conflicts"
    await advance(q, { github: gh, now: at(0) });
    assert.equal(q.prs[0].status, "pending");
    const update = { parents: { nodes: [{ oid: "head1" }, { oid: "base" }] }, signature: { wasSignedByGitHub: true } };
    // Even GitHub's own update commit is re-tiered: a web-editor conflict fix is signed the same way, so its parents prove nothing.
    gh.prs[1] = own(1, { headRefOid: "upd1", ...head(green, update) });
    const s1 = await advance(q, { github: gh, now: at(1) });
    assert.deepEqual(s1.retier, [{ repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1" }]);
    assert.equal(gh.writes.length, 1, "never merged under this request");

    // Someone's commit on top of the bound head: never merged under this request.
    const other = fakeGithub({ 1: own(1, { headRefOid: "x1", ...head(green, { parents: { nodes: [{ oid: "head1" }] }, signature: null }) }) });
    assert.equal((await advance(queue(1), { github: other, now: at(0) })).done, undefined);
    assert.equal(other.writes.length, 0);
    // After an update, a GitHub-signed merge of anything but the base's current tip goes back to tiering.
    const q2 = queue(1, 2);
    q2.prs[0].updatedHead = "head1";
    const odd = fakeGithub({ 1: own(1, { headRefOid: "upd1", ...head(green, { ...update, parents: { nodes: [{ oid: "head1" }, { oid: "elsewhere" }] } }) }), 2: own(2, head(pending)) });
    const s2 = await advance(q2, { github: odd, now: at(0) });
    assert.deepEqual(s2.retier, [{ repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1" }]);
    assert.deepEqual(q2.prs.map((p) => p.number), [2], "out of this queue");
    assert.equal(odd.writes.length, 0);
    // A conflict the update can't resolve: reported, not retried.
    const stuck = fakeGithub({ 1: own(1, { mergeStateStatus: "DIRTY" }) });
    stuck.updateBranch = async () => {
      throw Object.assign(new Error("failed"), { stderr: "gh: merge conflict between base and head (HTTP 422)" });
    };
    const s3 = await advance(queue(1), { github: stuck, now: at(0) });
    assert.match(s3.say[0], /conflicts with `master` that an update can't resolve/);
    assert.match(s3.say.at(-1), /0 merged, 1 not/);
  });

  it("a new request joins the running queue; a failed PR asked for again takes its new head", () => {
    const q = queue(1, 2);
    Object.assign(q.prs[0], { status: "merged" });
    Object.assign(q.prs[1], { status: "failed", note: "tests failed" });
    const next = addEach(q, [{ repo: "o/r", number: 2, url: "u2", head: "new2" }, { repo: "o/r", number: 3, url: "u3", head: "head3" }]);
    assert.deepEqual(next.prs.map((p) => [p.number, p.status, p.head]), [[1, "merged", "head1"], [2, "pending", "new2"], [3, "pending", "head3"]]);
    assert.equal(addEach(q, [{ repo: "o/r", number: 1, url: "u1", head: "x" }]), undefined, "merged already");
    // A finished queue's merges carry over, so the next queue's finish still accounts for them.
    const after = addEach({ ...q, state: "done", held: ["said"] }, [{ repo: "o/r", number: 3, url: "u3", head: "head3" }]);
    assert.deepEqual(after.prs.map((p) => [p.number, p.status]), [[1, "merged"], [2, "failed"], [3, "pending"]]);
  });

  it("merges only on GitHub's green: UNSTABLE only from advisory checks, and never past a page of checks", () => {
    const p = { head: "head1" };
    const rollup = (state, nodes) => head({ state, contexts: { nodes } });
    const build = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
    const design = { __typename: "StatusContext", context: "design-review", state: "FAILURE" };
    const other = { __typename: "StatusContext", context: "codecov", state: "FAILURE" };
    assert.equal(eachDecision(own(1, { mergeStateStatus: "UNSTABLE", ...rollup("FAILURE", [build, design]) }), p).do, "merge");
    assert.equal(eachDecision(own(1, { mergeStateStatus: "UNSTABLE", ...rollup("FAILURE", [build, other]) }), p).do, "fail");
    assert.equal(eachDecision(own(1, { mergeStateStatus: "UNSTABLE", ...rollup("SUCCESS", [build]) }), p).do, "fail", "GitHub sees a non-green check we don't");
    assert.equal(eachDecision(own(1, { mergeStateStatus: "CLEAN", ...rollup("PENDING", [build]) }), p).do, "wait", "the rollup itself must be green");
    const paged = own(1, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: true }, nodes: [build] } } } }] } });
    assert.equal(eachDecision(paged, p).do, "fail");
  });
});

describe("aidenhq close", () => {
  const state = { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", taskStatus: "in_progress" };

  it("is Tier 0 in the agents org, refused elsewhere, and comments the reason before closing", async () => {
    const tier = (repo) => classify("close", { ...state, prs: [{ repo }] });
    assert.equal(tier("acme-agents/roadmap-keeper").tier, 0);
    assert.equal(tier("other-org/x").reject, true, "outside the agents org");
    assert.equal(tier("acme/aidenhq").reject, true, "product repo");
    assert.equal(tier("acme-agents/aidenhq-instance").reject, true, "instance repo");

    const calls = [];
    const github = { comment: async (repo, n, body) => calls.push(["comment", n, body]), close: async (repo, n) => calls.push(["close", n]) };
    const lines = await closePrs(findPrs("acme-agents/roadmap-keeper#5"), "superseded by #6", github);
    assert.deepEqual(calls, [["comment", 5, "superseded by #6"], ["close", 5]]);
    assert.deepEqual(lines, ["Closed https://github.com/acme-agents/roadmap-keeper/pull/5: superseded by #6"]);
  });
});
