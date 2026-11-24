import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitted } from "../service/src/admission.ts";
import { handler } from "../service/src/api.ts";
import { applyShipChange, configTools, stamp } from "../service/src/config-tool.ts";
import { openState } from "../service/src/state.ts";

const covered = ["a/b"];
const state = () => openState(join(mkdtempSync(join(tmpdir(), "ship-")), "state.json"));

test("applyShipChange sets one repo's entry, refuses a stale read and reports what it loosens", () => {
  const raw = { defaults: "cautious", repos: {} };
  const r = applyShipChange(raw, { repo: "a/b", change: "full", readAt: stamp(raw), covered });
  assert.deepEqual([r.summary, r.value.repos], [["a/b: ship full"], { "a/b": "full" }]);
  assert.ok(r.loosens.includes("a/b.approve"));
  assert.throws(() => applyShipChange({ repos: { "a/b": "full" } }, { repo: "a/b", change: null, readAt: stamp(raw), covered }), /read again/);
  assert.throws(() => applyShipChange(raw, { repo: "a/c", change: "full", readAt: stamp(raw), covered }), /isn't a repo ship covers/);
});

test("ship_configure files a tightening and refuses a loosening for the owner", async () => {
  const raw = { repos: { "a/b": "full" } };
  const filed: unknown[] = [];
  const tool = configTools({ raw: () => raw, covered: () => covered, gated: () => undefined, state: state(), file: async (c) => (filed.push(c), { ok: true }) }).find((t) => t.name === "ship_configure")!;
  const caller = { agent: "x", roles: ["ship-admin"], assertion: "jwt" };
  await tool.run({ repo: "a/b", change: "cautious", read_at: stamp(raw) }, caller);
  assert.equal(filed.length, 1);
  await assert.rejects(tool.run({ repo: "a/b", change: { caps: { usd: null } }, read_at: stamp({ repos: { "a/b": "cautious" } }) }, caller), /read again/);
  const cautious = { repos: { "a/b": "cautious" } };
  const t2 = configTools({ raw: () => cautious, covered: () => covered, gated: () => undefined, state: state(), file: async () => ({}) }).find((t) => t.name === "ship_configure")!;
  await assert.rejects(t2.run({ repo: "a/b", change: "full", read_at: stamp(cautious) }, caller), /owner's to approve/);
});

test("ship_status reads status and per-repo metrics for the Fleet page", async () => {
  const s = state();
  s.put({ repo: "a/b", number: 1, generation: 1, trigger: { kind: "fleet", event: "e", actor: "x" }, status: "merged" });
  s.put({ repo: "a/b", number: 2, generation: 1, trigger: { kind: "fleet", event: "e", actor: "x" }, status: "stalled" });
  const tool = configTools({ raw: () => ({ repos: { "a/b": "full" } }), covered: () => covered, gated: () => undefined, state: s, file: async () => ({}) }).find((t) => t.name === "ship_status")!;
  const r = (await tool.run({}, { agent: "x", roles: [] })) as any;
  assert.deepEqual([r.adoptions.merged, r.adoptions.stalled, r.metrics, r.repos[0].approve, r.open.length], [1, 1, [{ repo: "a/b", adopted: 2, merged: 1, stalled: 1, merges_per_adoption: 0.5 }], "all", 1]);
});

test("admission: an external PR waits for a trusted hand-off; a member's, an uncovered repo's and external: any are admitted", () => {
  const s = state(), raw = { repos: {} };
  const pr = { repo: "a/b", number: 7, fork: true, member: false };
  assert.equal(admitted(raw, covered, s, pr).admitted, false);
  assert.equal(admitted(raw, covered, s, { ...pr, fork: false, member: true }).admitted, true);
  assert.equal(admitted(raw, ["x/y"], s, pr).admitted, true);
  assert.equal(admitted({ repos: { "a/b": { external: "any" } } }, covered, s, pr).admitted, true);
  s.put({ repo: "a/b", number: 7, generation: 1, trigger: { kind: "label", event: "e1", actor: "maint" }, status: "working" });
  assert.equal(admitted(raw, covered, s, pr).admitted, true);
});

test("the HTTP API: admission answers only code review, the board's token reads settings and previews a change", async () => {
  const raw = { defaults: "cautious", repos: { "a/b": "cautious" } };
  const api = handler({ raw: () => raw, covered: () => covered, gated: () => undefined, state: state(), token: () => "board", isModule: async (a, m) => a === `Bearer ${m}` });
  const srv = createServer(api).listen(0);
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const get = (p: string, auth: string, body?: unknown) => fetch(base + p, { method: body ? "POST" : "GET", headers: { authorization: auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => [r.status, await r.json() as any]);
  try {
    assert.deepEqual(await get("/v1/admitted?repo=a/b&pr=3&fork=1&member=0", "Bearer code-review"), [200, { admitted: false, why: "an external PR waits for a trusted member to hand it off" }]);
    assert.equal((await get("/v1/admitted?repo=a/b&pr=3", "Bearer board"))[0], 401);
    const [, s] = await get("/settings", "Bearer board");
    assert.equal(s.repos["a/b"].approve, "safe");
    const [, p] = await get("/settings/preview", "Bearer board", { repo: "a/b", change: "full", read_at: s.read_at });
    assert.deepEqual([p.owner, p.change.key, p.change.value.repos["a/b"]], [true, "ship", "full"]);
    assert.equal((await get("/settings/preview", "Bearer board", { repo: "a/b", change: "full", read_at: "old" }))[0], 400);
    assert.deepEqual((await get("/status", "Bearer board"))[1].repos, [{ repo: "a/b", handoff: "label", approve: "safe", merge: "ready" }]);
  } finally { srv.close(); }
});
