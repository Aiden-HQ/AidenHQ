// The first run end to end on the admin listener: /setup makes the account, the authenticator is enrolled, then the model
// step (/setup/model) connects OpenRouter (PKCE callback /setup/openrouter) or takes a pasted key, checks it with one call and
// sends the owner on to the board's welcome. OpenRouter is stubbed.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { openAccounts } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { checkModel, exchange, readiness, startPkce } from "../src/openrouter-pkce.ts";
import { PASSWORD, silent, totp } from "./auth-helpers.mjs";
import { serve } from "./helpers.mjs";

const HOST = "localhost:3120", BOARD = "http://board.example:3121", KEY = `sk-or-v1-${"a".repeat(64)}`;
const field = { module: "models-openrouter", secret: "openrouter_key", label: "OpenRouter API key", pattern: "^sk-or-[A-Za-z0-9_-]{16,200}$", required: true };
const vault = new Map();
// What the kernel's model_ready op answers (main.ts wires the same readiness to it and to the admin pages).
const state = readiness({ get: (n) => vault.get(n) ?? "", exists: (n) => vault.has(n), save: (n, v) => vault.set(n, v) });
let accounts, adminSrv, verdict = "ok", exchanged = [], verifies = 0;
before(async () => {
  accounts = await openAccounts({ dataDir: ":memory:", hosts: [HOST], adminUrl: `http://${HOST}`, edgeSecret: () => "", notify: () => {}, log: silent });
  const firstRun = { ownerEmail: () => undefined, recoveryKey: () => "", fields: () => [field, { ...field, module: "codehost-github", secret: "github_bot_token", label: "GitHub token" }], has: (n) => vault.has(n), save: (n, v) => vault.set(n, v), forgetRecoveryKey() {} };
  const model = {
    start: (callback, state) => ({ url: `https://openrouter.test/auth?${new URLSearchParams({ callback_url: callback, state })}`, verifier: "v".repeat(43) }),
    exchange: async (code, verifier) => { exchanged.push([code, verifier]); return KEY; },
    check: async () => verdict,
    saved: () => vault.get("openrouter_key") ?? "",
    verifyAgents: () => verifies++,
    ...state,
  };
  const cards = { ownerCards: async () => ({ live: [], finished: [] }), decideCard: async () => { throw new Error("no"); } };
  adminSrv = await serve(createAdmin({ accounts, firstRun, model, boardUrl: () => BOARD, cards, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST], origins: () => [`http://${HOST}`], frameOrigins: () => [] }));
});
after(() => { adminSrv.s.close(); accounts.close(); });

const jar = new Map();
const page = (method, p, form, cookies = jar) => new Promise((ok, no) => {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const headers = { host: HOST, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", origin: `http://${HOST}` } : {}) };
  const r = request(`${adminSrv.url}${p}`, { method, headers }, (res) => {
    for (const c of res.headers["set-cookie"] ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, location: String(res.headers.location ?? ""), body: d }));
  });
  r.on("error", no); r.end(body);
});
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)[1];
const stateOf = (html) => new URLSearchParams(/href="https:\/\/openrouter\.test\/auth\?([^"]+)"/.exec(html)[1].replace(/&#38;/g, "&")).get("state");

test("setup takes account then model", async () => {
  const token = new URL(accounts.mintSetup().url).searchParams.get("token");
  const form = await page("GET", `/setup?token=${token}`);
  assert.equal(form.status, 200);
  assert.ok(!form.body.includes("secret_"), "no module keys on the account form");
  const made = await page("POST", "/setup", { token, email: "owner@example.com", name: "Owner", password: PASSWORD });
  assert.equal(made.location, "/auth/enrol");
  const enrol = await page("GET", "/auth/enrol");
  const shown = await page("POST", "/auth/enrol", { csrf: csrfOf(enrol.body), password: PASSWORD });
  assert.match(shown.body, /like Google Authenticator, that shows a 6-digit code/);
  assert.match(shown.body, /<svg[^>]*>/); // the QR code
  const key = /Key: <code>([A-Z2-7 ]+)<\/code>/.exec(shown.body)[1].replace(/ /g, "");
  const fin = await page("POST", "/auth/enrol", { csrf: csrfOf(shown.body), code: totp(key) });
  assert.equal(fin.location, "/setup/model");
  const step = await page("GET", "/setup/model");
  assert.equal(step.status, 200);
  assert.match(step.body, /Connect OpenRouter/);
  assert.match(step.body, /callback_url=http%3A%2F%2Flocalhost%3A3120%2Fsetup%2Fopenrouter/);
  assert.match(step.body, /Use your API key[\s\S]*name="openrouter_key"[\s\S]*>Save<\/button>[\s\S]*Connect OpenRouter<\/a>/); // both, as equals
  assert.match(step.body, /https:\/\/openrouter\.ai\/settings\/keys/);
  const back = await page("GET", `/setup/openrouter?code=c0de&state=${stateOf(step.body)}`);
  assert.equal(back.status, 303, /class="err">[^<]*/.exec(back.body)?.[0]);
  assert.equal(back.location, `${BOARD}/#/welcome`);
  assert.deepEqual(exchanged, [["c0de", "v".repeat(43)]]);
  assert.equal(vault.get("openrouter_key"), KEY);
  assert.equal(state.ready(), true);
  assert.equal((await page("GET", `/setup/openrouter?code=c0de&state=${stateOf(step.body)}`)).location, `${BOARD}/#/welcome`); // a reload
  assert.equal(exchanged.length, 1);
});

test("openrouter error keeps the account", async () => {
  vault.clear();
  const step = await page("GET", "/setup/model");
  const back = await page("GET", `/setup/openrouter?error=access_denied`);
  assert.equal(back.status, 400);
  assert.match(back.body, /OpenRouter didn&#39;t connect/);
  assert.ok(back.body.includes("Connect a model") && !back.body.includes('name="password"'));
  assert.ok(!back.body.includes("access_denied"));
  assert.equal((await accounts.list()).length, 1);
  // The code from an older page (its state spent) connects nothing.
  assert.equal((await page("GET", `/setup/openrouter?code=c0de&state=${stateOf(step.body)}`)).status, 400);
  assert.equal(vault.has("openrouter_key"), false);
});

test("no credit shows retry", async () => {
  vault.clear();
  verdict = "no_credit";
  const n0 = verifies;
  const step = await page("GET", "/setup/model");
  assert.equal((await page("POST", "/setup/model", { csrf: csrfOf(step.body), action: "paste", openrouter_key: "not-a-key" })).status, 400);
  const pasted = await page("POST", "/setup/model", { csrf: csrfOf(step.body), action: "paste", openrouter_key: KEY });
  assert.equal(pasted.status, 200);
  assert.match(pasted.body, /Add credit in OpenRouter/);
  assert.match(pasted.body, /https:\/\/openrouter\.ai\/settings\/credits/);
  assert.match(pasted.body, /name="action" value="retry"/);
  assert.equal(vault.get("openrouter_key"), KEY); // kept, so Retry needs no new key
  assert.equal(state.ready(), false); // model_ready: no credit is not ready
  assert.equal((await page("POST", "/setup/model", { csrf: csrfOf(pasted.body), action: "retry" })).status, 200); // still none
  assert.equal(state.ready(), false);
  assert.equal(verifies, n0, "a key without credit doesn't start the agents' check");
  verdict = "ok";
  const retry = await page("POST", "/setup/model", { csrf: csrfOf(pasted.body), action: "retry" });
  assert.equal(retry.location, `${BOARD}/#/welcome`);
  assert.equal(state.ready(), true);
  assert.equal(verifies, n0 + 1, "a working key runs setup, which verifies the agents the no-key install left unverified");
  vault.set("openrouter_key", `sk-or-v1-${"b".repeat(64)}`); // a replaced key isn't checked yet
  assert.equal(state.ready(), false);
  vault.delete("openrouter_key_checked"); // a key from before the model step (no record): ready
  assert.equal(state.ready(), true);
});

test("model step needs the admin session", async () => {
  const r = await page("GET", "/setup/model", undefined, new Map());
  assert.equal(r.status, 303);
  assert.equal(r.location, "/auth/sign-in?next=%2Fsetup%2Fmodel");
});

test("the PKCE pieces: the challenge is the verifier's S256, the exchange and the 402", async () => {
  const { url, verifier } = startPkce("https://203.0.113.7:8446/setup/openrouter", { state: "s1" });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, "https://openrouter.ai/auth");
  const { createHash } = await import("node:crypto");
  assert.equal(q.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.deepEqual([q.get("code_challenge_method"), q.get("callback_url"), q.get("state")], ["S256", "https://203.0.113.7:8446/setup/openrouter", "s1"]);
  const seen = [];
  const fake = async (u, init) => { seen.push([String(u), JSON.parse(init.body)]); return String(u).endsWith("/auth/keys") ? Response.json({ key: KEY }) : new Response("{}", { status: 402 }); };
  assert.equal(await exchange("c", verifier, fake), KEY);
  assert.deepEqual(seen[0], ["https://openrouter.ai/api/v1/auth/keys", { code: "c", code_verifier: verifier, code_challenge_method: "S256" }]);
  assert.equal(await checkModel(KEY, { model: "m", fetchImpl: fake }), "no_credit");
  assert.equal(seen[1][1].max_tokens, 1);
});
