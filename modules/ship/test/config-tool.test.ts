import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handler } from "../service/src/api.ts";
import { applyShipChange, configTools } from "../service/src/config-tool.ts";
import { openState } from "../service/src/state.ts";

const covered = ["a/b"];
const state = () => openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));
const adoption = (n: number, hold: unknown = null) => ({ repo: "a/b", number: n, generation: 1, trigger: { kind: "fleet", event: "e", actor: "x" }, hold }) as any;

test("applyShipChange sets one repo's entry and reports what it loosens; an uncovered repo is refused", () => {
  const raw = { defaults: "cautious", repos: {} };
  const r = applyShipChange(raw, { repo: "a/b", change: "full", covered });
  assert.deepEqual([r.summary, r.value.repos], [["a/b: ship full"], { "a/b": "full" }]);
  assert.ok(r.loosens.includes("a/b.approve"));
  assert.throws(() => applyShipChange(raw, { repo: "a/c", change: "full", covered }), /isn't a repo ship covers/);
});

test("ship_configure files a tightening and refuses a loosening for the owner", async () => {
  const filed: unknown[] = [];
  const tools = (raw: object) => configTools({ raw: () => raw, covered: () => covered, gated: () => undefined, state: state(), file: async (c) => (filed.push(c), { ok: true }) });
  const caller = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  await tools({ repos: { "a/b": "full" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "cautious" }, caller);
  assert.equal(filed.length, 1);
  await assert.rejects(tools({ repos: { "a/b": "cautious" } }).find((t) => t.name === "ship_configure")!.run({ repo: "a/b", change: "full" }, caller), /owner's to approve/);
});

test("ship_status reads holds and per-repo adoption counts for the Fleet page", async () => {
  const s = state();
  s.put(adoption(1));
  s.put(adoption(2, { kind: "stalled", reason: "ci rounds" }));
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), covered: () => covered, gated: () => undefined, state: s, file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual([r.adoptions, r.metrics, r.repos[0].approve, r.held.length], [{ total: 2, stalled: 1, handed_back: 0, stopped: 0 }, [{ repo: "a/b", adopted: 2, held: 1 }], "all", 1]);
});

test("the generation check answers the github module only", async () => {
  const s = state();
  s.put(adoption(3));
  const srv = createServer(handler({ state: s, isModule: async (a, m) => a === `Bearer ${m}` })).listen(0);
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const get = (auth: string) => fetch(`${base}/v1/generation?repo=a/b&pr=3`, { headers: { authorization: auth } }).then(async (r) => [r.status, await r.json()]);
  try {
    assert.deepEqual(await get("Bearer github"), [200, { generation: 1, hold: null }]);
    assert.equal((await get("Bearer board"))[0], 401);
  } finally { srv.close(); }
});
