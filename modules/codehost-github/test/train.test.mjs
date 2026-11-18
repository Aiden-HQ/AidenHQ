// Merge trains end to end at the gate: three tasks' card queues, one approved green PR each, polled once a minute as the
// runner does (advanceTrains). The fake GitHub keeps real trees as sets of merged PRs, so CI on a train commit is red exactly
// when it carries the PR that breaks the combined build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceTrains } from "../src/merge-gate.mjs";
import { newQueue } from "../../engineering/src/merge-queue.mjs";

const green = { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } };
const red = { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] } };
const url = (n) => `https://github.com/acme/app/pull/${n}`;

function fakeGithub({ breaks } = {}) {
  const trees = { base0: [] }; // commit → the PRs in its tree
  const branches = { main: "base0" };
  const prs = {};
  const log = { builds: [], merges: [], deleted: [] };
  let seq = 0;
  return {
    log,
    prs,
    branches,
    open(n) {
      prs[n] = { number: n, url: url(n), state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", headRefOid: `${n}`.padStart(40, "a"), headRefName: `feat-${n}`, isCrossRepository: false, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] }, commits: { nodes: [{ commit: { statusCheckRollup: green } }] } };
    },
    async pr(repo, n) {
      const tip = branches.main;
      return { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: { ...prs[n], baseRefName: "main", baseRef: { target: { oid: tip, statusCheckRollup: green } } } } };
    },
    async baseStatus(repo, base) {
      return { tip: branches[base] ?? null, open: false, merged: [], overflow: false, stacked: false };
    },
    async commit(repo, oid) {
      return { statusCheckRollup: trees[oid]?.includes(breaks) ? red : green };
    },
    async evalGate() {
      return undefined;
    },
    async createRef(repo, branch, sha) {
      if (branch.startsWith("merge-train/")) log.builds.push(branch);
      branches[branch] = sha;
    },
    async mergeInto(repo, branch, head) {
      const n = Number(head.replace(/^a+/, ""));
      const sha = `c${++seq}`;
      trees[sha] = [...trees[branches[branch]], n];
      branches[branch] = sha;
      return sha;
    },
    async merge(repo, n, { sha }) {
      assert.equal(sha, prs[n].headRefOid, "merged at its bound head");
      const commit = `m${++seq}`;
      trees[commit] = [...trees[branches.main], n];
      branches.main = commit;
      prs[n] = { ...prs[n], state: "MERGED" };
      log.merges.push(n);
      return commit;
    },
    async deleteBranch(repo, branch) {
      log.deleted.push(branch);
      delete branches[branch];
    },
    trees,
  };
}

/** Three tasks, one PR each, polled a minute apart until every queue ends. */
async function runTrain(github) {
  const start = Date.parse("2026-11-17T10:00:00Z");
  const entries = [1, 2, 3].map((n, i) => {
    github.open(n);
    const queue = newQueue([{ repo: "acme/app", number: n, url: url(n), head: github.prs[n].headRefOid }], { gapMinutes: 0, now: new Date(start + i * 1000) });
    queue.strict = true;
    return { key: `task-${n}`, queue };
  });
  const trains = {};
  const said = { "task-1": [], "task-2": [], "task-3": [] };
  const turned = [];
  for (let min = 1; min < 60 && entries.some((e) => e.queue.state === "running"); min++) {
    const running = entries.filter((e) => e.queue.state === "running");
    const steps = await advanceTrains(running, trains, { github, now: new Date(start + min * 60_000), cardIsReview: () => true, train: () => true });
    for (const [key, step] of steps) {
      assert.equal(step.error, undefined, String(step.error?.stack));
      said[key].push(...step.say);
      turned.push(...(step.turned ?? []));
    }
  }
  return { entries, said, turned, trains };
}

test("three green PRs: one train, one CI run, three merges in queue order", async () => {
  const github = fakeGithub();
  const { entries, said } = await runTrain(github);
  assert.deepEqual(github.log.builds, ["merge-train/1"]);
  assert.deepEqual(github.log.merges, [1, 2, 3]);
  assert.deepEqual(github.trees[github.branches.main], [1, 2, 3]);
  assert.deepEqual(Object.keys(github.branches), ["main"], "the build and train branches deleted");
  for (const e of entries) assert.equal(e.queue.state, "done", JSON.stringify(e.queue));
  assert.match(said["task-2"].join("\n"), /Merged https:\/\/github.com\/acme\/app\/pull\/2 from merge train `merge-train\/1`/);
});

test("the middle PR breaks the combined build: the train bisects, #2 goes back to its task, #1 and #3 merge", async () => {
  const github = fakeGithub({ breaks: 2 });
  const { entries, said, turned } = await runTrain(github);
  assert.deepEqual(github.log.merges, [1, 3]);
  assert.deepEqual(github.trees[github.branches.main], [1, 3]);
  // [1,2,3] red → [1,2] red → [1] green, [2] red alone, then [3] on top of #1.
  assert.equal(github.log.builds.length, 5);
  const [one, two, three] = entries.map((e) => e.queue);
  assert.equal(one.state, "done");
  assert.equal(three.state, "done");
  assert.equal(two.state, "stopped");
  assert.equal(two.prs[0].status, "failed");
  assert.match(said["task-2"].join("\n"), /\*\*Not merged:\*\* https:\/\/github.com\/acme\/app\/pull\/2: CI failed on `merge-train\/\d+`/);
  assert.deepEqual(turned.map((t) => [t.number, t.key]), [[2, "train"]]);
  assert.deepEqual(Object.keys(github.branches), ["main"], "every train branch deleted");
});
