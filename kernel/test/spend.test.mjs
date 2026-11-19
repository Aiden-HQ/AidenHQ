// Spend (spec §5.12) end to end against a fake upstream: reservations in one transaction (A11), settlement and fail
// closed (A12), and the ledger's move from the old data/gateway/usage.db into kernel.db, with the caps it carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createGateway, openLedger, ownerOf } from "../src/gateway/lib.ts";
import { mintToken } from "../src/gateway/token.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closedPort = async () => { const x = await serve(() => {}); await new Promise((r) => x.s.close(r)); return x.url; };
// $1 per million output tokens, input free: a call asking for 10,000 output tokens reserves exactly $0.01.
const MODELS = { models: { flat: { in: 0, cached_in: 0, out: 1, peak: 1, max_output: 10_000 }, priced: { in: 1, cached_in: 0.1, out: 2, peak: 1, max_output: 10_000 } } };

/** A gateway on `dir`'s kernel.db with one job agent `ag` (day cap `dayUsd`), and an upstream `answer(body, res)`. Every secret is "js". */
async function rig(t, { dayUsd = 30, answer, dir = mkdtempSync(join(tmpdir(), "spend-")), legacy, agents } = {}) {
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: agents ?? { ag: { key: "eng", caps: { run_usd: 30, task_usd: 30, day_usd: dayUsd } } } }));
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(MODELS));
  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const body = JSON.parse(b); seen.push(body); answer(body, res, seen.length); });
  });
  const open = () => createGateway({ dbFile: join(dir, "kernel.db"), legacyDbFile: legacy, grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: upstream.url, jobLive: () => true, now: () => Date.parse("2026-11-16T10:00:00Z") });
  const gw = open();
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); try { gw.close(); } catch {} });
  const call = async (body, issueId = "WOR-1") => {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job: `j-${issueId}`, agentId: "ag", issueId }, Date.parse("2026-11-16T10:00:00Z"))}` }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const rows = () => gw.db.prepare("SELECT key, status, cost_usd, input, cached, output FROM calls ORDER BY rowid").all();
  return { dir, gw, open, call, seen, rows };
}
const usage = (cost, extra = {}) => (body, res, n) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${n}`, model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 500, cost, ...extra } }));

test("A11: 20 parallel calls with budget for 3: exactly 3 reserved and run, the rest refused", async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  // Day cap $0.0305: three $0.01 reservations fit; the fourth would have $0.0005 left, under its least output (1024 tokens).
  const r = await rig(t, { dayUsd: 0.0305, answer: (body, res, n) => held.then(() => usage(0.002)(body, res, n)) });
  let refusedSoFar = 0;
  const calls = Array.from({ length: 20 }, (_, i) => r.call({ model: "flat", max_tokens: 10_000, messages: [] }, `WOR-${i}`).then((c) => ((refusedSoFar += c.status === 402), c)));
  for (let i = 0; i < 100 && refusedSoFar < 17; i++) await sleep(50); // the upstream holds the calls it got
  await sleep(50);
  assert.equal(r.seen.length, 3);
  release();
  const out = await Promise.all(calls);
  assert.deepEqual(out.map((c) => c.status).sort(), [...Array(3).fill(200), ...Array(17).fill(402)]);
  for (const c of out.filter((c) => c.status === 402)) assert.match(c.json.error.message, /^spend cap reached: agent-day \$0\.03 of \$0\.03;/);
  // Settled at what the upstream billed ($0.002 each): the day has room again, and the next call runs.
  assert.deepEqual(r.rows().filter((x) => x.status === "ok").map((x) => x.cost_usd), [0.002, 0.002, 0.002]);
  assert.equal((await r.call({ model: "flat", max_tokens: 10_000, messages: [] })).status, 200);
});

test("caps keep their values: at the day cap refused, a reservation past it refused, bounded output, true cost settled", async (t) => {
  const r = await rig(t, { dayUsd: 0.05, answer: usage(0.03) });
  // The first call asks for 20,000 output tokens: cut to the model's 10,000. It settles at the $0.03 billed.
  assert.equal((await r.call({ model: "flat", max_tokens: 20_000, messages: [] })).status, 200);
  assert.equal(r.seen[0].max_tokens, 10_000);
  // $0.02 left: the second call's 10,000 tokens ($0.01) fit as asked. Billed $0.03 again: the day is at $0.06, past its cap.
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 200);
  assert.equal(r.seen[1].max_tokens, 10_000);
  const refused = await r.call({ model: "flat", messages: [] });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /^spend cap reached: agent-day \$0\.06 of \$0\.05;/);
  assert.equal(r.seen.length, 2);
  // Admission reads the same caps: no new job for this agent today, on any task.
  assert.deepEqual(r.gw.exhausted("ag", "WOR-9").map((o) => o.scope), ["day"]);
  // A cap with room for some output, not all: the call is cut to what is left, never past it.
  const s = await rig(t, { dayUsd: 0.005, answer: usage(0.001) });
  assert.equal((await s.call({ model: "flat", max_tokens: 10_000, messages: [] })).status, 200);
  assert.equal(s.seen[0].max_tokens, 5000);
});

test("a team's day cap counts every member's spend: one member may use all of it, and then no member starts", async (t) => {
  const r = await rig(t, { answer: usage(0.06), agents: {
    tr: { key: "eng", team: { name: "engineering", members: ["kai", "mina"] }, caps: { day_usd: 0.05 } },
    ag: { key: "kai", member_of: "eng", caps: { run_usd: 30, task_usd: 30, day_usd: 1000 } },
    ag2: { key: "mina", member_of: "eng", caps: { run_usd: 30, task_usd: 30, day_usd: 1000 } },
  } });
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 200); // kai spends $0.06 of the team's $0.05
  assert.match((await r.call({ model: "flat", messages: [] })).json.error.message, /^spend cap reached: agent-day \$0\.06 of \$0\.05;/);
  assert.deepEqual(r.gw.exhausted("ag2", "WOR-9").map((o) => o.scope), ["day"]); // mina never spent, but the team's day is used up
});

test("a definite upstream refusal before any output is released at $0; a cut stream is not", async (t) => {
  const r = await rig(t, { answer: (body, res) => res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "rate limited" } })) });
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 429);
  assert.deepEqual(r.rows().map((x) => [x.status, x.cost_usd]), [["upstream_429", 0]]);
  // A connection refused before the request left: nothing reached the upstream, nothing is charged.
  const dir = mkdtempSync(join(tmpdir(), "spend-refused-"));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { ag: { key: "eng" } } }));
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(MODELS));
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: await closedPort(), jobLive: () => true });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { front.s.close(); gw.close(); });
  const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job: "j-WOR-1", agentId: "ag", issueId: "WOR-1" }, Date.now())}` }, body: JSON.stringify({ model: "flat", messages: [] }) });
  assert.equal(res.status, 502);
  assert.deepEqual(gw.db.prepare("SELECT status, cost_usd FROM calls").all().map((x) => [x.status, x.cost_usd]), [["upstream_error", 0]]);
});

test("A12: stream cut, restart mid-call, no usage, under-reported cost, unpriced model", async (t) => {
  let hang;
  let arrived;
  const hangArrived = new Promise((r) => (arrived = r));
  const r = await rig(t, {
    answer: (body, res, n) => {
      if (body.messages[0] === "cut") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: {"id":"gen-${n}"}\n\n`); return setTimeout(() => res.destroy(), 20); }
      if (body.messages[0] === "hang") { hang = res; return arrived(); }
      if (body.messages[0] === "none") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${n}`, choices: [] }));
      // Under-reported: 1,000 input and 500 output tokens at $1 and $2 a million are $0.002, whatever it says.
      usage(0)(body, res, n);
    },
  });
  // A stream cut off and an answer with no usage are charged their whole reservation ($0.01 for 10,000 output tokens).
  await r.call({ model: "flat", messages: ["cut"] }).catch(() => {});
  assert.equal((await r.call({ model: "flat", messages: ["none"] })).status, 200);
  assert.deepEqual(r.rows().map((x) => [x.status, x.cost_usd]), [["upstream_aborted", 0.01], ["ok", 0.01]]);
  // The cut stream's generation id was kept from its first event (the true-up's handle).
  assert.equal(r.gw.db.prepare("SELECT gen FROM calls ORDER BY rowid LIMIT 1").get().gen, "gen-1");
  // Under-reported: settled at tokens × declared price.
  assert.equal((await r.call({ model: "priced", messages: [] })).status, 200);
  assert.equal(r.rows().at(-1).cost_usd, 0.002);
  // An unpriced model is refused before anything is reserved or sent.
  const n = r.seen.length;
  const unpriced = await r.call({ model: "acme/unpriced", messages: [] });
  assert.deepEqual([unpriced.status, unpriced.json.error.type], [403, "not_priced"]);
  assert.equal((await r.call({ model: "flat", models: ["acme/unpriced"], messages: [] })).status, 403);
  assert.equal(r.seen.length, n);
  // The kernel restarts while a call is in flight: the new one settles it at its reservation and counts it against the caps;
  // the old process finishing late changes nothing.
  const inFlight = r.call({ model: "flat", messages: ["hang"] });
  await hangArrived; // the upstream has the request, so the call is reserved
  assert.equal(r.rows().at(-1).status, "reserved");
  const restarted = r.open();
  t.after(() => restarted.close());
  assert.deepEqual(r.rows().at(-1).status, "unsettled");
  assert.equal(r.rows().at(-1).cost_usd, 0.01);
  hang.end(JSON.stringify({ id: "gen-late", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }));
  await inFlight;
  assert.deepEqual([r.rows().at(-1).status, r.rows().at(-1).cost_usd], ["unsettled", 0.01]);
});

test("restart: a live kernel's reservations are left to it; a dead one's close at the reserved amount, then settle at OpenRouter's record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spend-trueup-"));
  writeFileSync(join(dir, "grants.json"), "{}");
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(MODELS));
  // OpenRouter's record of a generation appears with a delay: not found at the first look.
  const looks = [];
  const upstream = await serve((req, res) => {
    looks.push(req.url);
    if (looks.length === 1) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "gen-cut", model: "acme/flat", total_cost: 0.0123, native_tokens_prompt: 5000, native_tokens_cached: 4000, native_tokens_completion: 300 } }));
  });
  t.after(() => upstream.s.close());
  const { db } = openLedger(join(dir, "kernel.db"));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const add = db.prepare("INSERT INTO calls (key, at, day, run_key, agent_id, kind, component, model, cost_usd, status, owner, gen) VALUES (?, '2026-11-16T09:59:00Z', '2026-11-16', 'r', 'ag', 'agent', 'agent', 'flat', 0.25, 'reserved', ?, ?)");
  add.run("gw:live", ownerOf(process.ppid), "gen-live"); // a kernel still draining its calls
  add.run("gw:cut", ownerOf(dead), "gen-cut"); // cut off mid-answer
  add.run("gw:early", ownerOf(dead), null); // cut off before the answer began
  db.close();
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: upstream.url, jobLive: () => true, now: () => Date.parse("2026-11-16T10:00:00Z") });
  t.after(() => gw.close());
  const rows = () => Object.fromEntries(gw.db.prepare("SELECT key, status, cost_usd, input, cached, output FROM calls").all().map((r) => [r.key, [r.status, r.cost_usd, r.input, r.cached, r.output]]));
  assert.deepEqual(rows(), { "gw:live": ["reserved", 0.25, 0, 0, 0], "gw:cut": ["unsettled", 0.25, 0, 0, 0], "gw:early": ["unsettled", 0.25, 0, 0, 0] });
  await gw.trueUp();
  assert.equal(rows()["gw:cut"][0], "unsettled");
  await gw.trueUp();
  assert.deepEqual(looks, ["/generation?id=gen-cut", "/generation?id=gen-cut"]);
  assert.deepEqual(rows(), { "gw:live": ["reserved", 0.25, 0, 0, 0], "gw:cut": ["interrupted", 0.0123, 1000, 4000, 300], "gw:early": ["unsettled", 0.25, 0, 0, 0] });
});
