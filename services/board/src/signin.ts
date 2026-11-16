// The gate-facing sign-in listener (3129; docs/design/access.md, App login modes). Published on
// 127.0.0.1 only; the gate (host network) proxies an allowlist of it on the my-apps host and calls the rest itself.
//   Pages (GET):   /.auth/sign-in, /.auth/two-factor, /.auth/set-password; assets /.auth/assets/*
//   Better Auth:   /.auth/api/{sign-in/email, two-factor/verify-totp, reset-password, sign-out, get-session}
//   Handoff:       /.auth/api/handoff/mint {host, state} (the gate, with the sign-in host's session cookie) → a single-use
//                  code for one app host; /.auth/api/handoff/redeem {code, host, state} → a new session's cookie value for
//                  that host, linked to the sign-in host's session; /.auth/api/handoff/revoke (an app host session's cookie)
//                  → that session ends. All server-side only, under the listener's own names: the gate never forwards them.
//   App access:    /.auth/api/app-access/{page, role, default} (the gate, server-side, with gate_board_secret and the asking
//                  email as `by`): an app's roles, default and log, for its admins (AidenHQ admins are admins of every app).
//   Requests:      /.auth/api/app-request/{new, mine} (the gate, with the visitor's verified email): in-app requests.
// No board route is here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { z } from "zod";
import { AccountError, safeNext, type Accounts, type GateInfo } from "./accounts.js";
import { AccessError } from "./app-access.js";
import { checkRequest } from "./app.js";

const HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page; `next` (a same-host path) rides along as a data attribute (no inline script). */
const page = (title: string, form: string, next?: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><link rel="stylesheet" href="/.auth/assets/auth.css"></head><body><main${next ? ` data-next="${esc(next)}"` : ""}><h1>${title}</h1>${form}<p id="msg" role="status"></p></main><script src="/.auth/assets/auth.js"></script></body></html>`;

const FORMS = {
  "/.auth/sign-in": ["Sign in", `<form id="password"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`],
  "/.auth/two-factor": ["Enter your code", `<form id="totp"><label>Code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button>Continue</button></form>`],
  "/.auth/set-password": ["Set your password", `<form id="set"><label>New password (12 characters or more)<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><button>Set password</button></form>`],
} as const;

const CSS = `:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1a;--muted:#6b6b66;--card:#fff;--line:#deded8;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a93;--card:#1e1e1c;--line:#33332f;--accent:#7b9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:380px;margin:12vh auto;padding:24px 16px}h1{font-size:22px;margin:0 0 16px}
form{display:grid;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
label{display:grid;gap:4px;font-size:14px;color:var(--muted)}input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
button{font:inherit;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}#msg{color:var(--muted);min-height:1.5em}`;

const JS = `(() => {
  const main = document.querySelector("main"), next = main.dataset.next || "";
  const msg = (t) => (document.getElementById("msg").textContent = t);
  const call = async (path, body) => {
    const r = await fetch("/.auth/api" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((d && (d.message || d.error)) || "failed (" + r.status + ")"), { status: r.status });
    return d;
  };
  const withNext = (path) => path + (next ? "?next=" + encodeURIComponent(next) : "");
  // Signed in: on to next (a path here, e.g. the gate's /.auth/go?…, which hands off to the app), else the apps list.
  const finish = async () => void (location.href = next || "/");
  const pw = document.getElementById("password"), totp = document.getElementById("totp"), set = document.getElementById("set");
  pw && pw.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      const d = await call("/sign-in/email", { email: pw.email.value, password: pw.password.value });
      if (d.twoFactorRedirect) location.href = withNext("/.auth/two-factor"); else await finish();
    } catch (err) { msg(err.message); }
  });
  totp && totp.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try { await call("/two-factor/verify-totp", { code: totp.code.value }); await finish(); } catch (err) { msg(err.message); }
  });
  set && set.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    const token = new URLSearchParams(location.search).get("token") || location.hash.slice(1);
    try { await call("/reset-password", { token, newPassword: set.password.value }); location.href = withNext("/.auth/sign-in"); } catch (err) { msg(err.message); }
  });
})();`;

const ASSETS: Record<string, [string, string]> = {
  "/.auth/assets/auth.js": [JS, "text/javascript; charset=utf-8"],
  "/.auth/assets/auth.css": [CSS, "text/css; charset=utf-8"],
};

/** Better Auth's endpoints here (the gate passes on only the first four, and calls get-session itself). */
const BETTER_AUTH = new Set(["/sign-in/email", "/two-factor/verify-totp", "/reset-password", "/sign-out", "/get-session"]);

export function createSigninServer(o: { accounts: Accounts; hosts: string[]; gate: () => GateInfo | undefined; log: Logger }): Server {
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

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://signin");
    const path = url.pathname;
    if (path === "/healthz") return text(res, 200, "ok", "text/plain");
    try {
      // The gate's server-side handoff calls (never proxied): only under the listener's own names, so no browser checks apply.
      if (["/.auth/api/handoff/mint", "/.auth/api/handoff/redeem", "/.auth/api/handoff/revoke"].includes(path)) {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!o.hosts.includes(String(req.headers.host ?? "").toLowerCase())) return json(res, 403, { error: "unknown host" });
        const State = z.string().min(16).max(256);
        if (path.endsWith("/mint")) {
          const { host, state } = z.object({ host: z.string().min(1).max(253), state: State }).strict().parse(await body(req));
          return json(res, 200, await o.accounts.mintHandoff(req, host, state));
        }
        if (path.endsWith("/revoke")) {
          const { host } = z.object({ host: z.string().min(1).max(253) }).strict().parse(await body(req));
          return json(res, 200, await o.accounts.revokeHostSession(req, host));
        }
        const { code, host, state } = z.object({ code: z.string().min(16).max(100), host: z.string().min(1).max(253), state: State }).strict().parse(await body(req));
        return json(res, 200, await o.accounts.redeemHandoff(code, host, state));
      }
      // App access and in-app requests (spec 2026-11-12-app-access-rbac-design.md): the gate, server-side, with its shared
      // secret, names who is asking (`by` / `email`, the email it signed in or verified through Access); the board checks the
      // rest (an app admin for the Access page; a member who isn't blocked for a request).
      if (path.startsWith("/.auth/api/app-access/") || path.startsWith("/.auth/api/app-request/") || path === "/.auth/api/app-feedback/new") {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        if (!o.hosts.includes(String(req.headers.host ?? "").toLowerCase()) || !o.accounts.fromGate(req)) return json(res, 403, { error: "only the gate" });
        const Email = z.string().max(200);
        const App = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
        const Role = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
        const input = await body(req);
        const apps = o.accounts.apps;
        switch (path.slice("/.auth/api/".length)) {
          case "app-access/page": {
            const { by, app } = z.object({ by: Email, app: App }).strict().parse(input);
            return json(res, 200, apps.page(by, app));
          }
          case "app-access/role": {
            const { by, app, email, role } = z.object({ by: Email, app: App, email: Email, role: Role.nullable() }).strict().parse(input);
            return json(res, 200, await apps.assign(by, app, email, role));
          }
          case "app-access/default": {
            const { by, app, role } = z.object({ by: Email, app: App, role: Role }).strict().parse(input);
            return json(res, 200, await apps.setDefault(by, app, role));
          }
          case "app-request/new": {
            const { email, app, text, context } = z.object({ email: Email, app: App, text: z.string().trim().min(1).max(4000), context: z.string().max(500).optional() }).strict().parse(input);
            return json(res, 200, apps.request(app, email, text, context));
          }
          case "app-feedback/new": {
            const { email, app } = z.object({ email: Email, app: App }).strict().parse(input);
            return json(res, 200, apps.notify(app, email));
          }
          case "app-request/mine": {
            const { email, app } = z.object({ email: Email, app: App }).strict().parse(input);
            return json(res, 200, { requests: apps.mine(app, email) });
          }
        }
        return json(res, 404, { error: "not found" });
      }
      // The listener's own names (the gate's server-side calls) and the sign-in host its pages are proxied under.
      const gate = o.gate();
      const hosts = [...o.hosts, ...(gate?.myAppsHost ? [gate.myAppsHost] : [])];
      // The gate strips every x-aidenhq-* header, the board's own included: here a write needs JSON and its Origin, exactly.
      const rejected = checkRequest(req, hosts, false) ?? (req.method !== "GET" && req.method !== "HEAD" && !req.headers.origin ? "no origin" : undefined);
      if (rejected) {
        o.log.warn({ method: req.method, path, reason: rejected }, "sign-in request rejected");
        return json(res, 403, { error: rejected });
      }
      // An app host session whose sign-in host session ended is no session.
      if (path === "/.auth/api/get-session" && req.method === "GET") return json(res, 200, await o.accounts.gateSession(req));
      // Signing out here ends the app host sessions handed off from this one too.
      if (path === "/.auth/api/sign-out" && req.method === "POST") await o.accounts.endHandedOff(req);
      if (path.startsWith("/.auth/api/") && BETTER_AUTH.has(path.slice("/.auth/api".length)))
        // Better Auth sees the listener's own host; the browser's Origin (the sign-in host) is one of its trusted origins.
        return await o.accounts.handle(req, res, path.slice("/.auth/api".length), "signin", url.search, o.hosts[0]);
      if (req.method !== "GET") return json(res, path.startsWith("/.auth/api/") ? 404 : 405, { error: path.startsWith("/.auth/api/") ? "not found" : "method not allowed" });
      const form = FORMS[path as keyof typeof FORMS];
      if (form) return text(res, 200, page(form[0], form[1], safeNext(url.searchParams.get("next"))), "text/html; charset=utf-8");
      const asset = ASSETS[path];
      if (asset) return text(res, 200, asset[0], asset[1]);
      return json(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof AccountError || err instanceof AccessError ? err.status : err instanceof z.ZodError ? 400 : 500;
      if (status >= 500) o.log.error({ err: String((err as Error).message ?? err).slice(0, 300), path }, "sign-in request failed");
      if (!res.headersSent) json(res, status, { error: status === 400 && err instanceof z.ZodError ? "bad request" : ((err as Error).message ?? "error") });
    }
  });
}
