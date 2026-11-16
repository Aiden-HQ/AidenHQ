// Module UI session handoff (lean 3g): /auth/handoff on the admin listener mints a one-time code for an allowed module origin,
// the module exchanges it on the backplane for its own session token, and every request checks that token, so a sign-out, a
// disable or a reset ends it.
import { test, after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { openAccounts, AccountError } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { PASSWORD, authApiServer, jsonBrowser, reqWith, silent, stepListener, totp } from "./auth-helpers.mjs";
import { serve } from "./helpers.mjs";

const HOST = "localhost:3120";
const BOARD = "http://board.example:3121";
const STATE = "s".repeat(32);
const tokenOf = (url) => url.split("token=").pop();

let accounts, steps, adminSrv, api;
const apps = { "tok-apps": { kind: "module", module: "apps-platform" }, "tok-board": { kind: "module", module: "board" } };
before(async () => {
  accounts = await openAccounts({ dataDir: ":memory:", hosts: [HOST], adminUrl: `http://${HOST}`, edgeSecret: () => "", notify: () => {}, log: silent });
  steps = await stepListener(accounts);
  const cards = { ownerCards: async () => ({ live: [], finished: [] }), decideCard: async () => { throw new Error("no"); } };
  adminSrv = await serve(createAdmin({ accounts, cards, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [HOST], origins: () => [`http://${HOST}`], frameOrigins: () => [], uiOrigins: () => ({ [BOARD]: "board" }) }));
  api = await authApiServer(accounts, { whoami: async (t) => apps[t] });
});
after(() => { steps.close(); adminSrv.s.close(); api.close(); accounts.close(); });

/** The admin listener (kernel pages) with an optional session cookie jar. */
const admin = (method, path, jar, { origin = `http://${HOST}` } = {}) => new Promise((ok, no) => {
  const headers = { host: HOST, ...(jar?.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded", origin } : {}) };
  const r = request(`${adminSrv.url}${path}`, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, location: String(res.headers.location ?? ""), body: d })); });
  r.on("error", no);
  r.end(method === "POST" ? "" : undefined);
});
const handoffPath = (to = BOARD, state = STATE) => `/auth/handoff?to=${encodeURIComponent(to)}&state=${encodeURIComponent(state)}`;

/** An enrolled admin (TOTP set up, so a ready session) as a signed-in jar: the owner first, then invited admins. */
async function adminAccount(email, owner = false) {
  const { url } = owner ? await accounts.setup(email, email) : await accounts.invite((await accounts.list()).find((a) => a.owner), { email, name: email, role: "admin" });
  const b = jsonBrowser(steps.url, HOST);
  assert.equal((await b("POST", "/api/auth/reset-password", { token: tokenOf(url), newPassword: PASSWORD })).status, 200);
  assert.equal((await b("POST", "/api/auth/sign-in/email", { email, password: PASSWORD })).status, 200);
  const uri = (await b("POST", "/api/auth/two-factor/enable", { password: PASSWORD })).json.totpURI;
  assert.equal((await b("POST", "/api/auth/two-factor/verify-totp", { code: totp(uri) })).status, 200);
  const signIn = async (step) => {
    const c = jsonBrowser(steps.url, HOST);
    assert.equal((await c("POST", "/api/auth/sign-in/email", { email, password: PASSWORD })).json.twoFactorRedirect, true);
    assert.equal((await c("POST", "/api/auth/two-factor/verify-totp", { code: totp(uri, step) })).status, 200);
    return c.jar;
  };
  return { jar: b.jar, signIn, account: (await accounts.list()).find((a) => a.email === email) };
}
const whoOf = (jar) => accounts.sessionOf(reqWith(jar));
const uiTokenFor = async (jar, module = "board", origin = BOARD) => {
  const code = accounts.mintUiCode(await whoOf(jar), module, origin, STATE);
  return (await accounts.exchangeUi(module, code, origin, STATE)).token;
};

let owner, ann, bob;
test("setup: an owner and two admins, each enrolled", async () => {
  owner = await adminAccount("owner@example.com", true);
  ann = await adminAccount("ann@example.com");
  bob = await adminAccount("bob@example.com");
  assert.equal((await whoOf(owner.jar)).ready, true);
});

test("GET /auth/handoff: signed out goes to sign-in keeping next; a ready admin gets a 303 to the module; any other target is refused", async () => {
  const path = handoffPath();
  const out = await admin("GET", path);
  assert.equal(out.status, 303);
  assert.match(out.location, /^\/auth\/sign-in\?next=/);
  assert.equal(decodeURIComponent(out.location.split("next=")[1]), path); // preserved, so sign-in comes back here

  const ok = await admin("GET", path, owner.jar);
  assert.equal(ok.status, 303);
  const to = new URL(ok.location);
  assert.equal(`${to.origin}${to.pathname}`, `${BOARD}/auth/handoff`);
  assert.equal(to.searchParams.get("state"), STATE);
  assert.match(to.searchParams.get("code"), /^[A-Za-z0-9_-]{40,}$/);
  // The code it minted is the module's to exchange, once.
  assert.equal((await accounts.exchangeUi("board", to.searchParams.get("code"), BOARD, STATE)).admin.email, "owner@example.com");

  // No open redirect: only an installed module's origin, exactly.
  for (const bad of ["http://evil.example", "https://board.example:3121", "http://board.example:3121.evil.example", `${BOARD}/`, `${BOARD}@evil.example`, "//evil.example", "javascript:alert(1)", "constructor", "__proto__", ""]) {
    const r = await admin("GET", handoffPath(bad), owner.jar);
    assert.equal(r.status, 400, bad);
    assert.equal(r.location, "", bad);
  }
  assert.equal((await admin("GET", handoffPath(BOARD, "short"), owner.jar)).status, 400); // the module's state nonce is required
  assert.equal((await admin("GET", "/auth/handoff", owner.jar)).status, 400);
  // A password-only session (no authenticator yet) is no admin: never a code.
  const early = jsonBrowser(steps.url, HOST);
  const { url } = await accounts.invite((await accounts.list()).find((a) => a.owner), { email: "cy@example.com", name: "Cy", role: "admin" });
  await early("POST", "/api/auth/reset-password", { token: tokenOf(url), newPassword: PASSWORD });
  await early("POST", "/api/auth/sign-in/email", { email: "cy@example.com", password: PASSWORD });
  assert.equal((await admin("GET", handoffPath(), early.jar)).status, 403);
});

test("exchangeUi: a code works once, for the module, origin and state it was minted for, within 60 seconds", async () => {
  const mint = async (module = "board", origin = BOARD, state = STATE) => accounts.mintUiCode(await whoOf(owner.jar), module, origin, state);
  const refused = (p) => assert.rejects(p, (e) => e instanceof AccountError && e.status === 400);
  const code = await mint();
  const got = await accounts.exchangeUi("board", code, BOARD, STATE);
  assert.match(got.token, /^ahqu_/);
  assert.equal(got.admin.email, "owner@example.com");
  await refused(accounts.exchangeUi("board", code, BOARD, STATE)); // a second use
  // Each wrong attempt spends the code: the right one fails after it.
  for (const [module, origin, state] of [["board", "http://other.example:3121", STATE], ["board", BOARD, "t".repeat(32)], ["other-module", BOARD, STATE]]) {
    const c = await mint();
    await refused(accounts.exchangeUi(module, c, origin, state));
    await refused(accounts.exchangeUi("board", c, BOARD, STATE));
  }
  await refused(accounts.exchangeUi("board", "nonsense-code-that-was-never-minted", BOARD, STATE));
  // A code older than 60 s (a stubbed clock).
  const old = await mint();
  const real = Date.now();
  const clock = mock.method(Date, "now", () => real + 61_000);
  try {
    await refused(accounts.exchangeUi("board", old, BOARD, STATE));
  } finally {
    clock.mock.restore();
  }
  // A code minted for one admin session dies with it: an ended session can't be exchanged.
  const gone = await adminAccount("dee@example.com");
  const c = accounts.mintUiCode(await whoOf(gone.jar), "board", BOARD, STATE);
  await accounts.setDisabled(owner.account, gone.account.id, true);
  await refused(accounts.exchangeUi("board", c, BOARD, STATE));
});

test("uiSession: the admin while the listener's session lives; null after sign-out, disable and reset, for another module, or for a stray token", async () => {
  const token = await uiTokenFor(owner.jar);
  const who = await accounts.uiSession("board", token);
  assert.equal(who.account.email, "owner@example.com");
  assert.equal(who.ready, true);
  assert.equal(await accounts.uiSession("other-module", token), null);
  for (const stray of ["", "ahqu_", "ahqu_nope", token.replace(/^ahqu_/, ""), `Bearer ${token}`, "x".repeat(60), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")]) assert.equal(await accounts.uiSession("board", stray), null, stray);
  assert.notEqual(await accounts.uiSession("board", token), null); // none of that ended it

  // The module's own sign-out ends its session and leaves the listener's.
  accounts.endUiSession("other-module", token);
  assert.notEqual(await accounts.uiSession("board", token), null);
  accounts.endUiSession("board", token);
  assert.equal(await accounts.uiSession("board", token), null);
  assert.equal((await whoOf(owner.jar)).ready, true);

  // The admin listener's sign-out ends the module sessions handed off from that session (and only that session's).
  const second = await owner.signIn(1);
  const mine = await uiTokenFor(second);
  const other = await uiTokenFor(owner.jar);
  assert.notEqual(await accounts.uiSession("board", mine), null);
  assert.equal((await admin("POST", "/auth/sign-out", second, { origin: "http://evil.example" })).status, 403); // wrong Origin: not signed out
  assert.notEqual(await accounts.uiSession("board", mine), null);
  const out = await admin("POST", "/auth/sign-out", second);
  assert.equal(out.status, 303);
  assert.equal(await accounts.uiSession("board", mine), null);
  assert.equal(await whoOf(second), null);
  assert.notEqual(await accounts.uiSession("board", other), null);

  // Disabling the account ends it (a second admin: the owner can't be disabled).
  const annToken = await uiTokenFor(ann.jar);
  assert.notEqual(await accounts.uiSession("board", annToken), null);
  await accounts.setDisabled(owner.account, ann.account.id, true);
  assert.equal(await accounts.uiSession("board", annToken), null);
  await accounts.setDisabled(owner.account, ann.account.id, false);
  assert.equal(await accounts.uiSession("board", annToken), null); // enabling doesn't bring it back: its sessions are gone

  // A reset ends it and clears the authenticator: no admin until it is set up again.
  const bobToken = await uiTokenFor(bob.jar);
  assert.notEqual(await accounts.uiSession("board", bobToken), null);
  await accounts.reset("bob@example.com");
  assert.equal(await accounts.uiSession("board", bobToken), null);
  assert.equal(await whoOf(bob.jar), null);
});

test("the backplane: the board's key and a live session token, and nothing else, reach the module routes", async () => {
  const key = { authorization: `Bearer ${api.boardKey}` };
  // /v1/auth/session
  assert.equal((await api.post("/v1/auth/session", { token: "x" })).status, 401); // no key
  assert.equal((await api.post("/v1/auth/session", { token: "x" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await api.post("/v1/auth/session", { token: "x" }, { authorization: "Bearer tok-board" })).status, 401); // a module's own token is not the board's key
  assert.equal((await api.post("/v1/auth/session", { token: "ahqu_bad" }, key)).status, 401); // key, bad token
  // /v1/auth/exchange then session then sign_out
  const code = accounts.mintUiCode(await whoOf(owner.jar), "board", BOARD, STATE);
  assert.equal((await api.post("/v1/auth/exchange", { code, origin: BOARD, state: STATE })).status, 401);
  assert.equal((await api.post("/v1/auth/exchange", { code, origin: BOARD, state: "t".repeat(32) }, key)).status, 400);
  assert.equal((await api.post("/v1/auth/exchange", { code, origin: BOARD, state: STATE }, key)).status, 400); // spent by the wrong attempt
  const ex = await api.post("/v1/auth/exchange", { code: accounts.mintUiCode(await whoOf(owner.jar), "board", BOARD, STATE), origin: BOARD, state: STATE }, key);
  assert.equal(ex.status, 200, ex.body);
  const token = ex.json.token;
  const sess = await api.post("/v1/auth/session", { token }, key);
  assert.equal(sess.status, 200);
  assert.equal(sess.json.account.email, "owner@example.com");
  assert.equal(JSON.stringify(sess.json).includes(token), false); // the token isn't echoed
  // /v1/accounts/*: the key alone isn't a session
  const invite = { email: "new@example.com", name: "New", role: "user" };
  assert.equal((await api.post("/v1/accounts/invite", invite)).status, 401); // no key
  assert.equal((await api.post("/v1/accounts/invite", invite, key)).status, 400); // key, no token: refused, nothing invited
  assert.equal((await api.post("/v1/accounts/invite", { ...invite, token: "ahqu_bad" }, key)).status, 401); // key, no live session
  assert.equal((await api.post("/v1/accounts/invite", { ...invite, token: "ahqu_bad" }, { authorization: "Bearer tok-board" })).status, 401);
  assert.equal((await accounts.list()).some((a) => a.email === "new@example.com"), false);
  assert.equal((await api.post("/v1/accounts/invite", { ...invite, token }, key)).status, 200);
  assert.equal((await api.post("/v1/accounts/list", { token }, key)).status, 200);
  // A signed-out session token does nothing, and the board's sign_out ends it.
  assert.equal((await api.post("/v1/auth/sign_out", { token }, key)).status, 200);
  assert.equal((await api.post("/v1/auth/session", { token }, key)).status, 401);
  assert.equal((await api.post("/v1/accounts/invite", { ...invite, email: "other@example.com", token }, key)).status, 401);
  // /v1/apps/*: the apps-platform module's own token, not the board's key or another module's
  assert.equal((await api.post("/v1/apps/requests", { app: "crm" }, key)).status, 401);
  assert.equal((await api.post("/v1/apps/requests", { app: "crm" }, { authorization: "Bearer tok-board" })).status, 401);
  assert.equal((await api.post("/v1/apps/requests", { app: "crm" })).status, 401);
  assert.equal((await api.post("/v1/apps/requests", { app: "crm" }, { authorization: "Bearer tok-apps" })).status, 404); // past the door: no shared app "crm" here
});
