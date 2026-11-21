// End to end against a fake OpenRouter and a fake control plane: attribution, billed cost in the ledger, the
// cap → 402 with one raise_cap filed, the owner's raise, the daily reset of a chat task, system kinds uncapped, and no way
// to switch the caps off (G10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway/lib.ts";
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

test("gateway: attribution, billed cost, caps, raise_cap once, daily reset, no off switch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", gateway_board_key: "gw-board", gateway_source_key: "src-key", paperclip_board_key: "pc-board", board_internal_token: "internal" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden", rev: "abc123", caps: { run_usd: 0.05, task_usd: 0.08, day_usd: 30 } }, ag2: { key: "eng" } } }));
  const settingsFile = join(dir, "gateway.json");
  writeFileSync(settingsFile, "{}");
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
  const runs = { run1: "iss1", run2: "iss1", c1: "chat1", c2: "chat1", c3: "chat1" };
  const paperclip = await serve((req, res) => {
    const auth = String(req.headers.authorization).slice(7);
    if (auth !== "pc-board") return json(res, 403, {});
    const m = /^\/api\/issues\/(\w+)$/.exec(req.url);
    if (m && issues[m[1]]) return json(res, 200, issues[m[1]]);
    json(res, 404, {});
  });
  // kernel.raise_cap, as main.ts files it (writes.ts fileNative): each filing kept.
  const filed = [];
  let now = Date.parse("2026-11-13T10:00:00Z");
  // A kernel job of `agent` on its run's task: one token per job (its hash is the run key), expiring at `exp` (seconds) if given.
  const T0 = now, minted = new Map();
  const jobToken = (agent, job, exp) => {
    const k = `${agent}/${job}/${exp}`;
    if (!minted.has(k)) minted.set(k, mintToken("job-secret", { kind: "job", job, agentId: agent, issueId: runs[job] ?? null, ttlMs: exp ? exp * 1000 - T0 : 365 * 864e5 }, T0));
    return minted.get(k);
  };
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, paperclipUrl: paperclip.url, fileRaiseCap: async (b) => void filed.push(b), jobLive: () => true, now: () => now });
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

  // A fast chat lane's turn token: a capped agent call, attributed to the lane; the lane secret never mints a system kind.
  assert.equal((await call(signed("lane-secret", { k: "agent", a: "ag2", c: "Aria" }, now))).status, 200);
  assert.equal((await call(mintToken("lane-secret", { kind: "reviewer" }, now))).status, 401);
  rows = await usage();
  assert.deepEqual([rows[1].agentId, rows[1].component, rows[1].kind], ["ag2", "Fast lane: Aria", "agent"]);

  // The board's side chat (its own key): a capped call of its own kind, with no agent behind it.
  assert.equal((await call("gw-board")).status, 200);
  rows = await usage();
  assert.deepEqual([rows[2].agentId, rows[2].component, rows[2].kind], [null, "Board side chat", "aside"]);

  // Run cap $0.05: the second call starts at $0.03 (allowed), the third at $0.06 is refused. A run cap is never filed for
  // raising (the next run has a new key): one ledger row, a message that says the run stops.
  assert.equal((await call(jobToken("ag1", "run1"))).status, 200);
  const refused = await call(jobToken("ag1", "run1"));
  assert.equal(refused.status, 402);
  const err = JSON.parse(refused.text).error;
  assert.equal(err.type, "cap_reached");
  assert.match(err.message, /^spend cap reached: run \$0\.06 of \$0\.05; this run stops here; the next run starts with a fresh run cap$/);
  assert.doesNotMatch(err.message, /usage limit|rate limit|try again|quota|capacity/i); // Paperclip would schedule a retry
  for (let i = 0; i < 5; i++) assert.equal((await call(jobToken("ag1", "run1"))).status, 402); // Codex retries a 402 five times
  assert.equal(filed.length, 0);
  assert.equal((await usage()).filter((r) => r.status === "cap_reached").length, 1);

  // Task cap $0.08: a new run on iss1 takes it to $0.09, then is refused at the task scope; one raise_cap filed.
  assert.equal((await call(jobToken("ag1", "run2"))).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call(jobToken("ag1", "run2"))).status, 402);
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0], { task: "iss1", scope: "task", agentId: "ag1", subject: "iss1", cap: 0.08, spent: 0.09 });

  // The owner raised it (the board's write): calls go through again.
  const raise = await fetch(`${front.url}/internal/caps`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: JSON.stringify({ scope: "task", agentId: "ag1", subject: "iss1", cap: 0.16 }) });
  assert.equal(raise.status, 200);
  assert.equal((await call(jobToken("ag1", "run2"))).status, 200);

  // The monitoring module's metrics (a textfile gateway.ts writes; no route): agent keys as labels.
  assert.equal((await fetch(`${front.url}/metrics`)).status, 404);
  const text = gw.metricsText();
  assert.match(text, /^aidenhq_gateway_agent_day_cap_usd\{agent="aiden"\} 30$/m);
  assert.match(text, /^aidenhq_gateway_agent_day_spend_usd\{agent="aiden"\} 0\.\d+$/m);
  assert.match(text, /^aidenhq_gateway_cap_refusals_today\{agent="aiden",kind="agent"\} 2$/m);
  assert.match(text, /^aidenhq_gateway_spend_usd_today\{agent="eng",kind="agent"\} 0\.03$/m); // its fast lane turn
  assert.doesNotMatch(text, /ag1|sk-real/); // ids and secrets never ride along
  for (const l of text.trim().split("\n")) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?)$/);

  // An expired job token is refused even once its run key is settled.
  const exp = Math.floor(now / 1000) + 60;
  assert.equal((await call(jobToken("ag1", "run3", exp))).status, 200);
  now += 120_000;
  assert.equal((await call(jobToken("ag1", "run3", exp))).status, 401);

  // OpenRouter's stream breaks mid-body: the call still lands in the ledger (upstream_aborted), charged its reservation (the input's estimate).
  await call(jobToken("ag1", "run4"));
  await call(jobToken("ag1", "run4"), { model: "breaks" }).catch(() => {});
  const aborted = (await usage()).filter((r) => r.status === "upstream_aborted");
  assert.deepEqual(aborted.map((r) => r.runId), ["run4"]);
  assert.ok(aborted[0].costUsd > 0 && aborted[0].costUsd < 0.0001, String(aborted[0].costUsd));

  // A chat task's cap counts the UTC day: refused at $0.09 today, open again tomorrow.
  for (const r of ["c1", "c2", "c3"]) await call(jobToken("ag1", r));
  const chatRefused = await call(jobToken("ag1", "c3"));
  assert.equal(chatRefused.status, 402);
  assert.match(JSON.parse(chatRefused.text).error.message, /task/);
  assert.equal(filed.at(-1).subject, "chat1:2026-11-13");
  now += 864e5;
  assert.equal((await call(jobToken("ag1", "c3"))).status, 200);

  // The agent-day cap, across tasks; no refusal text may look like a quota or a retry time to Paperclip.
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden", rev: "abc123", caps: { run_usd: 0.05, task_usd: 0.08, day_usd: 30 } }, ag3: { key: "x", caps: { run_usd: 1, task_usd: 1, day_usd: 0.05 } } } }));
  const dayJob = (i) => mintToken("job-secret", { kind: "job", job: `j-${i}`, agentId: "ag3", issueId: i }, now);
  for (const i of ["d1", "d2"]) assert.equal((await call(dayJob(i))).status, 200);
  const dayRefused = await call(dayJob("d3"));
  assert.match(JSON.parse(dayRefused.text).error.message, /^spend cap reached: agent-day \$0\.06 of \$0\.05;/);
  for (const r of [refused, chatRefused, dayRefused]) assert.doesNotMatch(JSON.parse(r.text).error.message, /usage limit|rate[- ]?limit|try again|quota|capacity|429|service unavailable|temporary|spawn|ENOENT|\d{4}-\d{2}-\d{2}|\d+:\d\d/i);

  // A grader token (the grading module's, per held task) names the agent it is billed to: its calls count against that agent's caps.
  const graded = await call(mintToken("job-secret", { kind: "grader", agentId: "ag3", issueId: "g1", component: "Grader" }, now));
  assert.match(JSON.parse(graded.text).error.message, /^spend cap reached: agent-day/, "charged to the graded agent's day cap");
  assert.equal((await call(mintToken("job-secret", { kind: "grader", agentId: "ag2", issueId: "g2", component: "Grader" }, now))).status, 200);
  assert.equal((await usage()).filter((r) => r.kind === "grader" && r.status === "ok").at(-1).agentId, "ag2");

  // System kinds are never capped. The old kill switch is gone: a stale enforce_caps: false still refuses (G10).
  const reviewer = mintToken("job-secret", { kind: "reviewer", issueId: "iss1" }, now);
  cost = 5;
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call("src-key")).status, 200);
  writeFileSync(settingsFile, JSON.stringify({ enforce_caps: false }));
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

test("gateway: the install cap counts every call of the day, no-agent ones too, and files one raise for the install; the spend summary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", gateway_board_key: "gw-board", gateway_source_key: "src-key" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden" } } }));
  const settingsFile = join(dir, "gateway.json");
  writeFileSync(settingsFile, JSON.stringify({ install_day_usd: 0.05 }));
  const upstream = await serve((req, res) => { req.resume(); req.on("end", () => json(res, 200, { id: `gen-${Math.random()}`, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.03 } })); });
  const filed = [];
  const now = Date.parse("2026-11-18T10:00:00Z");
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, fileRaiseCap: async (b) => void filed.push(b), jobLive: () => true, now: () => now });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); gw.close(); });
  const call = async (cred) => {
    const res = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${cred}` }, body: JSON.stringify({ model: "m", max_tokens: 1024, messages: [] }) });
    return { status: res.status, body: await res.json() };
  };
  const spend = async () => (await fetch(`${front.url}/v1/spend/summary`, { headers: { authorization: "Bearer gw-board" } })).json();
  const reviewer = mintToken("job-secret", { kind: "reviewer" }, now); // a system kind: no agent, never capped per agent

  // Two calls of different callers (a kernel job of ag1, then the uncapped reviewer) spend 0.06 of the install's 0.05: the
  // summary has today against the install cap and each agent's day against its own cap (the grants default here).
  assert.equal((await call(mintToken("job-secret", { kind: "job", job: "j-0123456789abcdef", agentId: "ag1", issueId: "iss1" }, now))).status, 200);
  assert.equal((await call(reviewer)).status, 200);
  assert.deepEqual(await spend(), { day: "2026-11-18", install: { spent: 0.06, cap: 0.05 }, agents: [{ agent_id: "ag1", spent: 0.03, cap: 30 }] });
  // A kernel job's calls name the job as their run: the run page's join.
  const [jobCall] = (await (await fetch(`${front.url}/usage`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: "{}" })).json()).records.filter((r) => r.agentId === "ag1");
  assert.equal(jobCall.runId, "j-0123456789abcdef");
  assert.equal((await fetch(`${front.url}/v1/spend/summary`, { headers: { authorization: "Bearer nope" } })).status, 401);
  // Past it every caller is refused, the reviewer, the source writers and the board's side chat included: one raise, no task.
  for (const cred of [reviewer, "src-key", "gw-board", mintToken("job-secret", { kind: "job", job: "j-0123456789abcdef", agentId: "ag1", issueId: "iss1" }, now)]) {
    const r = await call(cred);
    assert.equal(r.status, 402);
    assert.equal(r.body.error.type, "cap_reached");
    assert.match(r.body.error.message, /^spend cap reached: the install's daily \$0\.06 of \$0\.05; the owner has been asked to raise it$/);
  }
  assert.deepEqual(filed, [{ task: null, scope: "day", agentId: "install", subject: "2026-11-18", cap: 0.05, spent: 0.06 }]);
  // The owner's raise (the approved card): calls go through again, and the header shows the raised cap.
  gw.setCap("day", "install", "2026-11-18", 0.1);
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await spend()).install.cap, 0.1);
  // Unset, no install cap at all.
  writeFileSync(settingsFile, "{}");
  assert.equal((await spend()).install.cap, null);
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
  assert.equal(gw.db.prepare("SELECT status FROM calls").get().status, "upstream_aborted");
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
  const token = mintToken("job-secret", { kind: "check", component: "code-review:c1", capUsd: 1 });
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
test("gateway: a reviewer token's own cap (REVIEW_USD): calls go ahead while its spend is below the cap, a 402 once it reaches it, nothing filed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  writeFileSync(join(dir, "gateway.json"), "{}");
  const upstream = await serve((req, res) => { req.resume(); req.on("end", () => json(res, 200, { id: `gen-${Math.random()}`, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.03 } })); });
  const filed = [];
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), secret: (n) => ({ openrouter_key: "sk-real", gateway_job_secret: "job-secret" })[n] ?? "", upstream: upstream.url, modelsUrl, fileRaiseCap: async (b) => void filed.push(b) });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { upstream.s.close(); front.s.close(); gw.close(); });
  const review = mintToken("job-secret", { kind: "reviewer", component: "AI reviewer", capUsd: 0.05 });
  const call = async () => { const r = await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${review}` }, body: JSON.stringify({ model: "m", max_tokens: 1024, messages: [] }) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await call()).status, 200, "$0 spent of $0.05");
  assert.equal((await call()).status, 200, "$0.03 spent, still below the cap: it goes ahead");
  const over = await call();
  assert.equal(over.status, 402, "$0.06 spent: at the cap");
  assert.equal(over.body.error.type, "cap_reached");
  // Another review's token has its own run key, so its own cap.
  assert.equal((await fetch(`${front.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${mintToken("job-secret", { kind: "reviewer", component: "AI reviewer", capUsd: 0.05 })}` }, body: JSON.stringify({ model: "m", max_tokens: 1024, messages: [] }) })).status, 200);
  assert.deepEqual(filed, [], "a review's cap is never filed for raising: the review escalates to the owner instead");
});
