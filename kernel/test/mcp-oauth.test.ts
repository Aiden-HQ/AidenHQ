// The owner's MCP clients sign in (docs/superpowers/specs/2026-11-20-owner-mcp-design.md): the admin listener is the OAuth
// authorization server (metadata, registration, PKCE authorize behind the kernel's sign-in and consent, tokens bound to the
// board's /mcp), the board checks bearers on the backplane and decides cards as the bearer's account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAccounts } from "../src/accounts.ts";
import { createAdmin } from "../src/admin.ts";
import { createAuthApi } from "../src/auth-api.ts";
import { createBackplane } from "../src/backplane.ts";
import { createChannels } from "../src/channels.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";
import { call, silent, totp } from "./auth-helpers.ts";
import { serve } from "./helpers.ts";

const FIXTURE = new URL("./fixtures/board-auth/", import.meta.url).pathname;
const OWNER = JSON.parse(readFileSync(join(FIXTURE, "owner.json"), "utf8"));
const FRONT = "admin.example.com:8446"; // the admin front door: https
const ISSUER = `https://${FRONT}`;
const RESOURCE = "https://board.example.com/mcp";
const CALLBACK = "http://127.0.0.1:5555/cb";

/** One request through the front door; keeps a browser's cookies in `jar`. Forms post url-encoded, from this origin. */
function at(url, jar = new Map()) {
  return async (method, path, { form, json, headers = {} } = {}) => {
    const body = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined;
    const h = { host: FRONT, "x-forwarded-proto": "https", ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : json ? { "content-type": "application/json" } : {}), ...headers };
    const res = await new Promise((ok, no) => {
      const r = request(`${url}${path}`, { method, headers: h }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: d })); });
      r.on("error", no);
      r.end(body);
    });
    for (const c of res.headers["set-cookie"] ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (/max-age=0/i.test(c) || i === kv.length - 1) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { ...res, json: /^[[{]/.test(res.body) ? JSON.parse(res.body) : {}, csrf: /name="csrf" value="([0-9a-f]+)"/.exec(res.body)?.[1] };
  };
}
const page = { origin: ISSUER };
const relative = (location) => { const u = new URL(location, ISSUER); return u.pathname + u.search; };

/** The kernel's accounts (the fixture's owner, TOTP enrolled) and admin listener, the backplane's auth routes, and two cards for the owner. */
async function kernel(t) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  mkdirSync(join(dir, "kernel", "auth"), { recursive: true });
  for (const f of ["auth.db", "auth.secret"]) copyFileSync(join(FIXTURE, f), join(dir, "kernel", "auth", f));
  const accounts = await openAccounts({ dataDir: dir, hosts: [FRONT, "admin.example.com", "localhost:3120"], origins: [ISSUER], adminUrl: ISSUER, boardUrl: "https://board.example.com", edgeSecret: () => "", notify: () => {}, log: silent });
  const records = openRecords(join(dir, "kernel.db"));
  const writes = createWrites({ records, registry: () => ({ "acme.deploy": { module: "acme", floor: 2, tools: [] } }), connections: () => ({}), secret: () => "", resolver: {}, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }) });
  const channels = createChannels({ db: records.db, records, writes, board: async () => ({ status: 404, json: {} }), owner: async () => ({ status: 200, json: {} }), modules: () => ({}) });
  const card = (n) => records.file({ kind: "acme.deploy", module: "acme", args: { n }, targets: {}, executor: { module: "acme" }, policy: "p", tier: 2, card: { sentence: `Deploy ${n}.`, changes: "c", reads: "r", cost: "0", details: "" }, requester: { agent: "", key: "ada", name: "ada", roles: [], kind: "run" }, task: "t-7", identifier: "WOR-7", state: "owner" });
  const { s, url } = await serve(createAdmin({ accounts, cards: channels, ownerMessage: async () => ({ task: { identifier: "WOR-1" } }), owner: async () => ({ status: 200, json: {} }), hosts: () => [FRONT, "admin.example.com", "localhost:3120"], origins: () => [ISSUER], frameOrigins: () => [] }));
  // The backplane's routes, as the board calls them.
  const boardKey = "b".repeat(40);
  const bp = await serve(createBackplane({ accounts: createAuthApi({ accounts: () => accounts, whoami: async () => undefined, boardKey: () => boardKey, operatorKey: () => "", decide: channels.decideCard }), log: () => {} }));
  const api = { boardKey, post: (path, body, headers = {}) => call(bp.url, "POST", path, { host: "kernel.example", body, headers, origin: "" }) };
  t.after(() => { s.close(); bp.s.close(); accounts.close(); });
  /** The board's own session for a signed-in browser (the module UI handoff), as its account page holds it. */
  const boardSession = async (jar) => {
    const who = await accounts.sessionOf({ headers: { host: FRONT, "x-forwarded-proto": "https", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    const state = randomBytes(16).toString("hex");
    return (await accounts.exchangeUi("board", accounts.mintUiCode(who, "board", "https://board.example.com", state), "https://board.example.com", state)).token;
  };
  return { url, api, records, card, accounts, boardSession, spent: new Set() }; // spent: TOTP codes are single use per file
}

/** Signs `b` in through the kernel's pages (password, then a code not yet spent), from `next`; returns where it ends. */
async function signIn(b, next, spent) {
  const pw = await b("POST", `/auth/sign-in?next=${encodeURIComponent(next)}`, { form: { email: OWNER.email, password: OWNER.pw }, headers: page });
  assert.equal(pw.status, 303, pw.body);
  const code = [0, 1, -1].map((s) => totp(OWNER.b32, s)).find((c) => !spent.has(c));
  spent.add(code);
  const done = await b("POST", relative(pw.headers.location), { form: { code }, headers: page });
  assert.equal(done.status, 303, done.body);
  return relative(done.headers.location);
}

/** An authorize request with PKCE (S256) for the board's /mcp. */
function authorizeUrl(client, resource = RESOURCE) {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: CALLBACK, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st-1", scope: "offline_access", resource });
  return { path: `/oauth2/authorize?${q}`, verifier };
}

/**
 * An MCP client connects as the owner: registers (no Origin: not a browser form), then authorize with PKCE, from another
 * site (one same-site hop brings the session cookie), signed out (to the sign-in and back), consent, and the code for tokens.
 */
async function connect(k) {
  const c = at(k.url, new Map()); // the client itself: no cookies
  // A public native client on a loopback callback.
  const reg = await c("POST", "/oauth2/register", { json: { client_name: "Claude Code", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } });
  assert.equal(reg.status, 201, reg.body);
  const client = reg.json.client_id;

  const jar = new Map();
  const b = at(k.url, jar); // the owner's browser
  const { path, verifier } = authorizeUrl(client);
  const hop = await b("GET", path, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(hop.status, 200);
  assert.match(hop.body, /http-equiv="refresh"/);
  const out = await b("GET", path, { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(out.status, 303);
  const next = new URL(out.headers.location, ISSUER).searchParams.get("next");
  assert.equal(next, path);
  assert.equal(await signIn(b, next, k.spent), path); // back to authorize, now with the admin's session
  const consent = await b("GET", path);
  assert.equal(consent.status, 302, consent.body);
  const consentPage = await b("GET", relative(consent.headers.location));
  assert.equal(consentPage.status, 200, consentPage.body);
  assert.match(consentPage.body, /Claude Code<\/b> wants to manage AidenHQ as you/);
  assert.match(String(consentPage.headers["content-security-policy"]), /form-action 'self' http:\/\/127\.0\.0\.1:5555;/);
  const oauthQuery = /name="oauth_query" value="([^"]+)"/.exec(consentPage.body)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const allow = await b("POST", "/oauth/consent", { form: { csrf: consentPage.csrf, oauth_query: oauthQuery, accept: "true" }, headers: page });
  assert.equal(allow.status, 303, allow.body);
  const back = new URL(allow.headers.location);
  assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
  assert.equal(back.searchParams.get("state"), "st-1");
  assert.equal(back.searchParams.get("iss"), ISSUER);

  // Tokens bound to the board's /mcp: an hour, plus a refresh token.
  const tok = await c("POST", "/oauth2/token", { form: { grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: CALLBACK, client_id: client, code_verifier: verifier, resource: RESOURCE } });
  assert.equal(tok.status, 200, tok.body);
  assert.equal(tok.json.expires_in, 3600);
  assert.ok(tok.json.refresh_token);
  return { c, b, jar, client, tok };
}

test("mcp-oauth round trip: metadata, registration, sign-in and consent, a token for the board's /mcp, refresh, revoke", async (t) => {
  const k = await kernel(t);
  // The issuer is the admin front door's own origin, with S256, registration and client metadata documents (CIMD).
  const meta = await at(k.url)("GET", "/.well-known/oauth-authorization-server");
  assert.equal(meta.status, 200, meta.body);
  assert.equal(meta.json.issuer, ISSUER);
  assert.deepEqual(meta.json.code_challenge_methods_supported, ["S256"]);
  assert.equal(meta.json.registration_endpoint, `${ISSUER}/oauth2/register`);
  assert.equal(meta.json.authorization_endpoint, `${ISSUER}/oauth2/authorize`);
  assert.equal(meta.json.client_id_metadata_document_supported, true);
  // A proxy that passes the front door's name without its port still gets that origin; a loopback request its own.
  assert.equal((await at(k.url)("GET", "/.well-known/oauth-authorization-server", { headers: { host: "admin.example.com", "x-forwarded-proto": "" } })).json.issuer, ISSUER);
  assert.equal((await at(k.url)("GET", "/.well-known/oauth-authorization-server", { headers: { host: "localhost:3120", "x-forwarded-proto": "" } })).json.issuer, "http://localhost:3120");

  const { c, b, jar, client, tok } = await connect(k);
  const bearer = (token, resource = RESOURCE) => k.api.post("/v1/auth/mcp", { token, resource }, { authorization: `Bearer ${k.api.boardKey}` });
  const who = await bearer(tok.json.access_token);
  assert.equal(who.status, 200, who.body);
  assert.deepEqual([who.json.account.email, who.json.account.owner, who.json.client], [OWNER.email, true, "Claude Code"]);
  // Another resource (another board's /mcp) is refused; the board's key is required.
  assert.equal((await bearer(tok.json.access_token, "https://other.example.com/mcp")).status, 401);
  assert.equal((await k.api.post("/v1/auth/mcp", { token: tok.json.access_token, resource: RESOURCE })).status, 401);
  // A token minted for another resource isn't issued at all.
  const other = authorizeUrl(client, "https://other.example.com/mcp");
  const refused = await b("GET", other.path);
  assert.match(String(refused.headers.location), /[?&]error=invalid_target/);

  // Refresh: a new access token that works.
  const fresh = await c("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: tok.json.refresh_token, client_id: client, resource: RESOURCE } });
  assert.equal(fresh.status, 200, fresh.body);
  assert.equal((await bearer(fresh.json.access_token)).status, 200);
  // A client that renews without naming the resource keeps the grant's audience, and so does its rotated token.
  const bare = await c("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: fresh.json.refresh_token, client_id: client } });
  assert.equal(bare.status, 200, bare.body);
  assert.equal((await bearer(bare.json.access_token)).status, 200);
  const hop = await c("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: bare.json.refresh_token, client_id: client } });
  assert.equal(hop.status, 200, hop.body);
  assert.equal((await bearer(hop.json.access_token)).status, 200);
  fresh.json = hop.json;

  // The account's MCP clients, then revoke: every token of that client ends at once, and the refresh token too.
  const account = who.json.account.id;
  const key = { authorization: `Bearer ${k.api.boardKey}` };
  // Only the signed-in admin's own clients, by the board's session: never an account the caller names.
  const session = await k.boardSession(jar);
  assert.equal((await k.api.post("/v1/auth/mcp/grants", { token: "ahqu_forged" }, key)).status, 401);
  const grants = await k.api.post("/v1/auth/mcp/grants", { token: session }, key);
  assert.equal(grants.status, 200, grants.body);
  assert.equal(grants.json.grants.length, 1);
  assert.equal(grants.json.grants[0].client, "Claude Code");
  assert.ok(grants.json.grants[0].lastUsed);
  assert.equal((await k.api.post("/v1/auth/mcp/revoke", { token: session, grant: "not-this-accounts" }, key)).status, 404);
  assert.equal((await k.api.post("/v1/auth/mcp/revoke", { token: session, grant: grants.json.grants[0].id }, key)).status, 200);
  assert.equal((await bearer(fresh.json.access_token)).status, 401);
  assert.notEqual((await c("POST", "/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: fresh.json.refresh_token, client_id: client, resource: RESOURCE } })).status, 200);
  assert.equal((await k.api.post("/v1/auth/mcp/grants", { token: session }, key)).json.grants.length, 0);

  // A changed password ends every MCP grant.
  const again = await connect(k);
  assert.equal((await bearer(again.tok.json.access_token)).status, 200);
  const form = await again.b("GET", "/auth/password");
  assert.equal((await again.b("POST", "/auth/password", { form: { csrf: form.csrf, current: OWNER.pw, password: "a brand new password here" }, headers: page })).status, 200);
  assert.equal((await bearer(again.tok.json.access_token)).status, 401);
  assert.equal((await k.api.post("/v1/auth/mcp/grants", { token: await k.boardSession(again.jar) }, key)).json.grants.length, 0); // it must ask again

  // An admin without an authenticator is refused at authorize: no code.
  const ann = at(k.url);
  assert.equal((await ann("POST", "/auth/set-password", { form: { token: OWNER.invited.link, password: "a long enough password" }, headers: page })).status, 200);
  assert.equal((await ann("POST", "/auth/sign-in", { form: { email: OWNER.invited.email, password: "a long enough password" }, headers: page })).status, 303);
  const no = await ann("GET", authorizeUrl(client).path);
  assert.equal(no.status, 403);
  assert.equal(no.headers.location, undefined);
});

test("owner decide over MCP: each card against its digest, as the bearer's account; stale only closes; revoked decides nothing", async (t) => {
  const k = await kernel(t);
  const { tok, jar } = await connect(k);
  const key = { authorization: `Bearer ${k.api.boardKey}` };
  const account = (await k.api.post("/v1/auth/mcp", { token: tok.json.access_token, resource: RESOURCE }, key)).json.account.id;
  const decide = (cards, token = tok.json.access_token) => k.api.post("/v1/owner/decide", { token, resource: RESOURCE, cards }, key);
  const [one, two, three] = [1, 2, 3].map(k.card);

  // One read digest and one old one: the first is decided, the second fails alone and says what to do.
  const r = await decide([{ id: one.id, digest: one.digest, decision: "reject", reason: "not now" }, { id: two.id, digest: "old", decision: "approve" }]);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json.outcomes.map((o) => [o.id, o.ok, o.state]), [[one.id, true, "rejected"], [two.id, false, undefined]]);
  assert.match(r.json.outcomes[1].error, /changed since you read it: call approvals again/);
  assert.deepEqual([k.records.get(one.id).decided_by, k.records.get(one.id).via], [`account:${account}`, "mcp"]);

  // Stale only closes (a reject); then it is stamped stale:account:<id> and counts as stale, never a veto.
  const approveStale = await decide([{ id: two.id, digest: two.digest, decision: "approve", stale: true }]);
  assert.equal(approveStale.json.outcomes[0].ok, false);
  assert.equal(k.records.get(two.id).state, "owner");
  const closed = await decide([{ id: two.id, digest: two.digest, decision: "reject", stale: true }]);
  assert.deepEqual(closed.json.outcomes.map((o) => [o.ok, o.state]), [[true, "stale"]]);
  assert.equal(k.records.get(two.id).decided_by, `stale:account:${account}`);

  // A revoked grant gets 401 before any card is touched.
  const session = await k.boardSession(jar);
  const grant = (await k.api.post("/v1/auth/mcp/grants", { token: session }, key)).json.grants[0].id;
  await k.api.post("/v1/auth/mcp/revoke", { token: session, grant }, key);
  assert.equal((await decide([{ id: three.id, digest: three.digest, decision: "approve" }])).status, 401);
  assert.equal(k.records.get(three.id).state, "owner");

  // A password reset ends every MCP grant.
  const again = await connect(k);
  assert.equal((await k.api.post("/v1/auth/mcp", { token: again.tok.json.access_token, resource: RESOURCE }, key)).status, 200);
  await k.accounts.reset(OWNER.email);
  assert.equal((await k.api.post("/v1/auth/mcp", { token: again.tok.json.access_token, resource: RESOURCE }, key)).status, 401);
  assert.equal(k.accounts.mcpGrants(account).length, 0);
});

test("owner decide from the board: the admin's board session decides as that account, via board; a forged or ended one decides nothing", async (t) => {
  const k = await kernel(t);
  const { jar } = await connect(k);
  const key = { authorization: `Bearer ${k.api.boardKey}` };
  const session = await k.boardSession(jar);
  const [one, two] = [1, 2].map(k.card);
  const decide = (board, card, digest = card.digest) => k.api.post("/v1/owner/decide", { board, cards: [{ id: card.id, digest, decision: "approve" }] }, key);
  assert.equal((await decide("ahqu_forged_session_token", one)).status, 401);
  assert.equal((await k.api.post("/v1/owner/decide", { board: session, cards: [{ id: one.id, digest: one.digest, decision: "approve" }] })).status, 401); // the board's key too
  assert.equal(k.records.get(one.id).state, "owner");
  const stale = await decide(session, one, "old");
  assert.equal(stale.json.outcomes[0].ok, false);
  const r = await decide(session, one);
  assert.equal(r.json.outcomes[0].ok, true, r.body);
  const account = k.records.get(one.id).decided_by;
  assert.match(account, /^account:/);
  assert.equal(k.records.get(one.id).via, "board");
  await k.accounts.reset(OWNER.email);
  assert.equal((await decide(session, two)).status, 401);
  assert.equal(k.records.get(two.id).state, "owner");
});
