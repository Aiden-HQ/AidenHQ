import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "../service/src/settings.ts";
import { applyShipChange, configTools } from "../service/src/config-tool.ts";
import { openState } from "../service/src/state.ts";

const scope = { fleet: [] };
const state = () => openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
const adoption = (n: number, hold: unknown = null) => ({ repo: "a/b", number: n, generation: 1, trigger: { kind: "fleet", event: "e", actor: "x" }, hold }) as any;

test("applyShipChange sets one repo's entry and reports what it loosens; a new entry is a loosening", () => {
  const raw = { defaults: "cautious", repos: { "a/b": "cautious" } };
  const r = applyShipChange(raw, { repo: "a/b", change: "full", scope });
  assert.deepEqual([r.summary, r.value.repos], [["a/b: ship full"], { "a/b": "full" }]);
  assert.ok(r.loosens.includes("a/b.by_tier.standard.approve"));
  assert.deepEqual(applyShipChange({}, { repo: "a/b", change: "cautious", scope }).loosens, ["a/b.enabled"]);
  const kept = applyShipChange({ repos: { "a/b": { caps: { usd: 1, rounds: 10 } } } }, { repo: "a/b", change: { caps: { rounds: 5 } }, scope });
  assert.deepEqual((kept.value.repos as any)["a/b"].caps, { usd: 1, rounds: 5 });
  assert.deepEqual(applyShipChange(raw, { repo: "a/c", change: "full", scope }).loosens.filter((l) => l.startsWith("a/c")), ["a/c.enabled"]);
});

test("ship_configure files a tightening and refuses a loosening for the owner", async () => {
  const filed: unknown[] = [];
  const tools = (raw: object) => configTools({ raw: () => raw, scope: () => scope, state: state(), file: async (c) => (filed.push(c), { ok: true }) });
  const caller = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  await tools({ repos: { "a/b": "full" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "cautious" }, caller);
  assert.equal(filed.length, 1);
  await assert.rejects(tools({ repos: { "a/b": "cautious" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "full" }, caller), /owner's to approve/);
});

test("ship_status reads headline settings and holds for the Fleet page", async () => {
  const s = state();
  s.put(adoption(1));
  s.put(adoption(2, { kind: "stalled", reason: "ci rounds" }));
  s.put({ ...adoption(3, { kind: "handed_back", reason: "its PR was closed" }), counters: { lastRound: "closed" } });
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), scope: () => scope, state: s, file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  const { settings, own, inherits, ...row } = r.repos[0];
  assert.deepEqual([r.paused, row, r.held.length, settings.caps.usd, r.defaults.preset, r.defaults.settings.caps.usd], [false, { repo: "a/b", removable: true, preset: "full", enabled: true, handoff: "all", by_tier: PRESETS.full.by_tier, unwatched: { merge: "ready" }, actions: {}, over: [] }, 1, null, "cautious", 5]);
});

test("ship_configure for the owner returns the settings change and files nothing; Add writes only Ship's own list", async () => {
  const filed: unknown[] = [];
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious" } }), scope: () => scope, state: state(), file: async (c) => (filed.push(c), {}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const loosened = (await tool.run({ repo: "a/b", change: { by_tier: { sensitive: { approve: "on" } } } }, owner)) as any;
  assert.deepEqual(loosened._aidenhq.settings_change.map((c: any) => [c.key, c.value.repos["a/b"].by_tier]), [["ship", { sensitive: { approve: "on" } }]]);
  const added = (await tool.run({ repo: "x/y", add: true }, owner)) as any;
  assert.deepEqual(added._aidenhq.settings_change, [{ kind: "setting", key: "ship", value: { repos: { "a/b": "cautious", "x/y": {} } } }]);
  assert.deepEqual(filed, []);
  await assert.rejects(tool.run({ repo: "x/y", add: true }, { agent: "x", roles: ["ship-admin"], assertion: "jwt" }), /owner's/);
  await assert.rejects(tool.run({ repo: "x/y", change: "cautious" }, owner), /isn't on Ship yet/);
  // A change adds the entry with its own settings, in the one proposal.
  const ship = (r: any) => r._aidenhq.settings_change.find((c: any) => c.key === "ship").value.repos;
  assert.deepEqual(ship(await tool.run({ repo: "x/y", add: true, change: { preset: "full", caps: { usd: 3 } } }, owner))["x/y"], { preset: "full", caps: { usd: 3 } });
  // Add repo on a repo that already has an entry never resets it.
  await assert.rejects(tool.run({ repo: "A/B", add: true }, owner), /already on ship/);
});

test("an agent never adds a repo to Ship or drops one, whatever the shape (the ship tool is the only gate on Ship's list)", async () => {
  const filed: unknown[] = [];
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), scope: () => ({ fleet: ["org/*"] }), state: state(), file: async (c) => (filed.push(c), {}) }).find((t) => t.name === "ship_configure")!;
  const agent = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  for (const a of [{ repo: "x/y", change: {} }, { repo: "x/y", change: "cautious" }, { repo: "X/Y", change: { enabled: false } }, { edits: { repos: { "x/y": {} } } }, { edits: { repos: { "a/b": "cautious", "x/y": "cautious" } } }, { repo: "x/y", add: true }, { repo: "A/B", change: null }, { edits: { repos: { "a/b": null } } }])
    await assert.rejects(tool.run(a, agent), /owner's|isn't on Ship yet/, JSON.stringify(a));
  assert.deepEqual(filed, []);
  // A fleet repo needs no entry to be covered: tightening it is the agent's.
  await tool.run({ repo: "org/app", change: { enabled: false } }, agent);
  assert.equal(filed.length, 1);
});

test("removing a repo drops only its ship entry, and is the owner's", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious", "c/d": "full" } }), scope: () => ({ fleet: ["org/*"] }), state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const r = (await tool.run({ repo: "A/B", remove: true }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change, [{ kind: "setting", key: "ship", value: { repos: { "c/d": "full" } } }]);
  await assert.rejects(tool.run({ repo: "a/b", remove: true }, { agent: "x", roles: ["ship-admin"] }), /owner's/);
  await assert.rejects(tool.run({ repo: "org/app", remove: true }, owner), /no entry of its own/);
});

test("ship_configure merges several edits (a repo's fields, another repo, the pause) into one proposal", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": "cautious", "c/d": {} } }), scope: () => ({ fleet: [] }), state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ edits: { repos: { "a/b": { preset: "full", by_tier: { trivial: { approve: "observe" } } }, "c/d": { unwatched: { merge: "off" } } }, paused: true } }, { agent: "", roles: [], kind: "owner" })) as any;
  const [ship, pause] = r._aidenhq.settings_change;
  assert.deepEqual([ship.key, ship.value.repos["a/b"], ship.value.repos["c/d"], "paused" in ship.value, pause], ["ship", { preset: "full", by_tier: { trivial: { approve: "observe" } } }, { unwatched: { merge: "off" } }, false, { kind: "setting", key: "ship_paused", value: true }]);
});

test("the pause is its own setting and works whatever the entries hold; a broken entry still goes on its own", async () => {
  const raw = { repos: { "a/b": "cautious", "a/gone": "cautios" } };
  const tool = configTools({ raw: () => raw, scope: () => scope, state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const owner = { agent: "", roles: [], kind: "owner" };
  const paused = (await tool.run({ paused: true }, owner)) as any;
  assert.deepEqual(paused._aidenhq.settings_change, [{ kind: "setting", key: "ship_paused", value: true }]);
  const gone = (await tool.run({ repo: "a/gone", remove: true }, owner)) as any;
  assert.deepEqual(gone._aidenhq.settings_change[0].value.repos, { "a/b": "cautious" });
  // An agent can pause but not resume, whatever state this service last saw.
  const agent = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  const resume = configTools({ raw: () => ({ ...raw, paused: true }), scope: () => scope, state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  await assert.rejects(resume.run({ paused: false }, agent), /paused/);
  await assert.rejects(tool.run({ paused: false }, agent), /paused/);
});

test("ship_status lists the fleet's named repos that inherit the defaults, and which fields an entry sets itself", async () => {
  const tool = configTools({ raw: () => ({ repos: { "a/b": { unwatched: { merge: "off" } } } }), scope: () => ({ fleet: ["org/*", "org/product"] }), state: state(), file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual(r.repos.map((x: any) => [x.repo, x.preset, x.enabled, x.over]), [["a/b", "cautious", true, ["unwatched"]], ["org/product", "cautious", true, []]]);
});

test("a cap edit and a reset make the right proposal: caps merge field by field, a reset drops the field so the preset applies", async () => {
  const raw = { repos: { "a/b": { preset: "cautious", by_tier: { trivial: { approve: "observe" }, sensitive: { merge: "off" } }, caps: { usd: 1, rounds: 10 } } } };
  const tool = configTools({ raw: () => raw, scope: () => scope, state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  const r = (await tool.run({ edits: { repos: { "a/b": { caps: { usd: 2 }, reset: ["by_tier.trivial.approve", "caps.rounds"] } } } }, { agent: "", roles: [], kind: "owner" })) as any;
  assert.deepEqual(r._aidenhq.settings_change, [{ kind: "setting", key: "ship", value: { repos: { "a/b": { preset: "cautious", by_tier: { sensitive: { merge: "off" } }, caps: { usd: 2 } } } } }]);
  assert.match(r.changes[0], /caps, reset by_tier\.trivial\.approve, caps\.rounds/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["preset"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["caps.usd_"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { reset: ["caps.usd.x"] }, scope }), /can't reset/);
  assert.throws(() => applyShipChange(raw, { repo: "a/b", change: { caps: { usd: 1 }, reset: "caps.usd" }, scope }), /list of fields/);
});

test("a malformed tier cell is refused, never dropped", () => {
  assert.throws(() => applyShipChange({ repos: { "a/b": "cautious" } }, { repo: "a/b", change: { by_tier: { sensitive: "off" } }, scope }), /by_tier\.sensitive/);
});
