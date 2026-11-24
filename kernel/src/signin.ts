// The gate-facing sign-in listener (127.0.0.1:3129; docs/design/access.md, App login modes; lean 3g: here, beside the one
// opener of the accounts file, instead of the board). Loopback only; the gate (host network) serves the sign-in pages itself
// on the my-apps host, passes an allowlist of Better Auth's steps through to here, and calls the rest itself.
//   Better Auth:   /.auth/api/{sign-in/email, two-factor/verify-totp, reset-password, sign-out, get-session}
//   Handoff:       /.auth/api/handoff/mint {host, state} (the gate, with the sign-in host's session cookie) → a single-use
//                  code for one app host; /.auth/api/handoff/redeem {code, host, state} → a new session's cookie value for
//                  that host, linked to the sign-in host's session; /.auth/api/handoff/revoke (an app host session's cookie)
//                  → that session ends. All server-side only, under the listener's own names: the gate never forwards them.
//   App access:    /.auth/api/app-access/{page, role, default} (the gate, server-side, with gate_board_secret and the asking
//                  email as `by`): an app's roles, default and log, for its admins (AidenHQ admins are admins of every app).
//   Test user:     /.auth/api/test-session/{check, redeem} (the gate's test listener, server-side, with gate_board_secret): a
//                  canary cookie → its live session, and a one-time handoff code → that session's cookie. Both refuse with no
//                  settings.edge.test_user; the listener itself is the gate's, never this one.
//   Requests:      /.auth/api/app-request/{new, mine}, /.auth/api/app-feedback/new (the gate, with the visitor's verified
//                  email): in-app requests.
// No admin route is here: no page, no approval, no account admin.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { AccountError, type Accounts, type GateInfo } from "./accounts.ts";
import { TestSessionError } from "./test-session.ts";
import { AccessError } from "../../modules/apps-platform/src/app-access.ts";
import { forwardedProto, type Log } from "./auth-rules.ts";

const HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Better Auth's endpoints here (the gate passes on only the first four, and calls get-session itself). */
const BETTER_AUTH = new Set(["/sign-in/email", "/two-factor/verify-totp", "/reset-password", "/sign-out", "/get-session"]);
const APP = /^[a-z][a-z0-9-]{1,30}$/;
const STATE = (v: unknown) => typeof v === "string" && v.length >= 16 && v.length <= 256;

/**
 * A browser request the gate passed on: a known Host, and a write is JSON from exactly the request's own origin (the
 * scheme from X-Forwarded-Proto). The gate strips every x-aidenhq-* header a client sends; a write without an Origin is refused.
 */
function browserCheck(req: IncomingMessage, hosts: string[]): string | undefined {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!hosts.includes(host)) return "unknown host";
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return "JSON only";
  const origin = req.headers.origin;
  if (!origin) return "no origin";
  if (origin === "null") return "opaque origin";
  try {
    if (new URL(origin).origin !== new URL(`${forwardedProto(req)}://${host}`).origin) return "cross-origin";
  } catch {
    return "bad origin";
  }
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) return "cross-site";
  return undefined;
}

/** A JSON object with exactly these fields, each passing its check (else a 400). */
function fields<T extends Record<string, (v: unknown) => boolean>>(input: unknown, shape: T, optional: string[] = []): { [K in keyof T]: any } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountError(400, "bad request");
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in shape)) throw new AccountError(400, "bad request");
  for (const [k, ok] of Object.entries(shape)) if (!(k in o ? ok(o[k]) : optional.includes(k))) throw new AccountError(400, "bad request");
  return o as { [K in keyof T]: any };
}
const str = (min: number, max: number) => (v: unknown) => typeof v === "string" && v.length >= min && v.length <= max;
const trimmed = (min: number, max: number) => (v: unknown) => typeof v === "string" && v.trim().length >= min && v.length <= max;
const app = (v: unknown) => typeof v === "string" && APP.test(v);
const role = app;

export function createSignin(o: { accounts: Accounts; hosts: string[]; gate: () => GateInfo | undefined; log: Log }): RequestListener {
  const text = (res: ServerResponse, status: number, body: string, type: string) => res.writeHead(status, { ...HEADERS, "content-type": type }).end(body);
  const json = (res: ServerResponse, status: number, body: unknown) => text(res, status, JSON.stringify(body), "application/json");

  async function body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) if (chunks.push(c as Buffer) > 16) throw new AccountError(413, "too large");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw new AccountError(400, "invalid JSON");
    }
  }

  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://signin");
    } catch {
      return text(res, 400, "bad request", "text/plain");
    }
    const path = url.pathname;
    if (path === "/healthz") return text(res, 200, "ok", "text/plain");
    try {
      // The gate's server-side handoff calls (never proxied): only under the listener's own names, so no browser checks apply.
      if (["/.auth/api/handoff/mint", "/.auth/api/handoff/redeem", "/.auth/api/handoff/revoke"].includes(path)) {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!o.hosts.includes(String(req.headers.host ?? "").toLowerCase())) return json(res, 403, { error: "unknown host" });
        if (path.endsWith("/mint")) {
          const { host, state } = fields(await body(req), { host: str(1, 253), state: STATE });
          return json(res, 200, await o.accounts.mintHandoff(req, host, state));
        }
        if (path.endsWith("/revoke")) {
          const { host } = fields(await body(req), { host: str(1, 253) });
          return json(res, 200, await o.accounts.revokeHostSession(req, host));
        }
        const { code, host, state } = fields(await body(req), { code: str(16, 100), host: str(1, 253), state: STATE });
        return json(res, 200, await o.accounts.redeemHandoff(code, host, state));
      }
      // App access and in-app requests (spec 2026-11-12-app-access-rbac-design.md): the gate, server-side, with its shared
      // secret, names who is asking (`by` / `email`, the email it signed in or verified through Access); the kernel checks the
      // rest (an app admin for the Access page; a member who isn't blocked for a request).
      if (path.startsWith("/.auth/api/test-session/")) {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!o.hosts.includes(String(req.headers.host ?? "").toLowerCase()) || !o.accounts.fromGate(req)) return json(res, 403, { error: "only the gate" });
        const input = await body(req);
        if (path === "/.auth/api/test-session/check") {
          const f = fields(input, { cookie: str(1, 1024), host: str(1, 253) });
          try {
            const r = await o.accounts.test.check({ cookie: f.cookie, host: f.host });
            return json(res, r ? 200 : 401, r ?? { error: "no test session" });
          } catch (e) {
            if (e instanceof TestSessionError) return json(res, e.status, { error: e.message });
            throw e;
          }
        }
        const f = fields(input, { code: str(16, 200), host: str(1, 253), state: STATE });
        return json(res, 200, await o.accounts.test.redeem({ code: f.code, host: f.host, state: f.state }));
      }
      if (path.startsWith("/.auth/api/app-access/") || path.startsWith("/.auth/api/app-request/") || path === "/.auth/api/app-feedback/new") {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!o.hosts.includes(String(req.headers.host ?? "").toLowerCase()) || !o.accounts.fromGate(req)) return json(res, 403, { error: "only the gate" });
        const email = str(0, 200);
        const input = await body(req);
        const apps = o.accounts.apps;
        switch (path.slice("/.auth/api/".length)) {
          case "app-access/page": {
            const f = fields(input, { by: email, app });
            return json(res, 200, apps.page(f.by, f.app));
          }
          case "app-access/role": {
            const f = fields(input, { by: email, app, email, role: (v) => v === null || role(v) });
            return json(res, 200, await apps.assign(f.by, f.app, f.email, f.role));
          }
          case "app-access/default": {
            const f = fields(input, { by: email, app, role });
            return json(res, 200, await apps.setDefault(f.by, f.app, f.role));
          }
          case "app-request/new": {
            const f = fields(input, { email, app, text: trimmed(1, 4000), context: str(0, 500) }, ["context"]);
            return json(res, 200, apps.request(f.app, f.email, f.text.trim(), f.context));
          }
          case "app-feedback/new": {
            const f = fields(input, { email, app });
            return json(res, 200, apps.notify(f.app, f.email));
          }
          case "app-request/mine": {
            const f = fields(input, { email, app });
            return json(res, 200, { requests: apps.mine(f.app, f.email) });
          }
        }
        return json(res, 404, { error: "not found" });
      }
      // The listener's own names (the gate's server-side calls) and the sign-in host its steps are passed on under.
      const gate = o.gate();
      const hosts = [...o.hosts, ...(gate?.myAppsHost ? [gate.myAppsHost] : [])];
      const rejected = browserCheck(req, hosts);
      if (rejected) {
        o.log.warn({ method: req.method, path, reason: rejected }, "sign-in request rejected");
        return json(res, 403, { error: rejected });
      }
      // An app host session whose sign-in host session ended is no session.
      if (path === "/.auth/api/get-session" && req.method === "GET") return json(res, 200, await o.accounts.gateSession(req, o.hosts[0] ?? "", String(req.headers["x-forwarded-host"] ?? "")));
      // Signing out here ends the app host sessions handed off from this one too.
      if (path === "/.auth/api/sign-out" && req.method === "POST") await o.accounts.endHandedOff(req);
      if (path.startsWith("/.auth/api/") && BETTER_AUTH.has(path.slice("/.auth/api".length)))
        // Better Auth sees the listener's own host; the browser's Origin (the sign-in host) is one of its trusted origins.
        return await o.accounts.handle(req, res, path.slice("/.auth/api".length), url.search, o.hosts[0]);
      return json(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof AccountError || err instanceof AccessError || err instanceof TestSessionError ? err.status : 500;
      if (status >= 500) o.log.error({ err: String((err as Error).message ?? err).slice(0, 300), path }, "sign-in request failed");
      if (!res.headersSent) json(res, status, { error: (err as Error).message ?? "error" });
    }
  };
}
