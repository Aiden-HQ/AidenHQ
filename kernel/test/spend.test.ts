// Spend (spec §5.12) end to end against a fake upstream: reservations in one transaction (A11), settlement and fail
// closed (A12), and the ledger's move from the old data/gateway/usage.db into kernel.db.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createGateway, openLedger, ownerOf, spendOf } from "../src/gateway/lib.ts";
import { mintToken } from "../src/gateway/token.ts";
import { modelsList } from "./models-list.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closedPort = async () => { const x = await serve(() => {}); await new Promise((r) => x.s.close(r)); return x.url; };
// OpenRouter's models list as stubbed here: $1 per million output tokens, input free, so a call asking for 10,000 output
// tokens reserves exactly $0.01.
const LIST = await modelsList({ flat: { in: 0, cached_in: 0, out: 1, max_output: 10_000 }, priced: { in: 1, cached_in: 0.1, out: 2, max_output: 10_000 }, astra: { in: 8, cached_in: 0.4, out: 40, max_output: 128_000 } });
const modelsUrl = LIST.url;

/** A gateway on `dir`'s kernel.db with one job agent `ag` (the install's day limit `dayUsd`), and an upstream `answer(body, res)`. Every secret is "js". */
async function rig(t, { dayUsd = 30, taskUsd, answer, dir = mkdtempSync(join(tmpdir(), "spend-")), legacy, agents, clock = { t: Date.parse("2026-11-16T10:00:00Z") } } = {}) {
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: agents ?? { ag: { key: "eng" } } }));
  writeFileSync(join(dir, "gateway.json"), JSON.stringify({ install_day_usd: dayUsd, ...(taskUsd ? { task_usd: taskUsd } : {}) }));
  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const body = JSON.parse(b); seen.push(body); answer(body, res, seen.length); });
  });
  const open = () => createGateway({ dbFile: join(dir, "kernel.db"), legacyDbFile: legacy, grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: upstream.url, modelsUrl, jobLive: () => true, now: () => clock.t });
  const gw = open();
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); try { gw.close(); } catch {} });
  const call = async (body, issueId = "WOR-1", { agentId = "ag", job = `j-${issueId}` } = {}) => {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job, agentId, issueId }, clock.t)}` }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const rows = () => gw.db.prepare("SELECT key, status, cost_usd, input, cached, output FROM calls ORDER BY rowid").all();
  return { dir, gw, open, call, seen, rows };
}
const usage = (cost, extra = {}) => (body, res, n) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${n}`, model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 500, cost, ...extra } }));

test("limits count real cost: a $2 limit with $0.51 spent runs the next call, output bounded to the room; at the limit, refused", async (t) => {
  // Astra at $8/$40 a million: the old worst-case reservation (x2) refused this call with $1.49 of $2 left.
  const billed = [0.51, 1.6];
  const r = await rig(t, { dayUsd: 2, answer: (body, res, n) => usage(billed[n - 1] ?? 0.01)(body, res, n) });
  assert.equal((await r.call({ model: "astra", messages: [] })).status, 200);
  assert.equal((await r.call({ model: "astra", messages: [] })).status, 200);
  // Bounded so one call can't run away: what the $1.49 left buys at $40 a million, under the model's 128,000.
  assert.ok(r.seen[1].max_tokens > 37_000 && r.seen[1].max_tokens < 37_250, String(r.seen[1].max_tokens));
  // Settled at what OpenRouter billed: $2.11 of $2, so the next call is refused (overshoot bounded by that one call).
  assert.deepEqual(r.rows().map((x) => x.cost_usd), [0.51, 1.6]);
  const refused = await r.call({ model: "astra", messages: [] });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /^spend cap reached: the install's daily limit, \$2\.11 of \$2\.00 /);
  assert.equal(r.seen.length, 2);
  // Near a limit a call is still sent with at least 1,024 output tokens, never refused for its size.
  const s2 = await rig(t, { dayUsd: 0.0001, answer: usage(0.00005) });
  assert.equal((await s2.call({ model: "astra", messages: [] })).status, 200);
  assert.equal(s2.seen[0].max_tokens, 1024);
});

test("a session task's cap is per day: calls over yesterday's task_usd are admitted today, a crew task's stay refused", async (t) => {
  const clock = { t: Date.parse("2026-11-16T10:00:00Z") };
  const r = await rig(t, { clock, taskUsd: 0.05, answer: usage(0.06), agents: { ag: { key: "eng" }, ses: { key: "session", profile: "session" } } });
  for (const [agentId, task] of [["ses", "WOR-1"], ["ag", "WOR-2"]]) {
    assert.equal((await r.call({ model: "flat", messages: [] }, task, { agentId, job: `j-${task}-1` })).status, 200);
    assert.equal((await r.call({ model: "flat", messages: [] }, task, { agentId, job: `j-${task}-1` })).status, 402, `${agentId}: over the task's cap today`);
  }
  clock.t += 24 * 3600_000; // the next UTC day; each task's next job
  assert.equal((await r.call({ model: "flat", messages: [] }, "WOR-1", { agentId: "ses", job: "j-WOR-1-2" })).status, 200, "a session's cap starts again");
  assert.equal((await r.call({ model: "flat", messages: [] }, "WOR-2", { agentId: "ag", job: "j-WOR-2-2" })).status, 402, "a crew task's cap is the task's");
});

test("concurrent calls share the room: each holds its granted output, so two in flight can't both buy all of it", async (t) => {
  // $0.015 a day; flat: $1 a million output, input free. Both calls are held upstream until released.
  const held = [];
  const r = await rig(t, { dayUsd: 0.015, answer: (body, res, n) => held.push(() => usage(0.001)(body, res, n)) });
  const both = Promise.all([r.call({ model: "flat", messages: [] }), r.call({ model: "flat", messages: [] })]);
  try {
    for (let i = 0; i < 200 && r.seen.length < 2; i++) await sleep(5);
    // One got the 10,000 tokens it asked for ($0.01); the other only what was left ($0.005), never the whole room again.
    const [less, more] = r.seen.map((b) => b.max_tokens).sort((a, b) => a - b);
    assert.equal(more, 10_000);
    assert.ok(less >= 4999 && less <= 5000, String(less)); // $0.015 - $0.01 in floating point
    const holds = r.rows().map((x) => { assert.equal(x.status, "reserved"); return x.cost_usd; });
    assert.ok(holds[0] + holds[1] <= 0.015 + 1e-12, String(holds));
  } finally {
    for (const f of held.splice(0)) f(); // released even when an assertion fails
  }
  assert.deepEqual((await both).map((x) => x.status), [200, 200]);
  // Settled at what OpenRouter billed.
  assert.deepEqual(r.rows().map((x) => [x.status, x.cost_usd]), [["ok", 0.001], ["ok", 0.001]]);

  // A limit only held, not spent ($0.01, all of it held by one call in flight): a retryable 503; no cap refusal is recorded,
  // nothing is sent, nobody is told.
  const waiting = [];
  const b = await rig(t, { dayUsd: 0.01, answer: (body, res, n) => waiting.push(() => usage(0.001)(body, res, n)) });
  const first = b.call({ model: "flat", messages: [] });
  try {
    for (let i = 0; i < 200 && b.seen.length < 1; i++) await sleep(5);
    const busy = await b.call({ model: "flat", messages: [] });
    assert.deepEqual([busy.status, busy.json.error.type], [503, "spend_held"]);
    assert.deepEqual(b.rows().map((x) => x.status), ["reserved"]);
    assert.equal(b.seen.length, 1);
    // Admission defers a new job on it too (the room is taken), without the limit counted as reached.
    assert.deepEqual(b.gw.exhausted("ag", "WOR-9").map((o) => o.scope), ["day"]);
  } finally {
    for (const f of waiting.splice(0)) f();
  }
  assert.equal((await first).status, 200);
  // A cut-off call's hold a true-up may still shrink (unsettled, with a generation id) fills the limit the same way: held, not spent.
  b.gw.db.prepare("INSERT INTO calls (key, at, day, run_key, kind, component, model, cost_usd, status, gen) VALUES ('gw:cut', '2026-11-16T09:59:00Z', '2026-11-16', 'r', 'agent', 'agent', 'flat', 0.01, 'unsettled', 'gen-cut')").run();
  const cut = await b.call({ model: "flat", messages: [] });
  assert.deepEqual([cut.status, cut.json.error.type], [503, "spend_held"]);
});

test("the day limit keeps its value: at it refused, a reservation past it refused, bounded output, true cost settled", async (t) => {
  const r = await rig(t, { dayUsd: 0.05, answer: usage(0.03) });
  // The first call asks for 20,000 output tokens: cut to the model's 10,000. It settles at the $0.03 billed.
  assert.equal((await r.call({ model: "flat", max_tokens: 20_000, messages: [] })).status, 200);
  assert.equal(r.seen[0].max_tokens, 10_000);
  // $0.02 left: the second call's 10,000 tokens ($0.01) fit as asked. Billed $0.03 again: the day is at $0.06, past its cap.
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 200);
  assert.equal(r.seen[1].max_tokens, 10_000);
  const refused = await r.call({ model: "flat", messages: [] });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /^spend cap reached: the install's daily limit, \$0\.06 of \$0\.05 /);
  assert.equal(r.seen.length, 2);
  // Admission reads the same limits: no new job today, on any task.
  assert.deepEqual(r.gw.exhausted("ag", "WOR-9").map((o) => o.scope), ["day"]);
  // A limit with room for some output, not all: the call is cut to what is left, never past it.
  const s = await rig(t, { dayUsd: 0.005, answer: usage(0.001) });
  assert.equal((await s.call({ model: "flat", max_tokens: 10_000, messages: [] })).status, 200);
  assert.equal(s.seen[0].max_tokens, 5000);
});

test("a definite upstream refusal before any output is released at $0; a cut stream is not", async (t) => {
  const r = await rig(t, { answer: (body, res) => res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "rate limited" } })) });
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 429);
  assert.deepEqual(r.rows().map((x) => [x.status, x.cost_usd]), [["upstream_429", 0]]);
  // A connection refused before the request left: nothing reached the upstream, nothing is charged.
  const dir = mkdtempSync(join(tmpdir(), "spend-refused-"));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { ag: { key: "eng" } } }));
  writeFileSync(join(dir, "gateway.json"), "{}");
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: await closedPort(), modelsUrl, jobLive: () => true });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { front.s.close(); gw.close(); });
  const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job: "j-WOR-1", agentId: "ag", issueId: "WOR-1" }, Date.now())}` }, body: JSON.stringify({ model: "flat", messages: [] }) });
  assert.equal(res.status, 502);
  assert.deepEqual(gw.db.prepare("SELECT status, cost_usd FROM calls").all().map((x) => [x.status, x.cost_usd]), [["upstream_error", 0]]);
});

test("A12: stream cut, restart mid-call, no usage, a usage block without its cost, an id OpenRouter doesn't list", async (t) => {
  let hang;
  let arrived;
  const hangArrived = new Promise((r) => (arrived = r));
  const r = await rig(t, {
    answer: (body, res, n) => {
      if (body.messages[0] === "cut") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: {"id":"gen-${n}"}\n\n`); return setTimeout(() => res.destroy(), 20); }
      if (body.messages[0] === "hang") { hang = res; return arrived(); }
      if (body.messages[0] === "none") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${n}`, choices: [] }));
      // A usage block without OpenRouter's cost: 1,000 input and 500 output tokens at $1 and $2 a million are $0.002.
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${n}`, model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
    },
  });
  // A stream cut off and an answer with no usage keep their reservation, the input's estimate ($1 a million, a token per 3
  // bytes of the body) plus the output it was granted (10,000 tokens at $2 a million), as `unsettled` until OpenRouter's record
  // of the generation trues it up.
  const est = Math.ceil(JSON.stringify({ model: "priced", messages: ["cut"] }).length / 3) / 1e6 + 0.02;
  await r.call({ model: "priced", messages: ["cut"] }).catch(() => {});
  assert.equal((await r.call({ model: "priced", messages: ["none"] })).status, 200);
  assert.deepEqual(r.rows().map((x) => [x.status, x.cost_usd]), [["unsettled", est], ["unsettled", est]]);
  // The cut stream's generation id was kept from its first event (the true-up's handle).
  assert.equal(r.gw.db.prepare("SELECT gen FROM calls ORDER BY rowid LIMIT 1").get().gen, "gen-1");
  // No cost in the usage: settled at tokens × the list's price, never at 0.
  assert.equal((await r.call({ model: "priced", messages: [] })).status, 200);
  assert.equal(r.rows().at(-1).cost_usd, 0.002);
  // An id OpenRouter doesn't list is refused before anything is reserved or sent.
  const n = r.seen.length;
  const unpriced = await r.call({ model: "acme/unpriced", messages: [] });
  assert.deepEqual([unpriced.status, unpriced.json.error.type], [403, "not_priced"]);
  assert.equal((await r.call({ model: "flat", models: ["acme/unpriced"], messages: [] })).status, 403);
  assert.equal(r.seen.length, n);
  // The kernel restarts while a call is in flight: the new one settles it at its reservation and counts it against the caps;
  // the old process finishing late changes nothing.
  const inFlight = r.call({ model: "priced", messages: ["hang"] });
  await hangArrived; // the upstream has the request, so the call is reserved
  assert.equal(r.rows().at(-1).status, "reserved");
  const restarted = r.open();
  t.after(() => restarted.close());
  assert.deepEqual(r.rows().at(-1).status, "unsettled");
  assert.equal(r.rows().at(-1).cost_usd, est);
  hang.end(JSON.stringify({ id: "gen-late", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }));
  await inFlight;
  assert.deepEqual([r.rows().at(-1).status, r.rows().at(-1).cost_usd], ["unsettled", est]);
});

test("restart: a live kernel's reservations are left to it; a dead one's close at the reserved amount, then settle at OpenRouter's record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spend-trueup-"));
  writeFileSync(join(dir, "grants.json"), "{}");
  writeFileSync(join(dir, "gateway.json"), "{}");
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
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: upstream.url, modelsUrl, jobLive: () => true, now: () => clock.t });
  t.after(() => gw.close());
  const rows = () => Object.fromEntries(gw.db.prepare("SELECT key, status, cost_usd, input, cached, output FROM calls").all().map((r) => [r.key, [r.status, r.cost_usd, r.input, r.cached, r.output]]));
  assert.deepEqual(rows(), { "gw:live": ["reserved", 0.25, 0, 0, 0], "gw:cut": ["unsettled", 0.25, 0, 0, 0], "gw:early": ["unsettled", 0.25, 0, 0, 0] });
  await gw.trueUp();
  assert.equal(rows()["gw:cut"][0], "unsettled");
  const at = () => gw.db.prepare("SELECT at, changed FROM calls WHERE key = 'gw:cut'").get();
  const closedAt = at().at;
  await gw.trueUp();
  assert.deepEqual(looks, ["/generation?id=gen-cut", "/generation?id=gen-cut"]);
  // The true-up keeps the call's time (its day on the board) and stamps when it changed, which the board's pull reads.
  assert.deepEqual({ ...at() }, { at: closedAt, changed: "2026-11-16T10:00:00.000Z" });
  assert.deepEqual(rows(), { "gw:live": ["reserved", 0.25, 0, 0, 0], "gw:cut": ["interrupted", 0.0123, 1000, 4000, 300], "gw:early": ["unsettled", 0.25, 0, 0, 0] });
});

test("prices come from OpenRouter's models list: a new model runs and is recorded at usage.cost; an unlisted id is refused; a cold start retries; a failed refresh keeps the last list", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spend-list-"));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: { ag: { key: "eng" } } }));
  writeFileSync(join(dir, "gateway.json"), "{}"); // no table anywhere
  // The list: down for its first fetch (a cold start), then up, then down again.
  let up = false, fetches = 0;
  const list = await serve((req, res) => {
    fetches++;
    if (!up) return res.writeHead(502).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
      { id: "~acme/brand-new-latest", pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" }, top_provider: { max_completion_tokens: 943718 } },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }, // a router: no price, refused like an unknown id
    ] }));
  });
  const upstream = await serve((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const body = JSON.parse(b); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `gen-${Math.random()}`, model: body.model, max: body.max_tokens, usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0042 } })); }); });
  let clock = Date.parse("2026-11-16T10:00:00Z");
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: () => "js", upstream: upstream.url, modelsUrl: list.url, priceRetryMs: [0, 0], jobLive: () => true, now: () => clock });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const x of [list, upstream, front]) x.s.close(); gw.close(); });
  const call = async (model) => {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("js", { kind: "job", job: "j-1", agentId: "ag", issueId: "WOR-1" }, clock)}` }, body: JSON.stringify({ model, messages: [] }) });
    return { status: res.status, json: await res.json() };
  };
  // Cold start with the list unreachable: tried three times, then a retryable 503 (never "unknown model").
  const cold = await call("~acme/brand-new-latest");
  assert.deepEqual([cold.status, cold.json.error.type, fetches], [503, "prices_unavailable", 3]);
  // The list is up: a model no table ever named runs, sent with the output ceiling (not the list's 943718), recorded at usage.cost.
  up = true;
  const ok = await call("~acme/brand-new-latest");
  assert.deepEqual([ok.status, ok.json.max], [200, 131072]);
  assert.deepEqual(gw.db.prepare("SELECT status, cost_usd, model FROM calls").all().map((r) => [r.status, r.cost_usd, r.model]), [["ok", 0.0042, "~acme/brand-new-latest"]]);
  // An id OpenRouter doesn't list (or lists with no price) is refused: 403 not_priced.
  for (const id of ["acme/nope", "openrouter/auto"]) assert.deepEqual([(await call(id)).status, (await call(id)).json.error.type], [403, "not_priced"]);
  // The list goes down: a priced model still runs on the last good list, after a fresh look for a missing id fails.
  up = false;
  clock += 3600_000;
  assert.equal((await call("acme/nope")).status, 403);
  assert.equal((await call("~acme/brand-new-latest")).status, 200);
});

test("the spend totals equal a full sum: another process's writes, a hold ageing out with no write, a rehold, a day rollover, the prune", () => {
  const file = join(mkdtempSync(join(tmpdir(), "spend-totals-")), "kernel.db");
  const old = new DatabaseSync(file); // calls written before the totals existed: the backfill counts them
  old.exec("CREATE TABLE calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_key TEXT NOT NULL, run_id TEXT, agent_id TEXT, issue_id TEXT, task_subject TEXT, rev TEXT, kind TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost_usd REAL, ms INTEGER, status TEXT NOT NULL, owner TEXT, gen TEXT, changed TEXT)");
  old.prepare("INSERT INTO calls (key, at, day, run_key, agent_id, task_subject, kind, component, model, cost_usd, status) VALUES ('pre', '2026-11-09T12:00:00.000Z', '2026-11-09', 'r', 'ag', 'WOR-1', 'agent', 'c', 'm', 0.5, 'ok')").run();
  old.close();
  const { db } = openLedger(file);
  const spend = spendOf(db);
  const peer = new DatabaseSync(file); // a draining peer kernel's bare connection: the database keeps the totals for its writes too
  let clock = Date.parse("2026-11-16T10:00:00Z");
  const add = (key, day, status, usd, { at = `${day}T12:00:00.000Z`, gen = null, agent = "ag", task = "WOR-1" } = {}) => peer.prepare("INSERT INTO calls (key, at, day, run_key, agent_id, task_subject, kind, component, model, cost_usd, status, gen) VALUES (?, ?, ?, 'r', ?, ?, 'agent', 'c', 'm', ?, ?, ?)").run(key, at, day, agent, task, usd, status, gen);
  const sums = (where, args, open) => {
    const s = (extra) => db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE ${where}${extra}`).get(...args, ...(extra ? [open] : [])).s;
    return { spent: s(""), settled: s(" AND status != 'reserved' AND NOT (status = 'unsettled' AND gen IS NOT NULL AND at >= ?)") };
  };
  const near = (got, want, what) => assert.ok(Math.abs(got.spent - want.spent) < 1e-9 && Math.abs(got.settled - want.settled) < 1e-9, `${what}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  const check = () => {
    const open = new Date(clock - 30 * 60_000).toISOString(), d = new Date(clock).toISOString().slice(0, 10), m = d.slice(0, 7);
    for (const [from, to] of [[d, d], [`${m}-01`, `${m}-31`], ["2026-11-01", "2026-11-31"]]) near(spend.days(from, to, open), sums("day >= ? AND day <= ?", [from, to], open), `${from}..${to}`);
    for (const t of ["WOR-1", "WOR-2"]) near(spend.task(t, open), sums("task_subject = ? AND agent_id IS NOT NULL", [t], open), t);
  };
  add("a", "2026-11-10", "ok", 1);
  add("b", "2026-11-16", "reserved", 2);
  add("c", "2026-11-16", "unsettled", 4, { at: "2026-11-16T09:50:00.000Z", gen: "g1" }); // inside the true-up window
  add("d", "2026-11-16", "unsettled", 8, { at: "2026-11-16T08:00:00.000Z", gen: "g2" }); // outside it
  add("e", "2026-11-16", "unsettled", 0.25, { at: "2026-11-16T09:55:00.000Z" }); // no generation: a hold for good
  add("f", "2026-11-16", "cap_reached", null, { task: "WOR-2" });
  add("g", "2026-11-16", "ok", 16, { agent: null }); // no agent: the install's spend, no task's
  add("h", "2026-10-31", "ok", 64);
  check();
  // A hold ages past the true-up window with no write at all: settled changes, the totals don't need to.
  clock = Date.parse("2026-11-16T10:25:00Z");
  check();
  // A rehold (the call's hold replaced), a settle, a true-up and a late final row on a closed day.
  peer.prepare("UPDATE calls SET cost_usd = 3 WHERE key = 'b' AND status = 'reserved'").run();
  check();
  peer.prepare("UPDATE calls SET status = 'ok', cost_usd = 1.5, at = ? WHERE key = 'b'").run("2026-11-16T10:26:00.000Z");
  peer.prepare("UPDATE calls SET status = 'interrupted', cost_usd = 0.5, changed = ? WHERE key = 'c'").run("2026-11-16T10:26:00.000Z");
  add("i", "2026-11-12", "stream_error", 0.125);
  check();
  // The next day, and a call that started last month still counted against it.
  clock = Date.parse("2026-12-01T00:05:00Z");
  add("j", "2026-11-30", "ok", 128);
  check();
  // The prune (40 days) takes rows and their share of the totals; a total with no call left goes.
  clock = Date.parse("2026-12-20T00:00:00Z");
  peer.prepare("DELETE FROM calls WHERE at < ?").run("2026-11-11T00:00:00.000Z");
  check();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spend_day WHERE day IN ('2026-10-31', '2026-11-09', '2026-11-10')").get().n, 0);
  // Parts whose float sum falls just under a cap still meet it: whole nano-dollars add exactly.
  add("k", "2026-12-02", "ok", 0.2);
  add("l", "2026-12-03", "ok", 0.7);
  add("n", "2026-12-02", "unsettled", 0.1, { at: "2026-12-02T12:00:00.000Z" });
  assert.equal(spend.days("2026-12-01", "2026-12-31", "2026-12-20T00:00:00.000Z").settled, 1);
});

test("a rate limit cools the model down for every kernel on the file, Retry-After honoured; a new call waits it out before it holds anything", async (t) => {
  let limited = 1;
  const r = await rig(t, { answer: (body, res, n) => (limited-- > 0 ? res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end("{}") : usage(0.001)(body, res, n)) });
  assert.equal((await r.call({ model: "flat", messages: [] })).status, 200); // retried past the 429 inside the call
  assert.deepEqual({ ...r.gw.db.prepare("SELECT model, until, step FROM model_cooldown").get() }, { model: "flat", until: Date.parse("2026-11-16T10:00:00Z") + 1000, step: 0 });
  // A peer kernel's cooldown on a model holds a new call to it back, with nothing reserved, until the cooldown ends.
  const before = r.rows().length;
  r.gw.db.prepare("INSERT INTO model_cooldown (model, until, step) VALUES ('priced', ?, 0)").run(Date.parse("2026-11-16T10:00:30Z"));
  const waiting = r.call({ model: "priced", messages: [] });
  await sleep(300);
  assert.equal(r.rows().length, before);
  r.gw.db.prepare("UPDATE model_cooldown SET until = 0 WHERE model = 'priced'").run(); // the rig's clock stands still: ended here
  assert.equal((await waiting).status, 200);
});
