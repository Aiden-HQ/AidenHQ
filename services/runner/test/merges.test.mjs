import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { classify } from "../src/tiers.mjs";
import { finishedStatus } from "../src/agents.mjs";
import { advance, allowedWrite, closePrs, awaitChecks, codeReviewInfra, designReviewMarker, eachDecision, environmentFailure, environmentalChecks, environmentReceipt, jobFor, prDecision, supersededDesignReview, touchesUi, WRITES, withGate, ciState, namedChecks } from "../../../modules/codehost-github/src/merge-gate.mjs";
import { addEach, findPrs, newQueue, startOrResume } from "../../../modules/engineering/src/merge-queue.mjs";
import { prAttention } from "../../../modules/engineering/src/product-prs.ts";

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
    // The reviewer-eval gate (evalgate.ts): no reviewer code in these PRs, so it never holds a merge.
    async evalGate() {
      return undefined;
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
    // Re-runs: kept outside any queue, as the runner keeps them in its state. `reviewComments`: the code-review gate's comment by PR.
    reran: {},
    reviewComments: {},
    // A check's job by name: `jobs` answers { steps, annotations }, as GitHub's REST read of a job and its annotations does.
    jobs: {},
    async job(repo, check) {
      return this.jobs[check.name] ?? { steps: [{ name: "Run tests" }], annotations: [] };
    },
    reruns(repo, number) {
      return this.reran[number] ?? {};
    },
    async rerun(repo, number, { run, checks, head, whole }) {
      if (this.refuseRerun) throw new Error("gh: Resource not accessible by integration (HTTP 403)");
      writes.push({ rerun: run, checks: checks.map((c) => c.name), ...(whole ? { whole } : {}) });
      this.reran[number] = { ...this.reran[number], ...Object.fromEntries(checks.map((c) => [c.name, { head, id: c.id }])) };
    },
    // A workflow run's { status, updatedAt } by id: `runs`.
    runs: {},
    async run(repo, run) {
      return this.runs[run] ?? { status: "in_progress", updatedAt: at(0).toISOString() };
    },
    async codeReviewInfra(repo, number, head) {
      return codeReviewInfra(this.reviewComments[number], head);
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

  // WOR-4611 (2026-11-14): two merge cards on one task; the second card's queue replaced the first, so #141 never merged.
  it("a second approved merge on a running queue keeps the PRs still waiting", () => {
    const q = newQueue(findPrs("o/a#141"), { gapMinutes: 5, now: at(0) });
    const both = startOrResume(q, findPrs("o/b#2"), {});
    assert.deepEqual(both.prs.map((p) => [p.repo, p.number, p.status]), [["o/a", 141, "pending"], ["o/b", 2, "pending"]]);
    assert.equal(startOrResume({ ...q, strict: true }, findPrs("o/b#2"), {}).strict, true); // its gating comes along
    assert.deepEqual(startOrResume({ ...q, independent: true }, findPrs("o/b#2"), {}).prs.map((p) => p.number), [2]); // re-requested by the caller
  });

  // 2026-11-14: a replay card re-named a PR already waiting behind two others; it was appended last, so its merge waited
  // on PRs it had been ahead of (the flow test timed out 15 minutes apart). It keeps its place, at the head the card binds.
  it("a card that re-names a waiting PR keeps its place, at its new head", () => {
    const q = newQueue(findPrs("o/r#1 o/r#2 o/r#3"), { gapMinutes: 15, now: at(0) });
    q.prs[0].head = "old";
    const again = startOrResume(q, [{ ...findPrs("o/r#1")[0], head: "replayed" }], {});
    assert.deepEqual(again.prs.map((p) => [p.number, p.status]), [[1, "pending"], [2, "pending"], [3, "pending"]]);
    assert.equal(again.prs[0].head, "replayed", "the card's head, not the queue's");
  });

  // roadmap-keeper#111 (2026-11-13): its first queue failed on a code-review timeout; asked again on an approved card, it
  // got "merged already" while the PR was still open. Only a merged (or merged-by-someone-else) PR is done.
  it("a PR that failed in an earlier queue is merged when asked for again", () => {
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    q.prs[0].status = "failed";
    q.state = "stopped";
    const again = startOrResume(q, findPrs("o/r#1"), {});
    assert.deepEqual(again.prs.map((p) => [p.number, p.status]), [[1, "pending"]]);
    q.prs[0].status = "skipped"; // someone else merged it
    assert.equal(startOrResume(q, findPrs("o/r#1"), {}), undefined);
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
    // A red base: the PR that fixes it merges when it contains the base's tip, is updated first when behind, else stops.
    const redBase = (behindBy) => pr(1, { baseRef: { compare: { behindBy }, target: { statusCheckRollup: red } } });
    assert.equal(prDecision(redBase(0)).do, "merge");
    assert.equal(prDecision(redBase(2)).do, "update");
    assert.equal(prDecision(redBase(undefined)).do, "stop");
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

  it("writes only merges, branch updates, closing a PR (comment, then state) and re-running a job", () => {
    assert.deepEqual(WRITES.map((w) => w.method), ["PUT", "PUT", "POST", "PATCH", "DELETE", "POST", "POST", "POST"]);
    assert.ok(WRITES.some((w) => w.path.test("repos/o/r/actions/runs/7/rerun-failed-jobs")));
    assert.ok(WRITES.some((w) => w.path.test("repos/o/r/actions/runs/7/rerun")), "a whole run re-runs only for a ghost (ghostRetry), its one call site");
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/actions/runs/7/cancel") || w.path.test("repos/o/r/actions/runs/7/rerun/x")), "nothing else of a run");
    assert.ok(WRITES.some((w) => w.path.test("repos/o/r/pulls/1/merge")));
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/pulls/1/reviews")));
    assert.ok(WRITES.some((w) => w.method === "DELETE" && w.path.test("repos/o/r/git/refs/heads/feat/x")));
    assert.ok(!WRITES.some((w) => w.method !== "DELETE" && w.path.test("repos/o/r/git/refs/heads/master")));
    // The design review's wait: one status on a commit, never a whole-ref or check-run write.
    assert.ok(WRITES.some((w) => w.method === "POST" && w.path.test("repos/o/r/statuses/0123456789abcdef0123456789abcdef01234567")));
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/check-runs") || w.path.test("repos/o/r/statuses/not-a-sha")));
  });

  it("comments, PR edits and branch deletes only in the agents org; merges anywhere", () => {
    assert.ok(allowedWrite("PUT", "repos/acme/app/pulls/1/merge", "acme-agents"));
    assert.ok(allowedWrite("DELETE", "repos/Acme-Agents/app/git/refs/heads/feat/x", "acme-agents"));
    for (const [m, p] of [["POST", "repos/acme/app/issues/1/comments"], ["PATCH", "repos/acme/app/pulls/1"], ["DELETE", "repos/acme/app/git/refs/heads/feat/x"], ["POST", "repos/acme/app/actions/runs/7/rerun-failed-jobs"]]) {
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
  it("a three-level stack replays each PR from its parent's approved head, not the parent's replay", async () => {
    // A (merged) ← B ← C, one card. B is replayed onto master after A; C after B, from B's approved head.
    const prs = { 1: pr(1, { state: "MERGED", headRefName: "a", headRefOid: "headA" }), 2: pr(2, { headRefName: "b", baseRefName: "a", headRefOid: "headB" }), 3: pr(3, { headRefName: "c", baseRefName: "b", headRefOid: "headC" }) };
    const bases = { a: { tip: "headA", merged: [{ headRefOid: "headA", isCrossRepository: false }] } };
    const gh = fakeGithub(prs, { merge2: green }, bases);
    const from = [];
    gh.rebuild = async (repo, p, start) => {
      from.push([p.number, start]);
      prs[p.number] = { ...prs[p.number], headRefOid: `replayed${p.number}` };
      return `replayed${p.number}`;
    };
    const q = newQueue([1, 2, 3].map((n) => ({ ...findPrs(`o/r#${n}`)[0], head: `head${String.fromCharCode(64 + n)}` })), { gapMinutes: 0, now: at(0) });
    const cardIsReview = () => true;
    await advance(q, { github: gh, now: at(0), cardIsReview });
    await advance(q, { github: gh, now: at(1), cardIsReview });
    assert.deepEqual(gh.writes.find((w) => w.merge), { merge: 2, sha: "replayed2", method: "squash" });
    bases.b = { tip: "replayed2", merged: [{ headRefOid: "replayed2", isCrossRepository: false }] };
    await advance(q, { github: gh, now: at(10), cardIsReview });
    await advance(q, { github: gh, now: at(11), cardIsReview });
    assert.deepEqual(from, [[2, "headA"], [3, "headB"]]);
    assert.equal(q.state, "running", q.reason);
  });

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
    assert.match(step.say[0], /CI failed on `master` after merging #1: buildkite\/deploy failed/);
    assert.match(step.say[0], /its failing checks are on GitHub/);
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

  it("reports a cancelled run on the merge commit as cancelled, never as a CI failure", async () => {
    // Nothing newer on master to judge, so the merge commit's own rollup stands: it is red only because its checks were
    // cancelled (someone cancelled the run, or a push superseded it and this read raced the tip), and a cancelled check
    // never judged the commit. The receipt says cancelled; it must not announce a red base.
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: cancelled });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI was cancelled on `master` after merging #1/);
    assert.match(step.say[0], /cancelled, so it never tested that commit/);
    assert.doesNotMatch(step.say[0], /CI failed/, "a cancelled run is not a red base");
  });

  it("reports a cancelled run whose only red check is the aggregate gate its cancelled jobs failed", async () => {
    // The shape after #152: ci-required fails because its dependencies were cancelled, and no job failed. The gate's own
    // failure is derived from a cancelled sibling, so there is no failed check to name and the base is not red.
    const gateOnly = { state: "FAILURE", contexts: { nodes: [
      { __typename: "CheckRun", name: "supply-chain", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "packages", status: "COMPLETED", conclusion: "CANCELLED" },
      { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "FAILURE" },
    ] } };
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: gateOnly });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI was cancelled on `master` after merging #1/);
    assert.doesNotMatch(step.say[0], /CI failed/);
  });

  it("a genuinely failed check is still reported, naming the check", async () => {
    // A cancelled job beside a real failure does not hide it: the failure is what stopped the base, and it is named.
    const mixed = { state: "FAILURE", contexts: { nodes: [
      { __typename: "CheckRun", name: "supply-chain", status: "COMPLETED", conclusion: "CANCELLED" },
      { __typename: "CheckRun", name: "runner-unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "packages", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "FAILURE" },
    ] } };
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: mixed });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI failed on `master` after merging #1: packages failed/);
    assert.match(step.say[0], /its failing checks are on GitHub/);
    assert.doesNotMatch(step.say[0], /cancelled/);
  });

  it("a green run on the merge commit says the base is green, with no failure wording", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(6) });
    assert.equal(step.done, undefined);
    assert.match(step.say[0], /`master` is green/);
    assert.doesNotMatch(step.say.join("\n"), /CI failed|cancelled/);
  });

  it("still stops on a real failure on the merge commit when the base moved on", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: red, tip: green }, { master: { tip: "tip" } });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI failed on `master` after merging #1: buildkite\/deploy failed/);
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

  it("names the check still running, then fails that PR at the bound instead of waiting forever", async () => {
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } }) });
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    const first = await advance(q, { github: gh, now: at(0), timeoutMinutes: 30 });
    assert.equal(first.done, undefined);
    assert.equal(first.queue.waiting, "#1's checks are running (still running: build)");
    assert.equal((await advance(q, { github: gh, now: at(20), timeoutMinutes: 30 })).done, undefined);
    const step = await advance(q, { github: gh, now: at(31), timeoutMinutes: 30 });
    assert.equal(step.done, "stopped");
    assert.equal(step.queue.prs[0].status, "failed");
    assert.equal(step.queue.reason, "stuck for 30 minutes: #1's checks are running (still running: build)");
    assert.match(step.say.join("\n"), /\*\*Not merged:\*\* https:\/\/github.com\/o\/r\/pull\/1: stuck for 30 minutes: #1's checks are running \(still running: build\)/);
  });

  it("a stuck head no longer holds the PRs behind it: the next one still merges", async () => {
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } }), 2: pr(2) });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0), timeoutMinutes: 30 });
    assert.equal(gh.writes.length, 0, "nothing merges while #1's check runs");
    const step = await advance(q, { github: gh, now: at(31), timeoutMinutes: 30 });
    assert.equal(q.prs[0].status, "failed");
    assert.deepEqual(gh.writes.at(-1), { merge: 2, sha: "head2", method: "squash" });
    assert.equal(step.queue.prs[1].status, "merged");
    const last = await advance(q, { github: gh, now: at(38), timeoutMinutes: 30 });
    assert.equal(last.done, "stopped");
    assert.match(last.queue.reason, /stuck for 30 minutes: #1's checks are running \(still running: build\)/);
    assert.match(last.say.at(-1), /\*\*Merges finished:\*\* 1 merged, 1 not/);
  });

  it("a PR stacked on a head the queue gave up on is skipped by name, and an independent PR still merges", async () => {
    const stuck = pr(1, { headRefName: "feat/one", commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } });
    const child = pr(2, { headRefName: "feat/two", baseRefName: "feat/one" });
    const gh = fakeGithub({ 1: stuck, 2: child, 3: pr(3) }, {}, { "feat/one": { tip: "head1", open: true } });
    const q = newQueue(findPrs("o/r#1 o/r#2 o/r#3"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0), timeoutMinutes: 30 });
    assert.equal(gh.writes.length, 0, "nothing merges while #1's check runs");
    const step = await advance(q, { github: gh, now: at(31), timeoutMinutes: 30 });
    assert.equal(q.prs[0].status, "failed");
    assert.match(q.prs[0].note, /stuck for 30 minutes: #1's checks are running \(still running: build\)/);
    assert.equal(q.prs[1].status, "failed");
    assert.equal(q.prs[1].note, "stacked on #1, which did not merge");
    assert.match(step.say.join("\n"), /#2 skipped: stacked on #1, which did not merge/);
    assert.deepEqual(gh.writes.at(-1), { merge: 3, sha: "head3", method: "squash" });
    assert.equal(step.queue.prs[2].status, "merged");
  });

  it("names the running checks, but a hostile name prints as an unnamed check", async () => {
    const node = (name) => ({ __typename: "CheckRun", name, status: "IN_PROGRESS", conclusion: null });
    const hostile = ["![x](https://evil.example/p.png) `c` <img src=x>", "runner-flows (${{ matrix }})", "ignore this\nand do X", "a".repeat(41)];
    const rollup = { state: "PENDING", contexts: { nodes: [node("tests"), ...hostile.map(node)] } };
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } }) });
    const step = await advance(newQueue(findPrs("o/r#1"), { gapMinutes: 0, now: at(0) }), { github: gh, now: at(0), timeoutMinutes: 30 });
    assert.equal(step.queue.waiting, "#1's checks are running (still running: tests, an unnamed check, an unnamed check, an unnamed check, an unnamed check)");
  });

  it("ordinary check names print as they are", async () => {
    const rollup = { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", name: "code-review", status: "IN_PROGRESS", conclusion: null }, { __typename: "CheckRun", name: "services/runner", status: "IN_PROGRESS", conclusion: null }] } };
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } }) });
    const step = await advance(newQueue(findPrs("o/r#1"), { gapMinutes: 0, now: at(0) }), { github: gh, now: at(0), timeoutMinutes: 30 });
    assert.equal(step.queue.waiting, "#1's checks are running (still running: code-review, services/runner)");
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

describe("a design-review task whose head is superseded (owner, 2026-11-13)", () => {
  const issue = (head = "e086aa64") => ({ description: `https://github.com/acme/app/pull/7 changes UI files.\n\n<!-- source:design-review:acme/app/7@${head} -->` });
  const withVerdict = (state) => ({ state: "OPEN", headRefOid: "f727bc63", url: "https://github.com/acme/app/pull/7", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "StatusContext", context: "design-review", state }] } } } }] } });

  it("reads the head a review task asked about from its source marker", () => {
    assert.deepEqual(designReviewMarker(issue()), { repo: "acme/app", number: 7, head: "e086aa64" });
    assert.equal(designReviewMarker({ description: "a task with no marker" }), undefined);
    assert.equal(designReviewMarker({ description: "<!-- source:dependabot:acme/app/7 -->" }), undefined);
  });

  it("closes the earlier head's task once the PR has moved on, rather than leaving it to the owner", () => {
    assert.equal(supersededDesignReview(designReviewMarker(issue()), { state: "OPEN", headRefOid: "e086aa64" }), undefined, "the current head, no verdict: still the live review");
    assert.match(supersededDesignReview(designReviewMarker(issue()), withVerdict("PENDING")), /moved on to head `f727bc63`/);
    assert.equal(supersededDesignReview(designReviewMarker(issue("f727bc63")), { state: "MERGED", headRefOid: "f727bc63" }), "its PR merged");
    assert.equal(supersededDesignReview(designReviewMarker(issue("f727bc63")), { state: "CLOSED", headRefOid: "f727bc63" }), "its PR was closed");
    assert.equal(supersededDesignReview(designReviewMarker(issue()), undefined), undefined, "a PR the runner can't read is never closed");
  });

  it("closes a task whose verdict is already on its exact head, which nothing is waiting on", () => {
    const at = (state) => supersededDesignReview(designReviewMarker(issue("f727bc63")), withVerdict(state));
    assert.equal(at("FAILURE"), "its verdict is on that head already");
    assert.equal(at("SUCCESS"), "its verdict is on that head already");
    assert.equal(at("PENDING"), undefined, "still reviewing: the task stays open");
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

  it("a PR its checks kept from merging is reported in fixes, with its head, so the task's Engineer is woken", async () => {
    const failing = { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "FAILURE" }] } };
    const gh = fakeGithub({ 1: own(1, head(failing)), 2: own(2) });
    const step = await advance(queue(1, 2), { github: gh, now: at(0) });
    assert.deepEqual(step.fixes.map((f) => [f.number, f.head]), [[1, "head1"]]);
    assert.equal(step.fixes[0].number, 1);
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
    assert.deepEqual(step.say, ["**Not merged:** https://github.com/o/r/pull/1: 1 named check(s) failed on its head (`gh pr checks 1` names them)."]);
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

  // Aiden-HQ/AidenHQ#141, roadmap-keeper#214: a job stayed in_progress for an hour after its workflow run completed.
  it("a check still pending an hour after its workflow run is over is re-run once, never counted as passed, and merges once green", async () => {
    const H = "c0de".repeat(10);
    const run = (name, conclusion, databaseId, wf = 100) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: wf } } });
    const state = (nodes) => head({ state: nodes.some((x) => !x.conclusion) ? "PENDING" : "SUCCESS", contexts: { nodes } });
    const pr1 = (nodes) => own(1, { headRefOid: H, mergeStateStatus: nodes.some((x) => !x.conclusion) ? "UNSTABLE" : "CLEAN", ...state(nodes) });
    const tests = run("tests", "SUCCESS", 1);
    const gh = fakeGithub({ 1: pr1([tests, run("image-changes", null, 10)]) });
    const q = addEach(undefined, [{ repo: "o/r", number: 1, url: "u1", head: H }], { now: at(0) });
    // A run still going is not a ghost; one over for only a few minutes isn't yet.
    await advance(q, { github: gh, now: at(0) });
    gh.runs[100] = { status: "completed", updatedAt: at(0).toISOString() };
    await advance(q, { github: gh, now: at(5) });
    assert.deepEqual(gh.writes, []);
    // Over for more than ten minutes: its run is re-run, once.
    await advance(q, { github: gh, now: at(11) });
    assert.deepEqual(gh.writes, [{ rerun: 100, checks: ["image-changes"], whole: true }], "the whole run: the ghost job is not a failed one");
    await advance(q, { github: gh, now: at(15) });
    assert.equal(gh.writes.length, 1, "once per head, and the old job still reads in progress: never merged");
    assert.equal(q.state, "running");
    gh.prs[1] = pr1([tests, run("image-changes", "SUCCESS", 11)]);
    await advance(q, { github: gh, now: at(20) });
    assert.equal(gh.writes.at(-1).merge, 1);
    assert.equal(q.prs[0].status, "merged");
  });

  // roadmap-keeper#111 (2026-11-13): its merge failed on a code-review timeout and sat until someone re-ran the check.
  it("a check that failed for infrastructure reasons is re-run once; a second failure, or a real reject, is final", async () => {
    const H = "c0de".repeat(10);
    const run = (name, conclusion, databaseId, wf = 100) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: wf } } });
    const at1 = (n, nodes, mk = own) => {
      const state = nodes.some((x) => x.conclusion && x.conclusion !== "SUCCESS") ? "FAILURE" : nodes.some((x) => !x.conclusion) ? "PENDING" : "SUCCESS";
      return mk(n, { headRefOid: H, mergeStateStatus: state === "SUCCESS" ? "CLEAN" : "UNSTABLE", ...head({ state, contexts: { nodes } }) });
    };
    const tests = run("tests", "SUCCESS", 1);
    const timedOut = `<!-- ci:code-review -->\n**Code review failed on \`${H.slice(0, 7)}\`** (codegenie exit 1: request timed out). See the job log, fix the cause and re-run the check.`;
    const each = () => addEach(undefined, [{ repo: "o/r", number: 1, url: "u1", head: H }], { now: at(0) });

    // Independent queue: code-review's own "failed" verdict is re-run; the poll that still sees the old job waits; failing again is final.
    const gh = fakeGithub({ 1: at1(1, [tests, run("code-review", "FAILURE", 10)]) });
    gh.reviewComments[1] = timedOut;
    const q = each();
    await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ rerun: 100, checks: ["code-review"] }]);
    await advance(q, { github: gh, now: at(1) });
    assert.equal(q.prs[0].status, "pending", "the old job, its re-run not on GitHub yet");
    gh.prs[1] = at1(1, [tests, run("code-review", null, 11)]);
    await advance(q, { github: gh, now: at(2) });
    gh.prs[1] = at1(1, [tests, run("code-review", "FAILURE", 11)]);
    const step = await advance(q, { github: gh, now: at(9) });
    assert.match(step.say[0], /Not merged:.*1 named check\(s\) failed on its head/);
    assert.equal(gh.writes.length, 1, "re-run once");

    // A real reject (blocking findings) fails at once; so does a re-run GitHub refuses, and the next queue on that head tries again.
    const real = fakeGithub({ 1: at1(1, [tests, run("code-review", "FAILURE", 10)]) });
    real.reviewComments[1] = `<!-- ci:code-review -->\n\n**Code review: 1 blocking finding on \`${H.slice(0, 7)}\`.** Fix these before merging.`;
    assert.match((await advance(each(), { github: real, now: at(0) })).say[0], /Not merged/);
    assert.deepEqual(real.writes, []);
    const refused = fakeGithub({ 1: at1(1, [tests, run("code-review", "FAILURE", 10)]) });
    Object.assign(refused, { refuseRerun: true, reviewComments: { 1: timedOut } });
    assert.match((await advance(each(), { github: refused, now: at(0) })).say[0], /Not merged:.*1 named check\(s\) failed on its head/);
    refused.refuseRerun = false;
    await advance(each(), { github: refused, now: at(1) });
    assert.deepEqual(refused.writes, [{ rerun: 100, checks: ["code-review"] }]);

    // A card's queue: a cancelled workflow run (both its red jobs) is re-run in one call, and the PR merges once it's green.
    const card = fakeGithub({ 2: at1(2, [tests, run("image-scan", "CANCELLED", 20, 200), run("lint", "CANCELLED", 22, 200)], pr) });
    const cq = newQueue([{ repo: "o/r", number: 2, url: "u2", head: H }], { gapMinutes: 0, now: at(0) });
    await advance(cq, { github: card, now: at(0) });
    assert.equal(cq.state, "running");
    assert.deepEqual(card.writes, [{ rerun: 200, checks: ["image-scan", "lint"] }]);
    card.prs[2] = at1(2, [tests, run("image-scan", "SUCCESS", 21, 200), run("lint", "SUCCESS", 23, 200)], pr);
    await advance(cq, { github: card, now: at(3) });
    assert.deepEqual(card.writes.at(-1), { merge: 2, sha: H, method: "squash" });
  });

  // A job GitHub refused to start (billing, a spending limit) is the environment's, not the commit's: it is re-run once at the
  // same head, then reported with GitHub's annotation, and the head never moves.
  it("a check that never started is environmental, not a failure: re-run once at the head, then reported, never rebased", async () => {
    const H = "ab12".repeat(10);
    const billing = "The job was not started because recent account payments have failed or your spending limit needs to be increased.";
    const run = (name, conclusion, databaseId, wf = 100) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: wf } } });
    const rolled = (nodes) => head({ state: nodes.some((c) => c.conclusion === "FAILURE") ? "FAILURE" : "SUCCESS", contexts: { nodes } });
    const prAt = (n, nodes) => own(n, { headRefOid: H, mergeStateStatus: "UNSTABLE", ...rolled(nodes) });
    const green = run("services/runner", "SUCCESS", 1);
    const each = () => addEach(undefined, [{ repo: "o/r", number: 1, url: "u1", head: H }], { now: at(0) });

    // Every red check is a job with no steps and an infrastructure annotation: it is re-run at this head, no new head.
    const gh = fakeGithub({ 1: prAt(1, [green, run("image-scan", "FAILURE", 20, 200)]) });
    gh.jobs = { "image-scan": { steps: [], annotations: [{ annotation_level: "failure", message: billing }, { annotation_level: "notice", message: "The ubuntu-latest label will migrate" }] } };
    const q = each();
    const first = await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ rerun: 200, checks: ["image-scan"] }], "the failed job, at the same head");
    assert.deepEqual(first.fixes, [], "no fix asked of the Engineer");
    assert.equal(q.prs[0].status, "pending", "still waiting, not failed");
    assert.equal(q.prs[0].head, H, "the head never moved");
    assert.equal(first.done, undefined);

    // The new job never started either: the second identical cause is final, reported once with the annotation and no code ask.
    gh.prs[1] = prAt(1, [green, run("image-scan", "FAILURE", 21, 200)]);
    const step = await advance(q, { github: gh, now: at(1) });
    assert.equal(step.done, "stopped");
    assert.equal(q.prs[0].status, "failed");
    assert.match(q.prs[0].note, /blocked by the environment: image-scan never started/);
    assert.doesNotMatch(q.prs[0].note, /named check|failed check/, "never read as a failing check");
    const said = step.say.join("\n");
    assert.match(said, /`image-scan` never started/);
    assert.match(said, /head is not at fault/);
    assert.match(said, /spending limit needs to be increased/, "GitHub's annotation, quoted");
    assert.match(said, /rebase or a new head would change nothing/);
    assert.doesNotMatch(said, /has failing checks|named check\(s\) failed/);
    assert.deepEqual(gh.writes, [{ rerun: 200, checks: ["image-scan"] }], "no second re-run, no merge, no push");
    assert.equal(q.prs[0].head, H);
    // Polling the same head again says nothing more and asks for nothing.
    const again = await advance(q, { github: gh, now: at(5) });
    assert.deepEqual(again.say, []);

    // A job that ran a step is a real failure, as before: reported to the Engineer, not re-run.
    const real = fakeGithub({ 1: prAt(1, [green, run("image-scan", "FAILURE", 30, 300)]) });
    real.jobs = { "image-scan": { steps: [{ name: "Build and scan" }], annotations: [{ annotation_level: "failure", message: "fixable high or critical vulnerabilities" }] } };
    const rstep = await advance(each(), { github: real, now: at(0) });
    assert.deepEqual(real.writes, []);
    assert.equal(rstep.fixes.length, 1);
    assert.match(rstep.say[0], /named check\(s\) failed on its head/);

    // The gate's own roll-up doesn't make it environmental: it only rolls up the check beneath it.
    const gated = fakeGithub({ 1: prAt(1, [green, run("image-scan", "FAILURE", 40, 400), run("ci-required", "FAILURE", 41, 401)]) });
    gated.jobs = { "image-scan": { steps: [], annotations: [{ annotation_level: "failure", message: billing }] } };
    const g1 = await advance(each(), { github: gated, now: at(0) });
    assert.deepEqual(gated.writes, [{ rerun: 400, checks: ["image-scan"] }], "only the job that never ran");
    assert.deepEqual(g1.fixes, []);
  });

  it("a check that never started is re-run once in a card queue too, and no head is published for it", async () => {
    const H = "cd34".repeat(10);
    const run = (name, conclusion, databaseId, wf = 100) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: wf } } });
    const nodes = [run("tests", "SUCCESS", 1), run("image-scan", "FAILURE", 20, 200)];
    const gh = fakeGithub({ 2: pr(2, { headRefOid: H, mergeStateStatus: "UNSTABLE", ...head({ state: "FAILURE", contexts: { nodes } }) }) });
    gh.jobs = { "image-scan": { steps: [], annotations: [{ annotation_level: "failure", message: "recent account payments have failed" }] } };
    const q = newQueue([{ repo: "o/r", number: 2, url: "u2", head: H }], { gapMinutes: 0, now: at(0) });
    const first = await advance(q, { github: gh, now: at(0) });
    assert.equal(q.state, "running", "waiting on its re-run");
    assert.deepEqual(gh.writes, [{ rerun: 200, checks: ["image-scan"] }], "re-run at the head the card approved");
    assert.doesNotMatch(first.say.join(""), /failing checks/);
    assert.equal(q.prs[0].head, H, "the approved head, unchanged");
    // The re-run never started again: one receipt, no merge, no second re-run, and the head still the card's.
    gh.prs[2] = pr(2, { headRefOid: H, mergeStateStatus: "UNSTABLE", ...head({ state: "FAILURE", contexts: { nodes: [run("tests", "SUCCESS", 1), run("image-scan", "FAILURE", 21, 200)] } }) });
    const second = await advance(q, { github: gh, now: at(1) });
    assert.equal(second.done, "stopped");
    assert.match(second.say.at(-1), /`image-scan` never started/);
    assert.match(second.say.at(-1), /head is not at fault/);
    assert.match(second.say.at(-1), /recent account payments have failed/, "GitHub's annotation");
    assert.doesNotMatch(second.say.at(-1), /has failing checks|named check\(s\) failed/);
    assert.deepEqual(gh.writes, [{ rerun: 200, checks: ["image-scan"] }]);
    assert.equal(q.prs[0].head, H);
  });

  it("the product watcher asks for a rebase only when the red checks are the commit's: never for one that never started", () => {
    const H = "ef56".repeat(10);
    const run = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
    const openPr = (nodes) => ({ mergeable: "MERGEABLE", headRefOid: H, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes } } } }] } });
    const green = { state: "SUCCESS", contexts: { nodes: [run("tests", "SUCCESS")] } };
    const env = [{ name: "image-scan", note: "The job was not started because recent account payments have failed" }];
    // A job that never started: re-run at this head, never a rebase — even though `ci-required` rolls it up red.
    assert.deepEqual(prAttention(openPr([run("tests", "SUCCESS"), run("image-scan", "FAILURE"), run("ci-required", "FAILURE")]), green, env), { do: "environment", checks: env });
    // A real failure beside it: a rebase, as before (the environment's checks are not what is red).
    assert.deepEqual(prAttention(openPr([run("tests", "FAILURE"), run("image-scan", "FAILURE")]), green, env), { do: "rebase", why: "red" });
    // Green: nothing.
    assert.equal(prAttention(openPr([run("tests", "SUCCESS")]), green, []), undefined);
    // Behind a red main, nothing either: the base is not known green.
    assert.equal(prAttention(openPr([run("tests", "FAILURE")]), { state: "FAILURE", contexts: { nodes: [] } }, []), undefined);
    // A conflict still asks for the rebase, environment or not.
    assert.deepEqual(prAttention({ ...openPr([]), mergeable: "CONFLICTING" }, green, env), { do: "rebase", why: "conflict" });
  });

  it("a check with a step run, or no annotation, is a real failure: only a job that never started with an infra note is environmental", async () => {
    const H = "0123".repeat(10);
    const check = { __typename: "CheckRun", name: "image-scan", status: "COMPLETED", conclusion: "FAILURE", databaseId: 20, checkSuite: { workflowRun: { databaseId: 200 } } };
    const p = { headRefOid: H, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [check] } } } }] } };
    const gh = (job) => ({ job: async () => job });
    // A check run's id is not its Actions job's: the run's own job listing links back to the check run, and that decides.
    assert.equal(jobFor([{ id: 900, name: "image-scan", check_run_url: "https://api.github.com/repos/o/r/check-runs/20" }], check)?.id, 900, "the job behind the check run");
    assert.equal(jobFor([{ id: 901, name: "image-scan", check_run_url: "https://api.github.com/repos/o/r/check-runs/21" }], check)?.id, 901, "name is the fallback when no link matches");
    assert.equal(jobFor([{ id: 902, name: "lint", check_run_url: "https://api.github.com/repos/o/r/check-runs/22" }], check), undefined, "no job for this check");
    assert.equal(jobFor([], check), undefined);
    assert.deepEqual(await environmentFailure(gh({ steps: [], annotations: [{ annotation_level: "failure", message: "billing" }] }), "o/r", p), [{ name: "image-scan", note: "billing", id: 20, run: 200 }]);
    assert.deepEqual(await environmentFailure(gh({ steps: [{ name: "Build" }], annotations: [{ annotation_level: "failure", message: "billing" }] }), "o/r", p), [], "a step ran: it judged the commit");
    assert.deepEqual(await environmentFailure(gh({ steps: [], annotations: [] }), "o/r", p), [], "no annotation: nothing says why");
    assert.deepEqual(await environmentFailure(gh({ steps: [], annotations: [{ annotation_level: "notice", message: "a label moves" }] }), "o/r", p), [], "a notice isn't a failure");
    assert.deepEqual(await environmentFailure({ job: async () => { throw new Error("404"); } }, "o/r", p), [], "unreadable is a failure of the code");
    // The receipt names the check and GitHub's annotation, says the head is fine, and asks for no code change.
    const receipt = environmentReceipt("#51", [{ name: "image-scan", note: "billing" }], H);
    assert.match(receipt, /blocked by the environment, not the code/i);
    assert.match(receipt, /`image-scan` never started/);
    assert.match(receipt, /head is not at fault/);
    assert.match(receipt, /"billing"/);
    assert.match(receipt, /rebase or a new head would change nothing/);
    assert.doesNotMatch(receipt, /fix the cause on the PR|rerun the tests/, "no code action");
  });

  // Owner, 2026-11-15: the breaker on identical failures counts the code's failures only. A red head's fix names the checks
  // that were the environment's (timed out, never started, a runner that died), and the breaker leaves them out.
  it("a red head's fix names its environmental checks for the breaker to leave out", async () => {
    const H = "4567".repeat(10);
    const run = (name, conclusion, databaseId) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: 100 + databaseId } } });
    const nodes = [run("tests", "FAILURE", 1), run("lint", "TIMED_OUT", 2), run("image-scan", "FAILURE", 3), run("build", "FAILURE", 4), run("ci-required", "FAILURE", 5), run("deploy", "FAILURE", 6), run("docs", "FAILURE", 7)];
    const gh = fakeGithub({ 1: own(1, { headRefOid: H, mergeStateStatus: "UNSTABLE", ...head({ state: "FAILURE", contexts: { nodes } }) }) });
    gh.jobs = {
      tests: { steps: [{ name: "Run tests" }], annotations: [{ annotation_level: "failure", message: "Process completed with exit code 1." }] },
      "image-scan": { steps: [], annotations: [{ annotation_level: "failure", message: "The job was not started because your spending limit needs to be increased." }] },
      build: { steps: [{ name: "Build", conclusion: null }], annotations: [{ annotation_level: "failure", message: "The self-hosted runner: ci-3 lost communication with the server. Verify the machine is running." }] },
      // A failing step that prints GitHub's words is still the code's failure: it can't dodge the breaker.
      deploy: { steps: [{ name: "Deploy", conclusion: "failure" }], annotations: [{ annotation_level: "failure", message: "The runner has received a shutdown signal." }] },
      docs: { steps: [{ name: "Docs", conclusion: null }], annotations: [{ annotation_level: "failure", message: "Error: The runner has received a shutdown signal." }] },
    };
    const step = await advance(addEach(undefined, [{ repo: "o/r", number: 1, url: "u1", head: H }], { now: at(0) }), { github: gh, now: at(0) });
    assert.equal(step.fixes.length, 1, "a real failure is beside them: the Engineer is still asked to fix it");
    assert.deepEqual(step.fixes[0].environment, [2, 3, 4], "check run ids; the gate stays: it also rolls up the real failures");
    // Only the environment's checks are red: the gate's roll-up is theirs too, so nothing is left for the breaker to count.
    const envOnly = own(2, { headRefOid: H, ...head({ state: "FAILURE", contexts: { nodes: nodes.slice(1, 5) } }) });
    assert.deepEqual(await environmentalChecks(gh, "o/r", 2, envOnly), [2, 3, 4, 5]);
  });

  // Owner, 2026-11-13 (roadmap-keeper#108 merged an unstyled page while its review was pending): on a UI PR the design review blocks.
  describe("a UI PR waits for its design review", () => {
    const build = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
    const review = (state) => ({ __typename: "StatusContext", context: "design-review", state, description: "2 blocking: dark mode text unreadable" });
    const rolled = (nodes) => head({ state: nodes.some((n) => n.state && n.state !== "SUCCESS") ? "PENDING" : "SUCCESS", contexts: { nodes } });
    const ui = (n) => ({ ...addEach(undefined, [{ repo: "o/r", number: n, url: `u${n}`, head: `head${n}`, ui: true }], { now: at(0) }) });

    it("classifies UI files conservatively", () => {
      for (const f of ["src/web/design-system/tokens.css", "src/web/render.ts", "public/app.js", "app/views/list.erb", "src/Button.tsx", "templates/base.njk", "src/styles.ts"]) assert.ok(touchesUi([f]), f);
      for (const f of ["src/store/postgres.ts", "migrations/001.sql", "package.json", "src/api/agent-read.ts", "src/reviews.mjs"]) assert.ok(!touchesUi([f]), f);
    });

    it("a UI PR with design review pending (or not posted) isn't merged; one with it green is; a backend-only PR merges as before", async () => {
      for (const nodes of [[build, review("PENDING")], [build]]) {
        const gh = fakeGithub({ 1: own(1, { mergeStateStatus: nodes.length > 1 ? "UNSTABLE" : "CLEAN", ...rolled(nodes) }) });
        const step = await advance(ui(1), { github: gh, now: at(0) });
        assert.deepEqual(gh.writes, [], "not merged");
        assert.deepEqual(step.wake.map((w) => w.head), ["head1"], "the reviewer is asked for this head");
      }
      const green = fakeGithub({ 1: own(1, { ...rolled([build, review("SUCCESS")]) }) });
      assert.equal((await advance(ui(1), { github: green, now: at(0) })).done, "done");
      // Backend-only (no ui flag): a pending design review is advisory, as before.
      const backend = fakeGithub({ 1: own(1, { mergeStateStatus: "UNSTABLE", ...rolled([build, review("PENDING")]) }) });
      assert.equal((await advance(queue(1), { github: backend, now: at(0) })).done, "done");
      assert.deepEqual(backend.writes, [{ merge: 1, sha: "head1", method: "squash" }]);
    });

    it("decides UI from the PR's own files, so a queue without the flag still waits, then merges once the verdict lands", async () => {
      const files = (paths) => ({ pageInfo: { hasNextPage: false }, nodes: paths.map((path) => ({ path })) });
      const codeOnly = [build];
      const gh = fakeGithub({ 1: own(1, { ...head({ state: "SUCCESS", contexts: { nodes: codeOnly } }), files: files(["src/web/render.ts", "src/web/styles.ts"]) }) });
      const q = queue(1); // no `ui` flag: tiering never ran, as for a request that reached the queue some other way
      const first = await advance(q, { github: gh, now: at(0) });
      assert.deepEqual(gh.writes, [], "green code checks alone never merge a UI PR");
      assert.equal(q.prs[0].status, "pending");
      assert.deepEqual(first.wake.map((w) => w.head), ["head1"], "the reviewer is asked for this head");

      // The same head's verdict: success, and the next poll merges it.
      gh.prs[1] = own(1, { ...head({ state: "SUCCESS", contexts: { nodes: [build, review("SUCCESS")] } }), files: files(["src/web/render.ts", "src/web/styles.ts"]) });
      const second = await advance(q, { github: gh, now: at(1) });
      assert.deepEqual(gh.writes, [{ merge: 1, sha: "head1", method: "squash" }]);
      assert.equal(second.done, "done");

      // A backend-only PR with the same green checks needs no design review.
      const backend = fakeGithub({ 1: own(1, { ...head({ state: "SUCCESS", contexts: { nodes: codeOnly } }), files: files(["src/store/postgres.ts", "package.json"]) }) });
      assert.equal((await advance(queue(1), { github: backend, now: at(0) })).done, "done");
      assert.deepEqual(backend.writes, [{ merge: 1, sha: "head1", method: "squash" }]);
      // Tiering says so itself when the fleet has no design reviewer: that fleet's UI PRs merge as before.
      assert.equal(eachDecision(own(1, { files: files(["src/web/styles.ts"]) }), { head: "head1", ui: false }).do, "merge");
    });

    it("a file list past its first page counts as UI: fail closed, never a blind merge", async () => {
      const files = { pageInfo: { hasNextPage: true }, nodes: [{ path: "src/store/postgres.ts" }] };
      const gh = fakeGithub({ 1: own(1, { ...head({ state: "SUCCESS", contexts: { nodes: [build] } }), files }) });
      const step = await advance(queue(1), { github: gh, now: at(0) });
      assert.deepEqual(gh.writes, []);
      assert.deepEqual(step.wake.map((w) => w.head), ["head1"]);
    });

    // roadmap-keeper#167: the review task came only after a slow check finished, not when the head's review went pending.
    it("the reviewer is asked while the other checks still run, once per head, and not for a draft", async () => {
      const running = { __typename: "CheckRun", name: "code-review", status: "IN_PROGRESS", conclusion: null };
      const gh = fakeGithub({ 1: own(1, { mergeStateStatus: "UNSTABLE", ...rolled([running, review("PENDING")]) }) });
      const q = ui(1);
      assert.deepEqual((await advance(q, { github: gh, now: at(0) })).wake.map((w) => w.head), ["head1"], "asked at once");
      assert.equal((await advance(q, { github: gh, now: at(1) })).wake.length, 0, "once per head");
      gh.prs[1] = own(1, { mergeStateStatus: "UNSTABLE", ...rolled([build, review("PENDING")]) });
      assert.equal((await advance(q, { github: gh, now: at(2) })).wake.length, 0, "not again when the checks go green");
      const draft = fakeGithub({ 1: own(1, { isDraft: true, ...rolled([running, review("PENDING")]) }) });
      assert.equal((await advance(ui(1), { github: draft, now: at(0) })).wake.length, 0);
      assert.deepEqual(gh.writes, [], "nothing merged");
    });

    it("a failed design review stops it with the reviewer's reason", async () => {
      const gh = fakeGithub({ 1: own(1, { mergeStateStatus: "UNSTABLE", ...rolled([build, review("FAILURE")]) }) });
      const step = await advance(ui(1), { github: gh, now: at(0) });
      assert.deepEqual(gh.writes, []);
      assert.match(step.say[0], /Not merged:.*design review failed on its head \(its findings are on the PR/);
      assert.doesNotMatch(step.say[0], /dark mode/, "the status description is repo-controlled: never in the runner's words");
    });

    it("no verdict 2 hours after the checks went green asks once more, then parks it (never the owner's card)", async () => {
      const gh = fakeGithub({ 1: own(1, { mergeStateStatus: "UNSTABLE", ...rolled([build, review("PENDING")]) }) });
      const q = ui(1);
      assert.equal((await advance(q, { github: gh, now: at(0) })).wake.length, 1);
      assert.equal((await advance(q, { github: gh, now: at(60) })).wake.length, 0, "asked once per head");
      const again = await advance(q, { github: gh, now: at(121) });
      assert.deepEqual(again.wake, [{ repo: "o/r", number: 1, url: "u1", head: "head1", again: true }], "asked again");
      assert.equal(again.done, undefined);
      const step = await advance(q, { github: gh, now: at(243) });
      assert.equal(step.done, "stopped");
      assert.match(step.queue.prs[0].note, /^parked: no design review/);
      assert.deepEqual(gh.writes, []);
      // Asked for again later, it is merged then: not "merged already".
      assert.equal(startOrResume(step.queue, [{ repo: "o/r", number: 1, url: "u1", head: "head1" }], { gapMinutes: 0, now: at(244) }).prs.filter((p) => p.status === "pending").length, 1);
    });
  });

  it("a skipped image-scan is green only when the PR changes no image definition", () => {
    const p = { head: "head1" };
    const scan = { __typename: "CheckRun", name: "image-scan", status: "COMPLETED", conclusion: "SKIPPED" };
    const build = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" };
    const at = (paths, more = false) => own(1, { ...head({ state: "SUCCESS", contexts: { nodes: [build, scan] } }), files: { pageInfo: { hasNextPage: more }, nodes: paths.map((path) => ({ path })) } });
    assert.equal(eachDecision(at(["src/app.ts"]), p).do, "merge");
    assert.equal(eachDecision(at(["src/app.ts", "Dockerfile"]), p).do, "fail");
    assert.equal(eachDecision(at(["images/web/Containerfile.prod"]), p).do, "fail");
    assert.equal(eachDecision(at(["src/app.ts"], true), p).do, "fail", "files past the first page could be an image");
    assert.equal(prDecision(pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [build, scan] } } } }] }, files: { nodes: [{ path: "Dockerfile" }] } })).do, "stop");
    assert.equal(prDecision(pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [build, scan] } } } }] }, files: { nodes: [{ path: "README.md" }] } })).do, "merge");
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

test("withGate: a head without the base branch's ci-required check is pending, not green", () => {
  const run = (name, conclusion = "SUCCESS") => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  const data = (head, base) => ({ repository: { pullRequest: {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: head } } } }] },
    baseRef: { target: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: base } } } },
  } } });
  const rollup = (d) => d.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup;
  // The window: supply-chain and image-changes green, the test jobs and the gate not created yet.
  const early = withGate(data([run("supply-chain"), run("image-changes")], [run("scripts"), run("ci-required")]));
  assert.equal(ciState(rollup(early)), "pending");
  assert.ok(namedChecks(rollup(early)).some((c) => c.name === "ci-required" && c.pending));
  // The gate done on the head: unchanged and green.
  const done = withGate(data([run("scripts"), run("ci-required")], [run("ci-required")]));
  assert.equal(ciState(rollup(done)), "green");
  // A repository whose CI has no gate: unchanged.
  const none = withGate(data([run("tests")], [run("tests")]));
  assert.deepEqual(namedChecks(rollup(none)).map((c) => c.name), ["tests"]);
  // A merged head's rollup is final: the gate is never added as queued to it, or the grader would wait on checks that
  // will not run again.
  const merged = data([run("scripts")], [run("ci-required")]);
  merged.repository.pullRequest.state = "MERGED";
  assert.equal(ciState(rollup(withGate(merged))), "green");
  assert.deepEqual(namedChecks(rollup(merged)).map((c) => c.name), ["scripts"]);
});
