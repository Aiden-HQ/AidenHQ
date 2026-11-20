// Account flows in the kernel (ported from services/board/test/accounts.test.ts): the owner's setup link (operator route),
// enrolment, TOTP at sign-in, links, the lockout hold, users on the my-apps sign-in host and the gate's one-time handoffs.
// One accounts file for the whole file, as the old test had; the tests run in order and share state.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts, AccountError } from "../src/accounts.ts";
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

let ownerUri = "", spent = "", annUri = "", ownerB;

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

test("a session opened on the admin listener: TOTP at sign-in, a code once", async () => {
  const b = onAdmin();
  const first = await b("POST", "/api/auth/sign-in/email", { email: "owner@example.com", password: PASSWORD });
  assert.equal(first.json.twoFactorRedirect, true);
  assert.equal(await sessionOf(b), null); // the password step alone opens no session
  // The enrolment spent the current step's code: the same code is refused, the next step's is accepted.
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: spent })).status, 401);
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: totp(ownerUri, 1) })).status, 200);
  assert.equal((await sessionOf(b)).ready, true);
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: totp(ownerUri, -1), trustDevice: true })).status, 400);
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

test("an invite link works once, a newer link kills the older, and the owner's account can't be changed", async () => {
  const owner = (await accounts.list()).find((a) => a.owner);
  const invite = await accounts.invite(owner, { email: "ann@example.com", name: "Ann", role: "admin" });
  const older = tokenOf(invite.url);
  const newer = tokenOf((await accounts.newLink(owner, invite.account.id)).url);
  const b = onAdmin();
  assert.equal((await b("POST", "/api/auth/reset-password", { token: older, newPassword: PASSWORD })).status, 400);
  // Two claims at once: exactly one wins.
  const both = await Promise.all([1, 2].map(() => b("POST", "/api/auth/reset-password", { token: newer, newPassword: PASSWORD })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  for (const f of [() => accounts.setDisabled(owner, owner.id, true), () => accounts.setRole(owner, owner.id, "user"), () => accounts.newLink(owner, owner.id)]) {
    await assert.rejects(f(), (e) => e instanceof AccountError && e.status === 403);
  }
});

test("holds an unidentified peer after wrong passwords (429), keeps open sessions; a reset link lifts it", async () => {
  const b = onAdmin();
  const open = onAdmin();
  assert.equal((await open("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: PASSWORD })).status, 200);
  // An unidentified peer: two free failures, then a stepped hold (429 at once, no hashing).
  for (let i = 0; i < 3; i++) assert.equal((await b("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!!" })).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await b("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!!" })).status, 429);
  // Held even with the right password; claiming a link lifts the hold.
  assert.equal((await b("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: PASSWORD })).status, 429);
  // Failing on purpose signs nobody out.
  assert.equal((await sessionOf(open)).account.email, "ann@example.com");
  // The operator's reset route returns the one-time link.
  const reset = await api.post("/v1/operator/reset", { email: "ann@example.com" }, ops());
  assert.equal(reset.status, 200);
  const link = { url: reset.json.url };
  assert.equal(await sessionOf(open), null); // a reset ends every session
  assert.equal((await b("POST", "/api/auth/reset-password", { token: tokenOf(link.url), newPassword: "another long password" })).status, 200);
  assert.equal((await b("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "another long password" })).status, 200);
  assert.equal((await sessionOf(b)).ready, false); // needs TOTP still
  // A second browser signed in with the password alone, before the authenticator: enrolling elsewhere ends it.
  const passwordOnly = onAdmin();
  assert.equal((await passwordOnly("POST", "/api/auth/sign-in/email", { email: "ann@example.com", password: "another long password" })).status, 200);
  annUri = (await b("POST", "/api/auth/two-factor/enable", { password: "another long password" })).json.totpURI;
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: totp(annUri) })).status, 200);
  const ann = await sessionOf(b);
  assert.deepEqual([ann.ready, ann.account.owner], [true, false]);
  assert.equal(await sessionOf(passwordOnly), null);
});

test("keeps users off the admin steps; the sign-in host signs them in, hands off to an app host once, and serves no admin route", async () => {
  const owner = (await accounts.list()).find((a) => a.owner);
  const invite = await accounts.invite(owner, { email: "uma@example.com", name: "Uma", role: "user" });
  assert.match(invite.url, /^https:\/\/apps\.example\.com\/\.auth\/set-password#/);
  const s = onSignin();
  assert.equal((await s("POST", "/.auth/api/reset-password", { token: tokenOf(invite.url), newPassword: PASSWORD })).status, 200);
  assert.equal((await onAdmin()("POST", "/api/auth/sign-in/email", { email: "uma@example.com", password: PASSWORD })).status, 403);
  const signedIn = await s("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: PASSWORD });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.cookies.join(), /^__Host-better-auth\.session_token=[^;]+; Max-Age=\d+; HttpOnly; Path=\/; SameSite=Lax; Secure/);

  // The gate, server-side: mint with the sign-in host's session cookie, then redeem once for that host.
  const g = onSignin(new Map(s.jar), HOST.gate);
  const state = "s".repeat(32);
  assert.equal((await onSignin(undefined, HOST.gate)("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).status, 401);
  assert.equal((await g("POST", "/.auth/api/handoff/mint", { host: "evil.example.org", state })).status, 400);
  assert.equal((await g("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state: "short" })).status, 400);
  const mint = async () => (await g("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).json.code;
  const code = await mint();
  assert.equal((await g("POST", "/.auth/api/handoff/redeem", { code, host: "other.example.com", state })).status, 400); // spent by the wrong host
  assert.equal((await g("POST", "/.auth/api/handoff/redeem", { code, host: "crm.example.com", state })).status, 400);
  const code1 = await mint();
  assert.equal((await g("POST", "/.auth/api/handoff/redeem", { code: code1, host: "crm.example.com", state: "t".repeat(32) })).status, 400); // wrong state
  const code2 = await mint();
  // The gate never forwards these: through the sign-in host's name they're refused.
  assert.equal((await s("POST", "/.auth/api/handoff/redeem", { code: code2, host: "crm.example.com", state })).status, 403);
  const redeem = (c) => g("POST", "/.auth/api/handoff/redeem", { code: c, host: "crm.example.com", state });
  const redeemed = await redeem(code2);
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.json.token, /^[A-Za-z0-9._~+/=-]{16,1024}$/);
  assert.equal((await redeem(code2)).status, 400); // single use

  // The gate's get-session with the app host's cookie (its own new session): the user; with none: null.
  const app = onSignin(undefined, HOST.gate);
  app.jar.set("__Host-better-auth.session_token", redeemed.json.token);
  const appSession = async (b = app) => (await b("GET", "/.auth/api/get-session", undefined, { "x-forwarded-host": "crm.example.com", "x-forwarded-proto": "https" })).json;
  const user = (await appSession()).user;
  assert.equal(user.email, "uma@example.com");
  assert.equal(user.banned, false);
  assert.equal((await onSignin(undefined, HOST.gate)("GET", "/.auth/api/get-session")).body, "null");
  // On https only the __Host- name counts: the same value under the plain name is ignored.
  const plain = onSignin(undefined, HOST.gate);
  plain.jar.set("better-auth.session_token", redeemed.json.token);
  assert.equal(await appSession(plain), null);
  // An app host's session is never an admin session (nor a parent for another handoff).
  assert.equal(await accounts.sessionOf(reqWith(app.jar, HOST.admin, true)), null);
  assert.equal(await accounts.sessionOf(reqWith(new Map([["better-auth.session_token", redeemed.json.token]]), HOST.admin)), null);
  assert.equal((await app("POST", "/.auth/api/handoff/mint", { host: "crm.example.com", state })).status, 401);
  // The gate's sign-out on the app host ends that session only.
  const second = onSignin(undefined, HOST.gate);
  second.jar.set("__Host-better-auth.session_token", (await redeem(await mint())).json.token);
  assert.equal((await second("POST", "/.auth/api/handoff/revoke", { host: "other.example.com" })).status, 400);
  assert.equal((await second("POST", "/.auth/api/handoff/revoke", { host: "crm.example.com" })).status, 200);
  assert.equal(await appSession(second), null);
  assert.equal((await appSession()).user.email, "uma@example.com");
  // Signing out on the sign-in host ends every app host session handed off from it.
  assert.equal((await s("POST", "/.auth/api/sign-out", {})).status, 200);
  assert.equal(await appSession(), null);

  // Nothing else is served on 3129.
  assert.equal((await s("GET", "/.auth/api/list-sessions")).status, 404);
  assert.equal((await s("POST", "/.auth/api/change-password", { currentPassword: PASSWORD, newPassword: PASSWORD })).status, 404);
  assert.equal((await s("GET", "/api/board")).status, 404);
  // Admins give their TOTP code on the gate's side too; one without an authenticator can't sign in there.
  assert.equal((await onSignin()("POST", "/.auth/api/sign-in/email", { email: "ann@example.com", password: "another long password" })).json.twoFactorRedirect, true);
  const bob = await accounts.invite(owner, { email: "bob@example.com", name: "Bob", role: "admin" });
  assert.equal((await onAdmin()("POST", "/api/auth/reset-password", { token: tokenOf(bob.url), newPassword: PASSWORD })).status, 200);
  assert.equal((await onSignin()("POST", "/.auth/api/sign-in/email", { email: "bob@example.com", password: PASSWORD })).status, 403);

  // Two session cookies at once (one planted): no session.
  const dup = `__Host-better-auth.session_token=${redeemed.json.token}; __Host-better-auth.session_token=${redeemed.json.token}`;
  assert.equal((await onSignin(undefined, HOST.gate)("GET", "/.auth/api/get-session", undefined, { cookie: dup })).body, "null");

  // The gate's account map: every account, written in place, no secrets.
  await new Promise((r) => setTimeout(r, 50));
  const map = JSON.parse(readFileSync(gateAccountsFile, "utf8"));
  assert.ok(map.accounts.some((a) => a.email === "owner@example.com" && a.role === "admin" && a.disabled === false));
  assert.ok(map.accounts.some((a) => a.email === "uma@example.com" && a.role === "user" && a.disabled === false));
  assert.equal(JSON.stringify(map).includes("password"), false);
});

test("pauses sign-ins per address (the gate's client-IP header) and per account, and a challenge dies after 5 wrong codes", async () => {
  const from = (ip) => ({ "x-aidenhq-client-ip": ip, "x-aidenhq-gate": GATE_SECRET });
  // One password step, then wrong codes from five addresses (no address reaches its own pause): the sixth try, even with
  // the right code, finds the challenge spent.
  const s = onSignin();
  assert.equal((await s("POST", "/.auth/api/sign-in/email", { email: "ann@example.com", password: "another long password" }, from("10.0.0.1"))).json.twoFactorRedirect, true);
  // Five different wrong codes (a repeated one would stop at the replay guard, before Better Auth counts it).
  const wrong = (i) => String((Number(totp(annUri)) + 100_000 * (i + 1)) % 1_000_000).padStart(6, "0");
  for (let i = 0; i < 5; i++) assert.equal((await s("POST", "/.auth/api/two-factor/verify-totp", { code: wrong(i) }, from(`10.0.1.${i}`))).status, 401);
  // Five wrong codes for the account: the next one waits (429, from any address); after the wait, the challenge is spent.
  assert.equal((await s("POST", "/.auth/api/two-factor/verify-totp", { code: totp(annUri, 1) }, from("10.0.2.1"))).status, 429);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await s("POST", "/.auth/api/two-factor/verify-totp", { code: totp(annUri, 1) }, from("10.0.2.1"))).status, 400);

  // 20 wrong passwords spread over 20 addresses pause the whole account; the right password from a 21st is refused.
  const u = onSignin();
  for (let i = 0; i < 20; i++) assert.equal((await u("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: "wrong password!!" }, from(`10.3.0.${i}`))).status, 401);
  assert.equal((await u("POST", "/.auth/api/sign-in/email", { email: "uma@example.com", password: PASSWORD }, from("10.4.0.1"))).status, 403);
});
