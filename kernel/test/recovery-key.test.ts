// The vault recovery key's own show-once page (/recovery-key) and the board's "is one waiting" question.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { PASSWORD, authApiServer, jsonBrowser, silent, stepListener, totp } from "./auth-helpers.ts";
import { serve } from "./helpers.ts";

const HOST = "localhost:3120", BOARD = "http://board.example:3121", WORDS = "0123456789abcdef".repeat(4);
const dir = mkdtempSync(path.join(tmpdir(), "rk-")), file = path.join(dir, "vault_recovery_key");
let accounts, steps, adminSrv, api, jar, early, other;
before(async () => {
  accounts = await openAccounts({ dataDir: ":memory:", hosts: [HOST], adminUrl: `http://${HOST}`, edgeSecret: () => "", notify: () => {}, log: silent });
  steps = await stepListener(accounts);
  const firstRun = { ownerEmail: () => undefined, recoveryKey: () => (existsSync(file) ? WORDS : ""), fields: () => [], has: () => false, save() {}, forgetRecoveryKey: () => rmSync(file, { force: true }) };
  const cards = { ownerCards: async () => ({ live: [], finished: [] }), decideCard: async () => { throw new Error("no"); } };
  adminSrv = await serve(createAdmin({ accounts, firstRun, boardUrl: () => BOARD, cards, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST], origins: () => [`http://${HOST}`], frameOrigins: () => [] }));
  api = await authApiServer(accounts, { whoami: async () => undefined });
  const { url } = await accounts.setup("owner@example.com", "Owner");
  const b = jsonBrowser(steps.url, HOST);
  await b("POST", "/api/auth/reset-password", { token: url.split("token=").pop(), newPassword: PASSWORD });
  await b("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD });
  await b("POST", "/api/auth/two-factor/verify-totp", { code: totp((await b("POST", "/api/auth/two-factor/enable", { password: PASSWORD })).json.totpURI) });
  jar = b.jar;
  const { url: u3 } = await accounts.invite((await accounts.list())[0], { email: "di@example.com", name: "Di", role: "admin" });
  const o = jsonBrowser(steps.url, HOST);
  await o("POST", "/api/auth/reset-password", { token: u3.split("token=").pop(), newPassword: PASSWORD });
  await o("POST", "/api/auth/sign-in/email", { email: "di@example.com", password: PASSWORD });
  await o("POST", "/api/auth/two-factor/verify-totp", { code: totp((await o("POST", "/api/auth/two-factor/enable", { password: PASSWORD })).json.totpURI) });
  other = o;
  // A second admin that never enrolled an authenticator: signed in, not ready.
  const { url: u2 } = await accounts.invite((await accounts.list())[0], { email: "cy@example.com", name: "Cy", role: "admin" });
  early = jsonBrowser(steps.url, HOST);
  await early("POST", "/api/auth/reset-password", { token: u2.split("token=").pop(), newPassword: PASSWORD });
  await early("POST", "/api/auth/sign-in/email", { email: "cy@example.com", password: PASSWORD });
});
after(() => { steps.close(); adminSrv.s.close(); api.close(); accounts.close(); rmSync(dir, { recursive: true, force: true }); });

const admin = (method, p, cookies, form = "") => new Promise((ok, no) => {
  const headers = { host: HOST, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", origin: `http://${HOST}` } : {}) };
  const r = request(`${adminSrv.url}${p}`, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, location: String(res.headers.location ?? ""), body: d })); });
  r.on("error", no); r.end(method === "POST" ? form : undefined);
});

test("recovery key shows to an admin and is gone after saved", async () => {
  writeFileSync(file, WORDS);
  assert.equal((await admin("GET", "/recovery-key", early.jar)).status, 403); // not an admin with an authenticator
  assert.equal((await admin("GET", "/recovery-key", other.jar)).status, 403); // a non-owner admin
  const page = await admin("GET", "/recovery-key", jar);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("01234567 89abcdef") && page.body.includes(`data:text/plain`) && page.body.includes("aidenhq-recovery-key.txt"));
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page.body)[1];
  assert.equal((await admin("POST", "/recovery-key", jar, `csrf=${csrf}`)).status, 400); // a choice is required
  assert.ok(existsSync(file));
  const done = await admin("POST", "/recovery-key", jar, `csrf=${csrf}&choice=saved`);
  assert.equal(done.status, 303);
  assert.equal(done.location, `${BOARD}/auth/start`);
  assert.equal(existsSync(file), false);
  assert.match((await admin("GET", "/recovery-key", jar)).body, /No recovery key is waiting/);
});

test("declining deletes the key too", async () => {
  writeFileSync(file, WORDS);
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec((await admin("GET", "/recovery-key", jar)).body)[1];
  assert.equal((await admin("POST", "/recovery-key", jar, `csrf=${csrf}&choice=decline`)).status, 303);
  assert.equal(existsSync(file), false);
});
