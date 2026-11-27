// The cost reports end to end: calls written as the gateway writes them (a reservation settled, one swept as cut off and then
// trued up, a failure, a system call, old calls), a restart's prune, and what POST /v1/costs/<report> serves the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway/lib.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const close = (n) => Math.round(n * 1e6) / 1e6;

test("cost reports: the rollup follows every write and the prune, and serves the page's figures", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "costs-"));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: {} }));
  writeFileSync(join(dir, "gateway.json"), "{}");
  const now = Date.parse("2026-11-20T10:07:00.000Z");
  // The first start is two months back, so every call was within the ledger's 62 days when it was written.
  let clock = now - 60 * 864e5;
  const open = () => createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => (n === "gateway_board_key" ? "gw-board" : ""), now: () => clock });
  let gw = open();
  const iso = (ms) => new Date(ms).toISOString();
  const add = (key, at, { run = "j-1", agent = "ag1", issue = "iss1", kind = "agent", model = "m1", cost = 0.1, ms = 1000, status = "ok" } = {}) =>
    gw.db.prepare("INSERT OR IGNORE INTO calls (key, at, day, run_key, run_id, agent_id, issue_id, task_subject, kind, component, model, input, cached, output, cost_usd, ms, status, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 10, 1, ?, ?, ?, 'x')")
      .run(key, at, at.slice(0, 10), `rk-${run ?? key}`, run, agent, issue, issue, kind, kind, model, cost, ms, status);
  add("a", "2026-11-20T10:01:00.000Z");
  // A reservation counts once settled, at its settled time and amount; an ignored retry of its insert counts nothing.
  add("r", "2026-11-20T09:58:00.000Z", { status: "reserved", cost: 9, ms: null });
  add("r", "2026-11-20T09:58:00.000Z", { status: "reserved", cost: 9, ms: null });
  gw.db.prepare("UPDATE calls SET key = 'b', at = '2026-11-20T10:05:00.000Z', cost_usd = 0.2, ms = 3000, status = 'ok' WHERE key = 'r' AND status = 'reserved'").run();
  // Cut off: swept as unsettled (a hold: no dollars), then trued up from OpenRouter's record on another model.
  add("c", "2026-11-20T10:03:00.000Z", { status: "reserved", cost: 0.5, ms: null });
  gw.db.prepare("UPDATE calls SET status = 'unsettled', at = '2026-11-20T10:04:00.000Z' WHERE key = 'c' AND status = 'reserved'").run();
  // In flight: not reported until the restart below closes it as cut off (its kernel is gone), at the restart's time.
  add("in-flight", "2026-11-20T10:06:00.000Z", { status: "reserved", cost: 7, ms: null });
  add("d", "2026-11-20T09:40:00.000Z", { run: "j-2", agent: "ag2", issue: null, cost: null, ms: null, status: "upstream_502" });
  add("e", "2026-11-20T09:50:00.000Z", { run: null, agent: null, issue: null, kind: "reviewer", cost: 0.01 });
  add("old", iso(now - 50 * 864e5), { run: "j-0", cost: 1 });
  add("ancient", iso(now - 70 * 864e5), { run: "j-0", cost: 100 });

  const report = async (name, body, key = "gw-board") => {
    const res = await fetch(`${front.url}/v1/costs/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  let front = await serve((req, res) => gw.handle(req, res));
  const callsOf = async (run) => (await report("calls", { run })).body.map((r) => [r.key, r.status, r.costUsd]);
  assert.deepEqual(await callsOf("j-1"), [["a", "ok", 0.1], ["c", "unsettled", null], ["b", "ok", 0.2]]);
  gw.db.prepare("UPDATE calls SET status = 'interrupted', model = 'm2', cost_usd = 0.05 WHERE key = 'c' AND status = 'unsettled'").run();
  assert.deepEqual(await callsOf("j-1"), [["a", "ok", 0.1], ["c", "interrupted", 0.05], ["b", "ok", 0.2]]);

  // A restart prunes: buckets 62 days back go whole, with their calls; the 50-day-old call stays, in both.
  front.s.close();
  gw.close();
  clock = now;
  gw = open();
  front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { front.s.close(); gw.close(); });
  assert.deepEqual(gw.db.prepare("SELECT key FROM calls WHERE key IN ('old', 'ancient')").all().map((r) => r.key), ["old"]);
  assert.deepEqual((await callsOf("j-0")).map(([k]) => k), ["old"]);

  assert.equal((await report("summary", { from: iso(now - 60 * 864e5), to: iso(now) }, "nope")).status, 401);
  assert.equal((await report("summary", { from: iso(now - 864e5), to: iso(now), offset: 7 })).status, 400);
  const W = [[iso(now - 864e5), iso(now)], [iso(now - 60 * 864e5), iso(now - 864e5)]];
  const { status, body: s } = await report("summary", { from: iso(now - 60 * 864e5), to: iso(now), bucket: "day", offset: 330, windows: W, order: [iso(now - 30 * 864e5), iso(now)], top: 5, loop: 3 });
  assert.equal(status, 200);
  assert.equal(s.earliest, iso(now - 50 * 864e5));
  const sum = (k) => close(s.groups.reduce((n, g) => n + g[k], 0));
  assert.deepEqual([sum("calls"), sum("usd"), sum("errors"), sum("interrupted"), sum("msN"), sum("msSum")], [7, 1.36, 1, 2, 4, 6000]);
  assert.deepEqual(s.groups.filter((g) => g.agentId === null).map((g) => [g.model, g.lane, g.calls]), [["m1", "reviewer", 1]]);
  // The viewer's days at +05:30: 10:01 UTC is 15:31 there, the same day; the old call is its own day.
  assert.deepEqual(s.series.map((x) => [x.t, x.model, close(x.usd), x.calls]).sort(), [["2026-10-01", "m1", 1, 1], ["2026-11-20", "m1", 0.31, 5], ["2026-11-20", "m2", 0.05, 1]]);
  assert.deepEqual(s.windows.map((w) => [close(w.usd), w.calls]), [[0.36, 6], [1, 1]]);
  assert.deepEqual(s.modelOrder, ["m1", "m2"]);
  assert.deepEqual([s.tasks.count, close(s.tasks.usd), s.tasks.top.map((x) => [x.issueId, x.agentId, close(x.usd), x.calls])], [1, 1.35, [["iss1", "ag1", 1.35, 5]]]);
  assert.deepEqual(s.failed, [{ agentId: "ag2", status: "upstream_502", calls: 1, usd: 0 }]);
  assert.deepEqual(s.loops.map((x) => [x.runId, x.calls, close(x.usd), x.first, x.last]), [["j-1", 4, 0.35, "2026-11-20T10:01:00.000Z", "2026-11-20T10:07:00.000Z"]]);

  // A task's usage: its job's span is its first call to its last; the calls that name no task, apart.
  const runs = (await report("runs", { issues: ["iss1", "WOR-1"], from: iso(now - 864e5) })).body;
  assert.deepEqual(runs.tasks.map((x) => [x.issueId, x.calls, close(x.usd), x.jobs, x.jobMs]), [["iss1", 4, 0.35, 1, 6 * 60_000]]);
  assert.deepEqual([close(runs.unattributed.usd), runs.unattributed.calls], [0.01, 2]);
  assert.deepEqual((await report("issues", { ids: ["iss1"] })).body.map((x) => [x.issueId, x.tokens, close(x.usd)]), [["iss1", 5 * 111, 1.35]]);
  assert.deepEqual((await report("daily", { from: iso(now - 864e5), to: iso(now) })).body.map((x) => [x.agentId, x.day, close(x.usd), x.calls, x.priced]).sort(), [[null, "2026-11-20", 0.01, 1, 1], ["ag1", "2026-11-20", 0.35, 4, 3], ["ag2", "2026-11-20", 0, 1, 0]]);
  const top = (await report("top", { from: iso(now - 864e5), to: iso(now), agent: "ag1" })).body;
  assert.deepEqual([top.total.calls, top.split.map((x) => x.a), top.runs.map((x) => x.a), top.noTask, top.noRun], [4, ["m1", "m2"], ["j-1"], 0, 0]);
});
