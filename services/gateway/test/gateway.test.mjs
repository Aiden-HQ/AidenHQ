// End to end against a fake OpenRouter, a fake Paperclip and a fake board: attribution, billed cost in the ledger, the
// cap → 402 with one raise_cap filed, the owner's raise, the daily reset of a chat task, system kinds uncapped, the kill switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../lib.ts";
import { mintToken } from "../token.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub, runId, exp) => `eyJhbGciOiJIUzI1NiJ9.${b64({ sub, run_id: runId, exp })}.sig`;

test("gateway: attribution, billed cost, caps, raise_cap once, daily reset, kill switch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const secrets = { openrouter_key: "sk-real", gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", gateway_board_key: "gw-board", gateway_source_key: "src-key", paperclip_board_key: "pc-board", board_internal_token: "internal" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden", rev: "abc123", caps: { run_usd: 0.05, task_usd: 0.08, day_usd: 30 } }, ag2: { key: "eng" } } }));
  const settingsFile = join(dir, "gateway.json");
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
    if (req.url === "/api/agents/me") return auth.endsWith(".sig") ? json(res, 200, { id: JSON.parse(Buffer.from(auth.split(".")[1], "base64url")).sub }) : json(res, 401, {});
    if (auth !== "pc-board") return json(res, 403, {});
    let m = /^\/api\/heartbeat-runs\/(\w+)$/.exec(req.url);
    if (m) return json(res, 200, { id: m[1], issueId: runs[m[1]] });
    m = /^\/api\/issues\/(\w+)$/.exec(req.url);
    if (m) return json(res, 200, issues[m[1]]);
    json(res, 404, {});
  });
  const filed = [];
  const board = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      assert.equal(req.headers["x-gateway-key"], "gw-board");
      filed.push(JSON.parse(b));
      json(res, 200, { id: "A0000001" });
    });
  });
  let now = Date.parse("2026-11-13T10:00:00Z");
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, paperclipUrl: paperclip.url, boardUrl: board.url, now: () => now });
  const front = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const x of [upstream, paperclip, board, front]) x.s.close(); gw.close(); });

  const call = async (cred, { path = "/api/v1/chat/completions", model = "~deepseek/deepseek-flash-latest", models } = {}) => {
    const res = await fetch(front.url + path, { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: JSON.stringify({ model, models, stream: true, messages: [] }) });
    return { status: res.status, text: await res.text() };
  };
  const usage = async (since = "") => (await (await fetch(`${front.url}/usage`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: JSON.stringify({ since }) })).json()).records;

  // A Paperclip run: billed, attributed to its agent, run and task, with the rev; the real key goes upstream, ZDR forced.
  const r1 = await call(jwt("ag1", "run1"));
  assert.equal(r1.status, 200);
  assert.match(r1.text, /\[DONE\]/);
  assert.deepEqual(seen[0], { auth: "Bearer sk-real", zdr: true, url: "/chat/completions" });
  let rows = await usage();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], runKey: rows[0].runKey.length }, { key: "gen-1", at: rows[0].at, agentId: "ag1", component: "agent", model: "deepseek/v4", input: 60, cached: 40, output: 20, costUsd: 0.03, runKey: 64, runId: "run1", issueId: "iss1", rev: "abc123", kind: "agent", ms: 0, status: "ok" });

  // An Engineer job's token (responses, non-streamed); unknown credentials are refused.
  const job = mintToken("job-secret", { agentId: "ag2", issueId: "iss9" }, now);
  assert.equal((await call(job, { path: "/api/v1/responses" })).status, 200);
  assert.equal((await call("sk-guess")).status, 401);
  assert.equal((await call(mintToken("wrong", { agentId: "ag2" }, now))).status, 401);
  rows = await usage();
  assert.deepEqual([rows[1].agentId, rows[1].issueId, rows[1].component, rows[1].costUsd], ["ag2", "iss9", "Engineer jobs", 0.03]);

  // A fast chat lane's turn token: a capped agent call, attributed to the lane; the lane secret never mints a system kind.
  assert.equal((await call(mintToken("lane-secret", { agentId: "ag2", component: "Aria" }, now))).status, 200);
  assert.equal((await call(mintToken("lane-secret", { kind: "reviewer" }, now))).status, 401);
  rows = await usage();
  assert.deepEqual([rows[2].agentId, rows[2].component, rows[2].kind], ["ag2", "Fast lane: Aria", "agent"]);

  // Run cap $0.05: the second call starts at $0.03 (allowed), the third at $0.06 is refused. A run cap is never filed for
  // raising (the next run has a new key): one ledger row, a message that says the run stops.
  assert.equal((await call(jwt("ag1", "run1"))).status, 200);
  const refused = await call(jwt("ag1", "run1"));
  assert.equal(refused.status, 402);
  const err = JSON.parse(refused.text).error;
  assert.equal(err.type, "cap_reached");
  assert.match(err.message, /^spend cap reached: run \$0\.06 of \$0\.05; this run stops here; the next run starts with a fresh run cap$/);
  assert.doesNotMatch(err.message, /usage limit|rate limit|try again|quota|capacity/i); // Paperclip would schedule a retry
  for (let i = 0; i < 5; i++) assert.equal((await call(jwt("ag1", "run1"))).status, 402); // Codex retries a 402 five times
  assert.equal(filed.length, 0);
  assert.equal((await usage()).filter((r) => r.status === "cap_reached").length, 1);

  // Task cap $0.08: a new run on iss1 takes it to $0.09, then is refused at the task scope; one raise_cap filed.
  assert.equal((await call(jwt("ag1", "run2"))).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call(jwt("ag1", "run2"))).status, 402);
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0], { issue: "iss1", scope: "task", agentId: "ag1", subject: "iss1", cap: 0.08, spent: 0.09 });

  // The owner raised it (the board's write): calls go through again.
  const raise = await fetch(`${front.url}/internal/caps`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: JSON.stringify({ scope: "task", agentId: "ag1", subject: "iss1", cap: 0.16 }) });
  assert.equal(raise.status, 200);
  assert.equal((await call(jwt("ag1", "run2"))).status, 200);

  // The monitoring module's metrics (a textfile gateway.ts writes; no route): agent keys as labels.
  assert.equal((await fetch(`${front.url}/metrics`)).status, 404);
  const text = gw.metricsText();
  assert.match(text, /^aidenhq_gateway_agent_day_cap_usd\{agent="aiden"\} 30$/m);
  assert.match(text, /^aidenhq_gateway_agent_day_spend_usd\{agent="aiden"\} 0\.\d+$/m);
  assert.match(text, /^aidenhq_gateway_cap_refusals_today\{agent="aiden",kind="agent"\} 2$/m);
  assert.match(text, /^aidenhq_gateway_spend_usd_today\{agent="eng",kind="agent"\} 0\.06$/m); // its Engineer job and its fast lane turn
  assert.doesNotMatch(text, /ag1|sk-real/); // ids and secrets never ride along
  for (const l of text.trim().split("\n")) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?)$/);

  // An expired run JWT is refused even once its run key is settled.
  const exp = Math.floor(now / 1000) + 60;
  assert.equal((await call(jwt("ag1", "run3", exp))).status, 200);
  now += 120_000;
  assert.equal((await call(jwt("ag1", "run3", exp))).status, 401);

  // OpenRouter's stream breaks mid-body: the call still lands in the ledger (upstream_aborted, priced at the run's average).
  await call(jwt("ag1", "run4"));
  await call(jwt("ag1", "run4"), { model: "breaks" }).catch(() => {});
  const aborted = (await usage()).filter((r) => r.status === "upstream_aborted");
  assert.deepEqual(aborted.map((r) => [r.runId, r.costUsd]), [["run4", 0.03]]);

  // A chat task's cap counts the UTC day: refused at $0.09 today, open again tomorrow.
  for (const r of ["c1", "c2", "c3"]) await call(jwt("ag1", r));
  const chatRefused = await call(jwt("ag1", "c3"));
  assert.equal(chatRefused.status, 402);
  assert.match(JSON.parse(chatRefused.text).error.message, /task/);
  assert.equal(filed.at(-1).subject, "chat1:2026-11-13");
  now += 864e5;
  assert.equal((await call(jwt("ag1", "c3"))).status, 200);

  // The agent-day cap, across tasks; no refusal text may look like a quota or a retry time to Paperclip.
  writeFileSync(grantsFile, JSON.stringify({ agents: { ag1: { key: "aiden", rev: "abc123", caps: { run_usd: 0.05, task_usd: 0.08, day_usd: 30 } }, ag3: { key: "x", caps: { run_usd: 1, task_usd: 1, day_usd: 0.05 } } } }));
  for (const i of ["d1", "d2"]) assert.equal((await call(mintToken("job-secret", { agentId: "ag3", issueId: i }, now))).status, 200);
  const dayRefused = await call(mintToken("job-secret", { agentId: "ag3", issueId: "d3" }, now));
  assert.match(JSON.parse(dayRefused.text).error.message, /^spend cap reached: agent-day \$0\.06 of \$0\.05;/);
  for (const r of [refused, chatRefused, dayRefused]) assert.doesNotMatch(JSON.parse(r.text).error.message, /usage limit|rate[- ]?limit|try again|quota|capacity|429|service unavailable|temporary|spawn|ENOENT|\d{4}-\d{2}-\d{2}|\d+:\d\d/i);

  // System kinds are never capped; the kill switch stops refusals but keeps the ledger.
  const reviewer = mintToken("job-secret", { kind: "reviewer", issueId: "iss1" }, now);
  cost = 5;
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call(reviewer)).status, 200);
  assert.equal((await call("src-key")).status, 200);
  writeFileSync(settingsFile, JSON.stringify({ enforce_caps: false }));
  assert.equal((await call(jwt("ag1", "run1"))).status, 200);
  rows = await usage();
  assert.deepEqual(rows.filter((r) => r.kind === "reviewer").map((r) => r.component), ["AI reviewer", "AI reviewer"]);
  assert.equal(rows.filter((r) => r.kind === "source").length, 1);

  // An advisor call is counted against the caller's run as kind advisor.
  assert.equal((await call(mintToken("job-secret", { agentId: "ag2", issueId: "iss9" }, now), { path: "/advisor/api/v1/chat/completions" })).status, 200);
  const last = (await usage()).at(-1);
  assert.deepEqual([last.kind, last.agentId, last.issueId], ["advisor", "ag2", "iss9"]);
});

// An agent computer: box → the launcher's model route (forwardModel) → this gateway, named by the launcher's /whoami. Its
// calls land in the ledger as the box agent's run and task, are refused at its run cap like any agent's, and the kill switch
// covers them; a run that ended (token revoked) is refused even once its run key is settled.
test("gateway: an agent computer's calls are attributed and capped through the launcher", async (t) => {
  const { Tokens, forwardModel } = await import("../../computer/lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gw-box-"));
  const secrets = { openrouter_key: "sk-real", gateway_board_key: "gw-board", paperclip_board_key: "pc-board" };
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ agents: { box1: { key: "devops", rev: "def456", caps: { run_usd: 0.05, task_usd: 10, day_usd: 30 } } } }));
  const settingsFile = join(dir, "gateway.json");
  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push(req.headers.authorization);
      const id = `gen-b${seen.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id, model: "deepseek/v4", usage: { input_tokens: 10, output_tokens: 5, cost: 0.03 } } })}\n\n`);
    });
  });
  const paperclip = await serve((req, res) => {
    if (req.headers.authorization !== "Bearer pc-board") return json(res, 403, {});
    if (req.url === "/api/heartbeat-runs/prun1") return json(res, 200, { id: "prun1", issueId: "WOR-1" });
    if (req.url === "/api/issues/WOR-1") return json(res, 200, { labels: [] });
    json(res, 404, {});
  });
  const tokens = new Tokens();
  const runToken = tokens.issue("aidenhq-computer-x", "box1");
  let gwUrl;
  const launcher = await serve((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const who = tokens.whoami(token);
    if (req.url === "/whoami") return who ? json(res, 200, { agentId: who.agentId, runId: who.runId, issueId: who.issueId }) : json(res, 401, {});
    if (!who) return json(res, 401, {});
    forwardModel(req, res, `${gwUrl}/api/v1/responses`, token);
  });
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile, settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, paperclipUrl: paperclip.url, launcherUrl: launcher.url });
  const front = await serve((req, res) => gw.handle(req, res));
  gwUrl = front.url;
  t.after(() => { for (const x of [upstream, paperclip, launcher, front]) x.s.close(); gw.close(); });

  const call = async () => {
    const res = await fetch(`${launcher.url}/api/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" }, body: JSON.stringify({ model: "~deepseek/deepseek-flash-latest", stream: true, input: [] }) });
    return { status: res.status, text: await res.text() };
  };
  // Before the launcher knows the Paperclip run, the call is the agent's (run and day caps) but nothing is settled, so the
  // run is not pinned without its task; once the first exec binds it, the run and task are settled.
  const early = await call();
  assert.equal(early.status, 200);
  assert.match(early.text, /response\.completed/);
  assert.deepEqual(seen, ["Bearer sk-real"]); // the run token never goes upstream
  tokens.bind("aidenhq-computer-x", { runId: "prun1", issueId: "WOR-1" });
  assert.equal((await call()).status, 200); // run cap $0.05: starts at $0.03, allowed
  const rows = (await (await fetch(`${front.url}/usage`, { method: "POST", headers: { authorization: "Bearer gw-board" }, body: "{}" })).json()).records;
  assert.deepEqual(rows.map((r) => [r.agentId, r.runId, r.issueId, r.rev, r.kind, r.component, r.costUsd, r.status]), [
    ["box1", null, null, "def456", "agent", "agent", 0.03, "ok"],
    ["box1", "prun1", "WOR-1", "def456", "agent", "agent", 0.03, "ok"],
  ]);

  // The run's third call is refused at its run cap, with the gateway's 402 as it is.
  const refused = await call();
  assert.equal(refused.status, 402);
  assert.equal(JSON.parse(refused.text).error.type, "cap_reached");
  // The kill switch (spend_caps: off) lets it through; a run that ended is refused.
  writeFileSync(settingsFile, JSON.stringify({ enforce_caps: false }));
  assert.equal((await call()).status, 200);
  tokens.revoke("aidenhq-computer-x");
  const ended = await fetch(`${front.url}/api/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${runToken}` }, body: JSON.stringify({ model: "m" }) });
  assert.equal(ended.status, 401);
});
