// The loop's pass for a PR that isn't the fleet's own: a writer's `ship` label adopts it, and its round files the merge for that
// adoption; a cancelled task hands it back.
import { verdict } from "./risk.ts";
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
    effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
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
    effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  const pr = (number) => ({ number, url: `https://github.com/acme/app/pull/${number}`, headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } });
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  const open = new Set([5, 6]);
  pass.see("acme/app", "main", [pr(5), pr(6)]);
  await pass.open("acme/app", main, pr(6), open);
  await pass.open("acme/app", main, pr(5), open);
  assert.deepEqual(updated, ["/repos/acme/app/pulls/5/update-branch"]);
});

test("the merge order's front is only a PR this scan runs a round on toward the default branch, and nobody stopped", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const kept = (number, at) => ({ repo: "acme/app", number, generation: 1, trigger: { kind: "label", event: `e${number}`, actor: "maria", at, head: "a".repeat(40) }, task: `T${number}`, hold: null });
  [[1, "08:00"], [2, "08:30"], [3, "09:00"], [4, "09:30"]].forEach(([n, t]) => state.put(kept(n, `2026-11-24T${t}:00Z`)));
  const updated = [];
  const pass = adoptedPass({
    gh: async (method, path) => (method === "PUT" && updated.push(path), { status: 200, body: {} }), state,
    kernel: { call: async (m, path) => (path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}) },
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "repair", why: "behind", failing: [], dirty: false }),
    effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  const pr = (number, extra = {}) => ({ number, url: `https://github.com/acme/app/pull/${number}`, headRefOid: "a".repeat(40), baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] }, ...extra });
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  const all = [pr(1, { baseRefName: "release" }), pr(2, { isDraft: true }), pr(3, { author: { __typename: "Bot", login: "dependabot[bot]" } }), pr(4)];
  // 1 is on another base, 2 is a draft, 3 is a Dependabot PR the loop leaves out of the scan: 4 is the front.
  pass.see("acme/app", "main", [all[0], all[1], all[3]]);
  const open = new Set([1, 2, 3, 4]);
  await pass.open("acme/app", main, all[3], open);
  assert.deepEqual(updated, ["/repos/acme/app/pulls/4/update-branch"]);
});

test("a held adoption whose PR was closed is read once, then never again", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  state.put({ repo: "acme/app", number: 8, generation: 1, trigger: { kind: "label", event: "e8", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, task: "T8", hold: { kind: "stalled", reason: "rounds" } });
  let reads = 0;
  const pass = adoptedPass({
    gh: async () => (reads++, { status: 200, body: { state: "closed", merged_at: null } }), state,
    kernel: { call: async () => ({}) }, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
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
    decision: async () => ({ do: decisions.shift(), failing: ["test"] }), effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
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
    effects: { comment: async (_r, _n, body) => { if (fail) throw new Error("502"); posted.push(body); return 7; }, askReview: async () => {}, verdict: async () => verdict() },
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
    decision: async () => decision, effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
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
    gh, state, kernel, settings: () => ({ ...PRESETS.cautious, by_tier: { ...PRESETS.cautious.by_tier, standard: { approve: "on", merge: "ready" } } }), paused: () => false, log() {},
    decision: async () => ({ do: "wait", why: "waiting for required review", failing: [], dirty: false, approval: true }),
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { reviewed: H }) },
  });
  const pr = { number: 11, url: "https://github.com/acme/app/pull/11", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", oid: BASE, rollup: { contexts: { nodes: [] } } }, pr);
  const approve = calls.find((c) => c.path === "/v1/writes" && c.body.kind === "github.approve");
  assert.deepEqual(approve?.body.args, { repo: "acme/app", number: 11, head: H, generation: 1, base: "main", policy: "p1" });
});

test("a ready PR merges by its tier, and a head not classified yet merges nothing (the live base and author go to code review)", async () => {
  const H = "e".repeat(40), asked = [];
  const run = async (n, v) => {
    const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
    state.put({ repo: "acme/app", number: n, generation: 1, trigger: { kind: "label", event: `e${n}`, actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, task: `T${n}`, hold: null });
    const writes = [];
    const kernel = { call: async (method, path, body) => { if (path === "/v1/writes") { writes.push(body.kind); return { id: "m1", state: "claimed" }; } return path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}; } };
    const settings = { ...PRESETS.cautious, by_tier: { ...PRESETS.cautious.by_tier, sensitive: { approve: "off", merge: "off" } } };
    const pass = adoptedPass({
      gh: async () => ({ status: 200, body: {} }), state, kernel, settings: () => settings, paused: () => false, log() {},
      decision: async () => ({ do: "merge", why: "ready", failing: [], dirty: false }),
      effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async (...a) => (asked.push(a[3]), v) },
    });
  const pr = { number: n, url: `https://github.com/acme/app/pull/${n}`, headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
    await pass.open("acme/app", { name: "main", oid: "b".repeat(40), rollup: { contexts: { nodes: [] } } }, pr);
    return writes;
  };
  assert.deepEqual(await run(21, verdict("skip", { kind: "none", requires_review: false })), ["github.merge"], "a skip tier's merge is ready");
  assert.deepEqual(await run(22, verdict("sensitive")), [], "the tier's merge is off");
  assert.deepEqual(await run(23, { ...verdict("standard"), tier: { state: "pending" } }), [], "not classified yet: wait");
  assert.deepEqual(asked[0], { base: "main", association: "" }, "the live base and author association are sent");
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
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { verdict: "wait" }) },
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
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { verdict: "wait" }) },
  });
  const pr = { number: 13, url: "https://github.com/acme/app/pull/13", headRefOid: H, baseRefName: "main", author: { __typename: "User", login: "dev" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", oid: "b".repeat(40), rollup: { contexts: { nodes: [] } } }, pr);
  const repair = writes.find((w) => w.kind === "github.repair");
  assert.ok(repair?.args.plan.globs.includes("**/package-lock.json"), JSON.stringify(repair?.args.plan));
});

test("a task's PR that lands tells its task, and gets no report comment", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "f".repeat(40);
  state.put({ repo: "acme/app", number: 14, generation: 1, trigger: { kind: "fleet", event: "opened:14", actor: "T14", at: "2026-11-24T09:00:00Z", head: H }, task: "T14", owner: { kind: "task", task: "T14" }, hold: null });
  const wakes = [], comments = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: { merged_at: "2026-11-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/14", head: { sha: H }, base: { ref: "main" }, user: { login: "dev", type: "User" } } }),
    state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path, body) => (path === "/v1/wakes" && wakes.push(body), {}) },
    decision: async () => ({ do: "wait" }),
    effects: { comment: async (r, n, body) => (comments.push(body), 1), askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { verdict: "wait" }) },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.equal(wakes.length, 1, "told once");
  assert.deepEqual([wakes[0].task, /Merged/.test(wakes[0].text)], ["T14", true]);
  assert.equal(comments.length, 0, "a task's PR gets no report comment");
});

test("a fork's head counts as ship's own only when this adoption's write made it from the handed-off head", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const [H1, H2, H3, H4] = ["1", "2", "3", "4"].map((c) => c.repeat(40));
  state.put({ repo: "acme/app", number: 9, generation: 1, trigger: { kind: "comment", event: "c9", actor: "maria", at: "2026-11-24T09:00:00Z", head: H1 }, owner: { kind: "member", login: "maria" }, task: "T9", asked: true, hold: null });
  // The Engineer's pushes on T9: H1 -> H2 (from the hand-off), then H3 -> H4 (on top of the author's own H3).
  const records = [
    { id: "p1", kind: "github.push", state: "done", args: { pr: { repo: "acme/app", number: 9 }, expected: H1, generation: 1 } },
    { id: "p2", kind: "github.push", state: "done", args: { pr: { repo: "acme/app", number: 9 }, expected: H3, generation: 1 } },
  ];
  const objects = { [`github:outsider/app@${H2}`]: "p1", [`github:outsider/app@${H4}`]: "p2" };
  const kernel = { call: async (m, path) => {
    if (path.startsWith("/v1/work")) return { status: "in_progress", records };
    if (path.startsWith("/v1/objects")) { const r = objects[decodeURIComponent(path.split("ref=")[1])]; return r ? { ours: true, record: r } : { ours: false }; }
    return {};
  } };
  // Every compare shows a different own change: only the records can vouch for a head.
  const gh = async (method, path) => ({ status: 200, body: path.includes("/compare/") ? { files: [{ filename: "a.ts", status: "modified", patch: path }] } : {} });
  const pass = adoptedPass({
    gh, state, kernel, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait", why: "checks running" }),
    effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  const pr = (head) => ({ number: 9, url: "https://github.com/acme/app/pull/9", headRefOid: head, baseRefName: "main", author: { __typename: "User", login: "outsider" }, isCrossRepository: true, maintainerCanModify: true, headRepository: { nameWithOwner: "outsider/app" }, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } });
  const main = { name: "main", rollup: { contexts: { nodes: [] } } };
  await pass.open("acme/app", main, pr(H2));
  assert.deepEqual([state.get("acme/app", 9).hold, state.get("acme/app", 9).trigger.head], [null, H2], "ship's own push from the hand-off is covered");
  await pass.open("acme/app", main, pr(H4));
  assert.equal(state.get("acme/app", 9).hold?.kind, "stopped", "a push on top of the author's commit is not one ship made from the hand-off");
});

test("a fork head with the same patches but a changed file mode is not the same change", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const [H1, H2, H3, B] = ["1", "2", "3", "b"].map((c) => c.repeat(40));
  state.put({ repo: "acme/app", number: 9, generation: 1, fork: true, trigger: { kind: "comment", event: "c9", actor: "maria", at: "2026-11-24T09:00:00Z", head: H1 }, owner: { kind: "member", login: "maria" }, holder: "R9", asked: true, hold: null });
  const kernel = { call: async (m, path) => (path.startsWith("/v1/work") ? { status: "in_progress", records: [] } : path.startsWith("/v1/objects") ? { ours: false } : {}) };
  const mode = { [H1]: "100644", [H2]: "100644", [H3]: "100755" };
  const gh = async (method, path) => {
    if (path.includes("/compare/")) return { status: 200, body: { files: [{ filename: "run.sh", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] } };
    const tree = /git\/trees\/(\w+)/.exec(path)?.[1];
    if (tree) return { status: 200, body: { truncated: false, tree: [{ path: "run.sh", mode: mode[tree] }] } };
    return { status: 200, body: {} };
  };
  const pass = adoptedPass({
    gh, state, kernel, settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait", why: "checks running" }),
    effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  const pr = (head) => ({ number: 9, url: "https://github.com/acme/app/pull/9", headRefOid: head, baseRefName: "main", author: { __typename: "User", login: "outsider" }, isCrossRepository: true, maintainerCanModify: true, headRepository: { nameWithOwner: "outsider/app" }, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } });
  const main = { name: "main", oid: B, rollup: { contexts: { nodes: [] } } };
  await pass.open("acme/app", main, pr(H2));
  assert.deepEqual([state.get("acme/app", 9).hold, state.get("acme/app", 9).trigger.head], [null, H2], "same patches and modes: a base merge");
  await pass.open("acme/app", main, pr(H3));
  assert.equal(state.get("acme/app", 9).hold?.kind, "stopped", "the script became executable");
});

test("a fleet-triggered adoption's records task is closed when its PR merges; a task-owned PR's opener is not", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "e".repeat(40);
  // Fleet-triggered with no owner and no opener task: only the quiet records task recordTask filed.
  state.put({ repo: "acme/app", number: 20, generation: 1, trigger: { kind: "fleet", event: `all:${H}`, actor: "dev", at: "2026-11-24T09:00:00Z", head: H }, holder: "R20", hold: null });
  // The `handoff: all` adoption that files it in practice (trigger kind "all").
  state.put({ repo: "acme/app", number: 23, generation: 1, trigger: { kind: "all", event: `all:${H}`, actor: "dev", at: "2026-11-24T09:00:00Z", head: H }, holder: "R23", hold: null });
  // A task's PR: its opener task is never ship's to close.
  state.put({ repo: "acme/app", number: 21, generation: 1, trigger: { kind: "fleet", event: "opened:21", actor: "T21", at: "2026-11-24T09:00:00Z", head: H }, task: "T21", owner: { kind: "task", task: "T21" }, hold: null });
  const closes = [], wakes = [];
  const pass = adoptedPass({
    gh: async (method, path) => ({ status: 200, body: path.endsWith("/pulls/21")
      ? { merged_at: "2026-11-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/21", head: { sha: H }, base: { ref: "main" }, user: { login: "dev", type: "User" } }
      : { merged_at: "2026-11-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/20", head: { sha: H }, base: { ref: "main" }, user: { login: "dev", type: "User" } } }),
    state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path, body) => (path.endsWith("/close") && closes.push(path.split("/")[3]), path === "/v1/wakes" && wakes.push(body), {}) },
    decision: async () => ({ do: "wait" }),
    effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { verdict: "wait" }) },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes.sort(), ["R20", "R23"], "each records task, once");
  assert.deepEqual(wakes.map((w) => w.task), ["T21"], "the task's PR tells its task instead of closing it");
});

test("a closed-unmerged adoption's records task is closed, and a kernel refusal is retried next pass", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  state.put({ repo: "acme/app", number: 22, generation: 1, trigger: { kind: "label", event: "e22", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, owner: { kind: "member", login: "maria" }, holder: "R22", hold: null });
  let refuse = true;
  const closes = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: { state: "closed", merged_at: null, html_url: "https://github.com/acme/app/pull/22" } }), state,
    kernel: { call: async (m, path) => { if (path.endsWith("/close")) { closes.push(path.split("/")[3]); if (refuse) throw new Error("kernel 503"); } return {}; } },
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R22"]);
  assert.deepEqual(state.get("acme/app", 22).closing, ["R22"], "the refusal is kept for the next pass");
  refuse = false;
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R22", "R22"], "tried again");
  assert.equal(state.get("acme/app", 22).closing, undefined, "closed: nothing left");
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R22", "R22"], "an ended record is not read again");
});

test("a pending close left by a hold is cleared when the PR merges, so nothing keeps polling it", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "d".repeat(40);
  state.put({ repo: "acme/app", number: 24, generation: 1, trigger: { kind: "label", event: "e24", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, owner: { kind: "member", login: "maria" }, holder: "R24", hold: { kind: "handed_back", reason: "handed back by @maria" }, closing: ["R24"] });
  const closes = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: { merged_at: "2026-11-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/24", head: { sha: H }, base: { ref: "main" }, user: { login: "dev", type: "User" } } }),
    state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path) => (path.endsWith("/close") && closes.push(path.split("/")[3]), {}) },
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict() },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R24"], "closed once by the merged round");
  const kept = state.get("acme/app", 24);
  assert.equal(kept.closing, undefined, "the queue does not outlive the merge");
  assert.equal(kept.tasksClosed, true);
});

test("records that ended before this change are reconciled from their own holder, then left alone", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const counters = { head: "", wakes: 0, rounds: 0, ci: 0, review: 0, red: {} };
  state.put({ repo: "acme/app", number: 25, generation: 1, trigger: { kind: "label", event: "e25", actor: "maria", at: "2026-11-24T09:00:00Z", head: "a".repeat(40) }, owner: { kind: "member", login: "maria" }, holder: "R25", hold: { kind: "handed_back", reason: "its PR was closed" }, counters: { ...counters, lastRound: "closed" } });
  state.put({ repo: "acme/app", number: 26, generation: 1, trigger: { kind: "all", event: "all:x", actor: "dev", at: "2026-11-24T09:00:00Z", head: "b".repeat(40) }, holder: "R26", hold: null, counters: { ...counters, head: "b".repeat(40), lastRound: `${"b".repeat(40)}:done` } });
  const closes = [];
  let reads = 0;
  const pass = adoptedPass({
    gh: async () => (reads++, { status: 200, body: {} }), state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path) => (path.endsWith("/close") && closes.push(path.split("/")[3]), {}) },
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes.sort(), ["R25", "R26"], "a closed record and one merged without closing its holder");
  assert.equal(reads, 0, "their own holder ids are enough: no PR read");
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes.sort(), ["R25", "R26"], "settled: never read or closed again");
});

test("a PR merged into the wrong base is left to a person: neither the landed round nor the reconciler closes its task", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "c".repeat(40);
  state.put({ repo: "acme/app", number: 27, generation: 1, trigger: { kind: "fleet", event: "all:x", actor: "dev", at: "2026-11-24T09:00:00Z", head: H }, holder: "R27", hold: null, queue: { base: "release", attempt: 1, record: "m1" } });
  const closes = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: { merged_at: "2026-11-24T10:00:00Z", html_url: "https://github.com/acme/app/pull/27", head: { sha: H }, base: { ref: "main" }, user: { login: "dev", type: "User" } } }),
    state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path) => (path.endsWith("/close") && closes.push(path.split("/")[3]), {}) },
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict() },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, [], "a person decides what a wrong-base merge means");
});

test("a wrong-base merge recorded before this change is settled without closing its task", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "9".repeat(40);
  state.put({ repo: "acme/app", number: 28, generation: 1, trigger: { kind: "fleet", event: "all:x", actor: "dev", at: "2026-11-24T09:00:00Z", head: H }, holder: "R28", hold: null, queue: { base: "release", attempt: 1, record: "m1" }, counters: { head: H, wakes: 0, rounds: 0, ci: 0, review: 0, red: {}, lastRound: `${H}:done` } });
  const closes = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: { merged_at: "2026-11-24T10:00:00Z", base: { ref: "main" } } }), state,
    settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path) => (path.endsWith("/close") && closes.push(path.split("/")[3]), {}) },
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, verdict: async () => verdict() },
  });
  await pass.gone("acme/app", "main", new Set());
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, [], "a person checks the mismatch");
});

test("a closed PR reopened clears its settled marker, so a second close's failed task close is retried", async () => {
  const state = openState(join(mkdtempSync(join(tmpdir(), "adopted-")), "state.json"));
  const H = "7".repeat(40);
  state.put({ repo: "acme/app", number: 29, generation: 1, trigger: { kind: "label", event: "e29", actor: "maria", at: "2026-11-24T09:00:00Z", head: H }, owner: { kind: "member", login: "maria" }, holder: "R29", hold: null, tasksClosed: true, counters: { head: "", wakes: 0, rounds: 0, ci: 0, review: 0, red: {}, lastRound: "closed" } });
  let closed = false, refuse = true;
  const closes = [];
  const pass = adoptedPass({
    gh: async () => ({ status: 200, body: closed ? { state: "closed", merged_at: null, html_url: "https://github.com/acme/app/pull/29" } : { state: "open", merged_at: null, html_url: "https://github.com/acme/app/pull/29" } }),
    state, settings: () => PRESETS.cautious, paused: () => false, log() {},
    kernel: { call: async (m, path) => { if (path.endsWith("/close")) { closes.push(path.split("/")[3]); if (refuse) throw new Error("kernel 503"); } return {}; } },
    decision: async () => ({ do: "wait" }), effects: { comment: async () => 1, askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict() },
  });
  const pr = { number: 29, url: "https://github.com/acme/app/pull/29", headRefOid: "8".repeat(40), baseRefName: "main", author: { __typename: "User", login: "maria" }, isCrossRepository: false, isDraft: false, labels: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] } };
  await pass.open("acme/app", { name: "main", rollup: { contexts: { nodes: [] } } }, pr);
  assert.equal(state.get("acme/app", 29).tasksClosed, undefined, "the settled marker goes when the PR reopens");
  closed = true;
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R29"]);
  refuse = false;
  await pass.gone("acme/app", "main", new Set());
  assert.deepEqual(closes, ["R29", "R29"], "the refusal is retried rather than skipped as settled");
  assert.equal(state.get("acme/app", 29).tasksClosed, true);
});
