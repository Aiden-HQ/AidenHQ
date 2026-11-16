// App CI code review end to end, against a fake GitHub (its OIDC keys) and a fake OpenRouter: a job's OIDC token traded for
// a CI token bound to its repo and PR; the token's scope (the CI listener only, the allowed model and fields only); the
// ledger record; the repo-day cap's refusal, which the kill switch doesn't lift; the off switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway/lib.ts";
import { CI_AUDIENCE, GITHUB_ISSUER } from "../src/gateway/ci.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("gateway: CI code review trades a GitHub OIDC token for a scoped, capped, attributed CI token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-ci-"));
  const secrets = { openrouter_key: "sk-real", gateway_board_key: "gw-board", gateway_source_key: "src-key" };
  const settingsFile = join(dir, "gateway.json");
  const settings = (ci, extra = {}) => writeFileSync(settingsFile, JSON.stringify({ ...extra, ci: { enabled: true, orgs: ["acme-agents"], models: ["~deepseek/deepseek-flash-latest"], repo_day_usd: 0.25, day_usd: 1, ...ci } }));
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

  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: `gen-${seen.length}`, model: "deepseek/v4", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.1 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, githubJwksUrl: github.url, now: () => now });
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
  const restarted = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile, secret: (n) => secrets[n] ?? "", upstream: upstream.url, githubJwksUrl: github.url, now: () => now });
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
  assert.equal((await post(`${ci.url}/api/v1/responses`, tok, { model: "~deepseek/deepseek-flash-latest" })).status, 404);
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

  // Repo-day cap $0.25, each call holding $0.10 while in flight: the second call fits ($0.10 + $0.10), the third doesn't
  // ($0.20 + $0.10), nor does a fresh token's, and the kill switch for agents' caps doesn't lift it. Another repo has its own.
  assert.equal((await review(tok)).status, 200);
  settings({}, { enforce_caps: false });
  const refused = await review(tok);
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /^spend cap reached: CI repo-day \$0\.20 of \$0\.25;/);
  assert.equal((await review((await exchange(oidc({ ref: "refs/pull/13/merge" }))).json.token)).status, 402);
  assert.equal((await review((await exchange(oidc({ repository: "acme-agents/other" }))).json.token)).status, 200);
  assert.equal((await usage()).filter((r) => r.status === "cap_reached").length, 1);

  // Off: no new tokens and every issued one refused at once. On again, a token still expires after its 2 hours.
  settings({ enabled: false });
  assert.equal((await exchange(oidc())).status, 403);
  assert.equal((await review(tok)).status, 403);
  settings({ repo_day_usd: 5 });
  assert.equal((await review(tok)).status, 200);
  now += 3 * 3600_000;
  assert.equal((await review(tok)).status, 401);
});
