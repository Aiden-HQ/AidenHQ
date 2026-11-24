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
