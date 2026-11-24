// The test-user page canary's listener (docs/design/access.md, Test-user sign-in): the one door a headless browser reaches
// without a person. It is deliberately not the gate:
//
// - It listens on its own address (settings.edge.test_listener: a bridge gateway only the canary browser's network reaches),
//   never on the gate's port, the front door's socket or the tailnet address. With no settings.edge.test_user nothing binds it.
// - It serves nothing without a live test session. No front-door header, no Access token, no anonymous request: a request
//   without the listener's own cookie gets 401 and no page.
// - The cookie is host-only (`__Host-`) on the listener's own origin, per app: `<app>.canary.localhost`. A session for one app
//   presented under another app's host is refused, and the cookie never reaches the app's public URL (a different host).
// - Every request's identity is the test user as a `member` of that one app, minted per request by the gate's own signer; the
//   page's own JavaScript runs, and its own same-origin `POST /.aidenhq/notify` is the gate's real notify handler.
//
// The cookie is checked with the kernel's session check through the sign-in listener's gate secret (no new shared secret), and
// the handoff code is redeemed there once. Nothing here is trusted from the browser but the cookie it was given.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { IDENTITY_HEADER, hostOf, mint, sameOrigin, signerFor, subOf, upstreamHeaders, type GateConfig, type IdentityClaims, type IdentityToken, type VerifiedEmail } from "./gate.ts";

/** The listener's own host suffix: an origin Chrome treats as secure over plain http, and one the front door never names. */
export const CANARY_BASE = "canary.localhost";
/** The listener's one cookie: host-only, and never accepted by the gate, the front door or the sign-in host. */
export const CANARY_COOKIE = "__Host-aidenhq-canary.session";
const APP = /^([a-z][a-z0-9-]{1,30})\.canary\.localhost$/;
const CODE = /^[A-Za-z0-9_-]{16,200}$/;
const STATE = /^[0-9a-f]{32}$/;
const IDENTITY_TTL_S = 300;
const RESERVED = "/.aidenhq";
const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
const STRIP = /^(x-aidenhq-|tailscale-|cf-access-)/;

export interface TestListenerDeps {
  config: () => GateConfig;
  fetch?: typeof fetch;
  log?: (o: Record<string, unknown>) => void;
}

const cookiesOf = (req: IncomingMessage) => String(req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter(Boolean);
const cookieName = (c: string) => c.split("=")[0]!.trim();

/**
 * The listener. It exists only with both settings; with either missing, `listen` returns undefined and nothing is bound.
 */
export function createTestListener({ config, fetch: fetchImpl = fetch, log = (o) => console.log(JSON.stringify(o)) }: TestListenerDeps): Server {
  const cfg = () => config();
  const gateSecret = (c: GateConfig) => {
    try { return c.auth_secret_file ? readFileSync(c.auth_secret_file, "utf8").trim() : ""; } catch { return ""; }
  };
  const plain = (res: ServerResponse, status: number, msg: string, headers: OutgoingHttpHeaders = {}) =>
    void res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers }).end(`${msg}\n`);
  const json = (res: ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" }).end(JSON.stringify(body));

  /** One call to the kernel's sign-in listener, with the gate's own secret (the same one password mode uses). */
  async function kernel(c: GateConfig, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const secret = gateSecret(c);
    const r = await fetchImpl(new URL(path, c.auth_url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...(secret ? { "x-aidenhq-gate": secret } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await r.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  }

  /** The session behind one cookie value, a refusal (401/409), or "down" when the kernel could not answer. */
  async function sessionOf(c: GateConfig, cookie: string, app: string, host: string): Promise<{ email: VerifiedEmail; expires: string } | "other-app" | "down" | undefined> {
    if (!cookie) return undefined;
    // A kernel that can't answer is not "signed out": fail closed, but say so with 503 so a retryable blip during a page's
    // own subresources never tells the browser to sign in again (which would throw away a live session mid-page).
    const r = await kernel(c, "/.auth/api/test-session/check", { cookie, host }).catch(() => ({ status: 503, body: null }));
    // A live session for another app is its own refusal (404: there is no page for it here), never a sign-in prompt.
    if (r.status === 409) return "other-app";
    if (r.status >= 500 || r.status === 0) return "down";
    if (r.status !== 200 || typeof r.body?.email !== "string" || r.body?.app !== app) return undefined;
    return { email: String(r.body.email).trim().toLowerCase() as VerifiedEmail, expires: String(r.body.expires ?? "") };
  }

  /** The session behind this request's cookie, exactly one, or a refusal/"down". */
  function session(req: IncomingMessage, c: GateConfig, app: string, host: string) {
    const found = cookiesOf(req).filter((x) => cookieName(x) === CANARY_COOKIE);
    if (found.length !== 1) return Promise.resolve(undefined);
    return sessionOf(c, found[0]!.slice(CANARY_COOKIE.length + 1).trim(), app, host);
  }

  /** The app's own origin on this listener, exactly. */
  const originOf = (c: GateConfig, app: string) => `http://${app}.${CANARY_BASE}${c.test_listener?.port ? `:${c.test_listener.port}` : ""}`;
  /**
   * The app's one entry in the compiled config: its public host and its upstream port, resolved together. The kernel's
   * session and handoff are bound to that public host, while the cookie is host-only on this listener's origin; both name the
   * same one app, so a session for one app is never another's. A door is not an app entry (and a module door must never be
   * reachable this way), and the synthetic `<app>.canary.localhost` name is this listener's own, never an upstream.
   */
  const entryOf = (c: GateConfig, app: string) =>
    Object.entries(c.hosts ?? {}).find(([h, x]) => x.app === app && !x.door && h !== `${app}.${CANARY_BASE}`);

  /** The app this request names, its one compiled entry and the listener's origin for it; undefined refuses with 404. */
  function target(c: GateConfig, host: string | undefined) {
    const m = APP.exec(String(host ?? ""));
    if (!m) return undefined;
    const app = m[1]!;
    if (!c.test_user?.apps.includes(app)) return undefined;
    const entry = entryOf(c, app);
    const site = entry?.[1];
    const publicHost = entry?.[0];
    if (!site || !publicHost) return undefined;
    return { app, site, publicHost, origin: originOf(c, app) };
  }

  async function serve(req: IncomingMessage, res: ServerResponse) {
    const c = cfg();
    // Fail closed: with no test user there is nothing this listener may serve, whatever it was asked.
    if (!c.test_user || !c.test_listener) return plain(res, 404, "not found");
    const t = target(c, hostOf(req));
    if (!t) return plain(res, 404, "not found");
    const { app, site, publicHost, origin } = t;
    const url = new URL(String(req.url ?? "/"), "http://x");
    const path = url.pathname;

    // The handoff: redeem the one-time code with the kernel, then set this origin's host-only cookie.
    if (path === "/.auth/handoff" && (req.method === "GET" || req.method === "HEAD")) {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (!CODE.test(code) || !STATE.test(state)) return plain(res, 400, "bad request");
      const r = await kernel(c, "/.auth/api/test-session/redeem", { code, host: publicHost, state });
      // A backend failure is not a spent code: 503 so the browser may retry, and only a real refusal says used or expired.
      if (r.status >= 500 || r.status === 0) {
        log({ msg: "test handoff unavailable", app, status: r.status });
        return plain(res, 503, "unavailable: try again");
      }
      if (r.status !== 200 || typeof r.body?.token !== "string") {
        log({ msg: "test handoff refused", app, status: r.status });
        return plain(res, 401, "this sign-in is used or expired");
      }
      const next = url.searchParams.get("next") ?? "/";
      const safe = next.startsWith("/") && !next.startsWith("//") && !/[\x00-\x20\\]/.test(next) ? next : "/";
      return plain(res, 302, "signed in", {
        location: safe,
        "set-cookie": [`${CANARY_COOKIE}=${r.body.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`],
      });
    }

    const who = await session(req, c, app, publicHost);
    if (who === "other-app") return plain(res, 404, "not found");
    if (who === "down") return plain(res, 503, "unavailable: the session may still be valid; try again");
    if (!who) return plain(res, 401, "sign in first");

    // The gate's own path on an app host, as the gate serves it: the page says people sent something into the app's intake.
    if (path === RESERVED || path.startsWith(`${RESERVED}/`)) {
      if (req.method !== "POST" || path !== `${RESERVED}/notify`) return plain(res, 404, "not found");
      if (!sameOrigin(req, origin)) return plain(res, 403, "forbidden: cross-origin");
      req.resume();
      const r = await kernel(c, "/.auth/api/app-feedback/new", { email: who.email, app });
      return void res.writeHead(r.status === 200 ? 204 : r.status >= 500 ? 503 : r.status, { "cache-control": "no-store" }).end();
    }
    // A write or an upgrade needs the listener's own origin, exactly (as the gate does for an app host).
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req, origin)) return plain(res, 403, "forbidden: cross-origin");

    // The app's identity for this request: the test user, a member of this app only, minted by the gate's own key.
    let token: IdentityToken;
    try {
      const iat = Math.floor(Date.now() / 1000);
      const claims: IdentityClaims = { iss: "aidenhq-gate", aud: app, sub: subOf(who.email), kind: "person", email: who.email, name: "AidenHQ test user", role: "member", idp: "test", iat, exp: iat + IDENTITY_TTL_S };
      token = mint(signerFor(c.identity_key_file)(), claims);
    } catch (e) {
      log({ msg: "can't sign a test identity", app, err: String((e as Error).message) });
      return plain(res, 503, "unavailable");
    }
    const headers: OutgoingHttpHeaders = upstreamHeaders(req, token, { proto: "http" });
    // The token just minted is the only x-aidenhq-* the app may see; everything else of that shape came from the browser.
    for (const k of Object.keys(headers)) if (STRIP.test(k) && k.toLowerCase() !== IDENTITY_HEADER) delete headers[k];
    const up = httpRequest({ host: "127.0.0.1", port: site.port, method: req.method, path: req.url, headers });
    up.on("response", (r) => {
      const h = { ...r.headers };
      for (const k of HOP) delete h[k];
      delete h["set-auth-token"];
      // No app may set the listener's own session cookie: only the handoff sets that one. The app's other cookies (its own
      // __Host- CSRF token, say) pass through as they do at the public gate, so a form's own check works here too.
      if (h["set-cookie"]) {
        const kept = [h["set-cookie"]].flat().filter((x) => cookieName(x).toLowerCase() !== CANARY_COOKIE.toLowerCase());
        if (kept.length) h["set-cookie"] = kept;
        else delete h["set-cookie"];
      }
      res.writeHead(r.statusCode ?? 502, r.statusMessage, h);
      // A body the app cuts short ends the browser's response too, rather than leaving it half-written.
      r.on("error", () => res.destroy());
      r.pipe(res);
    });
    // A body cut short (the app restarted mid-response) closes the browser's response, so the canary fails now rather than
    // waiting out its own timeout for a body that will never finish.
    up.on("error", () => (res.headersSent ? res.destroy() : plain(res, 502, "bad gateway")));
    res.on("close", () => up.destroy());
    req.pipe(up);
  }

  /**
   * Open WebSocket tunnels: the app, host and cookie each was opened with, and the timer that ends it at the session's own
   * expiry. A tunnel is a long-lived connection, so the session that opened it is re-checked (on a timer and at expiry), not
   * trusted for as long as the socket lives.
   */
  type Tunnel = { app: string; host: string; cookie: string; until?: NodeJS.Timeout };
  const sockets = new Map<Duplex, Tunnel>();
  const drop = (s: Duplex) => {
    const t = sockets.get(s);
    if (t?.until) clearTimeout(t.until);
    sockets.delete(s);
    s.destroy();
  };
  /** Re-check every open tunnel's session; one that is no longer live is dropped now, never left riding an old session. */
  const recheck = async () => {
    let c: GateConfig;
    try { c = cfg(); } catch { return; }
    for (const [s, t] of sockets) {
      const who = await sessionOf(c, t.cookie, t.app, t.host).catch(() => "down" as const);
      // "down" keeps it (the kernel could not answer, so nothing says the session ended); a refusal or another app's answer
      // ends it now.
      if (!who || who === "other-app") drop(s);
    }
  };
  const RECHECK_MS = 60_000;
  let ticker: NodeJS.Timeout | undefined;
  const server = createServer((req, res) => {
    serve(req, res).catch((e) => {
      log({ msg: "test listener request failed", err: String((e as Error).message).slice(0, 300) });
      if (res.headersSent) res.destroy();
      else plain(res, 503, "unavailable");
    });
  });

  // A page's own WebSocket (a live feedback box, say) upgrades the connection, which `createServer`'s request handler never
  // sees. The gate proxies one through the same checks; so does this listener, with the same session and the same per-request
  // identity, so a canary page behaves as it does for a signed-in person and never gets a raw socket without a session.
  const refuse = (socket: Duplex, status: number, msg: string) =>
    void socket.end(`HTTP/1.1 ${status} ${{ 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 503: "Service Unavailable" }[status] ?? "Error"}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${msg.length + 1}\r\n\r\n${msg}\n`);
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    // A tunnel outlives the request that opened it and `server.close()` does not close it: it is tracked here so the
    // reconciler can drop every one when the test user (or the listener) goes away, rather than riding an old session.
    sockets.set(socket, { app: "", host: "", cookie: "" }); // filled once the request's host and session resolve, just below
    socket.on("close", () => sockets.delete(socket));
    const c = cfg();
    if (!c.test_user || !c.test_listener) return refuse(socket, 404, "not found");
    const t = target(c, hostOf(req));
    if (!t) return refuse(socket, 404, "not found");
    sockets.set(socket, { app: t.app, host: t.publicHost, cookie: cookiesOf(req).find((x) => cookieName(x) === CANARY_COOKIE)?.slice(CANARY_COOKIE.length + 1).trim() ?? "" });
    // Same checks as a write: the exact origin, never a cross-site socket, and the listener's own live session.
    if (!sameOrigin(req, t.origin)) return refuse(socket, 403, "forbidden: cross-origin");
    const who = await session(req, c, t.app, t.publicHost);
    if (who === "other-app") return refuse(socket, 404, "not found");
    if (who === "down") return refuse(socket, 503, "unavailable: the session may still be valid; try again");
    if (!who) return refuse(socket, 401, "sign in first");
    // A tunnel never outlives the session that opened it: at its expiry the socket closes, even while the listener and the
    // app's setting are unchanged. A minute timer re-checks the rest (a revoke, a closed task), so none rides an old session.
    const left = Date.parse(who.expires) - Date.now();
    if (Number.isFinite(left)) {
      if (left <= 0) return refuse(socket, 401, "sign in first");
      sockets.get(socket)!.until = setTimeout(() => drop(socket), Math.min(left, 2 ** 31 - 1));
    }
    ticker ??= setInterval(() => void recheck(), RECHECK_MS).unref();
    let token: IdentityToken;
    try {
      const iat = Math.floor(Date.now() / 1000);
      const claims: IdentityClaims = { iss: "aidenhq-gate", aud: t.app, sub: subOf(who.email), kind: "person", email: who.email, name: "AidenHQ test user", role: "member", idp: "test", iat, exp: iat + IDENTITY_TTL_S };
      token = mint(signerFor(c.identity_key_file)(), claims);
    } catch (e) {
      log({ msg: "can't sign a test identity", app: t.app, err: String((e as Error).message) });
      return refuse(socket, 503, "unavailable");
    }
    const headers = upstreamHeaders(req, token, { upgrade: true, proto: "http" });
    for (const k of Object.keys(headers)) if (STRIP.test(k) && k.toLowerCase() !== IDENTITY_HEADER) delete headers[k];
    const up = httpRequest({ host: "127.0.0.1", port: t.site.port, method: req.method, path: req.url, headers });
    up.on("upgrade", (r, usock, uhead) => {
      usock.on("error", () => socket.destroy());
      usock.on("close", () => socket.destroy());
      socket.on("close", () => usock.destroy());
      let s2 = `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n`;
      // The same cookie rule as an ordinary response: no app may replace or clear the listener's own session cookie on a
      // handshake either, so its own cookies (a CSRF token) pass and that one never lands.
      const cookies = (r.headers["set-cookie"] ?? []).filter((x) => cookieName(x).toLowerCase() !== CANARY_COOKIE.toLowerCase());
      for (let i = 0; i < r.rawHeaders.length; i += 2) {
        const k = r.rawHeaders[i]!;
        if (k.toLowerCase() === "set-auth-token" || k.toLowerCase() === "set-cookie") continue;
        s2 += `${k}: ${r.rawHeaders[i + 1]}\r\n`;
      }
      for (const x of cookies) s2 += `set-cookie: ${x}\r\n`;
      socket.write(`${s2}\r\n`);
      if (uhead.length) socket.write(uhead);
      if (head.length) usock.write(head);
      usock.pipe(socket).pipe(usock);
    });
    up.on("response", (r) => { // the app declined the upgrade: pass its status on, nothing more
      r.resume();
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    up.on("error", () => socket.destroy());
    up.end();
  };
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(req, socket, head).catch((e) => {
      log({ msg: "test listener upgrade failed", err: String((e as Error).message).slice(0, 300) });
      socket.destroy();
    });
  });
  // The reconciler closes the tunnels with the listener: `server.close()` leaves an upgraded socket open.
  return Object.assign(server, {
    closeTunnels: (allowed?: (app: string) => boolean) => {
      for (const [s, t] of sockets) if (!allowed || !allowed(t.app)) drop(s);
    },
    /** The timer's own check, for tests: the same one the minute ticker runs. */
    recheckTunnels: recheck,
  });
}

/** Whether this build's settings let the listener bind at all (both the test user and its address). */
export const testListenerOn = (c: GateConfig) => Boolean(c.test_user && c.test_listener);

/**
 * Keeps the listener in step with the compiled config: bound exactly while settings.edge.test_user and its address are both
 * set. The gate's config is re-read on every change, so a settings-only apply that turns the test user on binds it then (no
 * restart needed), and one that turns it off closes it. With no test user nothing is ever bound.
 */
export function createTestListenerReconciler({ config, log = (o) => console.log(JSON.stringify(o)) }: { config: () => GateConfig; log?: (o: Record<string, unknown>) => void }) {
  let server: Server | undefined;
  let at = "";
  const reconcile = () => {
    let c: GateConfig | undefined;
    try {
      c = config();
    } catch (e) {
      // No readable config at all: nothing may be served, so the listener closes rather than outliving the policy it was
      // bound under (a torn write is tolerated by the reader; this is a missing or unreadable file).
      log({ msg: "test listener closed: gate config unreadable", err: String((e as Error).message) });
    }
    const want = c && testListenerOn(c) ? c.test_listener! : undefined;
    const key = want ? `${want.address}:${want.port}` : "";
    // An app removed from settings.edge.test_user keeps no open tunnel either, even while the listener stays on its address.
    (server as (Server & { closeTunnels?: (allowed?: (app: string) => boolean) => void }) | undefined)?.closeTunnels?.((app) => Boolean(c?.test_user?.apps.includes(app)));
    if (key === at) return;
    if (server) {
      (server as Server & { closeTunnels?: () => void }).closeTunnels?.();
      server.close();
      server = undefined;
      log({ msg: "test listener closed", address: at });
    }
    at = key;
    if (!want) return;
    const s = createTestListener({ config, log });
    server = s;
    // A bind that fails (the bridge isn't up yet, the port is taken) is retried: `at` is cleared, so the next reconcile binds
    // again rather than treating the dead listener as the one serving.
    const failed = (e: Error) => {
      log({ msg: "test listener failed", address: key, err: e.message });
      if (server !== s) return;
      server = undefined;
      at = "";
      s.close();
    };
    s.once("error", failed);
    s.listen(want.port, want.address, () => {
      s.off("error", failed);
      s.on("error", (e) => log({ msg: "test listener failed", address: at, err: (e as Error).message }));
      log({ msg: "test listener listening", address: want.address, port: want.port });
    });
  };
  return { reconcile, current: () => server };
}
