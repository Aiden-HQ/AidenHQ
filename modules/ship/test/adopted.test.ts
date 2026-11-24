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
