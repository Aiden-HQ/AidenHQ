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
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), scope: () => scope, state: s, file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual([r.paused, r.repos, r.held.length], [false, [{ repo: "a/b", enabled: true, handoff: "all", approve: "all", merge: "ready" }], 1]);
});
