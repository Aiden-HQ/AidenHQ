// K4 kernel pages on the admin listener (127.0.0.1:3120; spec §2.3, §2.5; lean 3a): sign-in, the approval list and card
// pages' old addresses (they redirect to the board, the one approvals UI), the owner's confirmation page and the owner message
// frame. Server-rendered, no script.
// - Every request names an allowed Host (DNS rebinding); every route but /healthz, sign-in, OpenRouter's callback and GitHub's
//   App manifest return (each by a single-use state an admin's page made) needs a ready admin's session (TOTP enrolled), stamped `account:<id>` from the session, never from the request.
// - The OAuth authorization server for the owner's MCP clients (Better Auth's oauthProvider, auth-rules.ts): its metadata,
//   token, register and revoke need no session (a client's own credentials; no Origin check, they aren't browser forms);
//   authorize goes on only with a ready admin's session (else to sign-in and back), and /oauth/consent is an admin page.
// - Every POST carries this listener's own Origin, exactly (cookies ignore ports, so the board's origin on the same host is
//   refused here), and, signed in, a token bound to the session that only a page from this origin carries (A6).
// - Every page sends frame-ancestors 'none', except /owner/message, which the board's origins may frame: it only sends what
//   the owner typed into it (A7). Every one-click owner action here happens on a top-level page. Cards are decided on the board
//   (its Approve and Reject, through /v1/owner/decide with the admin's board session: auth-api.ts), never on a page here.
// - /setup (spec §6.10, A42): the first-run page, only with the single-use token ops/setup.sh --unattended prints and only
//   while no admin exists. A GET changes nothing; the submit is checked in full, then spends the token, makes the owner's
//   account and hands over to /auth/enrol for the authenticator. The owner then picks the model on /setup/model: Connect
//   OpenRouter (PKCE) or a pasted key, then one 1-token call; on success the key goes into the vault and the owner on to the
//   board's welcome. The flow is the models-openrouter module's (modules/models-openrouter/src/model-step.ts); its pages and
//   routes are served here. OpenRouter's return is a cross-site navigation, so the SameSite=Strict session cookie isn't sent:
//   the callback /setup/openrouter/<state> needs no session. The random state in its path names a pending entry the owner's
//   model page made (verifier, account), spent on first use and gone after 10 minutes. It answers with a page that moves on
//   to /setup/model itself (a same-site navigation, so the cookie comes back) with the outcome.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MODEL_KEY, type ModelStep } from "../../modules/models-openrouter/src/model-step.ts";
import type { AdminSession, Step } from "./accounts.ts";
import { ORG, manifest, type MadeApp } from "./github-app.ts";
import type { Api } from "./channels.ts";
import type { State as UpdateState } from "./updates.ts";

type Deps = {
  accounts: {
    sessionOf: (req: IncomingMessage) => Promise<AdminSession | null>; step: (req: IncomingMessage, sub: string, body: Record<string, unknown>) => Promise<Step>; secret: string;
    mintUiCode: (who: AdminSession, module: string, origin: string, state: string) => string;
    mintDoorCode?: (who: AdminSession, origin: string, state: string) => string;
    setupOpen: (token: string) => boolean; claimSetup: (token: string, input: { email: string; name: string; password: string }) => Promise<{ id: string }>;
    oauth: (req: IncomingMessage, res: ServerResponse, sub: string, search?: string) => Promise<void>; mcpClientName: (clientId: string) => string;
  };
  /** First-run setup's vault side: the owner email settings fix, the recovery key shown once, and secret writes. */
  firstRun?: { ownerEmail: () => string | undefined; recoveryKey: () => string; fields: () => SetupField[]; has: (secret: string) => boolean; save: (secret: string, value: string) => void; forgetRecoveryKey: () => void };
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
  /** The model step (models-openrouter): Connect's pending states and exchange, the 1-token check and the vault's key. */
  model?: ModelStep;
  /** The app doors' origins as one CSP source (`http://*.localhost:3130`), when there is a door: sign-in ends on a door host. */
  doorSource?: () => string | undefined;
  /** The board's front door: /recovery-key and the model step send the owner on to its welcome. */
  boardUrl?: () => string | undefined;
  /** Code review's optional GitHub App (github-app.ts), while the github module is on: made from the manifest flow, saved by the kernel alone. */
  githubApp?: { name: () => string; ready: () => boolean; convert: (code: string) => Promise<MadeApp>; save: (app: MadeApp) => void; remove: () => void };
  /** Release updates (updates.ts): what the updater recorded, and Update now (an admin's tap) for the release it shows. */
  updates?: { view: () => UpdateState; requestNow: (release: string, by: string) => string };
  log?: (msg: string, f?: Record<string, unknown>) => void;
};

/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.ts reads it. */
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
  { method: "GET", path: "/setup/openrouter/:state", auth: "pkce-state" },
  { method: "GET", path: "/setup/github-app", auth: "admin" },
  { method: "POST", path: "/setup/github-app", auth: "admin+csrf" },
  { method: "GET", path: "/setup/github-app/:state", auth: "manifest-state" },
  { method: "GET", path: "/recovery-key", auth: "admin" },
  { method: "POST", path: "/recovery-key", auth: "admin+csrf" },
  { method: "GET", path: "/", auth: "admin" },
  { method: "GET", path: "/approvals", auth: "admin" },
  { method: "GET", path: "/approvals/:id", auth: "admin" },
  { method: "GET", path: "/owner/message", auth: "admin" },
  { method: "POST", path: "/owner/message", auth: "admin+csrf" },
  { method: "GET", path: "/owner/confirm", auth: "admin" },
  { method: "POST", path: "/owner/confirm", auth: "admin+csrf" },
  { method: "GET", path: "/updates", auth: "admin" },
  { method: "POST", path: "/updates", auth: "admin+csrf" },
  { method: "GET", path: "/.well-known/oauth-authorization-server", auth: "none" },
  { method: "GET", path: "/oauth2/authorize", auth: "admin" },
  { method: "POST", path: "/oauth2/token", auth: "oauth-client" },
  { method: "POST", path: "/oauth2/register", auth: "none" },
  { method: "POST", path: "/oauth2/revoke", auth: "oauth-client" },
  { method: "GET", path: "/oauth/consent", auth: "admin" },
  { method: "POST", path: "/oauth/consent", auth: "admin+csrf" },
] as const;
/** OAuth's client endpoints: called by MCP clients, not posted from a page here. */
const OAUTH_CLIENT = new Set(["/oauth2/token", "/oauth2/register", "/oauth2/revoke"]);
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(":id", "(k-[0-9a-f]{16})").replace(":state", "([\\w-]{22})")}$`) }));
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

/** A secret a module asks for on /setup (its provided secret's `setup:`, compiled into config/kernel/modules.json `setup`). */
export type SetupField = { module: string; secret: string; label: string; pattern: string; help?: string; required?: boolean };
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

/** The /updates page: the release this server follows, the one available with what changed, the last install, and Update now. */
function updatesPage(u: UpdateState, form: (inner: string) => string): string {
  const when = (t?: string | null) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");
  if (!u.current) return `<h1>Updates</h1><p>This server doesn't follow a release, so it never updates itself: its product is pinned by hand (docs/setup.md, Upgrading the product).</p>`;
  const a = u.available;
  const last = u.last ? `<div class="card"><b>Last update:</b> ${esc(u.last.release)} ${u.last.outcome === "installed" ? `<span class="ok">installed</span>` : `<span class="err">failed</span>: ${esc(u.last.why ?? "")}`} · ${esc(when(u.last.at))} · by ${esc(u.last.by)}</div>` : "";
  const avail = a
    ? `<div class="card"><h2>${esc(a.name)} is available</h2>${a.notes.length ? `<ul>${a.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}<p class="muted">Every change since ${esc(a.from.name)}: <a href="${esc(a.compare)}" target="_blank" rel="noopener">${esc(a.compare)}</a></p>
<p class="muted">Verified against the official release: its commits, its tested stamp and its image digests. Update now files it as an apply, like any change to this server: the AI reviewer checks it while auto-updates are on, else it waits for your approval; a failed health check puts this server back on ${esc(a.from.name)}.</p>
${form(`<input type="hidden" name="release" value="${esc(a.name)}"><button class="b">Update now</button>`)}</div>`
    : `<p>${u.error ? `<span class="err">${esc(u.error)}</span>` : "Nothing newer is out."}</p>`;
  return `<h1>Updates</h1><p>This server runs <b>${esc(u.current.name)}</b>. Auto-updates are <b>${u.auto ? "on" : "off"}</b>${u.auto ? `: a newer release is filed between 02:00 and 05:00 (${esc(u.timezone ?? "UTC")}) and installs on the AI reviewer's yes` : ": you're told, and Update now files it for your approval"}. Change it in the board's Settings (auto_update). Last checked ${esc(when(u.checkedAt))}.</p>${avail}${last}`;
}

export function createAdmin(d: Deps) {
  const log = d.log ?? (() => {});
  const csrf = (s: AdminSession) => createHmac("sha256", d.accounts.secret).update(`csrf:${s.session.id}`).digest("hex");
  const proto = (req: IncomingMessage) => (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http");

  const boardOrigin = () => { const u = d.boardUrl?.(); return u ? ` ${new URL(u).origin}` : ""; };
  function send(res: ServerResponse, status: number, html: string, frame?: string[], extra: Record<string, string | string[]> = {}) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: under no-referrer a browser posts these forms with Origin: null, which the check refuses.
      "referrer-policy": "same-origin",
      ...(frame ? {} : { "x-frame-options": "DENY" }),
      // A form that succeeds redirects to the board's welcome, or (sign-in from an app door) through /auth/handoff to that
      // door: browsers apply form-action to the whole redirect chain.
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${boardOrigin()}${d.doorSource?.() ? ` ${d.doorSource()}` : ""}; base-uri 'none'; frame-ancestors ${frame?.length ? frame.join(" ") : "'none'"}`,
      ...extra,
    }).end(html);
  }
  const doc = (title: string, body: string, s?: AdminSession | null, head = "") =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${esc(title)} · AidenHQ</title><style>${CSS}</style></head><body>` +
    (s?.ready ? `<header><b>AidenHQ</b><a href="${esc(`${d.boardUrl?.() ?? ""}/#/`)}">Home</a><a href="/owner/message">Message</a>${d.updates?.view().current ? `<a href="/updates">Updates</a>` : ""}<a href="/auth/password">Password</a><form method="post" action="/auth/sign-out"><button>Sign out</button></form></header>` : "") +
    `<main>${body}</main></body></html>`;
  const redirect = (res: ServerResponse, to: string, cookies: string[] = []) =>
    void res.writeHead(303, { location: to, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) }).end();
  const form = (action: string, inner: string, s?: AdminSession | null) => `<form method="post" action="${esc(action)}">${s ? `<input type="hidden" name="csrf" value="${csrf(s)}">` : ""}${inner}</form>`;
  const safeNext = (n: string | null) => (n && (/^\/(approvals|owner|recovery-key|setup\/model)[\w/?=&.-]*$/.test(n) || /^\/(auth\/handoff|oauth2\/authorize)\?[\w=&.%:~+-]*$/.test(n)) ? n : welcome());

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
  // Pending GitHub App manifests, by their state: the account or org it is for and the admin who started it.
  const appPending = new Map<string, { org: string; account: string; at: number; gen: number; code?: string }>();
  // Each save or removal of the App moves this on: a flow started before one (another tab) is refused, never saved over it.
  let appGen = 0;
  // The board's own sign-in handoff (services/board/src/kernel-auth.ts): the owner arrives signed in there, and the board's
  // welcome gate opens #/welcome until setup is finished.
  // A sign-in with nowhere else to go (it began at the board, or on this page) ends there too, never on the approvals list.
  const welcome = () => (d.boardUrl?.() ? `${d.boardUrl()}/auth/start` : "/auth/password");
  // The owner goes on to the model step, or (a model key given at install) straight to the board's welcome, which shows the
  // recovery key and the modules' flows until it is finished.
  const afterEnrol = (s: AdminSession) => (d.model && s.account.owner ? (d.model.ready() ? welcome() : "/setup/model") : welcome());
  const NOT_CONNECTED = "OpenRouter didn't connect (cancelled, expired or from another page). Try again.";
  const modelPage = (req: IncomingMessage, s: AdminSession, msg = "", credit = false) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    const origin = d.origins().find((o) => new URL(o).host === host || new URL(o).hostname === host); // proxies differ in the Host they pass on
    const callable = origin && (origin.startsWith("https://") || new URL(origin).hostname === "localhost");
    // Two equal ways: a key the owner already has, and (where OpenRouter can call back) Connect.
    let connect = "";
    if (callable) {
      const url = d.model!.connect((state) => `${origin}/setup/openrouter/${state}`, s.account.id);
      connect = `<div class="card"><h2>Connect your account</h2><p class="muted">Sign in to OpenRouter (or make an account) and approve; you come straight back here.</p><a class="b" href="${esc(url)}">Connect OpenRouter</a></div>`;
    }
    const field = d.firstRun?.fields().find((f) => f.secret === MODEL_KEY);
    // A pasted key keeps whatever limit it has; the install's daily spend limit stops spend first.
    const cap = d.model?.dayCap();
    const capLine = cap ? `<p class="muted">This key's own limit applies; AidenHQ also stops at $${cap}/day (change it in Settings).</p>` : "";
    const paste = `<div class="card"><h2>Use your API key</h2><p class="muted">Paste a key you have, or make one at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a>.</p>${form("/setup/model", `<input type="hidden" name="action" value="paste"><label>${esc(field?.label ?? "OpenRouter API key")}<input name="${MODEL_KEY}" type="password" autocomplete="off" maxlength="300" placeholder="sk-or-…" required></label><button class="b">Save</button>`, s)}${capLine}</div>`;
    const retry = credit ? `<div class="card"><p>Your OpenRouter account needs credit before agents can run.</p><p><a href="${CREDITS}" target="_blank" rel="noopener">Add credit in OpenRouter</a>, then retry.</p>${form("/setup/model", `<input type="hidden" name="action" value="retry"><button class="b">Retry</button>`, s)}</div>` : "";
    const has = d.model?.ready() && !credit ? `<p class="muted">A working key is already in the vault; saving or connecting replaces it. <a href="${esc(welcome())}">Continue</a></p>` : "";
    return doc("Connect a model", `<h1>Connect a model</h1><p>Your agents think with AI models on OpenRouter. The key goes into the vault, read only by the kernel's model gateway.</p>${msg}${retry}${has}${credit ? "" : `<div class="pick">${paste}${connect}</div>`}`, s);
  };
  async function useKey(req: IncomingMessage, res: ServerResponse, s: AdminSession, key: string) {
    const r = await d.model!.take(key, `account:${s.account.id}`);
    if (r === "error") return send(res, 400, modelPage(req, s, err("OpenRouter didn't accept a call with that key. Try again, or paste another key.")));
    if (r === "no_credit") return send(res, 200, modelPage(req, s, "", true));
    return redirect(res, welcome());
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
    let url: URL;
    try {
      url = new URL(String(req.url ?? "/"), "http://x");
    } catch {
      return void res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
    }
    const host = String(req.headers.host ?? "").toLowerCase();
    try {
      if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      if (!d.hosts().includes(host)) throw new Refusal(421, "unknown host");
      // A page a browser opens at 127.0.0.1 moves to localhost (the sign-in's own origin); the cookie hop across the two dead-ends
      // otherwise. Only a browser navigation moves: health checks and probes on 127.0.0.1 get their answer.
      const local = host.replace(/^127\.0\.0\.1/, "localhost");
      if ((req.method === "GET" || req.method === "HEAD") && req.headers["sec-fetch-mode"] === "navigate" && local !== host && d.hosts().includes(local)) return void res.writeHead(308, { location: `http://${local}${req.url ?? "/"}`, "cache-control": "no-store" }).end();
      const hit = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) throw new Refusal(404, "not found");
      const id = hit.re.exec(url.pathname)![1] ?? "";
      if (OAUTH_CLIENT.has(hit.path) || hit.path === "/.well-known/oauth-authorization-server") return await d.accounts.oauth(req, res, hit.path, url.search);
      if (req.method === "POST" && !d.origins().includes(String(req.headers.origin ?? ""))) {
        const accepted = d.origins();
        const header = req.headers.origin;
        const came = header === undefined || header === "" ? "no Origin" : `the Origin ${header.length > 200 ? `${header.slice(0, 200)} (cut)` : header}`;
        throw new Refusal(403, `this form came from ${came}, which this listener doesn't accept; it accepts ${accepted.join(", ") || "no origins"}`);
      }
      const next = url.searchParams.get("next") ?? "";
      switch (`${hit.method} ${hit.path}`) {
        case "GET /oauth2/authorize": {
          const s = await d.accounts.sessionOf(req);
          const here = url.pathname + url.search;
          if (!s) {
            // An MCP client opened this from another site, so the SameSite=Strict cookie wasn't sent: one same-site hop brings it.
            if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 200, doc("Connecting", `<p><a href="${esc(here)}">Continue</a></p>`, null, `<meta http-equiv="refresh" content="0;url=${esc(here)}">`));
            return redirect(res, `/auth/sign-in?next=${encodeURIComponent(here)}`);
          }
          if (!s.ready) throw new Refusal(403, "only an admin with an authenticator connects an MCP client");
          return await d.accounts.oauth(req, res, "/oauth2/authorize", url.search);
        }
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
        case "GET /setup/openrouter/:state": {
          // OpenRouter's callback (header): no session; the state's pending entry, single-use and fresh; a denial carries no code.
          if (!d.model || !d.firstRun) throw new Refusal(404, "not found");
          // No entry (a reload, an old or made-up state): no outcome, so this unauthenticated page says nothing of the vault.
          const outcome = await d.model.callback(id, url.searchParams.get("code") ?? "");
          const to = `/setup/model${outcome ? `?connect=${outcome}` : ""}`;
          return send(res, 200, doc("Connecting", `<p>Back from OpenRouter. <a href="${to}">Continue</a></p>`, null, `<meta http-equiv="refresh" content="0;url=${to}">`));
        }
        case "GET /setup/github-app/:state": {
          // GitHub's return from the App manifest flow is a cross-site navigation, so no session cookie: it only keeps GitHub's
          // code on the pending entry the owner's page made (single-use, 10 minutes) and moves on same-site, where the owner's
          // session comes back and must be the one that started it (/setup/github-app?finish=).
          if (!d.githubApp) throw new Refusal(404, "not found");
          const p = appPending.get(id), code = url.searchParams.get("code") ?? "";
          if (p && !p.code && code && url.searchParams.get("state") === id && Date.now() - p.at <= 600_000) p.code = code;
          else appPending.delete(id);
          const to = `/setup/github-app?finish=${encodeURIComponent(id)}`;
          return send(res, 200, doc("GitHub App", `<p>Back from GitHub. <a href="${to}">Continue</a></p>`, null, `<meta http-equiv="refresh" content="0;url=${to}">`));
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
          // An app door (docs/design/app-doors.md): the gate's own handoff on that app host, which sets its host-only cookie.
          if (!module && d.accounts.mintDoorCode) {
            const code = d.accounts.mintDoorCode(s, to, state);
            const next = url.searchParams.get("next") ?? "/";
            log("session handed to an app door", { origin: to, by });
            return redirect(res, `${to}/.auth/handoff?${new URLSearchParams({ code, state, next: next.length <= 2000 ? next : "/" })}`);
          }
          if (!module) throw new Refusal(400, "that address isn't an installed module's");
          const code = d.accounts.mintUiCode(s, module, to, state);
          log("session handed to a module", { module, origin: to, by });
          return redirect(res, `${to}/auth/handoff?${new URLSearchParams({ code, state })}`);
        }
        case "GET /setup/github-app": case "POST /setup/github-app": {
          // Code review's GitHub App: the owner's alone (not another admin's); replacing one only when the owner says so.
          const gh = d.githubApp;
          if (!gh) throw new Refusal(404, "not found");
          if (!s.account.owner) throw new Refusal(403, "only the owner sets up code review's GitHub App");
          const page = (body: string, status = 200, extra: Record<string, string> = {}) => send(res, status, doc("GitHub App", body, s), undefined, extra);
          const ask = (m = "", org = "") => page(`<h1>Code review's GitHub App</h1><p>Code review can post as its own GitHub App, so its reviews, comments and the <code>aidenhq/review</code> status don't share your GitHub write limit. It is optional: wherever the App isn't installed, code review posts as you, as now. Your agents' pull requests, pushes and comments stay yours either way.</p>${m}${form("/setup/github-app", `<label>Who owns the App: an organization you own, or leave it empty for your own account<input name="org" maxlength="39" value="${esc(org)}" placeholder="your account"></label>${gh.ready() ? `<p class="muted">An App is already set up. A new one replaces its key here: the old App stops posting.</p><label><input type="checkbox" name="replace" value="1" required style="width:auto"> Replace the App</label>` : ""}<button class="b">Continue</button>`, s)}${gh.ready() ? `<h2>Stop using it</h2>${form("/setup/github-app", `<input type="hidden" name="remove" value="1"><p class="muted">Code review posts as you everywhere again. Uninstall or delete the App on GitHub yourself.</p><button class="b r">Remove the App</button>`, s)}` : ""}`, m ? 400 : 200);
          const finish = url.searchParams.get("finish");
          if (req.method === "GET" && finish) {
            const p = appPending.get(finish);
            appPending.delete(finish);
            if (!p?.code || p.account !== s.account.id || Date.now() - p.at > 600_000) return ask(err("That GitHub App link expired, was already used or was started by someone else. Start again."));
            if (p.gen !== appGen) return ask(err("The App was saved or removed since this was started (another tab?). Start again."));
            try {
              const app = await gh.convert(p.code);
              if (p.gen !== appGen) return ask(err("The App was saved or removed while GitHub made this one. Start again."));
              gh.save(app);
              appGen++;
              log("github app created", { app: app.id, slug: app.slug, owner: app.owner, by });
              const install = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
              return page(`<h1>GitHub App created</h1><p>The App <code>${esc(app.slug)}</code> is in your vault. Last step: <a class="b" href="${esc(install)}">Install it</a> on each organization (or only the repositories) code review watches.</p><p class="muted">Code review posts as the App on the repositories it is installed on, from its next write; elsewhere it posts as you. The GitHub card on the board shows which, per organization.</p>`);
            } catch (e) {
              log("github app not created", { err: (e as Error).message.slice(0, 200) });
              return ask(err(`Not created: ${(e as Error).message}`));
            }
          }
          if (req.method === "GET") return ask();
          if (f.get("remove") === "1") {
            gh.remove();
            appGen++;
            log("github app removed", { by });
            return page(`<h1>GitHub App removed</h1><p>Code review posts as you everywhere from its next write. Uninstall or delete the App on GitHub when you like.</p>`);
          }
          const org = (f.get("org") ?? "").trim();
          if (org && !ORG.test(org)) return ask(err("That isn't a GitHub organization name."), org);
          if (gh.ready() && f.get("replace") !== "1") return ask(err("An App is already set up: tick Replace the App to make a new one."), org);
          const origin = d.origins().find((o) => new URL(o).host === host || new URL(o).hostname === host);
          if (!origin) throw new Refusal(400, "this page's address isn't one of the kernel's");
          for (const [k, v] of appPending) if (Date.now() - v.at > 600_000) appPending.delete(k);
          const state = randomBytes(16).toString("base64url");
          appPending.set(state, { org, account: s.account.id, at: Date.now(), gen: appGen });
          const m = manifest(gh.name(), `${origin}/setup/github-app/${state}`);
          const action = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;
          return page(`<h1>Create code review's GitHub App</h1><p>GitHub shows the App and its permissions: pull requests (write: reviews and their comments), commit statuses (write: <code>aidenhq/review</code>), repository contents (write: the one-hour, single-repo tokens a session box's <code>git push</code> uses), and checks, actions and issues (read: the fleet reads your repos as the App, so it doesn't spend your GitHub rate limit). An App made before a permission was asked needs it accepted on GitHub (the App's settings, Permissions, then each installation's review); until then those reads use your account. Approve it there; you come straight back here and its key goes into your vault.</p><form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(m))}"><button class="b">Create on GitHub</button></form>`, 200, {
            // This one form posts the manifest to GitHub.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'",
          });
        }
        case "GET /setup/model": case "POST /setup/model": {
          if (!d.model || !d.firstRun) throw new Refusal(404, "not found");
          if (!s.account.owner) throw new Refusal(403, "only the owner picks the model");
          if (req.method === "GET") {
            // `connect`: the outcome OpenRouter's callback came back with (only which message shows; the vault says what's true).
            const connect = url.searchParams.get("connect");
            if (connect === "ok" && d.model.ready()) return redirect(res, welcome());
            if (connect === "credit") return send(res, 200, modelPage(req, s, "", true));
            return send(res, connect === "failed" ? 400 : 200, modelPage(req, s, connect === "failed" ? err(NOT_CONNECTED) : ""));
          }
          const action = f.get("action");
          if (action === "retry") return useKey(req, res, s, d.model.saved());
          if (action !== "paste") throw new Refusal(400, "paste or retry");
          const key = (f.get(MODEL_KEY) ?? "").trim(), field = d.firstRun.fields().find((x) => x.secret === MODEL_KEY);
          if (!key || key.length > 300 || /\s/.test(key) || !d.model.fits(key)) return send(res, 400, modelPage(req, s, err(`That isn't a valid ${field?.label ?? "OpenRouter API key"}.`)));
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
        // The board is the one approvals UI (its Approvals page and #/approvals/<id>, deciding through /v1/owner/decide): an
        // old link or bookmark to this listener's approvals goes there.
        case "GET /": case "GET /approvals": return redirect(res, `${d.boardUrl?.() ?? ""}/#/`);
        case "GET /approvals/:id": return redirect(res, `${d.boardUrl?.() ?? ""}/#/approvals/${id}`);
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
        case "GET /oauth/consent": {
          // Better Auth's signed authorize query: its own consent endpoint checks the signature, the client and the session.
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          let to = "";
          try { to = new URL(redirectUri).origin; } catch { throw new Refusal(400, "this sign-in link is incomplete: start again from your MCP client"); }
          const query = url.search.slice(1);
          const choose = (accept: boolean, label: string, cls: string) => form("/oauth/consent", `<input type="hidden" name="oauth_query" value="${esc(query)}"><input type="hidden" name="accept" value="${accept}"><button class="b ${cls}">${label}</button>`, s);
          const name = d.accounts.mcpClientName(url.searchParams.get("client_id") ?? "");
          return send(res, 200, doc("Connect", `<h1>Connect ${esc(name)}</h1><p><b>${esc(name)}</b> wants to manage AidenHQ as you: read everything you can, and act as you, approvals included.</p><p class="muted">It goes back to ${esc(to)}. Revoke it any time on the board's account page.</p><div style="display:flex;gap:8px">${choose(true, "Allow", "")}${choose(false, "Cancel", "r")}</div>`, s), undefined, {
            // Allow and Cancel redirect to the client's own address: browsers hold the whole redirect chain to form-action.
            "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${to}; base-uri 'none'; frame-ancestors 'none'`,
          });
        }
        case "POST /oauth/consent": {
          const r = await step(req, "/oauth2/consent", { accept: f.get("accept") === "true", oauth_query: f.get("oauth_query") ?? "" });
          if (!r.ok || typeof r.json.url !== "string") throw new Refusal(r.status >= 500 ? 502 : 400, `not connected: ${r.error || "start again from your MCP client"}`);
          log("MCP client consent", { accept: f.get("accept") === "true", client: new URLSearchParams(f.get("oauth_query") ?? "").get("client_id"), by });
          return redirect(res, r.json.url);
        }
        case "GET /updates": {
          if (!d.updates) throw new Refusal(404, "not found");
          return send(res, 200, doc("Updates", updatesPage(d.updates.view(), (inner) => form("/updates", inner, s)), s));
        }
        case "POST /updates": {
          if (!d.updates) throw new Refusal(404, "not found");
          const release = String(f.get("release") ?? "");
          if (!/^\d{4}\.\d{1,2}(\.\d+){0,2}$/.test(release)) throw new Refusal(400, "which release?");
          let said: string;
          try { said = d.updates.requestNow(release, by); } catch (e) { throw new Refusal(409, (e as Error).message); }
          log("update now", { release, by });
          return send(res, 200, doc("Updating", `<p class="ok">${esc(said)}</p><a href="/updates">Back to updates</a>`, s));
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
