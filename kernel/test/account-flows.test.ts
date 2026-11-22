// Account flows in the kernel (ported from services/board/test/accounts.test.ts): the owner's setup link (operator route),
// enrolment, TOTP at sign-in, links, the lockout hold, users on the my-apps sign-in host and the gate's one-time handoffs.
// One accounts file for the whole file, as the old test had; the tests run in order and share state.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { createSignin } from "../src/signin.ts";
import { PASSWORD, authApiServer, jsonBrowser, reqWith, silent, stepListener, totp } from "./auth-helpers.ts";
import { serve } from "./helpers.ts";

const GATE_SECRET = "g".repeat(64);
const HOST = { admin: "localhost:3120", gate: "127.0.0.1:3129", signin: "apps.example.com" };
const gate = () => ({ password: true, myAppsHost: "apps.example.com", appHosts: ["crm.example.com"] });
const tokenOf = (url) => url.split(/[?&]token=|#/).pop();

let accounts, admin, signin, api, gateAccountsFile;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-"));
  mkdirSync(join(dir, "gate"));
  gateAccountsFile = join(dir, "gate", "accounts.json");
  accounts = await openAccounts({ dataDir: ":memory:", hosts: [HOST.admin, HOST.gate], adminUrl: "http://localhost:3120", gate, gateAccountsFile, gateSecret: () => GATE_SECRET, edgeSecret: () => "", notify: () => {}, log: silent });
  admin = await stepListener(accounts);
  signin = await serve(createSignin({ accounts, hosts: [HOST.gate], gate, log: silent }));
  api = await authApiServer(accounts);
});
after(() => { admin.close(); signin.s.close(); api.close(); accounts.close(); });

/** A browser on the admin listener (Better Auth's JSON steps, http), and one on the sign-in listener (the gate's https host). */
const onAdmin = (jar) => jsonBrowser(admin.url, HOST.admin, { jar });
const onSignin = (jar, host = HOST.signin) => jsonBrowser(signin.url, host, { https: true, jar });
const ops = (extra = {}) => ({ "x-operator-key": api.operatorKey, ...extra });
const sessionOf = (b) => accounts.sessionOf(reqWith(b.jar));

let ownerUri = "", spent = "", ownerB;

test("sets up the owner with a single-use link (the operator route), then enrolment through the admin steps", async () => {
  assert.equal((await api.post("/v1/operator/setup", { email: "Owner@Example.com", name: "Owner" })).status, 401); // no operator key
  assert.equal((await api.post("/v1/operator/setup", { email: "Owner@Example.com", name: "Owner" }, { "x-operator-key": "wrong" })).status, 401);
  assert.equal((await api.post("/v1/operator/setup", { email: "Owner@Example.com", name: "Owner" }, { authorization: `Bearer ${api.boardKey}` })).status, 401); // the board's key is not the operator's
  const setup = await api.post("/v1/operator/setup", { email: "Owner@Example.com", name: "Owner" }, ops());
  assert.equal(setup.status, 200, setup.body);
  assert.deepEqual({ email: setup.json.account.email, role: setup.json.account.role, owner: setup.json.account.owner }, { email: "owner@example.com", role: "admin", owner: true });
  // Admin links open on the kernel's admin listener.
  assert.match(setup.json.url, /^http:\/\/localhost:3120\/auth\/set-password\?token=/);
  assert.equal((await api.post("/v1/operator/setup", { email: "x@example.com" }, ops())).status, 409);
  const token = tokenOf(setup.json.url);
  const b = onAdmin();
  assert.equal((await b("POST", "/api/auth/reset-password", { token, newPassword: PASSWORD })).status, 200);
  assert.equal((await b("POST", "/api/auth/reset-password", { token, newPassword: PASSWORD })).status, 400); // one use

  assert.equal((await b("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).status, 200);
  // Password alone: a session, but not a ready admin (no authenticator yet), so no approvals and no module handoff.
  const early = await sessionOf(b);
  assert.deepEqual([early.account.owner, early.ready], [true, false]);

  const enable = await b("POST", "/api/auth/two-factor/enable", { password: PASSWORD });
  assert.equal(enable.status, 200);
  ownerUri = enable.json.totpURI;
  spent = totp(ownerUri);
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: spent })).status, 200);
  const ready = await sessionOf(b);
  assert.deepEqual([ready.account.owner, ready.ready], [true, true]);
  ownerB = b;
});

test("the sign-in listener serves no sign-in page, no Better Auth route of its own and no admin route; the operator key is not a session", async () => {
  const s = onSignin();
  assert.equal((await s("GET", "/.auth/sign-in")).status, 404); // the gate serves the pages now
  assert.equal((await s("GET", "/.auth/two-factor")).status, 404);
  assert.equal((await s("GET", "/.auth/set-password")).status, 404);
  assert.equal((await s("GET", "/.auth/assets/auth.js")).status, 404);
  assert.equal((await s("GET", "/api/board")).status, 404);
  assert.equal((await s("GET", "/approvals")).status, 404);
  assert.equal((await s("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD })).status, 404);
  assert.equal((await s("POST", "/api/accounts", { email: "x@example.com", role: "user" })).status, 404);
  assert.equal((await s("GET", "/healthz")).status, 200);
  // The operator key and the board's key open no admin session.
  assert.equal((await api.post("/v1/auth/session", { token: "x" }, ops())).status, 401);
  assert.equal((await api.post("/v1/accounts/list", { token: "ahqu_bogus" }, ops({ authorization: `Bearer ${api.boardKey}` }))).status, 401); // needs a live session token
});

test("a write whose Origin differs in scheme or host is refused on the sign-in listener", async () => {
  const s = onSignin();
  const body = { email: "owner@example.com", password: "wrong password!!" };
  assert.equal((await s("POST", "/.auth/api/sign-in/email", body, { origin: "http://apps.example.com" })).status, 403); // http origin on an https host
  assert.equal((await s("POST", "/.auth/api/sign-in/email", body, { origin: "https://evil.example.org" })).status, 403);
  assert.equal((await s("POST", "/.auth/api/sign-in/email", body, { origin: "null" })).status, 403);
  assert.equal((await s("POST", "/.auth/api/sign-in/email", body, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await onSignin(undefined, "evil.example.org")("POST", "/.auth/api/sign-in/email", body)).status, 403); // unknown host
});
