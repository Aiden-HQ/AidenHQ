// Two merge-queue waits that cost a fix minutes for nothing: a card's PR whose head only this queue's own update moved (re-asked
// in code, no Engineer turn), and the fixed settle after a merge on a base whose CI ends with the gate check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance } from "../src/merge-gate.mjs";
import { newQueue } from "../../engineering/src/merge-queue.mjs";

const APPROVED = "a1".repeat(20);
const UPDATED = "b2".repeat(20);
const url = "https://github.com/acme/app/pull/7";
const at = (min) => new Date(Date.parse("2026-11-18T10:00:00Z") + min * 60_000);
const run = (name, status, conclusion) => ({ __typename: "CheckRun", name, status, conclusion });
const green = (...names) => ({ state: "SUCCESS", contexts: { nodes: names.map((n) => run(n, "COMPLETED", "SUCCESS")) } });
const redBase = { state: "FAILURE", contexts: { nodes: [run("tests", "COMPLETED", "FAILURE"), run("ci-required", "COMPLETED", "FAILURE")] } };

function github({ base = redBase, samePatch } = {}) {
  const writes = [];
  let pr = {
    id: "PR_7", number: 7, url, state: "OPEN", isDraft: false, reviewDecision: null, mergeStateStatus: "CLEAN", headRefOid: APPROVED, headRefName: "fix/x",
    baseRefName: "main", isCrossRepository: false, latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { parents: { nodes: [{ oid: "c0".repeat(20) }] }, statusCheckRollup: green("tests", "ci-required") } }] },
    baseRef: { compare: { behindBy: 1 }, target: { oid: "d3".repeat(20), statusCheckRollup: base } },
  };
  const commits = {};
  return {
    writes,
    commits,
    set: (over) => (pr = { ...pr, ...over }),
    async pr() {
      return { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: pr } };
    },
    async commit(repo, oid) {
      return { statusCheckRollup: commits[oid] ?? null };
    },
    async baseStatus() {
      return { tip: null, open: false, merged: [], overflow: false, stacked: false };
    },
    async evalGate() {},
    async updateBranch(repo, number, head) {
      writes.push({ update: number, head });
      // GitHub merges the base into the approved head: a new commit whose first parent is that head.
      pr = { ...pr, headRefOid: UPDATED, commits: { nodes: [{ commit: { parents: { nodes: [{ oid: head }, { oid: "d3".repeat(20) }] }, statusCheckRollup: green("tests", "ci-required") } }] } };
    },
    async merge(repo, number) {
      writes.push({ merge: number });
      pr = { ...pr, state: "MERGED" };
      return "e4".repeat(20);
    },
    async deleteBranch() {},
    ...(samePatch ? { samePatch } : {}),
  };
}

const queue = () => newQueue([{ repo: "acme/app", number: 7, url, head: APPROVED, patch: "key-1" }], { gapMinutes: 0, now: at(0) });
const opts = (gh, min) => ({ github: gh, now: at(min), cardIsReview: () => true, timeoutMinutes: 90 });

test("a head moved only by the queue's own update, with the same change, is asked for again in code", async () => {
  const asked = [];
  const gh = github({ samePatch: async (repo, number, patch, head) => (asked.push({ number, patch, head }), true) });
  const q = queue();
  await advance(q, opts(gh, 1)); // red base, PR behind it: the queue updates the PR
  assert.deepEqual(gh.writes, [{ update: 7, head: APPROVED }]);
  const step = await advance(q, opts(gh, 2));
  assert.deepEqual(step.retier, [{ repo: "acme/app", number: 7, url }]);
  assert.deepEqual(asked, [{ number: 7, patch: "key-1", head: UPDATED }], "the card's own content key, against the new head");
  assert.equal(q.state, "handed", "not done, not stopped: the new card's merge finishes the task");
  assert.equal(step.done, undefined);
  assert.match(step.say.join("\n"), /asked for again on that head, in code/);
});

test("a changed change, or no content check, stops for a new card as before", async () => {
  for (const samePatch of [async () => false, undefined]) {
    const gh = github({ samePatch });
    const q = queue();
    await advance(q, opts(gh, 1));
    const step = await advance(q, opts(gh, 2));
    assert.equal(step.done, "stopped");
    assert.match(q.reason, /changed since its merge card/);
    assert.equal(step.retier, undefined);
  }
});

test("a base with the gate check is settled once it passes on the merge commit, not after a fixed settle", async () => {
  const gh = github({ base: green("tests", "ci-required") });
  gh.set({ baseRef: { compare: { behindBy: 0 }, target: { oid: "d3".repeat(20), statusCheckRollup: green("tests", "ci-required") } } });
  const q = queue();
  await advance(q, opts(gh, 0));
  assert.deepEqual(gh.writes, [{ merge: 7 }]);
  const merge = "e4".repeat(20);
  gh.commits[merge] = { state: "SUCCESS", contexts: { nodes: [run("tests", "COMPLETED", "SUCCESS")] } }; // the gate hasn't registered yet
  const early = await advance(q, opts(gh, 1));
  assert.equal(early.done, undefined, "green without the gate check is still running");
  gh.commits[merge] = green("tests", "ci-required");
  const done = await advance(q, opts(gh, 2));
  assert.equal(done.done, "done", "two minutes after the merge, not five");
});

test("a base without the gate check keeps the settle", async () => {
  const gh = github({ base: green("tests") });
  gh.set({ baseRef: { compare: { behindBy: 0 }, target: { oid: "d3".repeat(20), statusCheckRollup: green("tests") } } });
  const q = queue();
  await advance(q, opts(gh, 0));
  gh.commits["e4".repeat(20)] = green("tests");
  assert.equal((await advance(q, opts(gh, 2))).done, undefined);
  assert.equal((await advance(q, opts(gh, 6))).done, "done");
});
