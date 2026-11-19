// The first run end to end on the admin listener: /setup makes the account, the authenticator is enrolled, then the model
// step (/setup/model) connects OpenRouter (PKCE callback /setup/openrouter/<state>, which needs no session) or takes a pasted key, checks it with one call and
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
let accounts, adminSrv, verdict = "ok", exchanged = [];
const madeApps = [], savedApps = [];
const githubApp = {
  defaultOrg: () => "acme-agents", name: () => "AidenHQ acme", ready: () => savedApps.length > 0,
  convert: async (code, org) => { madeApps.push([code, org]); if (code !== "app-code") throw new Error("GitHub said 404"); return { id: 7, slug: "aidenhq-acme", pem: "-----BEGIN RSA PRIVATE KEY-----", owner: org }; },
  save: (app) => savedApps.push(app),
};
before(async () => {
  accounts = await openAccounts({ dataDir: ":memory:", hosts: [HOST], adminUrl: `http://${HOST}`, edgeSecret: () => "", notify: () => {}, log: silent });
  const firstRun = { ownerEmail: () => undefined, recoveryKey: () => "", fields: () => [field, { ...field, module: "github", secret: "github_bot_token", label: "GitHub token" }], has: (n) => vault.has(n), save: (n, v) => vault.set(n, v), forgetRecoveryKey() {} };
  const model = {
    start: (callback, state) => ({ url: `https://openrouter.test/auth?${new URLSearchParams({ callback_url: callback, state })}`, verifier: "v".repeat(43) }),
    exchange: async (code, verifier) => { exchanged.push([code, verifier]); return KEY; },
    check: async () => verdict,
    saved: () => vault.get("openrouter_key") ?? "",
    ...state,
  };
  const cards = { ownerCards: async () => ({ live: [], finished: [] }), decideCard: async () => { throw new Error("no"); } };
  adminSrv = await serve(createAdmin({ accounts, firstRun, model, githubApp, boardUrl: () => BOARD, cards, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST], origins: () => [`http://${HOST}`], frameOrigins: () => [] }));
});
after(() => { adminSrv.s.close(); accounts.close(); });

const jar = new Map();
const page = (method, p, form, cookies = jar) => new Promise((ok, no) => {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const headers = { host: HOST, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", origin: `http://${HOST}` } : {}) };
  const r = request(`${adminSrv.url}${p}`, { method, headers }, (res) => {
    for (const c of res.headers["set-cookie"] ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, location: String(res.headers.location ?? ""), body: d, headers: res.headers }));
  });
  r.on("error", no); r.end(body);
});
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)[1];
const stateOf = (html) => new URLSearchParams(/href="https:\/\/openrouter\.test\/auth\?([^"]+)"/.exec(html)[1].replace(/&#38;/g, "&")).get("state");

test("setup takes account then model", async () => {
  const token = new URL(accounts.mintSetup().url).searchParams.get("token");
  const form = await page("GET", `/setup?token=${token}`);
  assert.equal(form.status, 200);
  // A browser posts these forms with Origin: null under no-referrer, which the origin check refuses.
  assert.equal(form.headers["referrer-policy"], "same-origin");
  // ...and a form's redirect to the board's welcome (another origin) is allowed by form-action.
  assert.match(form.headers["content-security-policy"], new RegExp(`form-action 'self' ${new URL(BOARD).origin};`));
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
  assert.match(step.body, /callback_url=http%3A%2F%2Flocalhost%3A3120%2Fsetup%2Fopenrouter%2F[\w-]{22}&/);
  assert.match(step.body, /Use your API key[\s\S]*name="openrouter_key"[\s\S]*>Save<\/button>[\s\S]*Connect OpenRouter<\/a>/); // both, as equals
  assert.match(step.body, /https:\/\/openrouter\.ai\/settings\/keys/);
  // OpenRouter's return is cross-site: the SameSite=Strict session cookie doesn't come with it.
  const back = await page("GET", `/setup/openrouter/${stateOf(step.body)}?code=c0de`, undefined, new Map());
  assert.equal(back.status, 200);
  assert.match(back.body, /<meta http-equiv="refresh" content="0;url=\/setup\/model\?connect=ok">/); // a same-site move on, with the cookie
  assert.deepEqual(exchanged, [["c0de", "v".repeat(43)]]);
  assert.equal(vault.get("openrouter_key"), KEY);
  assert.equal(state.ready(), true);
  assert.equal((await page("GET", "/setup/model?connect=ok")).location, `${BOARD}/auth/start`);
  assert.match((await page("GET", `/setup/openrouter/${stateOf(step.body)}?code=c0de`, undefined, new Map())).body, /url=\/setup\/model">/); // a reload: spent, no outcome
  assert.equal(exchanged.length, 1);
});

test("model step needs the admin session", async () => {
  const r = await page("GET", "/setup/model", undefined, new Map());
  assert.equal(r.status, 303);
  assert.equal(r.location, "/auth/sign-in?next=%2Fsetup%2Fmodel");
});

test("the GitHub App: an admin names the org, GitHub's return (no session) saves it once; nobody else starts one", async () => {
  assert.notEqual((await page("GET", "/setup/github-app", undefined, new Map())).status, 200, "admins only");
  const ask = await page("GET", "/setup/github-app");
  assert.match(ask.body, /value="acme-agents"/);
  assert.equal((await page("POST", "/setup/github-app", { csrf: csrfOf(ask.body), org: "-bad-" })).status, 400);
  const go = await page("POST", "/setup/github-app", { csrf: csrfOf(ask.body), org: "acme-agents" });
  assert.match(go.headers["content-security-policy"], /form-action 'self' https:\/\/github\.com;/);
  const state = /settings\/apps\/new\?state=([\w-]{22})"/.exec(go.body)[1];
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(go.body)[1].replace(/&#34;/g, '"').replace(/&#38;/g, "&"));
  assert.equal(manifest.redirect_url, `http://${HOST}/setup/github-app/${state}`);
  // GitHub's return is cross-site: no session cookie. The state must match, once.
  assert.equal((await page("GET", `/setup/github-app/${state}?code=app-code&state=other`, undefined, new Map())).status, 400);
  const go2 = await page("POST", "/setup/github-app", { csrf: csrfOf(ask.body), org: "acme-agents" });
  const state2 = /state=([\w-]{22})"/.exec(go2.body)[1];
  const back = await page("GET", `/setup/github-app/${state2}?code=app-code&state=${state2}`, undefined, new Map());
  assert.equal(back.status, 200);
  assert.match(back.body, /https:\/\/github\.com\/apps\/aidenhq-acme\/installations\/new/);
  assert.ok(!back.body.includes("PRIVATE KEY"), "the key is never shown");
  assert.deepEqual(savedApps.map((a) => [a.id, a.owner]), [[7, "acme-agents"]]);
  assert.equal((await page("GET", `/setup/github-app/${state2}?code=app-code&state=${state2}`, undefined, new Map())).status, 400, "spent");
  assert.equal(savedApps.length, 1);
});
