// The test-user page canary's listener (test-listener.ts): the one door a headless browser reaches without a person, and the
// checks that keep it to exactly one test session. Its kernel calls go to a fake sign-in listener standing in for the kernel's
// gate-only routes; the app is a real HTTP server on loopback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Duplex } from "node:stream";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate } from "../gate.ts";
import { createIdentity } from "../../starter/aidenhq-identity.mjs";
import { CANARY_BASE, CANARY_COOKIE, createTestListener, createTestListenerReconciler, testListenerOn } from "../test-listener.ts";
import { subOf } from "../gate.ts";
import { ensureIdentityKeys } from "../../../../scripts/identity.ts";

const secrets = mkdtempSync(join(tmpdir(), "test-listener-"));
ensureIdentityKeys(secrets);
const KEY = join(secrets, "identity", "gate.pem");
const SECRET = join(secrets, "gate_board_secret");
writeFileSync(SECRET, "gate-secret\n");
const EMAIL = "canary@aidenhq.test";
const COOKIE = "tok_live.signed"; // the cookie the fake kernel hands back and then accepts

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

/** The kernel's side: one live cookie for one host, one handoff code spent once, and the notify handler's 200. */
function fakeKernel() {
  const seen: { path: string; body: any }[] = [];
  const state = { live: true, spent: new Set<string>() };
  const s = createServer((q, r) => {
    let raw = "";
    q.on("data", (c) => (raw += c)).on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: String(q.url), body });
      const json = (status: number, b: unknown) => r.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (q.url === "/.auth/api/test-session/redeem") {
        const good = body.code === "code-ok-0123456789" && body.state === "0123456789abcdef".repeat(2) && body.host === "roadmap.example.com" && !state.spent.has(body.code);
        state.spent.add(String(body.code));
        return good ? json(200, { token: COOKIE, expires: "2030-01-01T00:00:00.000Z", app: "roadmap" }) : json(401, { error: "invalid or expired handoff" });
      }
      if (q.url === "/.auth/api/test-session/check") {
        // The kernel's check is for the app's own host, which the listener names: one app per host.
        const app = String(body.host).split(".")[0];
        if (!state.live || body.cookie !== COOKIE) return json(401, { error: "no test session" });
        // The one live cookie is roadmap's: presented under another app's host it is that app's own refusal (409 → 404).
        return app === "roadmap" ? json(200, { email: EMAIL, app, expires: "2030-01-01T00:00:00.000Z", role: "member" }) : json(409, { error: "that session is for another app" });
      }
      if (q.url === "/.auth/api/app-feedback/new") return json(200, { ok: true });
      if (q.url === "/.auth/api/get-session") return json(200, null);
      json(404, {});
    });
  });
  return { s, seen, state };
}

const appSeen: { method?: string; url?: string; host?: string; identity?: string }[] = [];
const app = createServer((q, s) => {
  appSeen.push({ method: q.method, url: q.url, host: String(q.headers.host ?? ""), identity: String(q.headers["x-aidenhq-identity"] ?? "") });
  s.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Roadmap</title><h1>Roadmap</h1>");
});

let kernel: ReturnType<typeof fakeKernel>, appPort: number, listener: any, lPort: number, gate: any, gatePort: number;
const cfg: any = {};
before(async () => {
  kernel = fakeKernel();
  const kernelPort = await listen(kernel.s);
  appPort = await listen(app);
  Object.assign(cfg, {
    login: "password", auth_url: `http://127.0.0.1:${kernelPort}`, auth_secret_file: SECRET, identity_key_file: KEY,
    accounts_file: join(secrets, "accounts.json"), my_apps: { host: "apps.example.com" },
    test_user: { email: EMAIL, apps: ["roadmap"] },
    test_listener: { address: "127.0.0.1", port: 0 },
    hosts: {
      [`roadmap.${CANARY_BASE}`]: { app: "roadmap", port: appPort },
      [`other.${CANARY_BASE}`]: { app: "other", port: appPort },
      "roadmap.example.com": { app: "roadmap", port: appPort },
      "other.example.com": { app: "other", port: appPort },
    },
  });
  writeFileSync(cfg.accounts_file, JSON.stringify({ accounts: [], apps: {} }));
  listener = createTestListener({ config: () => cfg, log: () => {} });
  lPort = await listen(listener);
  cfg.test_listener = { address: "127.0.0.1", port: lPort };
  gate = createGate({ config: () => ({ ...cfg, login: "password" }), log: () => {} });
  gatePort = await listen(gate);
});
after(() => { for (const s of [kernel.s, app, listener, gate]) { s.close(); s.closeAllConnections?.(); } });

/** One request to the test listener (or the gate), collecting the Set-Cookie values. */
const hit = (port: number, host: string, path: string, { method = "GET", cookie, headers = {} }: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; body: string; headers: any; cookies: string[] }>((ok, no) => {
    const q = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(cookie ? { cookie } : {}), ...headers } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => ok({ status: r.statusCode!, body, headers: r.headers, cookies: [r.headers["set-cookie"] ?? []].flat() as string[] }));
    });
    q.on("error", no);
    q.end(method === "POST" ? "{}" : undefined);
  });

test("the image ships every file the gate imports at runtime (main.ts's own imports included)", () => {
  // The gate runs the TypeScript directly: a module main.ts imports that the Dockerfile's COPY list omits is an image that
  // exits on start with ERR_MODULE_NOT_FOUND, taking ordinary app access down with it.
  const dir = new URL("..", import.meta.url).pathname;
  const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");
  const copied = new Set((dockerfile.match(/^COPY\s+([^\n]+?)\s+\.\/?$/gm) ?? []).flatMap((l) => l.trim().split(/\s+/).slice(1, -1)));
  const seen = new Set<string>(), queue = ["main.ts", "gate.ts"];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/from\s+"(\.\/[^"]+)"/g)) queue.push(m[1]!.replace(/^\.\//, ""));
  }
  for (const f of seen) assert.ok(copied.has(f), `${f} is imported at runtime but the Dockerfile doesn't copy it`);
});

test("with no settings.edge.test_user the capability is inert: nothing binds, and a bound listener serves no page", async () => {
  assert.equal(testListenerOn({ ...cfg, test_user: undefined }), false);
  assert.equal(testListenerOn({ ...cfg, test_listener: undefined }), false);
  assert.equal(testListenerOn(cfg), true);
  // Even if a listener were bound by hand, with the setting gone it answers 404 and never proxies.
  const bare: any = { ...cfg, test_user: undefined };
  const l = createTestListener({ config: () => bare, log: () => {} });
  const port = await listen(l);
  try {
    const r = await hit(port, `roadmap.${CANARY_BASE}`, "/");
    assert.equal(r.status, 404);
    assert.equal(r.body.trim(), "not found");
    assert.equal(appSeen.length, 0);
  } finally { l.close(); l.closeAllConnections?.(); }
});

test("a settings-only apply binds the listener when the test user appears and closes it when it goes, with no restart", async () => {
  let now: any = { ...cfg, test_user: undefined, test_listener: undefined };
  const rec = createTestListenerReconciler({ config: () => now, log: () => {} });
  const closed = (s: any) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections?.(); });
  rec.reconcile();
  assert.equal(rec.current(), undefined); // no setting: nothing bound at all
  now = { ...cfg, test_listener: { address: "127.0.0.1", port: 0 } };
  rec.reconcile();
  const bound = rec.current()!;
  await new Promise<void>((ok) => (bound.listening ? ok() : bound.once("listening", () => ok())));
  const port = (bound.address() as any).port;
  assert.ok(port > 0);
  try {
    // The same setting re-read is a no-op: one listener, not a second bind.
    rec.reconcile();
    assert.equal(rec.current(), bound);
    // The setting removed: the listener closes in place, and the port is dead.
    now = { ...cfg, test_user: undefined, test_listener: undefined };
    rec.reconcile();
    assert.equal(rec.current(), undefined);
    await new Promise((ok) => setTimeout(ok, 50));
    await assert.rejects(hit(port, `roadmap.${CANARY_BASE}`, "/"));
  } finally { await closed(bound).catch(() => undefined); }
});

test("a bind that fails before the bridge is up is retried, not remembered as serving", async () => {
  // The gate can be configured before the canary bridge exists: the first bind fails with EADDRNOTAVAIL, and a later
  // reconcile must try again rather than skip it because the address was already recorded.
  const logs: any[] = [];
  let now: any = { ...cfg, test_listener: { address: "10.99.99.99", port: 0 } };
  const rec = createTestListenerReconciler({ config: () => now, log: (o) => logs.push(o) });
  rec.reconcile();
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(rec.current(), undefined);
  assert.ok(logs.some((l) => l.msg === "test listener failed"));
  // Now the bridge exists (a loopback listener on a real address): the next pass binds it.
  now = { ...cfg, test_listener: { address: "127.0.0.1", port: 0 } };
  rec.reconcile();
  const bound = rec.current()!;
  try {
    await new Promise<void>((ok) => (bound.listening ? ok() : bound.once("listening", () => ok())));
    assert.ok(((bound.address() as any)?.port ?? 0) > 0);
  } finally {
    await new Promise<void>((ok) => { bound.close(() => ok()); bound.closeAllConnections?.(); });
  }
});

test("an unauthenticated browser gets 401 and no page; the front-door header and an anonymous request get nothing", async () => {
  for (const [host, headers] of [
    [`roadmap.${CANARY_BASE}`, {}],
    [`roadmap.${CANARY_BASE}`, { "x-aidenhq-edge": "forged", "x-aidenhq-gate": "forged", "cf-access-jwt-assertion": "forged" }],
  ] as const) {
    const r = await hit(lPort, host, "/", { headers: { ...headers } });
    assert.equal(r.status, 401);
    assert.equal(r.body.trim(), "sign in first");
    assert.deepEqual(r.cookies, []);
  }
  assert.equal(appSeen.length, 0);
  // Any other host is refused outright: no listener page for an app the setting doesn't name, or a host outside it.
  for (const host of [`other.${CANARY_BASE}`, "roadmap.example.com", "evil.example"]) assert.equal((await hit(lPort, host, "/")).status, 404, host);
});

test("the handoff redeems once and sets a host-only __Host- cookie on the listener's own origin", async () => {
  const state = "0123456789abcdef".repeat(2);
  const r = await hit(lPort, `roadmap.${CANARY_BASE}`, `/.auth/handoff?code=code-ok-0123456789&state=${state}&next=/intake`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/intake");
  const set = r.cookies.find((c) => c.startsWith(`${CANARY_COOKIE}=`));
  assert.ok(set, r.cookies.join("\n"));
  assert.match(set!, new RegExp(`^${CANARY_COOKIE}=${COOKIE.replace(/\./g, "\\.")}`));
  assert.match(set!, /; Path=\//);
  assert.match(set!, /; Secure/);
  assert.match(set!, /; HttpOnly/);
  assert.doesNotMatch(set!, /Domain=/i); // host-only: a sibling host never gets it
  assert.ok(set!.startsWith("__Host-"));
  // The same code again is spent.
  assert.equal((await hit(lPort, `roadmap.${CANARY_BASE}`, `/.auth/handoff?code=code-ok-0123456789&state=${state}`)).status, 401);
  // A bad state or a code the kernel refuses never sets a cookie.
  for (const path of ["/.auth/handoff?code=code-ok-0123456789&state=" + "s".repeat(32), "/.auth/handoff?code=wrong-code-0123456789&state=" + state, "/.auth/handoff?code=x&state=y"]) {
    const bad = await hit(lPort, `roadmap.${CANARY_BASE}`, path);
    assert.ok([400, 401].includes(bad.status), path);
    assert.equal(bad.cookies.filter((c) => c.startsWith(CANARY_COOKIE)).length, 0, path);
  }
});

test("a live test session serves the page as a member of its one app; the page's own notify is the gate's 204", async () => {
  const r = await hit(lPort, `roadmap.${CANARY_BASE}`, "/intake", { cookie: `${CANARY_COOKIE}=${COOKIE}` });
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>Roadmap<\/title>/);
  assert.equal(appSeen.at(-1)!.identity !== "", true);
  // The app verifies it exactly as its own middleware does: the gate's key, this app only, a person, a member.
  const who = createIdentity({ app: "roadmap", keysFile: join(secrets, "identity", "keys.json") }).identify({ method: "GET", url: "/intake", headers: { "x-aidenhq-identity": appSeen.at(-1)!.identity } });
  assert.deepEqual([who.role, who.email, who.kind], ["member", EMAIL, "person"]);
  // Its subject is its own namespace, never the one a real person with that email would get: an app keying records by
  // subject can never hand the canary someone else's.
  assert.match(who.sub, /^u_[A-Za-z0-9_-]{22}$/);
  assert.notEqual(who.sub, subOf(EMAIL));
  assert.throws(() => createIdentity({ app: "other", keysFile: join(secrets, "identity", "keys.json") }).identify({ method: "GET", url: "/intake", headers: { "x-aidenhq-identity": appSeen.at(-1)!.identity } }), /not for this app/);
  // The page's own POST /.aidenhq/notify reaches the kernel's app-feedback handler and answers 204, never the app.
  const before = appSeen.length;
  const n = await hit(lPort, `roadmap.${CANARY_BASE}`, "/.aidenhq/notify", { method: "POST", cookie: `${CANARY_COOKIE}=${COOKIE}`, headers: { origin: `http://roadmap.${CANARY_BASE}:${lPort}` } });
  assert.equal(n.status, 204);
  assert.equal(appSeen.length, before);
  assert.ok(kernel.seen.some((x) => x.path === "/.auth/api/app-feedback/new" && x.body.email === EMAIL && x.body.app === "roadmap"));
  // Cross-origin is refused.
  assert.equal((await hit(lPort, `roadmap.${CANARY_BASE}`, "/.aidenhq/notify", { method: "POST", cookie: `${CANARY_COOKIE}=${COOKIE}`, headers: { origin: "http://evil.example" } })).status, 403);
});

test("a session for one app is refused on another app's host, and the public app URL never accepts the canary cookie", async () => {
  // roadmap's cookie under other's host: the kernel says the session is another app's, so no page and no sign-in prompt.
  assert.equal((await hit(lPort, `other.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` })).status, 404);
  // The normal gate (the public app URL) does not accept the canary cookie: no session, no page.
  const front = await hit(gatePort, "roadmap.example.com", "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` });
  assert.ok([302, 401, 403].includes(front.status), String(front.status)); // the canary cookie is not a sign-in here
  assert.match(String(front.headers.location ?? ""), /\/\.auth\/go|sign-in/);
  assert.equal(appSeen.filter((x) => x.host === "roadmap.example.com").length, 0);
});

test("a revoked or expired session is 401 and no page; the app's own cookie is never taken", async () => {
  // The kernel says no (revoked, expired, task closed): the listener serves nothing.
  assert.equal((await hit(lPort, `roadmap.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` })).status, 200);
  kernel.state.live = false;
  try {
    assert.equal((await hit(lPort, `roadmap.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` })).status, 401);
    assert.equal((await hit(lPort, `roadmap.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=nope.signed` })).status, 401);
  } finally { kernel.state.live = true; }
  // A kernel that can't answer at all: never a page on an unchecked cookie, and a retryable 503 rather than a 401 that would
  // tell a live browser to sign in again mid-page.
  const deny = createTestListener({ config: () => ({ ...cfg, auth_url: "http://127.0.0.1:1" }), log: () => {} });
  const port = await listen(deny);
  try {
    assert.equal((await hit(port, `roadmap.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` })).status, 503);
  } finally { deny.close(); deny.closeAllConnections?.(); }
  // An app trying to plant the listener's own cookie has it stripped; its own cookies (a __Host- CSRF token included) pass,
  // as they do at the public gate, so a form's own check works on the canary.
  const plant = createServer((q, s) => s.writeHead(200, { "set-cookie": [`${CANARY_COOKIE}=planted; Path=/; Secure`, "__Host-csrf=app-token; Path=/; Secure", "theme=dark"] }).end("ok"));
  const plantPort = await listen(plant);
  // The upstream is the app's public entry, never the synthetic listener name: a decoy entry under `roadmap.canary.localhost`
  // pointing at another server is not what a page request reaches.
  const publicPort = cfg.hosts["roadmap.example.com"].port;
  cfg.hosts["roadmap.example.com"] = { app: "roadmap", port: plantPort };
  cfg.hosts[`roadmap.${CANARY_BASE}`] = { app: "roadmap", port: publicPort };
  try {
    const r = await hit(lPort, `roadmap.${CANARY_BASE}`, "/", { cookie: `${CANARY_COOKIE}=${COOKIE}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.cookies, ["__Host-csrf=app-token; Path=/; Secure", "theme=dark"]);
  } finally {
    cfg.hosts["roadmap.example.com"] = { app: "roadmap", port: publicPort };
    cfg.hosts[`roadmap.${CANARY_BASE}`] = { app: "roadmap", port: appPort };
    plant.close(); plant.closeAllConnections?.();
  }
});

// An event feed is an open HTTP response, not an upgrade: `server.close()` leaves it streaming. A session that ends, or an
// app that leaves the setting, must end it too, or it keeps delivering app data after access is gone.
test("an open event feed is cut when the app leaves the setting, and the browser loses it", async () => {
  const feed = createServer((q, s) => {
    s.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    s.write("data: one\n\n");
    const t = setInterval(() => s.write("data: tick\n\n"), 50);
    s.on("close", () => clearInterval(t));
  });
  const feedPort = await listen(feed);
  const c: any = { ...cfg, hosts: { "roadmap.example.com": { app: "roadmap", port: feedPort }, [`roadmap.${CANARY_BASE}`]: { app: "roadmap", port: feedPort } } };
  const l = createTestListener({ config: () => c, log: () => {} });
  const port = await listen(l);
  c.test_listener = { address: "127.0.0.1", port };
  try {
    const r = await new Promise<any>((ok) => {
      const q = request({ host: "127.0.0.1", port, path: "/feed", headers: { host: `roadmap.${CANARY_BASE}`, origin: `http://roadmap.${CANARY_BASE}:${port}`, cookie: `${CANARY_COOKIE}=${COOKIE}` } });
      q.on("response", (res) => ok(res));
      q.on("error", () => ok(null));
      q.end();
    });
    assert.ok(r && r.statusCode === 200, "the live feed is served to a live session");
    let data = "";
    r.on("data", (d) => (data += d));
    await new Promise((ok) => setTimeout(ok, 150));
    assert.match(data, /tick/, "it streams while access holds");
    // The app leaves settings.edge.test_user: the reconciler closes the feed, not just new connections.
    c.test_user = { email: EMAIL, apps: [] };
    const ended = new Promise<boolean>((ok) => { r.once("end", () => ok(true)); r.once("close", () => ok(true)); setTimeout(() => ok(false), 1500); });
    (l as any).closeTunnels?.((app: string) => Boolean(c.test_user?.apps.includes(app)));
    assert.equal(await ended, true);
  } finally {
    feed.closeAllConnections?.();
    feed.close();
    l.closeAllConnections?.();
    await new Promise<void>((ok) => l.close(() => ok()));
  }
});

test("a live tunnel is dropped when the test user is disabled, and server.close takes the rest", async () => {
  // A real upgraded socket through the listener: the fake app answers the upgrade and echoes one frame.
  const echo = createServer();
  echo.on("upgrade", (q, sock) => { sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); sock.on("data", (d) => sock.write(d)); });
  const echoPort = await listen(echo);
  // One roadmap entry, so entryOf resolves the echo server (the shared cfg's roadmap.example.com would come first).
  const c: any = { ...cfg, hosts: { "roadmap.example.com": { app: "roadmap", port: echoPort }, [`roadmap.${CANARY_BASE}`]: { app: "roadmap", port: echoPort } } };
  const logs: any[] = [];
  const l = createTestListener({ config: () => c, log: (o: any) => logs.push(o) });
  const port = await listen(l);
  c.test_listener = { address: "127.0.0.1", port };
  try {
    const open = () => new Promise<{ status: number; socket?: any }>((ok) => {
      const q = request({ host: "127.0.0.1", port, path: "/ws", headers: { host: `roadmap.${CANARY_BASE}`, connection: "Upgrade", upgrade: "websocket", origin: `http://roadmap.${CANARY_BASE}:${port}`, cookie: `${CANARY_COOKIE}=${COOKIE}` } });
      q.on("upgrade", (r, sock) => ok({ status: r.statusCode ?? 0, socket: sock }));
      q.on("response", (r) => ok({ status: r.statusCode ?? 0 }));
      q.on("error", () => ok({ status: 0 }));
      q.end();
    });
    const a = await open();
    assert.equal(a.status, 101, "a live session opens the tunnel");
    // The setting goes away while it is open: the reconciler's closeTunnels drops it (the tunnel is closure-scoped, so a
    // fresh listener is the same path a reconcile takes).
    const closed = new Promise<boolean>((ok) => { a.socket!.once("close", () => ok(true)); setTimeout(() => ok(false), 1000); });
    (l as any).closeTunnels?.();
    assert.equal(await closed, true);
  } finally {
    echo.close();
    await new Promise<void>((ok) => { l.close(() => ok()); l.closeAllConnections?.(); });
  }
});

// A tunnel outlives the request that opened it: without a re-check it would keep the app talking to the test member after the
// session is revoked or expires, long after every ordinary request would be 401.
test("an open tunnel loses the app's attempt at the session cookie, and the re-check closes it once its session is gone", async () => {
  const echo = createServer();
  const planted: string[] = [];
  echo.on("upgrade", (q, sock) => {
    const cookie = [`${CANARY_COOKIE}=app-planted; Path=/; Secure`, "__Host-csrf=app-token; Path=/; Secure"];
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: ${cookie[0]}\r\nSet-Cookie: ${cookie[1]}\r\n\r\n`);
    sock.on("data", (d) => sock.write(d));
  });
  const echoPort = await listen(echo);
  const c: any = { ...cfg, hosts: { "roadmap.example.com": { app: "roadmap", port: echoPort }, [`roadmap.${CANARY_BASE}`]: { app: "roadmap", port: echoPort } } };
  const l = createTestListener({ config: () => c, log: () => {} });
  const port = await listen(l);
  c.test_listener = { address: "127.0.0.1", port };
  try {
    const open = () => new Promise<{ status: number; socket?: any; headers?: any }>((ok) => {
      const q = request({ host: "127.0.0.1", port, path: "/ws", headers: { host: `roadmap.${CANARY_BASE}`, connection: "Upgrade", upgrade: "websocket", origin: `http://roadmap.${CANARY_BASE}:${port}`, cookie: `${CANARY_COOKIE}=${COOKIE}` } });
      q.on("upgrade", (r, sock) => ok({ status: r.statusCode ?? 0, socket: sock, headers: r.headers }));
      q.on("response", (r) => ok({ status: r.statusCode ?? 0 }));
      q.on("error", () => ok({ status: 0 }));
      q.end();
    });
    const a = await open();
    assert.equal(a.status, 101);
    // The app's own cookie passes the handshake; its attempt at the listener's cookie does not.
    const setCookie = [a.headers["set-cookie"] ?? []].flat();
    assert.deepEqual(setCookie, ["__Host-csrf=app-token; Path=/; Secure"]);
    // The kernel now says the session is gone: the next re-check closes the open tunnel instead of leaving it writing to the app.
    kernel.state.live = false;
    const closed = new Promise<boolean>((ok) => { a.socket!.once("close", () => ok(true)); setTimeout(() => ok(false), 1500); });
    await (l as any).recheckTunnels?.();
    assert.equal(await closed, true);
  } finally {
    kernel.state.live = true;
    echo.close();
    await new Promise<void>((ok) => { l.close(() => ok()); l.closeAllConnections?.(); });
  }
});

test("a WebSocket upgrade needs the listener's own origin and a live session, and is never forwarded otherwise", async () => {
  const ask = (origin: string | undefined, cookie?: string) => new Promise<string>((ok) => {
    const headers: Record<string, string> = { host: `roadmap.${CANARY_BASE}`, connection: "Upgrade", upgrade: "websocket" };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const q = request({ host: "127.0.0.1", port: lPort, path: "/ws", headers });
    q.on("upgrade", (r) => ok(`upgraded ${r.statusCode}`));
    q.on("response", (r) => ok(String(r.statusCode)));
    q.on("error", (e) => ok(`error ${(e as Error).message}`));
    q.end();
  });
  const before = appSeen.length;
  // Another site's socket is refused before the session is even read.
  assert.equal(await ask("http://evil.example"), "403");
  // The right origin but no session: 401, and nothing reaches the app.
  assert.equal(await ask(`http://roadmap.${CANARY_BASE}:${lPort}`), "401");
  assert.equal(appSeen.length, before, "no upgrade reaches the app without a live session");
});

// The app may answer a handshake slowly. If the browser is gone by then, its upstream request must be cancelled: the app's
// socket sees the connection end, and a late 101 never becomes a tunnel the listener has stopped tracking.
test("a browser that leaves mid-handshake cancels the upstream upgrade, so no app socket stays open unowned", async () => {
  const slow = createServer();
  const seen: { ended: boolean; sock: any }[] = [];
  slow.on("upgrade", (q, sock) => {
    const rec = { ended: false, sock };
    seen.push(rec);
    sock.on("error", () => {});
    sock.on("end", () => { rec.ended = true; });
    sock.on("close", () => { rec.ended = true; });
    // Answer only after the browser has gone: a tunnel opened now would outlive its session.
    setTimeout(() => { if (!sock.destroyed) sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); }, 250).unref?.();
  });
  const slowPort = await listen(slow);
  const c: any = { ...cfg, hosts: { "roadmap.example.com": { app: "roadmap", port: slowPort }, [`roadmap.${CANARY_BASE}`]: { app: "roadmap", port: slowPort } } };
  const l = createTestListener({ config: () => c, log: () => {} });
  const port = await listen(l);
  c.test_listener = { address: "127.0.0.1", port };
  try {
    const q = request({ host: "127.0.0.1", port, path: "/ws", headers: { host: `roadmap.${CANARY_BASE}`, connection: "Upgrade", upgrade: "websocket", origin: `http://roadmap.${CANARY_BASE}:${port}`, cookie: `${CANARY_COOKIE}=${COOKIE}` } });
    q.on("error", () => {});
    q.on("upgrade", () => {});
    q.end();
    // The browser times out: its socket goes before the app answers.
    await new Promise((ok) => setTimeout(ok, 40));
    q.destroy();
    await new Promise((ok) => setTimeout(ok, 700));
    assert.ok(seen.length > 0, "the app got the handshake");
    for (const r of seen) assert.equal(r.ended, true, "its socket ended with the browser, never left open unowned");
  } finally {
    for (const r of seen) r.sock.destroy();
    slow.closeAllConnections?.();
    slow.close();
    (l as any).closeTunnels?.();
    l.closeAllConnections?.();
    await new Promise<void>((ok) => l.close(() => ok()));
  }
});
