// App CI code review end to end, against a fake GitHub (its OIDC keys) and a fake OpenRouter: a job's OIDC token traded for
// a CI token bound to its repo and PR; the token's scope (the CI listener only, the allowed model and fields only); the
// ledger record; the install limit's refusal (a reservation that doesn't fit); the off switch. Then the Responses route a CLI
// reviewer uses: the same guarantees (ZDR, listed models, reservation and settlement, A11 and A12 within CI's caps).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway/lib.ts";
import { CI_AUDIENCE, GITHUB_ISSUER } from "../src/gateway/ci.ts";
import { modelsList } from "./models-list.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("gateway: CI code review trades a GitHub OIDC token for a scoped, attributed CI token, under the install's limit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-ci-"));
  const secrets = { openrouter_key: "sk-real", gateway_board_key: "gw-board", gateway_source_key: "src-key" };
  const settingsFile = join(dir, "gateway.json");
  // A review call reserves 4096 output tokens at $25 per million: $0.1024 (and a little for its input).
  const { url: modelsUrl } = await modelsList({ "~deepseek/deepseek-flash-latest": { in: 0, cached_in: 0, out: 25, max_output: 4096 } });
  const settings = (ci, day = 0.22) => writeFileSync(settingsFile, JSON.stringify({ ci: { orgs: ["acme-agents"], models: ["~deepseek/deepseek-flash-latest"], review: { model: "~deepseek/deepseek-flash-latest", effort: "high" }, ...ci }, install_day_usd: day }));
  settings({});

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = await serve((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] })));
  let now = Date.parse("2026-11-14T10:00:00Z");
  let run = 1000;
  const oidc = (claims = {}, header = {}) => {
    const repository = claims.repository ?? "acme-agents/app";
    const ref = claims.ref ?? "refs/pull/12/merge";
    const body = `${b64({ alg: "RS256", kid: "k1", typ: "JWT", ...header })}.${b64({ iss: GITHUB_ISSUER, aud: CI_AUDIENCE, exp: now / 1000 + 300, nbf: now / 1000 - 5, repository, repository_owner: "acme-agents", runner_environment: "self-hosted", event_name: "pull_request", ref, workflow_ref: `${repository}/.github/workflows/ci.yml@${ref}`, base_ref: "main", run_id: String(run++), run_attempt: "1", ...claims })}`;
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
  };

  const seen = [], held = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      const answer = () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ id: `gen-${seen.length}`, model: "deepseek/v4", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.1 } })}\n\ndata: [DONE]\n\n`); };
      // "hold": answered once 12 held calls are in flight together.
      if (JSON.parse(b).messages?.[0] !== "hold") return answer();
      held.push(answer);
      if (held.length === 12) held.splice(0).forEach((f) => f());
    });
  });
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, githubJwksUrl: github.url, now: () => now });
  const ci = await serve((req, res) => gw.handle(req, res, { ci: true }));
  const main = await serve((req, res) => gw.handle(req, res));
  t.after(() => { for (const x of [github, upstream, ci, main]) x.s.close(); gw.close(); });

  const post = async (url, cred, body) => {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const exchange = (jwt, head = "ab".repeat(20)) => post(`${ci.url}/ci/token`, jwt, { head });
  const review = (tok, extra = {}, base = ci.url) => post(`${base}/api/v1/chat/completions`, tok, { model: "~deepseek/deepseek-flash-latest", stream: true, messages: [], tools: [{ type: "function", function: { name: "submit_review" } }], ...extra });

  // Only a genuine pull_request job of the instance's org on a self-hosted runner gets a token.
  const got = await exchange(oidc());
  assert.equal(got.status, 200);
  const tok = got.json.token;
  assert.deepEqual(got.json.review, { model: "~deepseek/deepseek-flash-latest", effort: "high" }); // the instance's review model
  assert.match(tok, /^ahqci_[\w-]{43}$/);
  for (const bad of [
    oidc({ repository: "evil/app", repository_owner: "evil" }), // another org (the product org's runners share the network)
    oidc({ aud: "sts.amazonaws.com" }),
    oidc({ runner_environment: "github-hosted" }),
    oidc({ event_name: "push", ref: "refs/heads/main" }),
    oidc({ exp: now / 1000 - 3600 }),
    oidc({}, { alg: "HS256" }),
    oidc({ workflow_ref: "acme-agents/app/.github/workflows/other.yml@refs/pull/12/merge" }), // not our CI workflow
    oidc({ workflow_ref: "acme-agents/app/.github/workflows/ci.yml@refs/pull/99/merge" }), // another PR's
    oidc({ base_ref: "" }),
    `${oidc().split(".").slice(0, 2).join(".")}.${Buffer.from("forged").toString("base64url")}`,
  ]) assert.equal((await exchange(bad)).status, 401);
  // A flood of junk, forged and foreign tokens uses up nothing: a real job still gets its token. Only verified exchanges
  // count, per repo: one repo's 21st this minute is refused, another repo's isn't.
  const forged = `${oidc().split(".").slice(0, 2).join(".")}.${Buffer.from("x".repeat(256)).toString("base64url")}`;
  await Promise.all(Array.from({ length: 300 }, (_, i) => exchange([forged, oidc({ repository_owner: "evil", repository: "evil/x" }), "junk", `a.${b64({ iss: "x" })}.c`][i % 4])));
  assert.equal((await exchange(oidc())).status, 200);
  // A run attempt trades its OIDC token once: a replay (a leaked token) gets nothing; the job's re-run is a new attempt.
  const once = oidc({ run_id: "4242" });
  assert.equal((await exchange(once)).status, 200);
  assert.equal((await exchange(once)).status, 401);
  assert.equal((await exchange(oidc({ run_id: "4242", run_attempt: "2" }))).status, 200);
  // Two exchanges for one run attempt at the same moment: exactly one token. A restarted gateway (same ledger) still refuses.
  const race = oidc({ run_id: "5151" });
  const both = await Promise.all([exchange(race), exchange(race)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 401]);
  const restarted = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, modelsUrl, githubJwksUrl: github.url, now: () => now });
  const ci2 = await serve((req, res) => restarted.handle(req, res, { ci: true }));
  t.after(() => { ci2.s.close(); restarted.close(); });
  assert.equal((await post(`${ci2.url}/ci/token`, race, { head: "ab".repeat(20) })).status, 401);
  for (let i = 0; i < 20; i++) assert.equal((await exchange(oidc({ repository: "acme-agents/busy" }))).status, 200);
  assert.equal((await exchange(oidc({ repository: "acme-agents/busy" }))).status, 429);
  assert.equal((await exchange(oidc())).status, 200);

  // The CI listener serves CI routes and CI tokens only; a CI token works nowhere else.
  assert.equal((await review("src-key")).status, 401);
  assert.equal((await review(tok, {}, main.url)).status, 401);
  assert.equal((await post(`${ci.url}/usage`, "gw-board", {})).status, 404);
  assert.equal((await post(`${ci.url}/api/v1/embeddings`, tok, { model: "~deepseek/deepseek-flash-latest" })).status, 404);
  // Only the allowed models, and nothing that changes what OpenRouter runs.
  assert.equal((await review(tok, { model: "openai/gpt-sol" })).status, 403);
  assert.equal((await review(tok, { models: ["openai/gpt-sol"] })).status, 403);
  assert.equal((await review(tok, { tools: [{ type: "openrouter:web_search" }] })).status, 403);
  assert.equal(seen.length, 0);

  // A review call: the real key and ZDR upstream; the ledger names the repo and PR (from GitHub's token) and the head.
  assert.equal((await review(tok)).status, 200);
  assert.equal(seen[0].auth, "Bearer sk-real");
  assert.equal(seen[0].body.provider.zdr, true);
  const usage = async () => (await post(`${main.url}/usage`, "gw-board", { since: "" })).json.records;
  const [row] = await usage();
  assert.deepEqual({ ...row, at: undefined, runKey: undefined }, { key: "gen-1", at: undefined, agentId: null, component: "ci-code-review", model: "deepseek/v4", input: 10, cached: 0, output: 2, costUsd: 0.1, runKey: undefined, runId: null, issueId: null, rev: "ab".repeat(20), kind: "ci-code-review", ms: 0, status: "ok", subject: "acme-agents/app#12" });

  // The install's day limit $0.22 on real cost: calls go ahead while what was billed is under it ($0.10, then $0.20: the
  // third bounded to its least output, what $0.02 buys being less), then the next is refused at $0.30, and so is a fresh
  // token's, and another repo's. Every call carried its bounded max_tokens.
  assert.equal((await review(tok)).status, 200);
  assert.equal((await review(tok)).status, 200);
  const refused = await review(tok);
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /^spend cap reached: the install's daily limit, \$0\.30 of \$0\.22 /);
  assert.deepEqual(seen.map((s) => s.body.max_tokens), [4096, 4096, 1024]);
  assert.equal((await review((await exchange(oidc({ ref: "refs/pull/13/merge" }))).json.token)).status, 402);
  assert.equal((await review((await exchange(oidc({ repository: "acme-agents/other" }))).json.token)).status, 402);
  assert.equal((await usage()).filter((r) => r.status === "cap_reached").length, 3); // one per token

  // Module removed (no ci block): no new tokens and every issued one refused at once. Back, a token still expires after its 2 hours.
  writeFileSync(settingsFile, "{}");
  assert.equal((await exchange(oidc())).status, 403);
  assert.equal((await review(tok)).status, 403);
  settings({}, 5);
  assert.equal((await review(tok)).status, 200);
  // No in-flight limit of its own: 12 calls of one repo in flight together all run (each holds its reservation against the limit).
  const many = await Promise.all(Array.from({ length: 12 }, () => review(tok, { messages: ["hold"] })));
  assert.deepEqual(many.map((r) => r.status), Array(12).fill(200));
  now += 3 * 3600_000;
  assert.equal((await review(tok)).status, 401);
});

test("gateway: CI's Responses route (a CLI reviewer): ZDR, listed models only, checked then settled from response.completed, A12", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-ci-responses-"));
  const settingsFile = join(dir, "gateway.json");
  // $25 per million output tokens, input free: a call reserves 4096 output tokens, $0.1024. acme/unpriced is allowed, but
  // OpenRouter doesn't list it.
  const { url: modelsUrl } = await modelsList({ "~deepseek/deepseek-flash-latest": { in: 0, cached_in: 0, out: 25, max_output: 4096 } });
  const settings = (day = 5) => writeFileSync(settingsFile, JSON.stringify({ ci: { orgs: ["acme-agents"], models: ["~deepseek/deepseek-flash-latest", "acme/unpriced"] }, install_day_usd: day }));
  settings();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = await serve((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] })));
  const now = Date.parse("2026-11-16T10:00:00Z");
  const body = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: GITHUB_ISSUER, aud: CI_AUDIENCE, exp: now / 1000 + 300, repository: "acme-agents/app", repository_owner: "acme-agents", runner_environment: "self-hosted", event_name: "pull_request", ref: "refs/pull/7/merge", workflow_ref: "acme-agents/app/.github/workflows/ci.yml@refs/pull/7/merge", base_ref: "main", run_id: "1", run_attempt: "1" })}`;
  const oidc = `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;

  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const j = JSON.parse(b), n = seen.push({ path: req.url, body: j });
      const done = { type: "response.completed", response: { id: `resp-${n}`, model: "deepseek/v4", usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2, cost: 0.01 } } };
      const answer = () => {
        if (!j.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(done.response));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(["response.created", "response.output_text.delta"].map((type) => `event: ${type}\ndata: ${JSON.stringify({ type })}\n\n`).join("") + `event: response.completed\ndata: ${JSON.stringify(done)}\n\n`);
      };
      if (j.input?.[0] === "cut") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ type: "response.created" })}\n\n`); return setTimeout(() => res.destroy(), 20); }
      answer();
    });
  });
  const gw = createGateway({ dbFile: join(dir, "kernel.db"), grantsFile: join(dir, "grants.json"), settingsFile, secret: (n) => ({ openrouter_key: "sk-real" })[n] ?? "", upstream: upstream.url, modelsUrl, githubJwksUrl: github.url, now: () => now });
  const ci = await serve((req, res) => gw.handle(req, res, { ci: true }));
  t.after(() => { for (const x of [github, upstream, ci]) x.s.close(); gw.close(); });
  const tok = (await (await fetch(`${ci.url}/ci/token`, { method: "POST", headers: { authorization: `Bearer ${oidc}` }, body: "{}" })).json()).token;
  const call = async (extra = {}) => {
    const res = await fetch(`${ci.url}/api/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ model: "~deepseek/deepseek-flash-latest", input: [], store: false, include: ["reasoning.encrypted_content"], tools: [{ type: "function", name: "view_image" }, { type: "namespace", name: "mcp__repo", tools: [{ type: "function", name: "read_file" }] }], reasoning: { effort: "high" }, ...extra }) });
    return { status: res.status, text: await res.text() };
  };
  const rows = () => gw.db.prepare("SELECT key, status, cost_usd, input, cached, output, task_subject FROM calls ORDER BY rowid").all().map((r) => ({ ...r }));

  // Not streamed and streamed: the real key, ZDR and a bounded max_output_tokens upstream; settled at what was billed, the
  // streamed one from its response.completed event, both attributed to the repo and PR.
  assert.equal((await call()).status, 200);
  const streamed = await call({ stream: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.text, /response\.completed/);
  assert.deepEqual(seen.map((s) => [s.path, s.body.provider.zdr, s.body.max_output_tokens]), [["/responses", true, 4096], ["/responses", true, 4096]]);
  assert.deepEqual(rows(), ["resp-1", "resp-2"].map((key) => ({ key, status: "ok", cost_usd: 0.01, input: 6, cached: 4, output: 2, task_subject: "acme-agents/app#7" })));

  // Refused before anything is reserved or sent: a stored response, a server tool, a stored conversation, a fallback model,
  // a model CI may not use, and an allowed model OpenRouter doesn't list.
  for (const extra of [{ store: true }, { tools: [{ type: "web_search" }] }, { tools: [{ type: "namespace", name: "x", tools: [{ type: "mcp", server_url: "https://example.com" }] }] }, { previous_response_id: "resp-1" }, { models: ["openai/gpt-sol"] }, { model: "openai/gpt-sol" }, { model: "acme/unpriced" }]) {
    assert.equal((await call(extra)).status, 403, JSON.stringify(extra));
  }
  assert.equal(seen.length, 2);

  // A12: a stream cut before its response.completed keeps its reservation, the input's estimate ($0 here: input is free).
  await call({ stream: true, input: ["cut"] }).catch(() => {});
  assert.deepEqual([rows().at(-1).status, rows().at(-1).cost_usd], ["upstream_aborted", 0]);

  // At the install's day limit ($0.02 billed so far), refused before anything is sent; raised, the next call goes ahead.
  settings(0.02);
  const n = seen.length;
  assert.equal((await call()).status, 402);
  assert.equal(seen.length, n);
  settings(0.03);
  assert.equal((await call()).status, 200);
  assert.deepEqual(rows().filter((r) => r.status === "ok").map((r) => r.cost_usd), Array(3).fill(0.01));
});
