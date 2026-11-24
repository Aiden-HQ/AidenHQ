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
  const { settings, own, inherits, ...row } = r.repos[0];
  assert.deepEqual([r.paused, row, r.held.length, settings.caps.usd, r.defaults.preset, r.defaults.settings.caps.usd], [false, { repo: "a/b", preset: "full", enabled: true, handoff: "all", approve: "all", merge: "ready", actions: {}, over: [] }, 1, null, "cautious", 5]);
});

test("ship_configure for the owner returns the settings change and files nothing; a new repo covers its three settings", async () => {
  const filed: unknown[] = [];
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => scope, state: state(), maintainerRepos: () => ["a/b"], codeReview: () => ({ repos: [] }), file: async (c) => (filed.push(c), {}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const loosened = (await tool.run({ repo: "a/b", change: { approve: "all" } }, owner)) as any;
  assert.deepEqual(loosened._aidenhq.settings_change.map((c: any) => [c.key, c.value.repos["a/b"].approve]), [["ship", "all"]]);
  const added = (await tool.run({ repo: "x/y", add: true }, owner)) as any;
  assert.deepEqual(added._aidenhq.settings_change.map((c: any) => c.key), ["maintainer_repos", "code_review", "ship"]);
  assert.deepEqual(added._aidenhq.settings_change[0].value, ["a/b", { repo: "x/y", issues: false }]);
  assert.deepEqual(filed, []);
  await assert.rejects(tool.run({ repo: "x/y", add: true }, { agent: "x", roles: ["ship-admin"], assertion: "jwt" }), /owner's/);
  await assert.rejects(tool.run({ repo: "x/y", change: "cautious" }, owner), /isn't covered yet/);
  // Add repo on a repo that already has an entry never resets it.
  await assert.rejects(tool.run({ repo: "a/b", add: true }, owner), /already on ship/);
});

test("removing a listed repo is one change across maintainer_repos, code_review and ship, and the owner's", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => scope, state: state(), maintainerRepos: () => ["a/b", "c/d"], codeReview: () => ({ repos: [{ repo: "a/b" }] }), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ repo: "a/b", remove: true }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change.map((c: any) => c.value), [["c/d"], { repos: [] }, { repos: {} }]);
  await assert.rejects(tool.run({ repo: "a/b", remove: true }, { agent: "x", roles: ["ship-admin"] }), /owner's/);
});

test("ship_configure merges several edits (a repo's fields, another repo, the pause) into one proposal", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => ({ fleet: [], listed: ["a/b", "c/d"] }), state: state(), maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ edits: { repos: { "a/b": { preset: "full", approve: "safe" }, "c/d": { merge: "off" } }, paused: true } }, { agent: "", roles: [], kind: "owner" })) as any;
  const [ship, pause] = r._aidenhq.settings_change;
  assert.deepEqual([ship.key, ship.value.repos["a/b"], ship.value.repos["c/d"], "paused" in ship.value, pause], ["ship", { preset: "full", approve: "safe" }, { merge: "off" }, false, { kind: "setting", key: "ship_paused", value: true }]);
});

test("the pause is its own setting and works whatever the entries hold; an orphan entry blocks nothing but itself", async () => {
  // a/gone left the Maintainer (outside the scope) and its entry is a typo'd preset: the pause, another repo's edit and the orphan's removal still go.
  const raw = { repos: { "a/b": "cautious", "a/gone": "cautios" } };
  const tool = configTools({ raw: () => raw, scope: () => scope, state: state(), maintainerRepos: () => ["a/b"], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const paused = (await tool.run({ paused: true }, owner)) as any;
  assert.deepEqual(paused._aidenhq.settings_change, [{ kind: "setting", key: "ship_paused", value: true }]);
  const edit = (await tool.run({ repo: "a/b", change: { merge: "off" } }, owner)) as any;
  assert.deepEqual(edit._aidenhq.settings_change.map((c: any) => [c.key, "paused" in c.value]), [["ship", false]]);
  const gone = (await tool.run({ repo: "a/gone", remove: true }, owner)) as any;
  assert.deepEqual(gone._aidenhq.settings_change[0].value.repos, { "a/b": "cautious" });
  // Edits to the orphan itself still fail, and an agent can pause but not resume.
  await assert.rejects(tool.run({ repo: "a/gone", change: "full" }, owner), /isn't a repo ship covers|isn't covered/);
  const agent = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  const resume = configTools({ raw: () => ({ ...raw, paused: true }), scope: () => scope, state: state(), maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  await assert.rejects(resume.run({ paused: false }, agent), /paused/);
  // Whatever state this service last saw: an agent never resumes.
  const stale = configTools({ raw: () => raw, scope: () => scope, state: state(), maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  await assert.rejects(stale.run({ paused: false }, agent), /paused/);
  // Add repo on a repo the Maintainer already lists adds only its ship entry (no second maintainer_repos entry).
  const listed = configTools({ raw: () => ({ repos: {} }), scope: () => scope, state: state(), maintainerRepos: () => [{ repo: "a/b", issues: true }], codeReview: () => ({ repos: [{ repo: "a/b" }] }), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const added = (await listed.run({ repo: "A/B", add: true }, owner)) as any;
  assert.deepEqual(added._aidenhq.settings_change.map((c: any) => c.key), ["ship"]);
});

test("ship_status lists the fleet's named repos that inherit the defaults, and which fields an entry sets itself", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": { merge: "off" } } }), scope: () => ({ fleet: ["org/*", "org/product"], listed: ["a/b"] }), state: state(), maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual(r.repos.map((x: any) => [x.repo, x.preset, x.enabled, x.over]), [["a/b", "cautious", true, ["merge"]], ["org/product", "cautious", true, []]]);
});

test("a cap edit and a reset make the right proposal: caps merge field by field, a reset drops the field so the preset applies", async () => {
  const raw = { repos: { "a/b": { preset: "cautious", approve: "safe", caps: { usd: 1, rounds: 10 } } } };
  const tool = configTools({ raw: () => raw, scope: () => scope, state: state(), maintainerRepos: () => [], codeReview: () => ({}), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ edits: { repos: { "a/b": { caps: { usd: 2 }, reset: ["approve", "caps.rounds"] } } } }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change, [{ kind: "setting", key: "ship", value: { repos: { "a/b": { preset: "cautious", caps: { usd: 2 } } } } }]);
  assert.match(r.changes[0], /caps, reset approve, caps\.rounds/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["preset"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["caps.usd_"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["caps.usd.x"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { caps: { usd: 1 }, reset: "caps.usd" }, scope }), /list of fields/);
});
