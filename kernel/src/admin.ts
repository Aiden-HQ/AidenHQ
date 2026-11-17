// K4 kernel pages on the admin listener (127.0.0.1:3120; spec §2.3, §2.5; lean 3a): sign-in, the approval list and card
// pages, decide and batch decide, the owner's confirmation page and the owner message frame. Server-rendered, no script.
// - Every request names an allowed Host (DNS rebinding); every route but /healthz and sign-in needs a ready admin's session
//   (TOTP enrolled), stamped `account:<id>` from the session, never from the request.
// - Every POST carries this listener's own Origin, exactly (cookies ignore ports, so the board's origin on the same host is
//   refused here), and, signed in, a token bound to the session that only a page from this origin carries (A6).
// - Every page sends frame-ancestors 'none', except /owner/message, which the board's origins may frame: it only sends what
//   the owner typed into it (A7). Every one-click owner action happens on a top-level page here.
// - /setup (spec §6.10, A42): the first-run page, only with the single-use token ops/setup.sh --unattended prints and only
//   while no admin exists. A GET changes nothing; the submit is checked in full, then spends the token, makes the owner's
//   account and hands over to /auth/enrol for the authenticator. The owner then picks the model on /setup/model: Connect
//   OpenRouter (PKCE: the verifier and a state kept here per session, the callback /setup/openrouter) or a pasted key, then one
//   1-token call; on success the key goes into the vault and the owner on to the board's welcome.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminSession, Step } from "./accounts.ts";
import type { Api } from "./channels.ts";
import { secretFits } from "./module-secrets.ts";

type Card = Record<string, any>;
type Deps = {
  accounts: {
    sessionOf: (req: IncomingMessage) => Promise<AdminSession | null>; step: (req: IncomingMessage, sub: string, body: Record<string, unknown>) => Promise<Step>; secret: string;
    mintUiCode: (who: AdminSession, module: string, origin: string, state: string) => string;
    setupOpen: (token: string) => boolean; claimSetup: (token: string, input: { email: string; name: string; password: string }) => Promise<{ id: string }>;
  };
  /** First-run setup's vault side: the owner email settings fix, the recovery key shown once, and secret writes. */
  firstRun?: { ownerEmail: () => string | undefined; recoveryKey: () => string; fields: () => SetupField[]; has: (secret: string) => boolean; save: (secret: string, value: string) => void; forgetRecoveryKey: () => void };
  cards: { ownerCards: () => Promise<{ live: Card[]; finished: Card[] }>; decideCard: (id: string, digest: string, decision: "approve" | "reject", by: string, via: string) => Promise<{ identifier: string; sentence: string; state: string }> };
  ownerMessage: (b: { text?: unknown; task?: unknown }) => Promise<{ task: { identifier: string } }>;
  /** The control plane as the owner (a confirmed status change). */
  owner: Api;
  hosts: () => string[];
  /**
   * The origins a form may come from: the front door's (https://<name>:<port>, whatever Host its proxy passes on) and the
   * loopback addresses. Never derived from the Host: on one host name the board's origin differs only by port.
   */
  origins: () => string[];
  /** Origins that may frame /owner/message (the board's). */
  frameOrigins: () => string[];
  /** Module UI origins a session may be handed to (/auth/handoff), each with its module: the board's origins. */
  uiOrigins?: () => Record<string, string>;
  /** The model step: OpenRouter's PKCE start and exchange, the 1-token check, and the key the vault holds (for Retry). */
  model?: { start: (callback: string, state: string) => { url: string; verifier: string }; exchange: (code: string, verifier: string) => Promise<string>; check: (key: string) => Promise<"ok" | "no_credit" | "error">; saved: () => string; ready: () => boolean; checked: (key: string, ok: boolean) => void };
  /** The board's front door: /recovery-key and the model step send the owner on to its welcome. */
  boardUrl?: () => string | undefined;
  log?: (msg: string, f?: Record<string, unknown>) => void;
};

/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.mjs reads it. */
export const ROUTES = [
  { method: "GET", path: "/healthz", auth: "none" },
  { method: "GET", path: "/setup", auth: "setup-token" },
  { method: "POST", path: "/setup", auth: "origin+setup-token" },
  { method: "GET", path: "/auth/sign-in", auth: "none" },
  { method: "POST", path: "/auth/sign-in", auth: "origin" },
  { method: "GET", path: "/auth/totp", auth: "none" },
  { method: "POST", path: "/auth/totp", auth: "origin" },
  { method: "GET", path: "/auth/set-password", auth: "none" },
  { method: "POST", path: "/auth/set-password", auth: "origin" },
  { method: "GET", path: "/auth/enrol", auth: "session" },
  { method: "POST", path: "/auth/enrol", auth: "session+csrf" },
  { method: "GET", path: "/auth/password", auth: "admin" },
  { method: "POST", path: "/auth/password", auth: "admin+csrf" },
  { method: "POST", path: "/auth/sign-out", auth: "origin" },
  { method: "GET", path: "/auth/handoff", auth: "admin" },
  { method: "GET", path: "/setup/model", auth: "admin" },
  { method: "POST", path: "/setup/model", auth: "admin+csrf" },
  { method: "GET", path: "/setup/openrouter", auth: "admin" },
  { method: "GET", path: "/recovery-key", auth: "admin" },
  { method: "POST", path: "/recovery-key", auth: "admin+csrf" },
  { method: "GET", path: "/", auth: "admin" },
  { method: "GET", path: "/approvals", auth: "admin" },
  { method: "GET", path: "/approvals/:id", auth: "admin" },
  { method: "POST", path: "/approvals/:id/decide", auth: "admin+csrf" },
  { method: "POST", path: "/approvals/batch", auth: "admin+csrf" },
  { method: "GET", path: "/owner/message", auth: "admin" },
  { method: "POST", path: "/owner/message", auth: "admin+csrf" },
  { method: "GET", path: "/owner/confirm", auth: "admin" },
  { method: "POST", path: "/owner/confirm", auth: "admin+csrf" },
] as const;
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(":id", "(k-[0-9a-f]{16})")}$`) }));
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

/** A secret a module asks for on /setup (its provided secret's `setup:`, compiled into config/kernel/modules.json `setup`). */
export type SetupField = { module: string; secret: string; label: string; pattern: string; help?: string; required?: boolean };
/** The gateway's model key: the one module secret the first run still asks for, on the model step. */
const MODEL_KEY = "openrouter_key";
const CREDITS = "https://openrouter.ai/settings/credits";
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
class Refusal extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const CSS = `:root{color-scheme:light dark;--bg:#f9f9fb;--surface:#fff;--surface-2:#f0f0f3;--line:#d9d9e0;--text:#1c2024;--muted:#60646c;--accent:#3b3be8;--accent-hover:#2c2cd6;--on-accent:#fff;--link:#3b3be8;--danger:#ce2c31;--danger-soft:#feebec;--ok:#2a7e3b}
@media(prefers-color-scheme:dark){:root{--bg:#111113;--surface:#18191b;--surface-2:#212225;--line:#2e3135;--text:#edeef0;--muted:#b0b4ba;--accent:#4f4ff0;--accent-hover:#6363f5;--link:#a9abff;--danger:#ff9592;--danger-soft:#3b1219;--ok:#70e086}}
*{box-sizing:border-box}body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--text)}main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:22px;line-height:1.25;margin:16px 0 12px}h2{font-size:16px;margin:24px 0 8px}a{color:var(--link)}
header{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--line)}header b{margin-right:8px;color:var(--accent)}header a,header button{color:var(--text);background:none;border:0;font:inherit;cursor:pointer;text-decoration:none;padding:4px 0}header a:hover,header button:hover{color:var(--link)}
header form{margin-left:auto}.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;overflow-wrap:anywhere}
.muted{color:var(--muted);font-size:13px}.err{color:var(--danger);background:var(--danger-soft);border-radius:6px;padding:8px 10px}.ok{color:var(--ok)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-2);padding:8px;border-radius:6px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:4px 0 8px}
code{background:var(--surface-2);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
input,textarea,select{font:inherit;color:var(--text);background:var(--surface);padding:8px 10px;border:1px solid var(--line);border-radius:6px;width:100%}label{display:block;margin:8px 0}
input[type=checkbox]{accent-color:var(--accent);margin-right:6px;vertical-align:middle}
a.b{display:inline-block;text-decoration:none}button.b,a.b{font:inherit;font-weight:500;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer}button.b:hover,a.b:hover{background:var(--accent-hover)}button.r{background:transparent;color:var(--danger);border-color:var(--danger)}button.r:hover{background:var(--danger-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input:focus-visible,textarea:focus-visible{outline-offset:0;border-color:var(--accent)}
.pick{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}.pick .card{margin:0}.pick h2{margin:0 0 4px}
@media(max-width:600px){button.b{min-height:44px}}`;

export function createAdmin(d: Deps) {
  const log = d.log ?? (() => {});
  const csrf = (s: AdminSession) => createHmac("sha256", d.accounts.secret).update(`csrf:${s.session.id}`).digest("hex");
  const proto = (req: IncomingMessage) => (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http");

  function send(res: ServerResponse, status: number, html: string, frame?: string[], extra: Record<string, string | string[]> = {}) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(frame ? {} : { "x-frame-options": "DENY" }),
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors ${frame?.length ? frame.join(" ") : "'none'"}`,
      ...extra,
    }).end(html);
  }
  const doc = (title: string, body: string, s?: AdminSession | null) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AidenHQ</title><style>${CSS}</style></head><body>` +
    (s?.ready ? `<header><b>AidenHQ</b><a href="/approvals">Approvals</a><a href="/owner/message">Message</a><a href="/auth/password">Password</a><form method="post" action="/auth/sign-out"><button>Sign out</button></form></header>` : "") +
    `<main>${body}</main></body></html>`;
  const redirect = (res: ServerResponse, to: string, cookies: string[] = []) =>
    void res.writeHead(303, { location: to, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) }).end();
  const form = (action: string, inner: string, s?: AdminSession | null) => `<form method="post" action="${esc(action)}">${s ? `<input type="hidden" name="csrf" value="${csrf(s)}">` : ""}${inner}</form>`;
  const safeNext = (n: string | null) => (n && (/^\/(approvals|owner|setup\/model)[\w/?=&.-]*$/.test(n) || /^\/auth\/handoff\?[\w=&.%:-]*$/.test(n)) ? n : "/approvals");

  async function body(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 64_000) throw new Refusal(413, "too large"); chunks.push(c); }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  const step = (req: IncomingMessage, sub: string, b: Record<string, unknown>) => d.accounts.step(req, sub, b);

  const pages = {
    signIn: (msg = "", next = "") => doc("Sign in", `<h1>Sign in</h1>${msg}${form(`/auth/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`, `<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="b">Sign in</button>`)}`),
    totp: (msg = "", next = "") => doc("Authenticator code", `<h1>Authenticator code</h1>${msg}${form(`/auth/totp${next ? `?next=${encodeURIComponent(next)}` : ""}`, `<label>6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label><button class="b">Continue</button>`)}`),
    setPassword: (token: string, msg = "") => doc("Set your password", `<h1>Set your password</h1>${msg}${form("/auth/set-password", `<input type="hidden" name="token" value="${esc(token)}"><label>New password (12 characters or more)<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><button class="b">Set password</button>`)}`),
  };
  const err = (m: string) => `<p class="err">${esc(m)}</p>`;
  // Never re-renders the password: only the email and name come back after a refusal.
  const setupPage = (token: string, fr: NonNullable<Deps["firstRun"]>, msg = "", v: { email?: string; name?: string } = {}) => {
    const fixed = fr.ownerEmail();
    return doc("Set up AidenHQ", `<h1>Set up AidenHQ</h1>${msg}${form("/setup", `<input type="hidden" name="token" value="${esc(token)}">
<h2>Your account</h2><label>Email<input name="email" type="email" autocomplete="username" maxlength="200" required value="${esc(fixed ?? v.email ?? "")}"${fixed ? " readonly" : ""}></label>
<label>Name<input name="name" maxlength="100" value="${esc(v.name ?? "")}"></label><label>Password (12 characters or more)<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
<p class="muted">Next: an authenticator app (admins sign in with a code from it), then the AI model your agents use.</p>
<button class="b">Create account</button>`)}`);
  };
  // The model step. Connect needs a callback OpenRouter takes: https, or localhost on any port; elsewhere the paste field leads.
  const pkce = new Map<string, { verifier: string; state: string; at: number }>();
  const welcome = () => (d.boardUrl?.() ? `${d.boardUrl()}/#/welcome` : "/approvals");
  const afterEnrol = (s: AdminSession) => (d.model && s.account.owner && !d.model.ready() ? "/setup/model" : "/approvals");
  const modelPage = (req: IncomingMessage, s: AdminSession, msg = "", credit = false) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    const origin = d.origins().find((o) => new URL(o).host === host || new URL(o).hostname === host); // proxies differ in the Host they pass on
    const callable = origin && (origin.startsWith("https://") || new URL(origin).hostname === "localhost");
    // Two equal ways: a key the owner already has, and (where OpenRouter can call back) Connect.
    let connect = "";
    if (callable) {
      for (const [k, v] of pkce) if (Date.now() - v.at > 600_000) pkce.delete(k);
      const state = randomBytes(16).toString("base64url");
      const { url, verifier } = d.model!.start(`${origin}/setup/openrouter`, state);
      pkce.set(s.session.id, { verifier, state, at: Date.now() });
      connect = `<div class="card"><h2>Connect your account</h2><p class="muted">Sign in to OpenRouter (or make an account) and approve; you come straight back here.</p><a class="b" href="${esc(url)}">Connect OpenRouter</a></div>`;
    }
    const field = d.firstRun?.fields().find((f) => f.secret === MODEL_KEY);
    const paste = `<div class="card"><h2>Use your API key</h2><p class="muted">Paste a key you have, or make one at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a>.</p>${form("/setup/model", `<input type="hidden" name="action" value="paste"><label>${esc(field?.label ?? "OpenRouter API key")}<input name="${MODEL_KEY}" type="password" autocomplete="off" maxlength="300" placeholder="sk-or-…" required></label><button class="b">Save</button>`, s)}</div>`;
    const retry = credit ? `<div class="card"><p>Your OpenRouter account needs credit before agents can run.</p><p><a href="${CREDITS}" target="_blank" rel="noopener">Add credit in OpenRouter</a>, then retry.</p>${form("/setup/model", `<input type="hidden" name="action" value="retry"><button class="b">Retry</button>`, s)}</div>` : "";
    const has = d.model?.ready() && !credit ? `<p class="muted">A working key is already in the vault; saving or connecting replaces it. <a href="${esc(welcome())}">Continue</a></p>` : "";
    return doc("Connect a model", `<h1>Connect a model</h1><p>Your agents think with AI models on OpenRouter. The key goes into the vault, read only by the kernel's model gateway.</p>${msg}${retry}${has}${credit ? "" : `<div class="pick">${paste}${connect}</div>`}`, s);
  };
  /** One 1-token call with the key; saved when it works or only lacks credit (Retry then needs no new key). */
  async function useKey(req: IncomingMessage, res: ServerResponse, s: AdminSession, key: string) {
    const r = await d.model!.check(key);
    if (r === "error") return send(res, 400, modelPage(req, s, err("OpenRouter didn't accept a call with that key. Try again, or paste another key.")));
    d.firstRun!.save(MODEL_KEY, key);
    d.model!.checked(key, r === "ok"); // ready only once a check of this key passed (no credit: Retry checks it again)
    log("model key saved", { by: `account:${s.account.id}`, check: r });
    if (r === "no_credit") return send(res, 200, modelPage(req, s, "", true));
    return redirect(res, welcome());
  }
  function cardHtml(a: Card, s: AdminSession, full: boolean) {
    const head = `<div class="muted">${esc(a.identifier)} · ${esc(a.action ?? a.kind)} · Tier ${esc(a.tier)}${a.panel ? " · panel" : ""} · asked by ${esc(a.requestedBy)}</div><b>${esc(a.sentence)}</b>`;
    if (!full) return `<div class="card">${head}<div><a href="/approvals/${esc(a.id)}">Open</a></div></div>`;
    const rows = [["Changes", a.changes], ["Reads", a.reads], ["Cost", a.cost], ["Why", a.reason], ["AI reviewer", a.review]].filter(([, v]) => v).map(([k, v]) => `<div class="muted">${k}</div><pre>${esc(v)}</pre>`).join("");
    const decide = (decision: string, label: string, cls: string) => form(`/approvals/${a.id}/decide`, `<input type="hidden" name="digest" value="${esc(a.digest)}"><input type="hidden" name="decision" value="${decision}"><button class="b ${cls}">${label}</button>`, s);
    return `<div class="card">${head}${rows}<div class="muted">digest ${esc(String(a.digest).slice(0, 16))}…</div><div style="display:flex;gap:8px;margin-top:8px">${decide("approve", "Approve", "")}${decide("reject", "Reject", "r")}</div></div>`;
  }

  async function admin(req: IncomingMessage): Promise<AdminSession> {
    const s = await d.accounts.sessionOf(req);
    if (!s?.ready) throw new Refusal(s ? 403 : 401, s ? "this account can't decide here: an admin with an authenticator" : "sign in");
    return s;
  }
  function checkCsrf(s: AdminSession, f: URLSearchParams) {
    const a = Buffer.from(f.get("csrf") ?? ""), b = Buffer.from(csrf(s));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Refusal(403, "this form is stale or came from another page: reload and try again");
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(String(req.url ?? "/"), "http://x");
    const host = String(req.headers.host ?? "").toLowerCase();
    try {
      if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      if (!d.hosts().includes(host)) throw new Refusal(421, "unknown host");
      const hit = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) throw new Refusal(404, "not found");
      const id = hit.re.exec(url.pathname)![1] ?? "";
      if (req.method === "POST" && !d.origins().includes(String(req.headers.origin ?? ""))) throw new Refusal(403, "this form didn't come from this page's own address");
      const next = url.searchParams.get("next") ?? "";
      switch (`${hit.method} ${hit.path}`) {
        case "GET /setup": case "POST /setup": {
          const fr = d.firstRun;
          const f = req.method === "POST" ? await body(req) : url.searchParams;
          const token = f.get("token") ?? "";
          if (!fr || !/^[\w-]{43}$/.test(token) || !d.accounts.setupOpen(token)) throw new Refusal(410, "This setup link was used or has expired. While no admin exists, sudo ops/setup.sh --unattended on the server prints a new one.");
          if (req.method === "GET") return send(res, 200, setupPage(token, fr));
          const email = (f.get("email") ?? "").trim(), name = (f.get("name") ?? "").trim(), password = f.get("password") ?? "";
          const bad =
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 ? "Enter an email address."
            : name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name) ? "The name has characters it can't take."
            : password.length < 12 || password.length > 128 ? "The password needs 12 to 128 characters." : "";
          if (bad) return send(res, 400, setupPage(token, fr, err(bad), { email, name }));
          const account = await d.accounts.claimSetup(token, { email, name, password }).catch((e: Error & { status?: number }) => { throw new Refusal(e.status ?? 500, e.message); });
          log("first-run account made", { account: account.id });
          const r = await step(req, "/sign-in/email", { email, password });
          return redirect(res, r.ok ? "/auth/enrol" : "/auth/sign-in", r.cookies);
        }
        case "GET /auth/sign-in": return send(res, 200, pages.signIn("", next));
        case "POST /auth/sign-in": {
          const f = await body(req);
          const r = await step(req, "/sign-in/email", { email: f.get("email") ?? "", password: f.get("password") ?? "" });
          if (!r.ok) return send(res, r.status === 429 ? 429 : 401, pages.signIn(err(r.error), next), undefined, r.retryAfter ? { "retry-after": r.retryAfter } : {});
          return redirect(res, r.json.twoFactorRedirect ? `/auth/totp?next=${encodeURIComponent(safeNext(next))}` : "/auth/enrol", r.cookies);
        }
        case "GET /auth/totp": return send(res, 200, pages.totp("", next));
        case "POST /auth/totp": {
          const r = await step(req, "/two-factor/verify-totp", { code: (await body(req)).get("code") ?? "" });
          if (!r.ok) return send(res, r.status === 429 ? 429 : 401, pages.totp(err(r.error), next), undefined, r.retryAfter ? { "retry-after": r.retryAfter } : {});
          return redirect(res, safeNext(next), r.cookies);
        }
        case "GET /auth/set-password": return send(res, 200, pages.setPassword(url.searchParams.get("token") ?? ""));
        case "POST /auth/set-password": {
          const f = await body(req);
          const r = await step(req, "/reset-password", { token: f.get("token") ?? "", newPassword: f.get("password") ?? "" });
          if (!r.ok) return send(res, 400, pages.setPassword(f.get("token") ?? "", err(r.error)));
          return send(res, 200, pages.signIn(`<p class="ok">Password set. Sign in; an authenticator is set up next.</p>`));
        }
        case "GET /auth/enrol": case "POST /auth/enrol": {
          const s = await d.accounts.sessionOf(req);
          if (!s || s.account.role !== "admin") return redirect(res, "/auth/sign-in");
          if (s.ready) return redirect(res, afterEnrol(s));
          const ask = (m = "") => send(res, 200, doc("Set up an authenticator", `<h1>Set up an authenticator</h1><p>Admins sign in with a code from an authenticator app: an app on your phone, like Google Authenticator, that shows a 6-digit code.</p>${m}${form("/auth/enrol", `<label>Your password<input name="password" type="password" autocomplete="current-password" required></label><button class="b">Show the key</button>`, s)}`));
          if (req.method === "GET") return ask();
          const f = await body(req);
          checkCsrf(s, f);
          if (f.get("code")) {
            const r = await step(req, "/two-factor/verify-totp", { code: f.get("code") });
            return r.ok ? redirect(res, afterEnrol(s), r.cookies) : ask(err(r.error));
          }
          const r = await step(req, "/two-factor/enable", { password: f.get("password") ?? "" });
          if (!r.ok) return ask(err(r.error));
          const uri = String(r.json.totpURI ?? "");
          const key = new URL(uri).searchParams.get("secret") ?? "";
          return send(res, 200, doc("Set up an authenticator", `<h1>Add AidenHQ to your authenticator</h1><p>An app on your phone, like Google Authenticator, that shows a 6-digit code. In it, add an account and scan this code.</p><div style="width:220px;max-width:100%">${(await import("uqr")).renderSVG(uri)}</div><p>Can't scan it? Enter this key by hand. Key: <code>${esc(key.replace(/(.{4})/g, "$1 ").trim())}</code> (time-based, 6 digits), or <a href="${esc(uri)}">open it in an authenticator app</a> on this device.</p>${form("/auth/enrol", `<label>The code it shows<input name="code" inputmode="numeric" pattern="[0-9]{6}" required></label><button class="b">Finish</button>`, s)}`), undefined, r.cookies.length ? { "set-cookie": r.cookies } : {});
        }
        case "POST /auth/sign-out": {
          const r = await step(req, "/sign-out", {});
          return redirect(res, "/auth/sign-in", r.cookies);
        }
      }
      // Everything below: a ready admin.
      const s = await admin(req);
      const f = req.method === "POST" ? await body(req) : new URLSearchParams();
      if (req.method === "POST") checkCsrf(s, f);
      const by = `account:${s.account.id}`;
      switch (`${hit.method} ${hit.path}`) {
        case "GET /auth/handoff": {
          const to = url.searchParams.get("to") ?? "", state = url.searchParams.get("state") ?? "";
          const module = Object.hasOwn(d.uiOrigins?.() ?? {}, to) ? d.uiOrigins!()[to]! : undefined;
          if (!module) throw new Refusal(400, "that address isn't an installed module's");
          const code = d.accounts.mintUiCode(s, module, to, state);
          log("session handed to a module", { module, origin: to, by });
          return redirect(res, `${to}/auth/handoff?${new URLSearchParams({ code, state })}`);
        }
        case "GET /setup/model": case "POST /setup/model": case "GET /setup/openrouter": {
          if (!d.model || !d.firstRun) throw new Refusal(404, "not found");
          if (!s.account.owner) throw new Refusal(403, "only the owner picks the model");
          if (hit.path === "/setup/model" && req.method === "GET") return send(res, 200, modelPage(req, s));
          if (req.method === "POST") {
            const action = f.get("action");
            if (action === "retry") return useKey(req, res, s, d.model.saved());
            if (action !== "paste") throw new Refusal(400, "paste or retry");
            const key = (f.get(MODEL_KEY) ?? "").trim(), field = d.firstRun.fields().find((x) => x.secret === MODEL_KEY);
            if (!key || key.length > 300 || /\s/.test(key) || (field && !secretFits(field, key))) return send(res, 400, modelPage(req, s, err(`That isn't a valid ${field?.label ?? "OpenRouter API key"}.`)));
            return useKey(req, res, s, key);
          }
          // The callback: single-use, bound to this session and the state it was sent with; a denial carries no code.
          const p = pkce.get(s.session.id), code = url.searchParams.get("code") ?? "";
          pkce.delete(s.session.id);
          if (!p && d.model.ready()) return redirect(res, welcome()); // a reload after it worked
          const fresh = p && Date.now() - p.at <= 600_000 && url.searchParams.get("state") === p.state;
          if (!code || !fresh) return send(res, 400, modelPage(req, s, err("OpenRouter didn't connect (cancelled, expired or from another page). Try again.")));
          const key = await d.model.exchange(code, p.verifier).catch((e: Error) => (log("openrouter exchange failed", { err: e.message.slice(0, 200) }), ""));
          const field = d.firstRun.fields().find((x) => x.secret === MODEL_KEY);
          if (!key || (field && !secretFits(field, key))) return send(res, 400, modelPage(req, s, err("OpenRouter didn't hand over a key. Try again.")));
          return useKey(req, res, s, key);
        }
        case "GET /recovery-key": {
          if (!s.account.owner) throw new Refusal(403, "only the owner sees the recovery key");
          const rk = d.firstRun?.recoveryKey();
          if (!rk) return send(res, 200, doc("Recovery key", `<h1>Vault recovery key</h1><p>No recovery key is waiting.</p>`, s));
          const file = `AidenHQ vault recovery key\n${rk}\n`;
          return send(res, 200, doc("Recovery key", `<h1>Vault recovery key</h1><p>Shown once. Without it, a vault whose sealed password is lost can't be opened. Store it somewhere safe, such as a password manager.</p><pre style="user-select:all">${esc(rk.replace(/(.{8})/g, "$1 ").trim())}</pre><p><a href="data:text/plain;charset=utf-8,${encodeURIComponent(file)}" download="aidenhq-recovery-key.txt">Download as a file</a> <span class="muted">(or click the key to select it, then copy)</span></p>${form("/recovery-key", `<label><input type="radio" name="choice" value="saved" required style="width:auto"> I saved it somewhere safe</label><label><input type="radio" name="choice" value="decline" style="width:auto"> I don't want a recovery key</label><button class="b">Continue</button>`, s)}`, s));
        }
        case "POST /recovery-key": {
          if (!s.account.owner) throw new Refusal(403, "only the owner sees the recovery key");
          const choice = f.get("choice");
          if (choice !== "saved" && choice !== "decline") throw new Refusal(400, "choose saved or decline");
          d.firstRun?.forgetRecoveryKey();
          log("recovery key shown once", { choice, by });
          return redirect(res, welcome());
        }
        case "GET /auth/password": return send(res, 200, doc("Change password", `<h1>Change password</h1>${form("/auth/password", `<label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password (12 characters or more)<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><button class="b">Change</button>`, s)}`, s));
        case "POST /auth/password": {
          const r = await step(req, "/change-password", { currentPassword: f.get("current") ?? "", newPassword: f.get("password") ?? "", revokeOtherSessions: true });
          return send(res, r.ok ? 200 : 400, doc("Change password", r.ok ? `<p class="ok">Password changed; your other sessions ended.</p>` : err(r.error), s), undefined, r.cookies.length ? { "set-cookie": r.cookies } : {});
        }
        case "GET /": case "GET /approvals": {
          const { live, finished } = await d.cards.ownerCards();
          const batch = live.length > 1 ? form("/approvals/batch", `${live.map((a) => `<label><input type="checkbox" name="item" value="${esc(`${a.id}:${a.digest}`)}" style="width:auto"> ${esc(a.identifier)}: ${esc(a.sentence)}</label>`).join("")}<div style="display:flex;gap:8px"><button class="b" name="decision" value="approve">Approve selected</button><button class="b r" name="decision" value="reject">Reject selected</button></div>`, s) : "";
          const done = finished.slice(0, 20).map((a) => `<div class="card muted">${esc(a.identifier)} · ${esc(a.state)}${a.outcome ? ` · ${esc(a.outcome)}` : ""}: ${esc(a.sentence)}</div>`).join("");
          return send(res, 200, doc("Approvals", `<h1>Waiting for you (${live.length})</h1>${live.map((a) => cardHtml(a, s, false)).join("") || `<p class="muted">Nothing waits on you.</p>`}${batch ? `<h2>Several at once</h2><div class="card">${batch}</div>` : ""}<h2>Recent</h2>${done}`, s));
        }
        case "GET /approvals/:id": {
          const { live, finished } = await d.cards.ownerCards();
          const a = live.find((x) => x.id === id);
          if (a) return send(res, 200, doc(a.sentence, cardHtml(a, s, true), s));
          const old = finished.find((x) => x.id === id);
          return send(res, old ? 200 : 404, doc("Approval", old ? `<div class="card">${esc(old.identifier)} · ${esc(old.state)}: ${esc(old.sentence)}${old.outcomeText ? `<pre>${esc(old.outcomeText)}</pre>` : ""}</div>` : `<p>This card isn't waiting for you (decided, replaced, or with the AI reviewer).</p>`, s));
        }
        case "POST /approvals/:id/decide": {
          const decision = f.get("decision") === "approve" ? "approve" : f.get("decision") === "reject" ? "reject" : undefined;
          if (!decision) throw new Refusal(400, "approve or reject");
          const r = await d.cards.decideCard(id, f.get("digest") ?? "", decision, by, "web");
          log("web decision", { card: id, decision, by });
          return send(res, 200, doc("Decided", `<p class="ok">${decision === "approve" ? "Approved" : "Rejected"}: ${esc(r.sentence)} (${esc(r.identifier)}, now ${esc(r.state)})</p><a href="/approvals">Back to approvals</a>`, s));
        }
        case "POST /approvals/batch": {
          const decision = f.get("decision") === "approve" ? "approve" : f.get("decision") === "reject" ? "reject" : undefined;
          const items = f.getAll("item").slice(0, 20).map((v) => v.split(":")).filter((p): p is [string, string] => p.length === 2);
          if (!decision || !items.length) throw new Refusal(400, "pick cards, then approve or reject");
          // Each card on its own, against the digest the owner saw: one that changed meanwhile fails alone.
          const lines: string[] = [];
          for (const [cid, digest] of items) {
            const r = await d.cards.decideCard(cid, digest, decision, by, "web").then((x) => `<p class="ok">${esc(x.identifier)}: ${esc(x.state)}</p>`, (e: Error) => `<p class="err">${esc(cid)}: ${esc(e.message)}</p>`);
            lines.push(r);
          }
          log("web batch decision", { cards: items.map(([c]) => c), decision, by });
          return send(res, 200, doc("Decided", `${lines.join("")}<a href="/approvals">Back to approvals</a>`, s));
        }
        case "GET /owner/message": return send(res, 200, doc("Message", form("/owner/message", `<label>Task (optional, e.g. WOR-12)<input name="task" maxlength="100" value="${esc(url.searchParams.get("task") ?? "")}"></label><label>Message<textarea name="text" rows="4" maxlength="8000" required></textarea></label><button class="b">Send</button>`, s)), d.frameOrigins());
        case "POST /owner/message": {
          const r = await d.ownerMessage({ text: f.get("text") ?? "", task: f.get("task") || undefined });
          log("owner message from the web frame", { task: r.task.identifier, by });
          return send(res, 200, doc("Sent", `<p class="ok">Sent to ${esc(r.task.identifier)}.</p><a href="/owner/message">Another</a>`), d.frameOrigins());
        }
        case "GET /owner/confirm": case "POST /owner/confirm": {
          const p = req.method === "POST" ? f : url.searchParams;
          const task = String(p.get("task") ?? "").slice(0, 100), to = String(p.get("to") ?? "");
          if (p.get("action") !== "status" || !/^[A-Za-z0-9-]{1,100}$/.test(task) || !STATUSES.includes(to)) throw new Refusal(400, "action=status, task and to (a task status)");
          if (req.method === "GET") return send(res, 200, doc("Confirm", `<p>Set <b>${esc(task)}</b> to <b>${esc(to)}</b>?</p>${form("/owner/confirm", `<input type="hidden" name="action" value="status"><input type="hidden" name="task" value="${esc(task)}"><input type="hidden" name="to" value="${esc(to)}"><button class="b">Confirm</button>`, s)}`, s));
          const r = await d.owner("PATCH", `/api/issues/${encodeURIComponent(task)}`, { status: to });
          if (r.status >= 300) throw new Refusal(r.status === 404 ? 404 : 502, `the control plane answered ${r.status}`);
          log("owner status change", { task, to, by });
          return send(res, 200, doc("Done", `<p class="ok">${esc(task)} is ${esc(to)}.</p>`, s));
        }
      }
      throw new Refusal(404, "not found");
    } catch (e) {
      const status = (e as Refusal).status ?? 500;
      if (status >= 500) log("admin error", { path: url.pathname, err: String((e as Error).message).slice(0, 300) });
      if (res.headersSent) return void res.destroy();
      if (status === 401 && req.method === "GET") return redirect(res, `/auth/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
      send(res, status, doc("Refused", err(status >= 500 ? "something went wrong; try again" : (e as Error).message)));
    }
  };
}
