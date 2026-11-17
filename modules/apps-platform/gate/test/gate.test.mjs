// End to end on loopback: a local RSA key and JWKS server stand in for Cloudflare Access, an echo app for a shared app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessPage, authHeaders, createGate, mint, myAppsPage, requestsPage, signingKey, subOf, verifyToken } from "../gate.ts";
import { createIdentity } from "../../../../services/shared/aidenhq-identity.mjs";
import { ensureIdentityKeys } from "../../../../scripts/identity.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ISSUER = "https://team.cloudflareaccess.com";
const AUD = "aud-roadmap";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (claims, { kid = "k1", alg = "RS256" } = {}) => {
  const body = `${b64({ alg, kid, typ: "JWT" })}.${b64({ iss: ISSUER, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
};

const secrets = mkdtempSync(join(tmpdir(), "gate-"));
// The app-identity keys as compile makes them; the app's side is the shared middleware, as an app copies it.
ensureIdentityKeys(secrets);
const KEY = join(secrets, "identity", "gate.pem");
const identities = {};
const identify = (h, app = "roadmap") => (identities[app] ??= createIdentity({ app, keysFile: join(secrets, "identity", "keys.json") })).identify({ method: "GET", url: "/", headers: h });
/** The person the app sees, from the echoed headers (verified as the app verifies them). */
const who = (body, app) => identify(JSON.parse(body), app);
// The board's account map and app roles: boss is an admin account (no role rows), gone is disabled; admin@ and editor@
// have no account (access mode: an Access-verified email is a member).
const ACCOUNTS = join(secrets, "accounts.json");
writeFileSync(ACCOUNTS, JSON.stringify({ accounts: [
  { email: "Boss@Example.com", role: "admin", disabled: false },
  { email: "owner@example.com", role: "admin", disabled: false },
  { email: "viewer@example.com", role: "user", disabled: false },
  { email: "gone@example.com", role: "user", disabled: true },
], apps: {
  roadmap: { default: "blocked", roles: { "viewer@example.com": "member", "admin@example.com": "admin", "gone@example.com": "member", "editor@example.com": "editor" } },
  other: { default: "blocked", roles: { "viewer@example.com": "member" } },
} }));
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
let jwksSrv, app, gate, gatePort, seen;
before(async () => {
  jwksSrv = createServer((_q, s) => s.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] })));
  const jwksPort = await listen(jwksSrv);
  app = createServer((q, s) => {
    seen = { method: q.method, headers: q.headers };
    if (q.url === "/events") {
      s.writeHead(200, { "content-type": "text/event-stream" });
      s.write("data: one\n\n");
      setTimeout(() => s.end("data: two\n\n"), 300);
      return;
    }
    // a hostile app tries to plant (or overwrite) the sign-in cookie
    s.writeHead(200, { "content-type": "application/json", "set-cookie": ["__Secure-better-auth.session_token=planted; Domain=example.com", "theme=dark"] }).end(JSON.stringify(q.headers));
  });
  const appPort = await listen(app);
  const cfg = {
    login: "access", issuer: ISSUER, certs_url: `http://127.0.0.1:${jwksPort}/cdn-cgi/access/certs`, owner_email: "Squat@Example.com",
    accounts_file: ACCOUNTS, identity_key_file: KEY, my_apps: { host: "apps.example.com", aud: "aud-apps" },
    hosts: {
      "roadmap.example.com": { app: "roadmap", port: appPort, aud: AUD },
      "other.example.com": { app: "other", port: appPort, aud: "aud-other" },
    },
  };
  gate = createGate({ config: () => cfg, log: () => {} });
  gatePort = await listen(gate);
});
after(() => { for (const s of [jwksSrv, app, gate]) { s.close(); s.closeAllConnections(); } });

/** One request through the gate → { status, body, headers }. */
const call = (headers, { method = "GET", path = "/", host = "roadmap.example.com", onFirst } = {}) =>
  new Promise((resolve, reject) => {
    seen = undefined;
    const q = request({ host: "127.0.0.1", port: gatePort, method, path, headers: { host, ...headers } }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => { if (!body) onFirst?.(c); body += c; });
      r.on("end", () => resolve({ status: r.statusCode, body, headers: r.headers }));
    });
    q.on("error", reject);
    q.end(method === "POST" ? "{}" : undefined);
  });

test("a member is proxied as itself; no Access token, cookie or forged identity reaches the app", async () => {
  const r = await call({
    "cf-access-jwt-assertion": token({ email: "viewer@example.com" }),
    cookie: "CF_Authorization=secret; theme=dark",
    "x-aidenhq-user": "owner@example.com",
    "x-aidenhq-role": "admin",
    "x-aidenhq-app": "other",
    "tailscale-user-login": "owner@example.com",
    "cf-access-authenticated-user-email": "owner@example.com",
    "x-aidenhq-gate": "forged",
    "x-aidenhq-identity": "forged.token.here",
  });
  assert.equal(r.status, 200);
  const h = JSON.parse(r.body);
  // the Access adapter → the gate's token → the app's middleware: one person, for this app only
  assert.deepEqual(who(r.body), { sub: subOf("viewer@example.com"), email: "viewer@example.com", name: "", role: "member", kind: "person" });
  assert.match(subOf("viewer@example.com"), /^u_[A-Za-z0-9_-]{22}$/);
  assert.throws(() => who(r.body, "other"), /not for this app/);
  assert.equal(h.cookie, "theme=dark");
  for (const k of Object.keys(h)) assert.ok(!/^(cf-access-|tailscale-)/.test(k) && (!k.startsWith("x-aidenhq-") || k === "x-aidenhq-identity"), `${k} reached the app`);
});

test("the app's middleware refuses a missing, forged, expired or agent-claiming token; tailnet reads may be anonymous", () => {
  const keysFile = join(secrets, "identity", "keys.json");
  const app = createIdentity({ app: "roadmap", keysFile });
  const key = signingKey(KEY)();
  const t = Math.floor(Date.now() / 1000);
  const good = { iss: "aidenhq-gate", aud: "roadmap", sub: subOf("a@example.com"), kind: "person", email: "a@example.com", role: "member", iat: t, exp: t + 300 };
  const req = (token, method = "GET") => ({ method, url: "/", headers: token ? { "x-aidenhq-identity": token } : {} });
  assert.equal(app.identify(req(mint(key, good))).sub, good.sub);
  assert.throws(() => app.identify(req()), /no identity/);
  assert.throws(() => app.identify(req(mint(key, { ...good, exp: t - 1, iat: t - 301 }))), /expired/);
  assert.throws(() => app.identify(req(mint(key, { ...good, exp: t + 3600 }))), /expired/); // longer than 5 minutes
  assert.throws(() => app.identify(req(mint(key, { ...good, aud: "other" }))), /not for this app/);
  assert.throws(() => app.identify(req(mint(key, { ...good, kind: "agent", sub: "agent:x" }))), /not for this app/); // the gate's key can't make an agent
  assert.throws(() => app.identify(req(mint(key, { ...good, role: "blocked" }))), /bad identity/);
  const forged = mint({ key: generateKeyPairSync("ed25519").privateKey, kid: key.kid }, good);
  assert.throws(() => app.identify(req(forged)), /bad identity/);
  const tailnet = createIdentity({ app: "roadmap", keysFile, anonymous: true });
  assert.equal(tailnet.identify(req()), null);
  assert.equal(tailnet.identify(req(undefined, "POST")), null); // the app decides what anyone may do
  assert.throws(() => tailnet.identify(req("x.y.z")), /bad identity/);
});

test("the owner's admin account is an admin of every shared app; matching owner_email without one is nothing", async () => {
  const r = await call({ "cf-access-jwt-assertion": token({ email: "owner@EXAMPLE.com" }) });
  assert.equal(who(r.body).role, "admin");
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "squat@example.com" }) })).status, 403);
});

test("a token for another app (wrong aud) is refused", async () => {
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "viewer@example.com", aud: ["aud-other"] }) })).status, 403);
  assert.equal(seen, undefined);
});

test("bad tokens are refused: none, expired, wrong issuer, alg none, unknown key, no email, not shared", async () => {
  const unsigned = `${b64({ alg: "none", kid: "k1" })}.${b64({ iss: ISSUER, aud: [AUD], exp: 9e9, email: "viewer@example.com" })}.`;
  for (const h of [
    {},
    { "cf-access-jwt-assertion": token({ email: "viewer@example.com", exp: Math.floor(Date.now() / 1000) - 1 }) },
    { "cf-access-jwt-assertion": token({ email: "viewer@example.com", iss: "https://evil.cloudflareaccess.com" }) },
    { "cf-access-jwt-assertion": unsigned },
    { "cf-access-jwt-assertion": token({ email: "viewer@example.com" }, { kid: "k2" }) },
    { "cf-access-jwt-assertion": token({ common_name: "svc-token" }) },
    { "cf-access-jwt-assertion": token({ email: "stranger@example.com" }) },
  ]) assert.equal((await call(h)).status, 403, JSON.stringify(h).slice(0, 80));
  assert.equal(seen, undefined);
});

test("anyone not blocked may write, same-origin only; a custom role passes through; blocked is refused", async () => {
  const a = token({ email: "admin@example.com" });
  assert.equal((await call({ "cf-access-jwt-assertion": a, origin: "https://other.example.com" }, { method: "POST" })).status, 403);
  assert.equal((await call({ "cf-access-jwt-assertion": a, "sec-fetch-site": "same-site" }, { method: "POST" })).status, 403);
  assert.equal((await call({ "cf-access-jwt-assertion": a }, { method: "POST" })).status, 403);
  assert.equal(seen, undefined);
  assert.equal((await call({ "cf-access-jwt-assertion": a, origin: "https://roadmap.example.com" }, { method: "POST" })).status, 200);
  assert.equal(seen.method, "POST");
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "viewer@example.com" }), origin: "https://roadmap.example.com" }, { method: "POST" })).status, 200);
  assert.equal(who((await call({ "cf-access-jwt-assertion": token({ email: "editor@example.com" }) })).body).role, "editor");
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "stranger@example.com" }) })).status, 403); // default blocked
});

test("the gate's own /.aidenhq paths: never proxied; the Access page link; requests need the exact origin", async () => {
  const v = token({ email: "viewer@example.com" });
  const r = await call({ "cf-access-jwt-assertion": v }, { path: "/.aidenhq/access" });
  assert.deepEqual([r.status, r.headers.location], [302, "https://apps.example.com/access?app=roadmap"]);
  assert.equal((await call({ "cf-access-jwt-assertion": v, "sec-fetch-site": "same-origin" }, { method: "POST", path: "/.aidenhq/request" })).status, 403);
  assert.equal((await call({ "cf-access-jwt-assertion": v }, { path: "/.aidenhq/other" })).status, 404);
  assert.equal((await call({ "cf-access-jwt-assertion": v }, { path: "/%2eaidenhq/access" })).status, 400);
  assert.equal(seen, undefined);
});

test("stale keys fail closed: a JWKS outage past 2 h refuses every request with a 503", async () => {
  let clock = Date.now(), up = true;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const fetchJwks = async () => (up ? new Response(JSON.stringify({ keys: [jwk] })) : new Response("down", { status: 500 }));
  const g = createGate({ config: () => ({ issuer: ISSUER, certs_url: "http://jwks.invalid/certs", owner_email: "owner@example.com", accounts_file: ACCOUNTS, identity_key_file: KEY, hosts: { "roadmap.example.com": { app: "roadmap", port: app.address().port, aud: AUD } } }), fetch: fetchJwks, now: () => clock, log: () => {} });
  const port = await listen(g);
  const get = () => new Promise((resolve) => request({ host: "127.0.0.1", port, headers: { host: "roadmap.example.com", "cf-access-jwt-assertion": token({ email: "owner@example.com" }) } }, (r) => (r.resume(), resolve(r.statusCode))).end());
  try {
    assert.equal(await get(), 200);
    up = false;
    clock += 61 * 60_000; // past max-age, refresh fails: the cache is still within the hard limit
    assert.equal(await get(), 200);
    clock += 60 * 60_000; // 2 h+ since the last good load
    assert.equal(await get(), 503);
    up = true;
    clock += 60_000; // the next refresh succeeds again
    assert.equal(await get(), 200);
  } finally {
    g.close();
    g.closeAllConnections();
  }
});

test("without its signing key the gate refuses (503) rather than proxy", async () => {
  const g = createGate({ config: () => ({ issuer: ISSUER, certs_url: `http://127.0.0.1:${jwksSrv.address().port}/cdn-cgi/access/certs`, owner_email: "owner@example.com", accounts_file: ACCOUNTS, identity_key_file: join(secrets, "absent.pem"), hosts: { "roadmap.example.com": { app: "roadmap", port: app.address().port, aud: AUD } } }), log: () => {} });
  const port = await listen(g);
  try {
    seen = undefined;
    const status = await new Promise((resolve) => request({ host: "127.0.0.1", port, headers: { host: "roadmap.example.com", "cf-access-jwt-assertion": token({ email: "viewer@example.com" }) } }, (r) => (r.resume(), resolve(r.statusCode))).end());
    assert.equal(status, 503);
    assert.equal(seen, undefined);
  } finally {
    g.close();
    g.closeAllConnections();
  }
});

test("a PR preview host: its parent's Access audience and roles, its own identity, and no cookie leaves its host", async () => {
  // The app sets a cookie for the whole domain: through the gate it stays on the host that set it.
  const tosser = createServer((q, s) => s.writeHead(200, { "content-type": "application/json", "set-cookie": ["toss=1; Domain=example.com; Path=/", "plain=1; Path=/"] }).end(JSON.stringify(q.headers)));
  const port = await listen(tosser);
  const file = join(secrets, "previews.json");
  writeFileSync(file, JSON.stringify({ "roadmap-pr-3": port, "other-pr-3": 3120 }));
  const cfg = {
    login: "access", issuer: ISSUER, certs_url: `http://127.0.0.1:${jwksSrv.address().port}/cdn-cgi/access/certs`, owner_email: "owner@example.com",
    accounts_file: ACCOUNTS, identity_key_file: KEY, my_apps: { host: "apps.example.com", aud: "aud-apps" },
    hosts: { "roadmap.example.com": { app: "roadmap", port, aud: AUD }, "other.example.com": { app: "other", port, aud: "aud-other" } },
    previews: { file, ports: [port, port] },
  };
  const g = createGate({ config: () => cfg, log: () => {} });
  const gp = await listen(g);
  const get = (host, email, aud = [AUD]) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: gp, path: "/", headers: { host, "cf-access-jwt-assertion": token({ email, aud }) } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, body, cookies: r.headers["set-cookie"] ?? [] }));
    }).on("error", reject).end();
  });
  try {
    const r = await get("pr-3.roadmap.example.com", "viewer@example.com");
    assert.equal(r.status, 200);
    assert.equal(who(r.body, "roadmap-pr-3").role, "member"); // roadmap's role, for the preview only
    assert.throws(() => who(r.body, "roadmap"), /not for this app/);
    assert.deepEqual(r.cookies, ["toss=1; Path=/", "plain=1; Path=/"]);
    assert.deepEqual((await get("roadmap.example.com", "viewer@example.com")).cookies, ["toss=1; Path=/", "plain=1; Path=/"]); // nor reaches its previews
    assert.equal((await get("pr-3.roadmap.example.com", "viewer@example.com", ["aud-other"])).status, 403); // only the parent's Access
    assert.equal((await get("pr-3.roadmap.example.com", "nobody@example.com")).status, 403); // blocked on roadmap: blocked here
    assert.equal((await get("pr-3.other.example.com", "viewer@example.com", ["aud-other"])).status, 404); // a port outside the band
    assert.equal((await get("pr-4.roadmap.example.com", "viewer@example.com")).status, 404); // not running
  } finally {
    for (const s of [g, tosser]) { s.close(); s.closeAllConnections(); }
  }
});

test("an unknown host is a 404", async () => {
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "owner@example.com" }) }, { host: "board.example.com" })).status, 404);
});

test("SSE streams through: the first event arrives before the app ends the response", async () => {
  let firstAt;
  const start = Date.now();
  const r = await call({ "cf-access-jwt-assertion": token({ email: "viewer@example.com" }) }, { path: "/events", onFirst: () => (firstAt = Date.now()) });
  assert.equal(r.status, 200);
  assert.equal(r.body, "data: one\n\ndata: two\n\n");
  assert.ok(firstAt - start < 250, `first event after ${firstAt - start} ms`);
});

test("a WebSocket upgrade needs the same origin, then passes through", async () => {
  app.once("upgrade", (q, sock) => {
    sock.on("error", () => {});
    sock.on("end", () => sock.destroy());
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (d) => sock.write(`echo:${d}`));
  });
  const upgrade = (origin) => new Promise((resolve) => {
    const s = connect(gatePort, "127.0.0.1", () => s.write(`GET /ws HTTP/1.1\r\nHost: roadmap.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\nCf-Access-Jwt-Assertion: ${token({ email: "viewer@example.com" })}\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.startsWith("HTTP/1.1 101") && buf.includes("\r\n\r\n") && !buf.includes("echo:")) s.write("hi");
      if (buf.includes("echo:hi") || buf.startsWith("HTTP/1.1 403")) { s.destroy(); resolve(buf); }
    });
    s.on("close", () => resolve(buf));
  });
  assert.match(await upgrade("https://other.example.com"), /^HTTP\/1.1 403/);
  assert.match(await upgrade("https://roadmap.example.com"), /^HTTP\/1.1 101[\s\S]*echo:hi/);
});

test("access mode: a disabled account is refused even with a role; an admin account is an admin of every app", async () => {
  assert.equal((await call({ "cf-access-jwt-assertion": token({ email: "gone@example.com" }) })).status, 403);
  assert.equal(seen, undefined);
  assert.equal(who((await call({ "cf-access-jwt-assertion": token({ email: "boss@example.com" }) })).body).role, "admin");
  assert.equal(who((await call({ "cf-access-jwt-assertion": token({ email: "viewer@example.com" }) })).body).role, "member");
});

test("my apps lists only the apps the visitor isn't blocked from (all of them for an admin), behind its own Access aud", async () => {
  const mine = (email, aud = "aud-apps") => call({ "cf-access-jwt-assertion": token({ email, aud: [aud] }) }, { host: "apps.example.com" });
  const v = await mine("admin@example.com"); // roadmap's admin, no account
  assert.equal(v.status, 200);
  assert.match(v.body, /https:\/\/roadmap\.example\.com\//);
  assert.match(v.body, /\/access\?app=roadmap/);
  assert.doesNotMatch(v.body, /other\.example\.com/);
  const b = await mine("boss@example.com");
  assert.match(b.body, /roadmap\.example\.com/);
  assert.match(b.body, /other\.example\.com/);
  assert.equal((await mine("gone@example.com")).status, 403);
  assert.equal((await mine("viewer@example.com", AUD)).status, 403); // a token for an app isn't one for my apps
});

test("password mode: sign-in only on the my-apps host; app hosts get a host-only cookie through a one-time handoff", async () => {
  let clock = Date.now();
  const SC = "__Host-better-auth.session_token";
  const people = { "s-ann": "ann@example.com", "s-gone": "gone@example.com", "s-nobody": "nobody@example.com" };
  const codes = new Map(); // the board's side (lane 1), as the gate expects it: 60 s, single use, bound to one host and state
  const revoked = [];
  let n = 0;
  const auth = createServer((q, s) => {
    let raw = "";
    q.on("data", (c) => (raw += c)).on("end", () => {
      const sid = new RegExp(`${SC}=([^;]+)`).exec(q.headers.cookie ?? "")?.[1];
      const json = (status, body, headers = {}) => s.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (q.url === "/.auth/api/get-session") return json(200, people[sid] ? { session: { id: sid, token: sid }, user: { email: people[sid] } } : null);
      if (q.url === "/.auth/api/handoff/mint") {
        if (!people[sid]) return json(401, null);
        const code = `code-${++n}`;
        const { host, state } = JSON.parse(raw);
        codes.set(code, { host, state, at: clock, email: people[sid] });
        return json(200, { code });
      }
      if (q.url === "/.auth/api/handoff/redeem") {
        const { code, host, state } = JSON.parse(raw);
        const c = codes.get(code);
        codes.delete(code);
        if (!c || c.host !== host || c.state !== state || clock - c.at > 60_000) return json(400, { error: "invalid code" });
        const token = `tok-${host}-${n}-0123456789abcdef`;
        people[token] = c.email;
        return json(200, { token });
      }
      if (q.url === "/.auth/api/handoff/revoke") {
        revoked.push(sid);
        delete people[sid];
        return json(200, { ok: true });
      }
      if (q.url === "/.auth/api/sign-in/email") return json(200, { redirect: false, token: "s-ann", user: { email: "ann@example.com" } }, { "set-auth-token": "s-ann", "set-cookie": [`${SC}=s-ann; Path=/; Secure; HttpOnly`, `${SC}=wide; Domain=example.com; Path=/; Secure`] });
      json(200, { url: q.url, headers: q.headers });
    });
  });
  const authPort = await listen(auth);
  writeFileSync(join(secrets, "accounts-pw.json"), JSON.stringify({ accounts: [{ email: "ann@example.com", name: "Ann Ö", role: "user", disabled: false }, { email: "gone@example.com", role: "user", disabled: true }], apps: { roadmap: { default: "member", roles: {} }, other: { default: "member", roles: {} } } }));
  const site = (app) => ({ app, port: app_port() });
  const app_port = () => app.address().port;
  const cfg = {
    login: "password", auth_url: `http://127.0.0.1:${authPort}`, owner_email: "owner@example.com", accounts_file: join(secrets, "accounts-pw.json"), identity_key_file: KEY,
    my_apps: { host: "apps.example.com" }, hosts: { "roadmap.example.com": site("roadmap"), "other.example.com": site("other") },
  };
  const g = createGate({ config: () => cfg, now: () => clock, log: () => {} });
  const port = await listen(g);
  const send = (path, { cookie, host = "roadmap.example.com", method = "GET", origin } = {}) => new Promise((resolve) => {
    seen = undefined;
    request({ host: "127.0.0.1", port, path, method, headers: { host, "x-aidenhq-user": "owner@example.com", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c)).on("end", () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }).end(method === "POST" ? "{}" : undefined);
  });
  const MY = "apps.example.com";
  const ST = "__Host-better-auth.handoff_state";
  /** The app host's redirect for a page → { go, state }: the go URL and the state cookie the app host set. */
  const start = async (host = "roadmap.example.com", path = "/plan?q=1") => {
    const r = await send(path, { host });
    const go = new URL(r.headers.location);
    const [c] = r.headers["set-cookie"];
    return { r, go, state: go.searchParams.get("state"), cookie: c };
  };
  /** Signed in on the my-apps host, follow go → the handoff URL. */
  const mint = async (st) => new URL((await send(st.go.pathname + st.go.search, { host: MY, cookie: `${SC}=s-ann` })).headers.location);
  const redeem = (h, stateCookie, host = "roadmap.example.com") => send(h.pathname + h.search, { host, ...(stateCookie ? { cookie: `${ST}=${stateCookie}` } : {}) });
  try {
    // no session on an app host → the my-apps host's go (with a state bound to this browser) → sign-in there
    const st = await start();
    assert.equal(st.r.status, 302);
    assert.equal(st.go.origin + st.go.pathname, "https://apps.example.com/.auth/go");
    assert.equal(st.go.searchParams.get("to"), "https://roadmap.example.com/plan?q=1");
    assert.match(st.state, /^[0-9a-f]{32}$/);
    assert.equal(st.cookie, `${ST}=${st.state}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`);
    assert.equal(seen, undefined);
    const go = await send(st.go.pathname + st.go.search, { host: MY });
    assert.equal(go.status, 302);
    assert.equal(go.headers.location, `/.auth/sign-in?next=${encodeURIComponent(`/.auth/go?to=https%3A%2F%2Froadmap.example.com%2Fplan%3Fq%3D1&state=${st.state}`)}`);
    assert.equal((await send(`/.auth/go?to=${encodeURIComponent("https://evil.example.net/")}&state=${st.state}`, { host: MY, cookie: `${SC}=s-ann` })).status, 400);
    assert.equal((await send(`/.auth/go?to=${encodeURIComponent("https://roadmap.example.com/")}`, { host: MY, cookie: `${SC}=s-ann` })).status, 400); // no state


    // signed in on the my-apps host → a code for that app host and state → its handoff sets a host-only cookie
    const h1 = await mint(st);
    assert.equal(h1.origin + h1.pathname, "https://roadmap.example.com/.auth/handoff");
    assert.equal(h1.searchParams.get("next"), "/plan?q=1");
    assert.equal(h1.searchParams.get("state"), st.state);
    const done = await redeem(h1, st.state);
    assert.equal(done.status, 302);
    assert.equal(done.headers.location, "/plan?q=1");
    const [cookie, cleared] = done.headers["set-cookie"];
    assert.match(cookie, /^__Host-better-auth\.session_token=tok-roadmap\.example\.com-1-0123456789abcdef; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    assert.doesNotMatch(cookie, /domain/i);
    assert.match(cleared, /^__Host-better-auth\.handoff_state=; Path=\/; Max-Age=0/);
    // a code works once, only on its own host, and only for 60 s
    assert.equal((await redeem(h1, st.state)).status, 403);
    const s2 = await start("other.example.com");
    const h2 = await mint(st); // a code for roadmap…
    assert.equal((await redeem(h2, st.state, "other.example.com")).status, 403); // …is no good on other
    const h3 = await mint(st);
    clock += 61_000;
    assert.equal((await redeem(h3, st.state)).status, 403);
    // login CSRF: a link minted for someone else's browser (another state) is refused in this one, and so is no state cookie
    const h4 = await mint(st);
    assert.equal((await redeem(h4, s2.state)).status, 403);
    assert.equal((await redeem(h4)).status, 403);
    // next is only ever a path on this host, resolved as a browser would
    for (const [next, want] of [["//evil.example.net/", "/"], ["/\\evil.example.net", "/"], ["/\t/evil.example.net", "/"], ["https://evil.example.net/", "/"], ["/a/../b?x=1#y", "/b?x=1#y"]]) {
      const h = await mint(st);
      const r = await send(`${h.pathname}?code=${h.searchParams.get("code")}&state=${st.state}&next=${encodeURIComponent(next)}`, { cookie: `${ST}=${st.state}` });
      assert.equal(r.headers.location, want, next);
    }

    // the session opens the app: identity set, the auth cookie neither sent to nor settable by the app
    const appCookie = cookie.split(";")[0];
    const ok = await send("/", { cookie: `theme=dark; ${appCookie}` });
    assert.equal(ok.status, 200);
    const h = JSON.parse(ok.body);
    const atClock = createIdentity({ app: "roadmap", keysFile: join(secrets, "identity", "keys.json"), now: () => clock / 1000 }); // this gate's clock moved on
    assert.deepEqual(atClock.identify({ method: "GET", url: "/", headers: JSON.parse(ok.body) }), { sub: subOf("ann@example.com"), email: "ann@example.com", name: "Ann Ö", role: "member", kind: "person" });
    assert.equal(h["x-aidenhq-user"], undefined); // the forged header the client sent
    assert.equal(h.cookie, "theme=dark");
    assert.deepEqual(ok.headers["set-cookie"], ["theme=dark"]);
    assert.equal((await send("/", { cookie: `${SC}=s-gone` })).status, 403);
    assert.equal((await send("/", { cookie: `${SC}=s-nobody` })).status, 403); // a session but no account

    // sign-out on an app host: same-origin only; the board revokes this host's session, the cookie expires, and the
    // gate's cache forgets it at once (the session was cached by the request above)
    assert.equal((await send("/.auth/sign-out", { method: "POST", origin: "https://other.example.com", cookie: appCookie })).status, 403);
    assert.equal((await send("/", { cookie: appCookie })).status, 200);
    const out = await send("/.auth/sign-out", { method: "POST", origin: "https://roadmap.example.com", cookie: appCookie });
    assert.equal(out.status, 303);
    assert.equal(out.headers.location, "https://apps.example.com/");
    assert.match(out.headers["set-cookie"][0], /^__Host-better-auth\.session_token=; Path=\/; Max-Age=0/);
    assert.deepEqual(revoked, [appCookie.split("=")[1]]);
    assert.equal((await send("/", { cookie: appCookie })).status, 302); // back to sign-in, not the cached answer

    // no sign-in surface on an app host (only the handoff); no session or token endpoints anywhere
    assert.equal((await send("/.auth/sign-in")).status, 404);
    assert.equal((await send("/.auth/api/sign-in/email", { method: "POST", origin: "https://roadmap.example.com" })).status, 404);
    for (const p of ["/.auth/api/get-session", "/.auth/api/list-sessions", "/.auth/api/change-password", "/.auth/api/token", "/.auth/api/handoff/mint", "/.auth/assets/../api/get-session", "/x/../.auth/api/list-sessions"]) {
      assert.equal((await send(p, { host: MY, cookie: `${SC}=s-ann` })).status, 404, p);
    }
    // encoded traversal is refused before any path check
    for (const p of ["/.auth/%2e%2e/api/get-session", "/.auth/assets/%2E%2E%2Fapi%2Fget-session", "/%2eauth/api/get-session", "/.auth/assets/..%5capi"]) {
      assert.equal((await send(p, { host: MY, cookie: `${SC}=s-ann` })).status, 400, p);
    }
    assert.equal((await send("/%2eauth/handoff?code=x")).status, 400);

    // the sign-in page is the auth listener's, at the normalised path: only Better Auth's cookies, no forged identity
    const page = JSON.parse((await send("/.auth/assets/x/../app.css?v=1", { host: MY, cookie: "theme=dark; better-auth.session_token=x" })).body);
    assert.equal(page.url, "/.auth/assets/app.css?v=1");
    assert.equal(page.headers.cookie, "better-auth.session_token=x");
    assert.equal(page.headers["x-forwarded-host"], MY);
    assert.equal(page.headers["x-aidenhq-user"], undefined);
    // signing in: cross-origin refused; same-origin sets the host-only cookie, never a Domain one, and no token in the answer
    assert.equal((await send("/.auth/api/sign-in/email", { host: MY, method: "POST", origin: "https://roadmap.example.com" })).status, 403);
    const signIn = await send("/.auth/api/sign-in/email", { host: MY, method: "POST", origin: `https://${MY}` });
    assert.equal(signIn.status, 200);
    assert.deepEqual(JSON.parse(signIn.body), { redirect: false, user: { email: "ann@example.com" } });
    assert.equal(signIn.headers["set-auth-token"], undefined);
    assert.deepEqual(signIn.headers["set-cookie"], [`${SC}=s-ann; Path=/; Secure; HttpOnly`]);
    const mine = await send("/", { host: MY, cookie: `${SC}=s-ann` });
    assert.equal(mine.status, 200);
    assert.match(mine.body, /roadmap\.example\.com/);
  } finally {
    for (const s of [g, auth]) { s.close(); s.closeAllConnections(); }
  }
});

test("fails closed: unreadable accounts or a failing session check refuse with a 503", async () => {
  const cfg = { login: "access", issuer: ISSUER, certs_url: `http://127.0.0.1:${jwksSrv.address().port}/cdn-cgi/access/certs`, owner_email: "owner@example.com", accounts_file: join(secrets, "missing.json"), identity_key_file: KEY, hosts: { "roadmap.example.com": { app: "roadmap", port: app.address().port, aud: AUD } } };
  const g = createGate({ config: () => cfg, log: () => {} });
  const port = await listen(g);
  const get = (headers) => new Promise((resolve) => request({ host: "127.0.0.1", port, headers: { host: "roadmap.example.com", ...headers } }, (r) => (r.resume(), resolve(r.statusCode))).end());
  try {
    assert.equal(await get({ "cf-access-jwt-assertion": token({ email: "viewer@example.com" }) }), 503);
    Object.assign(cfg, { login: "password", auth_url: "http://127.0.0.1:1", accounts_file: ACCOUNTS }); // nothing listens there
    delete cfg.hosts["roadmap.example.com"].aud;
    assert.equal(await get({ cookie: "__Host-better-auth.session_token=s-ann" }), 503);
  } finally {
    g.close();
    g.closeAllConnections();
  }
});

test("sign-in traffic names the visitor's address from Cloudflare only on cloudflared's socket, never the client's own copy", () => {
  const req = (headers) => ({ headers: { host: "apps.example.com", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
  const forged = { "x-aidenhq-client-ip": "10.9.9.9", "x-aidenhq-gate": "forged" };
  const secret = "s".repeat(64);
  assert.equal(authHeaders(req({ ...forged, "cf-connecting-ip": "203.0.113.7" }), secret, true)["x-aidenhq-client-ip"], "203.0.113.7");
  assert.equal(authHeaders(req(forged), secret)["x-aidenhq-gate"], secret);
  // On the loopback port anyone on the host can set CF-Connecting-IP: it names nothing there.
  assert.equal(authHeaders(req({ ...forged, "cf-connecting-ip": "203.0.113.7" }), secret)["x-aidenhq-client-ip"], undefined);
  // Only Cloudflare's header names it: never X-Forwarded-For, never a non-IP; then no header (the board uses its socket).
  assert.equal(authHeaders(req({ ...forged, "x-forwarded-for": "198.51.100.2" }), "", true)["x-aidenhq-client-ip"], undefined);
  assert.equal(authHeaders(req({ ...forged, "cf-connecting-ip": "*" }), "", true)["x-aidenhq-client-ip"], undefined);
  assert.equal(authHeaders(req(forged))["x-aidenhq-gate"], undefined);
});

test("the gate's pages escape every value: emails, role names and meanings, app names, request text and replies", () => {
  const x = `<script>alert(1)</script>"'`;
  const pages = [
    accessPage({ app: x, host: x, default: x, roles: [{ name: x, meaning: x }], assignments: [{ email: x, role: x, set_by: x, declared: false }], log: [{ at: x, subject: x, before: x, after: x, by: x, asked_by: x, request_id: x }] }),
    requestsPage(x, [{ at: x, text: x, status: x, reply: x }]),
    myAppsPage(x, [{ host: x, app: x, role: "admin" }]),
  ];
  for (const p of pages) {
    assert.doesNotMatch(p, /<script>/);
    assert.match(p, /&#60;script&#62;alert\(1\)&#60;\/script&#62;&#34;&#39;/);
  }
});

test("header-jwt: the front door's token for this host signs a person in; wrong aud, no token, RS256 or magic-link are refused; the header never reaches the app", async () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const IDP = "https://idp.example.com", HDR = "x-test-identity";
  const es = (claims, { alg = "ES256" } = {}) => {
    const body = `${b64({ alg, kid: "e1", typ: "JWT" })}.${b64({ iss: IDP, aud: "service:abc", email: "Viewer@Example.com", auth_method: "okta", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    return `${body}.${(alg === "ES256" ? sign("sha256", Buffer.from(body), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }) : sign("sha256", Buffer.from(body), privateKey)).toString("base64url")}`;
  };
  const jwk = { ...ec.publicKey.export({ format: "jwk" }), kid: "e1" };
  const cfg = {
    login: "header-jwt", identity: { header: HDR, issuer: IDP, jwks_url: "http://jwks.invalid/jwks", auth_method: "okta" }, owner_email: "owner@example.com",
    accounts_file: ACCOUNTS, identity_key_file: KEY, my_apps: { host: "apps.example.com", aud: "service:apps" },
    hosts: { "roadmap.example.com": { app: "roadmap", port: app.address().port, aud: "service:abc", default_role: "member" }, "other.example.com": { app: "other", port: app.address().port, aud: "service:xyz" } },
  };
  const cookieApp = createServer((q, s) => s.writeHead(200, { "set-cookie": "theme=dark; Domain=example.com" }).end(JSON.stringify(q.headers)));
  cfg.hosts["roadmap.example.com"].port = await listen(cookieApp);
  const g = createGate({ config: () => cfg, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })), log: () => {} });
  const port = await listen(g);
  const get = (headers, { host = "roadmap.example.com", path = "/" } = {}) => new Promise((resolve) => { seen = undefined; request({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (r) => { let b = ""; r.on("data", (c) => (b += c)).on("end", () => resolve({ status: r.statusCode, body: b, cookies: r.headers["set-cookie"] ?? [] })); }).end(); });
  try {
    const ok = await get({ [HDR]: es({}) });
    assert.equal(ok.status, 200);
    assert.equal(who(ok.body).email, "viewer@example.com");
    assert.equal(JSON.parse(ok.body)[HDR], undefined);
    assert.equal((await get({ [HDR]: es({}) }, { host: "other.example.com" })).status, 401); // app A's token on app B's host
    assert.equal((await get({})).status, 401);
    assert.equal((await get({ "cf-access-jwt-assertion": token({ email: "viewer@example.com" }) })).status, 401); // an Access token isn't the header
    assert.equal((await get({ [HDR]: es({}, { alg: "RS256" }) })).status, 401);
    // the key's type must match the alg: an ES256 token never verifies against an RSA key (nor RS256 against an EC key)
    await assert.rejects(verifyToken(es({}), { issuer: IDP, aud: "service:abc", key: async () => publicKey, alg: "ES256" }), /key type/);
    await assert.rejects(verifyToken(token({}), { issuer: ISSUER, aud: AUD, key: async () => ec.publicKey }), /key type/);
    assert.equal((await get({ [HDR]: es({ auth_method: "magic-link" }) })).status, 401);
    assert.equal((await get({ [HDR]: es({ email: "nobody@example.com" }) })).status, 403); // a valid identity that isn't allowed
    assert.equal((await get({ [HDR]: es({}) }, { path: "/.auth/sign-in" })).status, 404);
    // the app's Domain cookies are host-only
    const c = await get({ [HDR]: es({}) }, { path: "/" });
    assert.equal(c.cookies.some((x) => /domain=/i.test(x)), false);
    assert.equal(seen, undefined);
  } finally {
    cookieApp.close();
    cookieApp.closeAllConnections();
    g.close();
    g.closeAllConnections();
  }
});
