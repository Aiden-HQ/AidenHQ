// A PR whose base can never land on the default branch: its base's PR was closed unmerged, or the base ref is gone, and no
// PR of its own ever merged. The gate fails it on the first poll instead of holding the queue until its 90-minute bound.
// A base whose parent is still open, and one whose parent merged, keep behaving as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance } from "../src/merge-gate.mjs";
import { newQueue } from "../../engineering/src/merge-queue.mjs";

const HEAD = "a1".repeat(20);
const TIP = "b2".repeat(20);
const url = "https://github.com/acme/app/pull/7";
const at = (min) => new Date(Date.parse("2026-11-18T10:00:00Z") + min * 60_000);
const run = (name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });
const green = { state: "SUCCESS", contexts: { nodes: [run("tests"), run("ci-required")] } };

/** A green, approved PR on `base` (the same head for every PR: the queue keys off number and repo). */
const prFor = (number, base = "main", over = {}) => ({
  id: `PR_${number}`, number, url: `https://github.com/acme/app/pull/${number}`, state: "OPEN", isDraft: false,
  reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: HEAD, headRefName: `fix/${number}`, baseRefName: base,
  isCrossRepository: false, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: green } }] },
  baseRef: { target: { oid: "c3".repeat(20), statusCheckRollup: green } },
  ...over,
});

/** #7 stacked on `fleet/x` (or on `base`), plus any other PRs by number; `baseStatus` says what the base looks like. */
function github(baseStatus, { base = "fleet/x", prs = {} } = {}) {
  const writes = [];
  const all = { 7: prFor(7, base), ...prs };
  return {
    writes,
    async pr(repo, number) {
      return { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: all[number] } };
    },
    async commit() {
      return { statusCheckRollup: null };
    },
    async baseStatus() {
      return { tip: TIP, open: false, merged: [], overflow: false, stacked: false, ...baseStatus };
    },
    async evalGate() {},
    async retarget(repo, number, to) {
      writes.push({ retarget: number, base: to });
    },
    async merge(repo, number) {
      writes.push({ merge: number });
      return "e4".repeat(20);
    },
    async deleteBranch() {},
  };
}

const queue = () => newQueue([{ repo: "acme/app", number: 7, url, head: HEAD }], { gapMinutes: 0, now: at(0) });
const opts = (gh, min) => ({ github: gh, now: at(min), cardIsReview: () => true, timeoutMinutes: 90 });

test("a base whose PR was closed unmerged fails the PR on the first poll and stops the queue", async () => {
  const gh = github({});
  const q = queue();
  const step = await advance(q, opts(gh, 1));
  assert.equal(step.done, "stopped");
  assert.equal(q.state, "stopped");
  assert.equal(q.prs[0].status, "failed");
  assert.match(q.reason, /based on `fleet\/x`, which has no open or merged PR of its own, so it can never land on `main`/);
  assert.match(step.say.join("\n"), /\*\*Not merged:\*\* https:\/\/github.com\/acme\/app\/pull\/7: based on `fleet\/x`/);
  assert.deepEqual(gh.writes, [], "nothing was merged or retargeted");
});

test("a base ref that is gone fails the PR on the first poll and names it as gone", async () => {
  const gh = github({ tip: null });
  const q = queue();
  const step = await advance(q, opts(gh, 1));
  assert.equal(step.done, "stopped");
  assert.match(q.reason, /based on `fleet\/x`, which no longer exists on this repository: retarget it to `main`/);
});

test("a ready PR ahead of it doesn't postpone that failure to a later poll", async () => {
  // #8 is ready for a train slot, so the loop would otherwise break before reaching #7.
  const gh = github({}, { prs: { 8: prFor(8) } });
  const q = newQueue(
    [
      { repo: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8", head: HEAD },
      { repo: "acme/app", number: 7, url, head: HEAD },
    ],
    { gapMinutes: 0, now: at(0) },
  );
  const step = await advance(q, { ...opts(gh, 1), train: () => true });
  assert.equal(step.ready?.[0]?.number, 8, "the ready PR still comes back for its train");
  assert.equal(q.prs[1].status, "failed", "the unlandable one is failed in the same poll");
  assert.match(q.prs[1].note, /based on `fleet\/x`/);
});

test("an independent queue fails that PR on the first poll and merges the others", async () => {
  const gh = github({}, { prs: { 9: prFor(9) } });
  const other = { repo: "acme/app", number: 9, url: "https://github.com/acme/app/pull/9", head: HEAD };
  const q = newQueue([{ repo: "acme/app", number: 7, url, head: HEAD }, other], { gapMinutes: 0, now: at(0) });
  q.independent = true;
  q.strict = true;
  const step = await advance(q, opts(gh, 1));
  assert.equal(q.prs[0].status, "failed", "the unlandable PR fails in the first poll");
  assert.match(q.prs[0].note, /based on `fleet\/x`, which has no open or merged PR of its own/);
  assert.equal(q.prs[1].status, "merged", "the other PR still merges");
  assert.deepEqual(gh.writes, [{ merge: 9 }]);
  assert.deepEqual(step.turned.map((t) => t.number), [7]);
});

test("a base whose parent PR is still open still waits", async () => {
  const gh = github({ open: true });
  const q = queue();
  const step = await advance(q, opts(gh, 1));
  assert.equal(q.prs[0].status, "pending", "still waiting");
  assert.equal(step.done, undefined);
  assert.deepEqual(gh.writes, []);
});

test("a base whose parent PR merged still retargets", async () => {
  const parentUrl = "https://github.com/acme/app/pull/8";
  const gh = github(
    { merged: [{ state: "MERGED", headRefOid: TIP, isCrossRepository: false }] },
    { prs: { 8: prFor(8, "main", { url: parentUrl, state: "MERGED", headRefName: "fleet/x", headRefOid: TIP }) } },
  );
  gh.rebuild = async () => HEAD;
  // The parent merged in this same queue: the stacked PR's own commits are replayed onto `main` and it is retargeted.
  const q = newQueue(
    [
      { repo: "acme/app", number: 8, url: parentUrl, head: TIP, status: "merged", mergedAt: at(0).toISOString(), base: "main", headRef: "fleet/x", headOid: TIP, ciAt: at(0).toISOString() },
      { repo: "acme/app", number: 7, url, head: HEAD, status: "pending" },
    ],
    { gapMinutes: 0, now: at(0) },
  );
  const step = await advance(q, opts(gh, 1));
  assert.deepEqual(gh.writes, [{ retarget: 7, base: "main" }]);
  assert.notEqual(q.prs[1].status, "failed");
  assert.equal(step.done, undefined);
});
