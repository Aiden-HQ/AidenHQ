// End to end against a fake OpenRouter and a fake control plane: attribution, billed cost in the ledger, the task cap → 402
// with the delegator told once, the daily reset of a chat task, the install's day and month limits on every caller, and no
// way to switch them off (G10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, usageTap } from "../src/gateway/lib.ts";
import { mintToken } from "../src/gateway/token.ts";
import { modelsList } from "./models-list.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
// OpenRouter's models list as these tests stub it (USD per million tokens): a call reserves about $0.004, well under what the
// fake upstream bills ($0.03).
const price = { in: 1, cached_in: 0.1, out: 1, max_output: 4096 };
const LIST = await modelsList({ "~deepseek/deepseek-flash-latest": price, breaks: price, m: price, "anthropic/claude-haiku-5.5": price });
const modelsUrl = LIST.url;
// A token signed by hand (`ahqj_<payload>.<hmac>`): a fast lane's turn token as the chat lane signs it, or a forged kind.
const signed = (secret, p, now) => { const body = Buffer.from(JSON.stringify({ i: null, c: null, x: now + 3600_000, ...p })).toString("base64url"); return `ahqj_${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`; };

test("gateway: attribution, billed cost, the task cap, the delegator told once, daily reset, no off switch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", gateway_board_key: "gw-board", gateway_source_key: "src-key", paperclip_board_key: "pc-board", board_internal_token: "internal" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden", rev: "abc123" }, ag2: { key: "eng" } } }));
  const settingsFile = join(dir, "gateway.json");
  writeFileSync(settingsFile, JSON.stringify({ task_usd: 0.08 }));
  let cost = 0.03;
  const seen = [];
  const asked = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const body = JSON.parse(b);
      seen.push({ auth: req.headers.authorization, zdr: body.provider?.zdr, url: req.url });
      asked.push(body.models ? [body.model, body.models] : body.model);
      const id = `gen-${seen.length}`;
      if (body.model === "breaks") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: {"id":"${id}"}\n\n`); return setTimeout(() => res.destroy(), 20); }
      if (req.url.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id, model: "deepseek/v4", choices: [{ delta: { content: "hi" } }], usage: null })}\n\n`);
        res.end(`data: ${JSON.stringify({ id, model: "deepseek/v4", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, cost } })}\n\ndata: [DONE]\n\n`);
      } else json(res, 200, { id, model: "deepseek/v4", output: [], usage: { input_tokens: 10, output_tokens: 5, cost } });
    });
  });
  const issues = { iss1: { labels: [] }, chat1: { labels: [{ name: "chat" }] } };
  const runs = { run1: "iss1", run2: "iss1", h1: "iss1", c1: "chat1", c2: "chat1", c3: "chat1" };
  const paperclip = await serve((req, res) => {
    const auth = String(req.headers.authorization).slice(7);
    if (auth !== "pc-board") return json(res, 403, {});
    const m = /^\/api\/issues\/(\w+)$/.exec(req.url);
    if (m && issues[m[1]]) return json(res, 200, issues[m[1]]);
    json(res, 404, {});
  });
  // What the task's delegator was told (main.ts: a wake notice on the parent, else the owner).
  const told = [];
  let now = Date.parse("2026-11-13T10:00:00Z");
  // A kernel job of `agent` on its run's task: one token per job (its hash is the run key), expiring at `exp` (seconds) if given.
  const T0 = now, minted = new Map();
  const jobToken = (agent, job, exp) => {
    const k = `${agent}/${job}/${exp}`;
    if (!minted.has(k)) minted.set(k, mintToken("job-secret", { kind: "job", job, agentId: agent, issueId: runs[job] ?? null, ttlMs: exp ? exp * 1000 - T0 : 365 * 864e5 }, T0));
    return minted.get(k);
  };
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, paperclipUrl: paperclip.url, tellDelegator: async (task, text) => void told.push([task, text]), jobLive: () => true, now: () => now });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const x of [upstream, paperclip, front]) x.s.close(); gw.close(); });

  const call = async (cred, { path = "/api/v1/chat/completions", model = "~deepseek/deepseek-flash-latest", models } = {}) => {
    const res = await fetch(front.url + path, { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: JSON.stringify({ model, models, stream: true, messages: [] }) });
    return { status: res.status, text: await res.text() };
  };
  const usage = async (since = "") => (await (await fetch(`${front.url}/usage`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: JSON.stringify({ since }) })).json()).records;

  // A kernel job: billed, attributed to its agent, run (the job) and task, with the rev; the real key goes upstream, ZDR forced.
  const r1 = await call(jobToken("ag1", "run1"));
  assert.equal(r1.status, 200);
  assert.match(r1.text, /\[DONE\]/);
  assert.deepEqual(seen[0], { auth: "Bearer sk-real", zdr: true, url: "/chat/completions" });
  let rows = await usage();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], runKey: rows[0].runKey.length }, { key: "gen-1", at: rows[0].at, agentId: "ag1", component: "agent", model: "deepseek/v4", input: 60, cached: 40, output: 20, costUsd: 0.03, runKey: 64, runId: "run1", issueId: "iss1", rev: "abc123", kind: "agent", ms: 0, status: "ok" });

  // Unknown credentials are refused, and so is the old agent-kind token under the job secret (only a lane signs that kind).
  assert.equal((await call("sk-guess")).status, 401);
  assert.equal((await call(mintToken("wrong", { kind: "reviewer" }, now))).status, 401);
  assert.equal((await call(signed("job-secret", { k: "agent", a: "ag2", i: "iss9" }, now), { path: "/api/v1/responses" })).status, 401);

  // A fast chat lane's turn token: an agent call, attributed to the lane; the lane secret never mints a system kind.
  assert.equal((await call(signed("lane-secret", { k: "agent", a: "ag2", c: "Aria" }, now))).status, 200);
  assert.equal((await call(mintToken("lane-secret", { kind: "reviewer" }, now))).status, 401);
  rows = await usage();
  assert.deepEqual([rows[1].agentId, rows[1].component, rows[1].kind], ["ag2", "Fast lane: Aria", "agent"]);

  // The board's side chat (its own key): a call of its own kind, with no agent behind it.
  assert.equal((await call("gw-board")).status, 200);
  rows = await usage();
  assert.deepEqual([rows[2].agentId, rows[2].component, rows[2].kind], [null, "Board side chat", "aside"]);

  // Task cap $0.08 (settings.task_usd): the agent's calls on iss1, from any of its runs, go ahead while the task's spend is
  // below it ($0.03, $0.06, then $0.09); the next is refused, and whoever asked for the task is told once.
  assert.equal((await call(jobToken("ag1", "run1"))).status, 200);
  assert.equal((await call(jobToken("ag1", "run2"))).status, 200);
  const refused = await call(jobToken("ag1", "run2"));
  assert.equal(refused.status, 402);
  const err = JSON.parse(refused.text).error;
  assert.equal(err.type, "cap_reached");
  assert.match(err.message, /^task spend cap reached: this task's \$0\.09 of \$0\.08 \(settings\.task_usd\); this task stops here; whoever asked for it has been told$/);
  for (let i = 0; i < 5; i++) assert.equal((await call(jobToken("ag1", "run1"))).status, 402); // Codex retries a 402 five times
  assert.deepEqual(told.map(([task]) => task), ["iss1"]);
  assert.match(told[0][1], /^Task spend cap reached: .*\$0\.09 of \$0\.08/);
  assert.equal((await usage()).filter((r) => r.status === "cap_reached").length, 2); // one per run key
  assert.deepEqual(gw.exhausted("ag1", "iss1").map((o) => o.scope), ["task"]);
  // The refusals are on the run's ledger key, as the limits they named: what the kernel reads to end a judged run at a spend
  // limit even when the eval it ran is too old to report one.
  const run1 = createHash("sha256").update(jobToken("ag1", "run1")).digest("hex");
  assert.deepEqual(gw.refusedByKey(run1), ["task"]);
  assert.deepEqual(gw.refusedByKey(createHash("sha256").update("no such token").digest("hex")), []);
  // Handed to another agent, the task keeps what it spent.
  assert.equal((await call(jobToken("ag2", "h1"))).status, 402);
  assert.deepEqual(gw.exhausted("ag2", "iss1").map((o) => o.scope), ["task"]);
  // The owner raises the task's limit (settings.task_usd): a later call on the same run key goes through, and the refusal
  // stays on that key. A case the limit cut was never judged, and a call settling after it doesn't un-cut it: a concurrent
  // eval's in-flight calls are exactly that, so an older harness must not be able to credit the cut case.
  writeFileSync(settingsFile, JSON.stringify({ task_usd: 0.16 }));
  assert.equal((await call(jobToken("ag1", "run1"))).status, 200);
  assert.deepEqual(gw.refusedByKey(run1), ["task"], "the refusal is never cleared by a later settled call");
  writeFileSync(settingsFile, JSON.stringify({ task_usd: 0.08 }));

  // The monitoring module's metrics (a textfile gateway.ts writes; no route): agent keys as labels.
  assert.equal((await fetch(`${front.url}/metrics`)).status, 404);
  const text = gw.metricsText();
  assert.match(text, /^aidenhq_gateway_cap_refusals_today\{agent="aiden",kind="agent"\} 2$/m);
  assert.match(text, /^aidenhq_gateway_spend_usd_today\{agent="eng",kind="agent"\} 0\.03$/m); // its fast lane turn
  assert.doesNotMatch(text, /ag1|sk-real/); // ids and secrets never ride along
  for (const l of text.trim().split("\n")) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?)$/);

  // An expired job token is refused even once its run key is settled.
  const exp = Math.floor(now / 1000) + 60;
  assert.equal((await call(jobToken("ag1", "run3", exp))).status, 200);
  now += 120_000;
  assert.equal((await call(jobToken("ag1", "run3", exp))).status, 401);

  // OpenRouter's stream breaks mid-body: the call still lands in the ledger, charged its reservation (the input's estimate and
  // its 4,096 output tokens) as `unsettled` until OpenRouter's record of its generation trues it up.
  await call(jobToken("ag1", "run4"));
  await call(jobToken("ag1", "run4"), { model: "breaks" }).catch(() => {});
  const aborted = (await usage()).filter((r) => r.status === "unsettled");
  assert.deepEqual(aborted.map((r) => r.runId), ["run4"]);
  assert.ok(aborted[0].costUsd > 0.004096 && aborted[0].costUsd < 0.0042, String(aborted[0].costUsd));

  // A chat task's cap counts the UTC day: refused at $0.09 today, open again tomorrow.
  for (const r of ["c1", "c2", "c3"]) await call(jobToken("ag1", r));
  const chatRefused = await call(jobToken("ag1", "c3"));
  assert.equal(chatRefused.status, 402);
  assert.equal(told.at(-1)[0], "chat1");
  assert.deepEqual(gw.exhausted("ag1", "chat1").map((o) => o.scope), ["task"], "admission reads a chat task's cap by the day too");
  now += 864e5;
  assert.equal((await call(jobToken("ag1", "c3"))).status, 200);
  for (const r of [refused, chatRefused]) assert.doesNotMatch(JSON.parse(r.text).error.message, /usage limit|rate[- ]?limit|try again|quota|capacity|429|service unavailable|temporary|spawn|ENOENT|\d{4}-\d{2}-\d{2}|\d+:\d\d/i);

  // A grader token names the agent it is billed to.
  assert.equal((await call(mintToken("job-secret", { kind: "grader", agentId: "ag2", issueId: "g2", component: "Grader" }, now))).status, 200);
  assert.equal((await usage()).filter((r) => r.kind === "grader" && r.status === "ok").at(-1).agentId, "ag2");

  // A call with no agent has no task cap. The old kill switch is gone: a stale enforce_caps: false still refuses (G10).
  const reviewer = mintToken("job-secret", { kind: "reviewer", issueId: "iss1" }, now);
  cost = 5;
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call("src-key")).status, 200);
  writeFileSync(settingsFile, JSON.stringify({ task_usd: 0.08, enforce_caps: false }));
  assert.equal((await call(jobToken("ag1", "run1"))).status, 402);
  rows = await usage();
  assert.deepEqual(rows.filter((r) => r.kind === "reviewer").map((r) => r.component), ["AI reviewer", "AI reviewer"]);
  assert.equal(rows.filter((r) => r.kind === "source").length, 1);

  // An advisor call is counted against the caller's run as kind advisor.
  assert.equal((await call(mintToken("job-secret", { kind: "job", job: "j-adv", agentId: "ag2", issueId: "iss9" }, now), { path: "/advisor/api/v1/chat/completions" })).status, 200);
  const last = (await usage()).at(-1);
  assert.deepEqual([last.kind, last.agentId, last.issueId], ["advisor", "ag2", "iss9"]);
});

test("gateway: a Paperclip run JWT, a launcher run token and the old harness key are no credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  writeFileSync(join(dir, "grants.json"), JSON.stringify({ agents: {} }));
  writeFileSync(join(dir, "gateway.json"), "{}");
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => (n === "gateway_harness_key" ? "harness-key" : "") });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { front.s.close(); gw.close(); });
  for (const cred of ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZzEifQ.sig", "ahqc_x", "harness-key"]) {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(res.status, 401, cred);
  }
});

test("gateway: the install's day and month limits count every call, every caller; the owner is told once per limit; the spend summary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", gateway_board_key: "gw-board", gateway_source_key: "src-key" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden" } } }));
  const settingsFile = join(dir, "gateway.json");
  writeFileSync(settingsFile, JSON.stringify({ install_day_usd: 0.05, install_month_usd: 0.2 }));
  const upstream = await serve((req, res) => { req.resume(); req.on("end", () => json(res, 200, { id: `gen-${Math.random()}`, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.03 } })); });
  const told = [];
  let now = Date.parse("2026-11-18T10:00:00Z");
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, notifyOwner: (text) => void told.push(text), jobLive: () => true, now: () => now });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); gw.close(); });
  const call = async (cred) => {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${cred}` }, body: JSON.stringify({ model: "m", max_tokens: 1024, messages: [] }) });
    return { status: res.status, body: await res.json() };
  };
  const spend = async () => (await fetch(`${front.url}/v1/spend/summary`, { headers: { authorization: "Bearer gw-board" } })).json();
  const reviewer = () => mintToken("job-secret", { kind: "reviewer" }, now);
  const job = () => mintToken("job-secret", { kind: "job", job: "j-0123456789abcdef", agentId: "ag1", issueId: "iss1" }, now);

  // Under both limits calls go ahead: a kernel job of ag1, then the reviewer, spend 0.06 of the day's 0.05.
  assert.equal((await call(job())).status, 200);
  assert.equal((await call(reviewer())).status, 200);
  assert.deepEqual(await spend(), { day: "2026-11-18", month: "2026-11", install: { day: { spent: 0.06, cap: 0.05 }, month: { spent: 0.06, cap: 0.2 } }, agents: [{ agent_id: "ag1", spent: 0.03 }] });
  // A kernel job's calls name the job as their run: the run page's join.
  const [jobCall] = (await (await fetch(`${front.url}/usage`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: "{}" })).json()).records.filter((r) => r.agentId === "ag1");
  assert.equal(jobCall.runId, "j-0123456789abcdef");
  assert.equal((await fetch(`${front.url}/v1/spend/summary`, { headers: { authorization: "Bearer nope" } })).status, 401);
  // The model picker's catalog: the list the gateway already holds, for the board's key only.
  assert.equal((await fetch(`${front.url}/v1/models/catalog`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const { models } = await (await fetch(`${front.url}/v1/models/catalog`, { headers: { authorization: "Bearer gw-board" } })).json();
  assert.deepEqual(models.find((x) => x.id === "anthropic/claude-haiku-5.5"), { id: "anthropic/claude-haiku-5.5", name: "anthropic/claude-haiku-5.5", provider: "anthropic", created: 0, context: 0, output: 4096, in: 1, cached_in: 0.1, out: 1, tools: false, reasoning: false });
  // An engine sizes its context window from /api/v1/models, with its own job credential.
  assert.equal((await fetch(`${front.url}/api/v1/models`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const listed = await (await fetch(`${front.url}/api/v1/models?ids=anthropic%2Fclaude-haiku-5.5`, { headers: { authorization: `Bearer ${job()}` } })).json();
  assert.deepEqual(listed.data.find((x) => x.id === "anthropic/claude-haiku-5.5"), { id: "anthropic/claude-haiku-5.5", object: "model", context_length: 0, max_completion_tokens: 4096 });
  // Past the day's limit every caller is refused, the reviewer, the source writers and the board's side chat included; the
  // owner is told once.
  for (const cred of [reviewer(), "src-key", "gw-board", job()]) {
    const r = await call(cred);
    assert.equal(r.status, 402);
    assert.equal(r.body.error.type, "cap_reached");
    assert.match(r.body.error.message, /^spend cap reached: the install's daily limit, \$0\.06 of \$0\.05 \(settings\.spend_day_usd\); the owner can raise it in Settings$/);
  }
  assert.equal(told.length, 1);
  assert.match(told[0], /daily spend limit \(\$0\.06 of \$0\.05/);
  assert.deepEqual(gw.exhausted("ag1", "iss1").map((o) => o.scope), ["day"]);

  // The next day: the month's limit (0.2) still counts the 0.06 before it. Calls go ahead below it, then every one is refused.
  now = Date.parse("2026-11-19T10:00:00Z");
  writeFileSync(settingsFile, JSON.stringify({ install_day_usd: 1, install_month_usd: 0.2 }));
  for (let i = 0; i < 5; i++) assert.equal((await call(reviewer())).status, 200, `$${(0.06 + i * 0.03).toFixed(2)} spent this month`);
  // The last call crossed it: admission's check tells the owner already, before any call is refused (and only once).
  assert.deepEqual(gw.exhausted("ag1", "iss1").map((o) => o.scope), ["month"]);
  await new Promise((r) => setImmediate(r)); // told after the caller's transaction
  assert.equal(told.length, 2);
  const month = await call(reviewer());
  assert.equal(month.status, 402);
  assert.match(month.body.error.message, /^spend cap reached: the install's monthly limit, \$0\.21 of \$0\.20 \(settings\.spend_month_usd\);/);
  assert.equal((await call(job())).status, 402);
  assert.equal(told.length, 2);
  assert.match(told[1], /monthly spend limit/);
  // A new month starts over.
  now = Date.parse("2026-12-01T00:10:00Z");
  assert.equal((await call(reviewer())).status, 200);
  // Unset or unreadable: the kernel's defaults, never no limit.
  writeFileSync(settingsFile, "{}");
  assert.deepEqual((await spend()).install, { day: { spent: 0.03, cap: 50 }, month: { spent: 0.03, cap: 1000 } });
  writeFileSync(settingsFile, "not json");
  assert.equal((await spend()).install.day.cap, 50);
});

test("gateway: a control plane blip never settles a chat run as capped for life, and a stalled stream is cut and settled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", paperclip_board_key: "pc-board" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden" } } }));
  const settingsFile = join(dir, "gateway.json");
  writeFileSync(settingsFile, "{}");
  const upstream = await serve((req, res) => { req.resume(); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"id":"gen-stall"}\n\n`); // then nothing: a stream that stalls
  }); });
  let down = true;
  const paperclip = await serve((req, res) => (down ? json(res, 502, {}) : json(res, 200, { labels: [{ name: "chat" }] })));
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, paperclipUrl: paperclip.url, jobLive: () => true, streamIdleMs: 50, taskRetryMs: [0] });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const x of [upstream, paperclip, front]) x.s.closeAllConnections?.(), x.s.close(); gw.close(); });
  const token = mintToken("job-secret", { kind: "job", job: "c1", agentId: "ag1", issueId: "chat1" });
  const call = () => fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "m", stream: true, messages: [] }) });
  // The control plane is down: the call is refused for now (the engine retries) and nothing about the run is settled.
  assert.equal((await call()).status, 503);
  assert.equal(gw.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
  // Back: the run is a chat task's (capped by the day), and the stalled answer is cut within streamIdleMs, its reservation settled.
  down = false;
  const r = await call();
  assert.equal(r.status, 200);
  await r.text().catch(() => {});
  assert.equal(gw.db.prepare("SELECT perpetual FROM runs").get().perpetual, 1);
  for (let i = 0; i < 100 && gw.inflight() > 0; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(gw.inflight(), 0);
  assert.equal(gw.db.prepare("SELECT status FROM calls").get().status, "unsettled"); // its generation is trued up later
});

test("gateway: Anthropic format: a check token's call settles at the streamed usage; only allowed betas and fields go up; a server tool is refused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  writeFileSync(join(dir, "grants.json"), "{}");
  writeFileSync(join(dir, "gateway.json"), "{}");
  const seen = [];
  // OpenRouter's /messages stream as captured 2026-11-20: id and input in message_start, final usage and cost in message_delta.
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push({ url: req.url, beta: req.headers["anthropic-beta"], version: req.headers["anthropic-version"], body: JSON.parse(b) });
      res.writeHead(200, { "content-type": "text/event-stream", "x-generation-id": "gen-1795-abc" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_vrtx_1", model: "anthropic/claude-haiku-5.5", usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } })}\n\n`);
      res.end(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 14, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cost: 0.0021 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
    });
  });
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => ({ openrouter_key: "sk-real", gateway_job_secret: "job-secret" })[n] ?? "", upstream: upstream.url, modelsUrl });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); gw.close(); });
  const token = mintToken("job-secret", { kind: "check", component: "code-review:c1" });
  const call = (body) => fetch(`${front.url}/api/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219,effort-2025-11-24,some-pricier-beta-2026-01-01" }, body: JSON.stringify(body) });
  const ok = await call({ model: "anthropic/claude-haiku-5.5", max_tokens: 1024, stream: true, speed: "fast", service_tier: "priority", mcp_servers: [{ url: "https://x" }], tools: [{ name: "mcp__repo__diff", input_schema: {} }], messages: [] });
  assert.equal(ok.status, 200);
  await ok.text();
  assert.deepEqual([seen[0].url, seen[0].beta, seen[0].version], ["/messages", "claude-code-20250219,effort-2025-11-24", "2023-06-01"]);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["max_tokens", "messages", "model", "provider", "stream", "tools"]);
  assert.equal(seen[0].body.provider.zdr, true);
  const row = gw.db.prepare("SELECT input, cached, output, cost_usd, status, gen FROM calls").get();
  assert.deepEqual({ ...row }, { input: 112, cached: 1000, output: 14, cost_usd: 0.0021, status: "ok", gen: "gen-1795-abc" });
  // A server tool (billed per use, outside the reservation) never goes up.
  const refused = await call({ model: "anthropic/claude-haiku-5.5", max_tokens: 1024, tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [] });
  assert.equal(refused.status, 403);
  assert.equal(seen.length, 1);
});
// An in-stream failure as OpenRouter sends it (seen live on 2026-11-22): HTTP 200 and a generation, the answer opened, then failed.
const sse = (events) => events.map((e) => `data:${JSON.stringify(e)}\n\n`).join(""); // no space after the colon: valid SSE
// Each opening event echoes the request (Codex's instructions and tools: well over 64 KiB).
const opened = (id, echo = "") => [{ type: "response.created", response: { id, status: "in_progress", error: null, instructions: echo } }, { type: "response.in_progress", response: { id, status: "in_progress", error: null, instructions: echo } }];
const failed = (id, code) => ({ type: "response.failed", response: { id, status: "failed", error: { code, message: "secret provider text" } } });
const streamed = (body) => (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`: OPENROUTER PROCESSING\n\n${body}data: [DONE]\n\n`); };
const completed = sse([...opened("gen-ok"), { type: "response.output_text.delta", delta: "Hi" }, { type: "response.completed", response: { id: "gen-ok", model: "m", usage: { input_tokens: 10, output_tokens: 5, cost: 0.02 } } }]);

async function streamRig(t, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  writeFileSync(join(dir, "gateway.json"), JSON.stringify(settings));
  const rig = { answers: [], posts: 0, logged: [], bodies: [] };
  const upstream = await serve((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { rig.posts++; if (b) rig.bodies.push(JSON.parse(b)); rig.answers.shift()(res); }); });
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => ({ openrouter_key: "sk-real", gateway_job_secret: "job-secret" })[n] ?? "", upstream: upstream.url, modelsUrl, retryDelaysMs: [0, 0], streamIdleMs: 300, log: (m, f) => rig.logged.push([m, f]) });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.closeAllConnections?.(); upstream.s.close(); front.s.close(); gw.close(); });
  const token = mintToken("job-secret", { kind: "reviewer" });
  // A 30 KB prompt: reserved at about 10,000 input tokens x $1/M = $0.01.
  rig.body = { model: "m", stream: true, input: "x".repeat(30_000) };
  rig.gw = gw;
  rig.call = async (path = "responses", body = rig.body) => { const r = await fetch(`${front.url}/api/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  rig.rows = () => gw.db.prepare("SELECT status, cost_usd, input, output FROM calls ORDER BY rowid").all().map((x) => ({ ...x }));
  rig.fresh = () => { gw.db.exec("DELETE FROM calls"); rig.posts = 0; };
  return rig;
}

test("gateway: a stream that fails in-band is booked free as stream_error (OpenRouter bills none), its tokens kept", async (t) => {
  const rig = await streamRig(t);

  // Output streamed, then an error event: free, visible as stream_error.
  rig.answers = [streamed(sse([...opened("gen-a"), { type: "response.output_text.delta", delta: "Hel" }, failed("gen-a", "server_error")]))];
  assert.match((await rig.call()).text, /response\.failed/);
  let [row] = rig.rows();
  assert.deepEqual([row.status, row.cost_usd], ["stream_error", 0]);
  assert.equal(rig.logged.find(([m]) => m === "upstream stream error")[1].reason, "error event: server_error");

  // A usage block named the input (Anthropic's message_start): its tokens are kept, still at $0.
  rig.fresh();
  rig.answers = [streamed(sse([{ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 1 } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }, { type: "error", error: { type: "overloaded_error", message: "secret provider text" } }]))];
  await rig.call("messages", { model: "m", stream: true, max_tokens: 64, messages: [{ role: "user", content: "x".repeat(30_000) }] });
  [row] = rig.rows();
  assert.deepEqual([row.status, row.input, row.cost_usd], ["stream_error", 100, 0]);

  // A usage block on an error event is never taken as completion.
  rig.fresh();
  rig.answers = [streamed(sse([{ id: "gen-u", choices: [{ delta: { content: "Hi" } }] }, { id: "gen-u", error: { code: 502, message: "secret provider text" }, usage: { prompt_tokens: 50, completion_tokens: 1 } }]))];
  await rig.call("chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "x".repeat(30_000) }] });
  [row] = rig.rows();
  assert.deepEqual([row.status, row.input, row.cost_usd], ["stream_error", 50, 0]);

  // A completion whose JSON spans two data fields of one event is read whole: billed, not failed.
  rig.fresh();
  const done = JSON.stringify({ type: "response.completed", response: { id: "gen-s", model: "m", usage: { input_tokens: 10, output_tokens: 5, cost: 0.02 } } });
  rig.answers = [streamed(`${sse(opened("gen-s"))}data: ${done.slice(0, done.indexOf(",") + 1)}\ndata: ${done.slice(done.indexOf(",") + 1)}\n\n`)];
  await rig.call();
  assert.deepEqual(rig.rows().map((x) => [x.status, x.cost_usd]), [["ok", 0.02]]);

  // A clean end with neither usage nor a finish (no error event) is no in-band failure: OpenRouter may have billed it, so it
  // keeps its reservation (input estimate plus its output bound), then is settled from OpenRouter's record of its generation.
  rig.fresh();
  rig.answers = [streamed(sse([...opened("gen-c"), { type: "response.output_text.delta", delta: "Hi" }]))];
  await rig.call();
  [row] = rig.rows();
  assert.equal(row.status, "unsettled");
  assert.ok(row.cost_usd > 0.01, String(row.cost_usd));
  rig.answers = [(res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { model: "m", total_cost: 0.0042, native_tokens_prompt: 10_000, native_tokens_completion: 3 } }))];
  await rig.gw.trueUp();
  assert.deepEqual(rig.rows().map((x) => [x.status, x.cost_usd]), [["interrupted", 0.0042]]);
  // Without a generation id it stays at the reservation, never $0, still `unsettled` (a hold, not a bill, for the board).
  rig.fresh();
  rig.answers = [streamed(sse([{ type: "response.output_text.delta", delta: "Hi" }]))];
  await rig.call();
  [row] = rig.rows();
  assert.deepEqual([row.status, row.cost_usd > 0.01], ["unsettled", true]);
  assert.doesNotMatch(JSON.stringify(rig.logged), /secret provider text/, "provider and model text stay out of the journal");
});

test("gateway: an answer that failed before any output is re-run once when its error is transient; one that streamed output or completed never is", async (t) => {
  const rig = await streamRig(t);

  // The incident's shape: opened (echoing a large request), then failed (rate limited). Nothing reached the caller, so it is
  // re-run; the caller gets the completed answer and the failed attempt keeps its own free stream_error row.
  rig.answers = [streamed(sse([...opened("gen-x", rig.body.input + "y".repeat(80_000)), failed("gen-x", "rate_limit_exceeded")])), streamed(completed)];
  rig.body = { ...rig.body, input: rig.body.input + "y".repeat(80_000) };
  const rerun = await rig.call();
  assert.equal(rerun.status, 200);
  assert.doesNotMatch(rerun.text, /gen-x|secret provider text/, "nothing of the failed attempt reaches the caller");
  assert.match(rerun.text, /^: OPENROUTER PROCESSING[\s\S]*response\.created[\s\S]*response\.completed/, "the chosen attempt's opening events are replayed once");
  assert.equal(rig.posts, 2);
  assert.deepEqual(rig.rows().map((x) => [x.status, x.cost_usd]), [["ok", 0.02], ["stream_error", 0]]);
  assert.equal(rig.logged.find(([m]) => m === "upstream retry")[1].stream_error, "rate_limit_exceeded");

  // Only once: a second failure goes to the caller as it came (Codex retries on its own).
  rig.fresh();
  rig.answers = [streamed(sse([...opened("gen-y"), failed("gen-y", "rate_limit_exceeded")])), streamed(sse([...opened("gen-z"), failed("gen-z", "rate_limit_exceeded")])), streamed(completed)];
  assert.match((await rig.call()).text, /gen-z[\s\S]*response\.failed/);
  assert.equal(rig.posts, 2);
  assert.deepEqual(rig.rows().map((x) => x.status), ["stream_error", "stream_error"]);

  // A Responses `error` event, its code at the top: read as transient too.
  rig.fresh();
  rig.answers = [streamed(sse([...opened("gen-e"), { type: "error", code: "server_error", message: "secret provider text" }])), streamed(completed)];
  assert.match((await rig.call()).text, /response\.completed/);
  assert.equal(rig.posts, 2);

  // A chat stream's role-only first chunk is no output: a transient error after it is re-run too.
  rig.fresh();
  rig.answers = [streamed(sse([{ id: "gen-r", choices: [{ delta: { role: "assistant", content: "" } }] }, { id: "gen-r", error: { code: 502, message: "secret provider text" }, choices: [{ delta: {}, finish_reason: "error" }] }])), streamed(completed)];
  assert.match((await rig.call("chat/completions", { model: "m", stream: true, messages: [] })).text, /response\.completed/);
  assert.equal(rig.posts, 2);

  // A permanent error before any output: not re-run.
  rig.fresh();
  rig.answers = [streamed(sse([...opened("gen-p"), failed("gen-p", "invalid_prompt")])), streamed(completed)];
  await rig.call();
  assert.equal(rig.posts, 1);

  // A transient error after output was streamed: never re-run (the caller already has part of the answer).
  rig.fresh();
  rig.answers = [streamed(sse([...opened("gen-o"), { type: "response.output_text.delta", delta: "Hi" }, failed("gen-o", "server_error")])), streamed(completed)];
  await rig.call();
  assert.equal(rig.posts, 1);

  // A completed answer followed by an error event: billed what OpenRouter billed, never re-run.
  rig.fresh();
  rig.answers = [streamed(completed + sse([failed("gen-ok", "server_error")])), streamed(completed)];
  await rig.call();
  assert.equal(rig.posts, 1);
  assert.deepEqual(rig.rows().map((x) => [x.status, x.cost_usd]), [["ok", 0.02]]);

  // A re-run is cap-checked against everything but the call's own hold (which already covers it): its own reservation past
  // the install's day limit ($0.005 here) still re-runs; other spend reaching the limit meanwhile sends the failure to the caller.
  const capped = await streamRig(t, { install_day_usd: 0.005 });
  capped.answers = [streamed(sse([...opened("gen-c"), failed("gen-c", "rate_limit_exceeded")])), streamed(completed)];
  assert.match((await capped.call()).text, /response\.completed/);
  assert.equal(capped.posts, 2);
  capped.fresh();
  const other = () => { const t0 = new Date(); capped.gw.db.prepare("INSERT INTO calls (key, at, day, run_key, kind, component, model, cost_usd, status) VALUES ('other', ?, ?, 'r', 'agent', 'agent', 'm', 1, 'ok')").run(t0.toISOString(), t0.toISOString().slice(0, 10)); };
  capped.answers = [(res) => { other(); streamed(sse([...opened("gen-c"), failed("gen-c", "rate_limit_exceeded")]))(res); }, streamed(completed)];
  assert.match((await capped.call()).text, /response\.failed/);
  assert.equal(capped.posts, 1);
  assert.deepEqual(capped.rows().map((x) => x.status), ["stream_error", "ok"]); // the call, then the other spend
  // The re-run is sized again: the discarded attempt's input estimate ($0.01) leaves it less output than the first attempt got.
  const tight = await streamRig(t, { install_day_usd: 0.022 });
  tight.answers = [streamed(sse(opened("gen-t"))), streamed(completed)];
  assert.match((await tight.call()).text, /response\.completed/);
  assert.equal(tight.posts, 2);
  assert.equal(tight.bodies[0].max_output_tokens, 4096);
  assert.ok(tight.bodies[1].max_output_tokens > 1900 && tight.bodies[1].max_output_tokens < 2000, String(tight.bodies[1].max_output_tokens));
  // An attempt that ended before any output may be billed: its own input estimate ($0.01) past the limit refuses the re-run.
  capped.fresh();
  capped.answers = [streamed(sse(opened("gen-q"))), streamed(completed)];
  await capped.call();
  assert.equal(capped.posts, 1);
  assert.deepEqual(capped.rows().map((x) => x.status), ["unsettled"]);

  // An attempt that just ended before any output (no error event) is re-run too, but not booked free: its row keeps the input
  // estimate, trued up from its generation.
  rig.fresh();
  rig.answers = [streamed(sse(opened("gen-n"))), streamed(completed)];
  assert.match((await rig.call()).text, /response\.completed/);
  assert.equal(rig.posts, 2);
  const rows = rig.rows();
  assert.deepEqual(rows.map((x) => x.status), ["ok", "unsettled"]);
  assert.equal(rows[1].cost_usd, Math.ceil(JSON.stringify(rig.body).length / 3) / 1e6); // the input estimate at $1 a million

  // Keep-alives past the first-output wait (a quarter of the idle cut here): passed through as they come, and still billed.
  rig.fresh();
  rig.answers = [(res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": OPENROUTER PROCESSING\n\n"); setTimeout(() => res.end(completed), 150); }];
  assert.match((await rig.call()).text, /^: OPENROUTER PROCESSING[\s\S]*response\.completed/);
  assert.deepEqual(rig.rows().map((x) => [x.status, x.cost_usd]), [["ok", 0.02]]);
});

test("usage tap: an echoed finish_reason is no finish, and completed usage outlives a later error chunk's", () => {
  const sseOf = (...events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const echoed = usageTap(true);
  echoed.feed(sseOf({ type: "response.created", response: { id: "gen-1", error: null, tools: [{ parameters: { example: { finish_reason: "stop" } } }] } }));
  echoed.done();
  assert.match(echoed.failure()?.reason ?? "", /no usage or finish/);
  assert.equal(echoed.failure()?.inBand, false);
  // A finish without its final usage (Anthropic's message_stop with no usage-bearing message_delta): not complete either.
  const unbilled = usageTap(true);
  unbilled.feed(sseOf({ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 100, output_tokens: 1 } } }, { type: "message_stop" }));
  unbilled.done();
  assert.deepEqual(unbilled.failure(), { reason: "a finish without final usage; last event: message_stop", inBand: false });
  const completed = usageTap(true);
  completed.feed(sseOf({ id: "gen-2", model: "m", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.02 } }, { id: "gen-2", error: { code: 500 }, usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }));
  assert.deepEqual([completed.done()?.output, completed.done()?.costUsd, completed.failure()], [5, 0.02, undefined]);
});

test("usage tap: a JSON answer without an id (an embedding) still counts its usage, under the call's own key", () => {
  const tap = usageTap(false);
  tap.feed(JSON.stringify({ object: "list", data: [{ embedding: [0.1] }], model: "google/gemini-embedding-001", usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.0002 } }));
  assert.deepEqual(tap.done(), { key: undefined, model: "google/gemini-embedding-001", input: 12, cached: 0, output: 0, costUsd: 0.0002 });
});
