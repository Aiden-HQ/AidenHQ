// The loop's pass for a PR that isn't the fleet's own: a writer's `ship` label adopts it, and its round files the merge for that
// adoption; a cancelled task hands it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptedPass } from "../service/src/adopted.ts";
import { PRESETS } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";

test("a writer's ship label adopts a PR and its round files the adoption's merge; a cancelled task hands it back", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const calls = [];
  let taskStatus = "in_progress";
  const kernel = { call: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/v1/tasks") return { id: "T1" };
    if (path.startsWith("/v1/work")) return { status: taskStatus, records: [] };
    if (path === "/v1/writes") return { id: "r1", tier: 0, state: "claimed" };
    return {};
  } };
  const gh = async (method, path) => path.endsWith("/permission") ? { status: 200, body: { role_name: path.includes("/mallory/") ? "read" : "write" } } : { status: 200, body: {} };
  const pass = adoptedPass({
    gh, state, kernel, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "merge", failing: [] }),
    effects: { comment: async () => 1, askReview: async () => {} },
  });
  const pr = (events) => ({ number: 4, url: "https://github.com/acme/app/pull/4", headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [{ name: "ship" }] }, assignees: { nodes: [] }, timelineItems: { nodes: events } });
  const label = (id, login) => ({ __typename: "LabeledEvent", id, createdAt: "2026-11-24T10:00:00Z", actor: { __typename: "User", login }, label: { name: "ship" } });
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };

  await pass.open("acme/app", main, pr([label("e1", "mallory")]));
  assert.equal(state.get("acme/app", 4), undefined, "a reader's label adopts nothing");
  await pass.open("acme/app", main, pr([label("e1", "mallory"), label("e2", "maria")]));
  assert.deepEqual([state.get("acme/app", 4).generation, state.get("acme/app", 4).trigger.kind], [1, "label"]);
  const merge = calls.find((c) => c.path === "/v1/writes");
  assert.deepEqual(merge.body.args, { prs: [{ repo: "acme/app", number: 4, head: "a".repeat(40), base: "main" }], generation: 1, attempt: 1 });

  state.put({ ...state.get("acme/app", 4), task: "T1" });
  taskStatus = "cancelled";
  await pass.open("acme/app", main, pr([label("e1", "mallory"), label("e2", "maria")]));
  assert.equal(state.get("acme/app", 4).hold?.kind, "handed_back");
});

test("under rebase: conflict, only the earliest hand-off among the repo's open adoptions is brought up to date", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const kept = (number, at) => ({ repo: "acme/app", number, generation: 1, trigger: { kind: "label", event: `e${number}`, actor: "maria", at, head: "a".repeat(40) }, task: `T${number}`, hold: null });
  state.put(kept(5, "2026-11-24T09:00:00Z"));
  state.put(kept(6, "2026-11-24T10:00:00Z"));
  const updated = [];
  const pass = adoptedPass({
    gh: async (method, path) => (method === "PUT" && updated.push(path), { status: 200, body: {} }), state,
    kernel: { call: async (m, path) => (path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}) },
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "repair", why: "behind", failing: [], dirty: false }),
    effects: { comment: async () => 1, askReview: async () => {} },
  });
  const pr = (number) => ({ number, url: `https://github.com/acme/app/pull/${number}`, headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } });
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  const open = new Set([5, 6]);
  await pass.open("acme/app", main, pr(6), open);
  await pass.open("acme/app", main, pr(5), open);
  assert.deepEqual(updated, ["/repos/acme/app/pulls/5/update-branch"]);
});

test("a held adoption whose PR was closed is read once, then never again", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  state.put({ repo: "acme/app", number: 8, generation: 1, trigger: { kind: "label", event: "e8", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, task: "T8", hold: { kind: "stalled", reason: "rounds" } });
  let reads = 0;
  const pass = adoptedPass({
    gh: async () => (reads++, { status: 200, body: { state: "closed", merged_at: null } }), state,
    kernel: { call: async () => ({}) }, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {} },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.equal(reads, 1);
  assert.equal(state.get("acme/app", 8).hold.kind, "stalled", "its own hold is kept");
});

test("a CI re-run with no push (fix_ci, wait, fix_ci at one head) wakes the task once", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  state.put({ repo: "acme/app", number: 9, generation: 1, trigger: { kind: "label", event: "e9", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, task: "T9", hold: null });
  const wakes = [];
  const decisions = ["fix_ci", "wait", "fix_ci"];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: {} }), state,
    kernel: { call: async (m, path, body) => (path === "/v1/wakes" && wakes.push(body), path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}) },
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: decisions.shift(), failing: ["test"] }), effects: { comment: async () => 1, askReview: async () => {} },
  });
  const pr = { number: 9, url: "https://github.com/acme/app/pull/9", headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  for (let i = 0; i < 3; i++) await pass.open("acme/app", main, pr, new Set([9]));
  assert.equal(wakes.length, 1);
});

test("a report that failed to post is posted again on the next pass", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  state.put({ repo: "acme/app", number: 10, generation: 1, trigger: { kind: "label", event: "e10", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, task: "T10", hold: null });
  let fail = true;
  const posted = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: {} }), state, kernel: { call: async () => ({}) },
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait", why: "CI is running" }),
    effects: { comment: async (_r, _n, body) => { if (fail) throw new Error("502"); posted.push(body); return 7; }, askReview: async () => {} },
  });
  const pr = { number: 10, url: "https://github.com/acme/app/pull/10", headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  await pass.open("acme/app", main, pr, new Set([10]));
  assert.equal(posted.length, 0);
  fail = false;
  await pass.open("acme/app", main, pr, new Set([10]));
  assert.equal(posted.length, 1);
  assert.equal(state.get("acme/app", 10).reportStale, undefined);
  assert.equal(state.get("acme/app", 10).report, 7);
});

test("on a merge queue branch the pass fills queue and groupFailing: a ready PR is enqueued, a removal red on the base too is enqueued again", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "a".repeat(40);
  state.put({ repo: "acme/app", number: 9, generation: 1, trigger: { kind: "label", event: "e9", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, task: "T9", hold: null });
  const calls = [];
  let n = 0;
  const kernel = { call: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/v1/work")) return { status: "in_progress", records: [] };
    if (path === "/v1/writes") return { id: `q${++n}`, state: "claimed" };
    if (path.startsWith("/v1/writes/")) return { state: "done", outcome: { text: "queued" } };
    return {};
  } };
  let decision = { do: "enqueue", why: "ready", failing: [], dirty: false, queue: true, groupFailing: [] };
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: {} }), state, kernel, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => decision, effects: { comment: async () => 1, askReview: async () => {} },
  });
  const pr = { number: 9, url: "https://github.com/acme/app/pull/9", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  const main = { name: "main", rollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "FAILURE" }] } } };
  const enqueues = () => calls.filter((c) => c.path === "/v1/writes" && c.body.kind === "github.enqueue").map((c) => c.body.args);

  await pass.open("acme/app", main, pr);
  assert.deepEqual(enqueues(), [{ repo: "acme/app", number: 9, head: H, base: "main", generation: 1, attempt: 1 }]);
  // Removed from the queue with `x` red on its merge_group run and on main too: not the PR's own, so queued once more, no wake.
  decision = { ...decision, groupFailing: ["x"] };
  await pass.open("acme/app", main, pr);
  assert.deepEqual(enqueues().map((a) => a.attempt), [1, 2]);
  assert.equal(calls.some((c) => c.path === "/v1/wakes"), false);
});

test("a covered PR waiting only on an approval is judged through the loop and approved as the App", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "c".repeat(40), BASE = "b".repeat(40);
  state.put({ repo: "acme/app", number: 11, generation: 1, trigger: { kind: "label", event: "e11", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, task: "T11", hold: null });
  const calls = [], reads = [];
  const kernel = { call: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/v1/work")) return { status: "in_progress", records: [] };
    if (path === "/v1/writes") return { id: "a1", state: "claimed" };
    return {};
  } };
  const gh = async (method, path) => (reads.push(path), path.includes("/compare/") ? { status: 200, body: { files: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" }] } } : { status: 200, body: {} });
  const pass = adoptedPass({
    gh, state, kernel, settings: () => ({ ...PRESETS.cautious, approve: "safe" }), paused: () => false, log() {},
    decision: async () => ({ do: "wait", why: "waiting for required review", failing: [], dirty: false, approval: true }),
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => ({ verdict: "pass", reasons: [], reviewed: H, kind: "completed" }) },
  });
  const pr = { number: 11, url: "https://github.com/acme/app/pull/11", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", oid: BASE, rollup: { contexts: { nodes: [] } } }, pr);
  assert.ok(reads.includes(`/repos/acme/app/compare/${BASE}...${H}`));
  const approve = calls.find((c) => c.path === "/v1/writes" && c.body.kind === "github.approve");
  assert.deepEqual(approve?.body.args, { repo: "acme/app", number: 11, head: H, generation: 1, base: "main" });
});

test("the loop's gh reaches the round: a conflict runs the repo's own /rebase step before ship's repair", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "d".repeat(40);
  state.put({ repo: "acme/app", number: 12, generation: 1, trigger: { kind: "label", event: "e12", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, task: "T12", hold: null });
  const posted = [];
  const gh = async (method, path, body) => (method === "POST" && path.endsWith("/comments") && posted.push(body), { status: 200, body: path.includes("/git/trees/") ? { tree: [] } : {} });
  const writes = [];
  const pass = adoptedPass({
    gh, state, settings: () => ({ ...PRESETS.cautious, actions: { conflict: [{ comment: "/rebase" }] } }), paused: () => false, log() {},
    kernel: { call: async (m, path, body) => (path === "/v1/writes" && writes.push(body), path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : { id: "r1" }) },
    decision: async () => ({ do: "repair", why: "conflict", failing: [], dirty: true }),
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => ({ verdict: "wait", reasons: [] }) },
  });
  const pr = { number: 12, url: "https://github.com/acme/app/pull/12", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", oid: "b".repeat(40), rollup: { contexts: { nodes: [] } } }, pr);
  assert.deepEqual(posted, [{ body: "/rebase" }]);
  assert.equal(writes.length, 0, "ship's own repair waits for the step");
});

test("a conflict with no generated setting files ship's repair with the globs discovery found on the base", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "e".repeat(40);
  state.put({ repo: "acme/app", number: 13, generation: 1, trigger: { kind: "label", event: "e13", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, task: "T13", hold: null });
  const writes = [];
  const pass = adoptedPass({
    gh: async (method, path) => ({ status: 200, body: path.includes("/git/trees/") ? { tree: [] } : {} }), state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path, body) => (path === "/v1/writes" && writes.push(body), path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : { id: "r1" }) },
    decision: async () => ({ do: "repair", why: "conflict", failing: [], dirty: true }),
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => ({ verdict: "wait", reasons: [] }) },
  });
  const pr = { number: 13, url: "https://github.com/acme/app/pull/13", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", oid: "b".repeat(40), rollup: { contexts: { nodes: [] } } }, pr);
  const repair = writes.find((w) => w.kind === "github.repair");
  assert.ok(repair?.args.plan.globs.includes("**/package-lock.json"), JSON.stringify(repair?.args.plan));
});
