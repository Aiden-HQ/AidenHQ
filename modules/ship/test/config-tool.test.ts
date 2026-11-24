import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyShipChange, configTools } from "../service/src/config-tool.ts";
import { openState } from "../service/src/state.ts";

const scope = { fleet: [], listed: ["a/b"] };
const state = () => openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
const adoption = (n: number, hold: unknown = null) => ({ repo: "a/b", number: n, generation: 1, trigger: { kind: "fleet", event: "e", actor: "x" }, hold }) as any;

test("applyShipChange sets one repo's entry and reports what it loosens; an uncovered repo is refused", () => {
  const raw = { defaults: "cautious", repos: { "a/b": "cautious" } };
  const r = applyShipChange(raw, { repo: "a/b", change: "full", scope });
  assert.deepEqual([r.summary, r.value.repos], [["a/b: ship full"], { "a/b": "full" }]);
  assert.ok(r.loosens.includes("a/b.approve"));
  assert.deepEqual(applyShipChange({}, { repo: "a/b", change: "cautious", scope }).loosens, ["a/b.enabled"]);
  const kept = applyShipChange({ repos: { "a/b": { caps: { usd: 1, rounds: 10 } } } }, { repo: "a/b", change: { caps: { rounds: 5 } }, scope });
  assert.deepEqual((kept.value.repos as any)["a/b"].caps, { usd: 1, rounds: 5 });
  assert.throws(() => applyShipChange(raw, { repo: "a/c", change: "full", scope }), /isn't a repo ship covers/);
});

test("ship_configure files a tightening and refuses a loosening for the owner", async () => {
  const filed: unknown[] = [];
  const tools = (raw: object) => configTools({ raw: () => raw, scope: () => scope, state: state(), maintainerRepos: () => ["a/b"], codeReview: () => ({}), file: async (c) => (filed.push(c), { ok: true }) });
  const caller = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  await tools({ repos: { "a/b": "full" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "cautious" }, caller);
  assert.equal(filed.length, 1);
  await assert.rejects(tools({ repos: { "a/b": "cautious" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "full" }, caller), /owner's to approve/);
});

test("ship_status reads headline settings and holds for the Fleet page", async () => {
  const s = state();
  s.put(adoption(1));
  s.put(adoption(2, { kind: "stalled", reason: "ci rounds" }));
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), scope: () => scope, state: s, maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual([r.paused, r.repos, r.held.length], [false, [{ repo: "a/b", preset: "full", enabled: true, handoff: "all", approve: "all", merge: "ready" }], 1]);
});

test("ship_configure for the owner returns the settings change and files nothing; a new repo covers its three settings", async () => {
  const filed: unknown[] = [];
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => scope, state: state(), maintainerRepos: () => ["a/b"], codeReview: () => ({ repos: [] }), file: async (c) => (filed.push(c), {}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const loosened = (await tool.run({ repo: "a/b", change: { approve: "all" } }, owner)) as any;
  assert.deepEqual(loosened._aidenhq.settings_change.map((c: any) => [c.key, c.value.repos["a/b"].approve]), [["ship", "all"]]);
  const added = (await tool.run({ repo: "x/y", change: "cautious" }, owner)) as any;
  assert.deepEqual(added._aidenhq.settings_change.map((c: any) => c.key), ["maintainer_repos", "code_review", "ship"]);
  assert.deepEqual(added._aidenhq.settings_change[0].value, ["a/b", { repo: "x/y", issues: false }]);
  assert.deepEqual(filed, []);
  await assert.rejects(tool.run({ repo: "x/y", change: "cautious" }, { agent: "x", roles: ["ship-admin"], assertion: "jwt" }), /owner's/);
});

test("removing a listed repo is one change across maintainer_repos, code_review and ship, and the owner's", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => scope, state: state(), maintainerRepos: () => ["a/b", "c/d"], codeReview: () => ({ repos: [{ repo: "a/b" }] }), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ repo: "a/b", remove: true }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change.map((c: any) => c.value), [["c/d"], { repos: [] }, { repos: {} }]);
  await assert.rejects(tool.run({ repo: "a/b", remove: true }, { agent: "x", roles: ["ship-admin"] }), /owner's/);
});
