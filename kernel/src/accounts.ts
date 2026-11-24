// K3 accounts (spec §2.1, §2.6; lean 3a, 3g): Better Auth on data/kernel/auth/auth.db, and the kernel is the only process that
// opens it. Admins sign in on the admin listener (127.0.0.1:3120) with email, password and TOTP; a session counts only when it
// is a ready admin's (TOTP enrolled, not disabled). Here too (from the board, 3g):
// - the gate-facing sign-in surface (signin.ts on 127.0.0.1:3129): Better Auth's sign-in steps for the my-apps host, and the
//   gate's one-time handoffs to each app host (an app host session, linked to the sign-in host's);
// - module UI sessions (the board on its own origin): /auth/handoff on the admin listener mints a one-time code for an allowed
//   UI origin, the module exchanges it on the backplane (POST /v1/auth/exchange) for its own session token, sets it in its own
//   host-only cookie and checks it on every request (POST /v1/auth/session), so a sign-out, a disable or a reset ends it;
// - account admin (invite, role, disable, links, sessions), setup and reset links, app access (app-access.ts) and the gate's
//   account map (data/gate/accounts.json).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createAppAccess, type Manifest, type SharedApp } from "../../modules/apps-platform/src/app-access.ts";
import { createTestSessions } from "./test-session.ts";
import { AccountError, authCore, authSecret, forwardedProto, GATE_HEADER, inboundCookies, openAuthDb, outboundCookie, readBody, secretIs, EDGE_HEADER, type Log } from "./auth-rules.ts";

export { AccountError };
export type Role = "admin" | "user";
export type Step = { ok: boolean; status: number; retryAfter?: string; json: Record<string, any>; cookies: string[]; error: string };

/** An account as the board and the other lanes see it. */
export interface Account {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Exactly one account: the instance's owner (his words carry the owner's authority). */
  owner: boolean;
  twoFactorEnabled: boolean;
  /** Disabled by an admin: no sign-in and no session anywhere. */
  disabled: boolean;
  /** Sign-ins refused from some address until then (the lockout); open sessions are unaffected. */
  lockedUntil: string | null;
  createdAt: string;
}
/** A signed-in browser: its account and Better Auth session. `ready`: an admin with TOTP enrolled. */
export type AdminSession = { account: Account; session: { id: string; expiresAt: string }; ready: boolean };

/**
 * What the kernel reads from the gate's config (config/gate.json, scripts/edge.ts), re-read on use: the sign-in host
 * (my_apps.host), the app hosts, and whether apps sign in with a password (login: password) or Cloudflare Access.
 */
export interface GateInfo {
  password: boolean;
  myAppsHost?: string;
  appHosts: string[];
  /** The gate serves pull request previews of the app hosts (settings.edge.previews): pr-<n>.<host>. */
  previews?: boolean;
  /** The shared apps by name: their host and the registry's default role (share.default_role), if any. */
  apps?: Record<string, SharedApp>;
  /** App doors (docs/design/app-doors.md): every exposed app at <name>.<base>, named by browsers with this scheme and port. */
  door?: { base: string; scheme: "http" | "https"; port?: number };
  /** The module door (docs/design/app-doors.md): its exact origin (the board's host on the door port) → the gate's host for it. */
  moduleDoors?: Record<string, string>;
  /** settings.edge.test_user: the one non-owner account an allowlisted agent may sign in as, for these shared apps only. */
  test?: { email: string; apps: string[] };
  /** The gate's test listener (loopback/bridge only, never proxied): its address and the apps' hosts it may serve. */
  testListener?: { address: string; port: number };
}

export function readGate(file: string): GateInfo | undefined {
  try {
    const g = JSON.parse(readFileSync(file, "utf8")) as { login?: string; my_apps?: { host?: string }; hosts?: Record<string, { app?: string; default_role?: string; door?: unknown; origin?: unknown }>; previews?: unknown; doors?: { base?: unknown }; origin?: { scheme?: unknown; port?: unknown } };
    const door = typeof g.doors?.base === "string" && g.doors.base ? { base: g.doors.base.toLowerCase(), scheme: g.origin?.scheme === "http" ? "http" as const : "https" as const, ...(Number.isInteger(g.origin?.port) ? { port: g.origin!.port as number } : {}) } : undefined;
    // A module door is a door, not a shared app: never an app host or a shared app, only an origin a door handoff may name.
    const entries = Object.entries(g.hosts ?? {});
    const shared = entries.filter(([, h]) => h.door !== true);
    const moduleDoors = Object.fromEntries(entries.filter(([, h]) => h.door === true && typeof h.origin === "string").map(([host, h]) => [String(h.origin), host.toLowerCase()]));
    const apps = Object.fromEntries(shared.map(([host, h]) => [String(h.app), { host: host.toLowerCase(), ...(h.default_role ? { defaultRole: h.default_role } : {}) }]));
    // The test user is only ever a shared app's identity: an app or address the gate doesn't serve is never in the block.
    const rawTest = (g as { test_user?: unknown }).test_user;
    const test = rawTest && typeof rawTest === "object" && typeof (rawTest as { email?: unknown }).email === "string" && Array.isArray((rawTest as { apps?: unknown }).apps)
      ? { email: String((rawTest as { email: string }).email).trim().toLowerCase(), apps: ((rawTest as { apps: unknown[] }).apps).filter((a): a is string => typeof a === "string") }
      : undefined;
    const rawListener = (g as { test_listener?: unknown }).test_listener;
    const testListener = rawListener && typeof rawListener === "object" && typeof (rawListener as { address?: unknown }).address === "string" && Number.isInteger((rawListener as { port?: unknown }).port)
      ? { address: String((rawListener as { address: string }).address), port: Number((rawListener as { port: number }).port) }
      : undefined;
    return { password: g.login === "password", myAppsHost: g.my_apps?.host?.toLowerCase(), appHosts: shared.map(([h]) => h.toLowerCase()), previews: !!g.previews, apps, ...(door ? { door } : {}), ...(Object.keys(moduleDoors).length ? { moduleDoors } : {}), ...(test ? { test } : {}), ...(testListener ? { testListener } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * An app host the gate serves: one of gate.json's, or (with previews) a preview of one, `pr-<n>.<host>`, as
 * modules/apps-platform/gate/gate.ts derives it. Whether that preview runs is the gate's to check.
 */
export function isAppHost(g: GateInfo | undefined, host: string): boolean {
  if (!g) return false;
  if (g.appHosts.includes(host)) return true;
  const m = /^pr-[1-9][0-9]{0,5}\.(.+)$/.exec(host);
  return !!g.previews && !!m && g.appHosts.includes(m[1]!);
}

/**
 * The app host a door origin names (the module door's exact origin, or `<scheme>://<name>.<base>[:<port>]`, exactly, as the
 * gate builds it), or undefined. Only
 * the name's shape is checked here; whether that app runs is the gate's to check, as for previews.
 */
export function doorHost(g: GateInfo | undefined, origin: string): string | undefined {
  if (g?.moduleDoors && Object.hasOwn(g.moduleDoors, origin)) return g.moduleDoors[origin];
  const d = g?.door;
  if (!d) return undefined;
  const prefix = `${d.scheme}://`, suffix = `.${d.base}${d.port ? `:${d.port}` : ""}`;
  if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) return undefined;
  const name = origin.slice(prefix.length, origin.length - suffix.length);
  return /^[a-z][a-z0-9-]{1,30}$/.test(name) ? `${name}.${d.base}` : undefined;
}

/** Every door origin as CSP source expressions (`http://*.localhost:3130`, the module door's origin), or undefined without a door. */
export const doorSource = (g: GateInfo | undefined): string | undefined =>
  [...(g?.door ? [`${g.door.scheme}://*.${g.door.base}${g.door.port ? `:${g.door.port}` : ""}`] : []), ...Object.keys(g?.moduleDoors ?? {})].join(" ") || undefined;

const HANDOFF_TTL_MS = 60_000;
/** The board's MCP endpoint: the resource (RFC 8707) every MCP client's token names. */
export const mcpResource = (boardUrl = "http://localhost:3121") => `${new URL(boardUrl).origin}/mcp`;
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dateOf = (v: string | number) => new Date(typeof v === "number" ? v : String(v));

export interface AccountsOptions {
  /** data/: the accounts file is data/kernel/auth/auth.db (":memory:" in tests). */
  dataDir: string;
  /** Host headers Better Auth answers to: the admin listener's and the sign-in listener's. */
  hosts: string[];
  /** Origins besides a request's own that may post: the admin front door's (a proxy may not pass it on as the Host). */
  origins?: string[];
  /** The admin listener's address (AIDENHQ_ADMIN_URL): where admin links open. */
  adminUrl?: string;
  /** The board's address (its front door, else its loopback one): MCP clients' tokens are for its /mcp. */
  boardUrl?: string;
  /** The front door's proof on the admin listener (edge_board_secret). */
  edgeSecret: () => string;
  /** The gate's proof on the sign-in listener (gate_board_secret): only a request carrying it may name the client's address. */
  gateSecret?: () => string;
  /** The gate's config, re-read on use (none: no shared apps, so no user links and no handoffs). */
  gate?: () => GateInfo | undefined;
  /** data/gate/accounts.json: the gate's account map, rewritten in place after every change (single-file mount). */
  gateAccountsFile?: string;
  /** Setup, invite and reset links last this long (hours; default 72; public exposure: 24, decision D9). */
  linkTtlHours?: number;
  /** settings.owner_email, read at each use: when set, setup makes only this email the owner's account. */
  ownerEmail?: () => string | undefined;
  /** One line to the owner's channel: sign-in alerts and new-sign-in notices. */
  notify: (line: string) => void;
  /** apps-mcp's manifest of one shared app at its running commit (custom roles, default). */
  manifest?: (app: string) => Promise<Manifest>;
  /** Wakes an app's maintaining agent when in-app requests wait (the app-request routine's webhook). */
  wake?: (app: string, count: number) => Promise<boolean>;
  /** Runs an app's "App feedback: <app>" routine (app-access.ts notify). */
  feedbackWake?: (app: string, count: number) => Promise<boolean>;
  /** A task as the control plane has it now (the test user's own task check). */
  task?: (id: string) => Promise<{ id: string; identifier?: string | null; status?: string; assigneeAgentId?: string | null } | undefined>;
  log: Log;
  now?: () => number;
}

export async function openAccounts(o: AccountsOptions) {
  const { log } = o;
  const LINK_TTL_MS = (o.linkTtlHours ?? 72) * 3_600_000;
  const dbPath = o.dataDir === ":memory:" ? ":memory:" : join(o.dataDir, "kernel", "auth", "auth.db");
  const secret = authSecret(dbPath); // before the file exists: a fresh install makes both, an old file without its secret refuses
  const db = openAuthDb(dbPath);
  // Module UI sessions (the board's): the token's hash, the admin listener's session it came from, the module and its origin.
  db.exec("CREATE TABLE IF NOT EXISTS ui_session (hash TEXT PRIMARY KEY, parent_id TEXT NOT NULL, module TEXT NOT NULL, origin TEXT NOT NULL)");
  // First-run setup's single-use token (/setup, spec §6.10): its hash only, at most one row.
  db.exec("CREATE TABLE IF NOT EXISTS setup_token (hash TEXT NOT NULL, expires INTEGER NOT NULL)");
  const https = (req: Pick<IncomingMessage, "headers">) => forwardedProto(req) === "https";
  /**
   * The admin listener's address as Better Auth sees it: the front door's own (AIDENHQ_ADMIN_URL, scheme and port) when a
   * request names its host, however the proxy passed it on, so the OAuth issuer and its endpoints are always that origin.
   */
  const front = o.adminUrl ? new URL(o.adminUrl) : undefined;
  const adminAddress = (req: Pick<IncomingMessage, "headers">): { host: string; proto?: "https" | "http" } => {
    const h = String(req.headers.host ?? "").toLowerCase();
    return front && (h === front.host || h === front.hostname) ? { host: front.host, proto: front.protocol === "https:" ? "https" : "http" } : { host: h };
  };

  /**
   * The gate's accounts.json (accounts: email, name, role, disabled; apps: each shared app's default and assignments; no
   * secrets), written in place (the gate mounts this one file). Exports run one at a time, each reading the database when it
   * starts, so they can't finish out of order; a caller awaits the run that starts after its own write, and hears when the
   * file couldn't be written (a revocation must never be reported done before the gate has it). Without edge (no gate
   * config) there is no gate to tell.
   */
  let exporting: Promise<void> = Promise.resolve();
  const writeGate = async () => {
    if (!o.gateAccountsFile || !o.gate?.()) return;
    const file = o.gateAccountsFile;
    // `list` leaves the test account out (it is never a board account), so the gate's map has it by absence, never as a row.
    const accountRows = (await accounts.list()).map((a) => ({ email: a.email, name: a.name, role: a.role, disabled: a.disabled }));
    const text = JSON.stringify({ accounts: accountRows, apps: apps.exportApps() }, null, 2) + "\n";
    if (!existsSync(dirname(file))) throw new Error(`the gate's accounts.json directory isn't there (${dirname(file)})`);
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    writeFileSync(file, text, { mode: 0o644 });
  };
  const changed = (): Promise<void> => {
    const run = exporting.then(writeGate, writeGate);
    exporting = run.catch((err) => log.error({ err: String(err) }, "writing the gate's accounts.json failed"));
    return run;
  };
  /** An account change on the gate before the caller returns, or an error saying it isn't there yet. */
  const exported = async () => {
    try {
      await changed();
    } catch (err) {
      throw new AccountError(503, `saved, but the gate hasn't got it yet (${(err as Error).message}); it retries within a minute`);
    }
  };

  const rules = authCore({
    db,
    secret,
    hosts: o.hosts,
    // The admin front door's origin, and the gate's sign-in host, which posts from its own https origin. The admin listener
    // checks every form's Origin against its own allowlist before Better Auth sees it, so the sign-in host never reaches it.
    trustedOrigins: () => {
      const h = o.gate?.()?.myAppsHost;
      return [...(o.origins ?? []), ...(h ? [`https://${h}`] : [])];
    },
    linkTtlMs: LINK_TTL_MS,
    mcpResource: mcpResource(o.boardUrl),
    notify: o.notify,
    // A new password ends every MCP grant too: a client signed in with the old one must sign in again.
    onPasswordReset: (user) => { endMcp(user.id); void changed().catch(() => {}); },
    log,
    ...(o.now ? { now: o.now } : {}),
  });
  await (await getMigrations(rules.options)).runMigrations();
  // Per-app roles, defaults, the change log and in-app requests (app-access.ts), by email.
  const apps = createAppAccess({
    db,
    gate: () => o.gate?.(),
    account: (email) => {
      const u = db.prepare("SELECT role, banned, banExpires FROM user WHERE email = ?").get(email) as { role: string; banned: number | null; banExpires: string | number | null } | undefined;
      if (!u) return undefined;
      const disabled = Boolean(u.banned) && (!u.banExpires || new Date(u.banExpires).getTime() > Date.now());
      return { role: u.role === "admin" ? "admin" : "user", disabled };
    },
    // The test user's own membership (test-session.ts): a member of the apps settings.edge.test_user names, never admin. Only
    // the account the kernel itself made is one: an existing account named in the setting keeps its own role, and a session
    // that names it is never minted (test-session.ts refuses an existing email).
    testMember: (app, email) => {
      const t = o.gate?.()?.test;
      return Boolean(t && t.email === email && t.apps.includes(app) && testSessions.isTestAccount(email));
    },
    // Every account the kernel minted for the canary is blocked everywhere the setting does not name it, even after the
    // setting is removed (the account row outlives it), so an app's default never hands it access.
    testAccount: (email) => testSessions.isTestAccount(email),
    ...(o.manifest ? { manifest: o.manifest } : {}),
    exported: changed,
    ...(o.wake ? { wake: o.wake } : {}),
    ...(o.feedbackWake ? { feedbackWake: o.feedbackWake } : {}),
    log,
  });
  const auth = betterAuth(rules.options);
  const ctx = await auth.$context;
  /**
   * The test-user page canary (test-session.ts): a real Better Auth session for one non-owner account, minted only by the
   * kernel's own route for an allowlisted agent's open task, and accepted only by the gate's test listener. Its account is
   * never in the gate's map, so no other surface can use it.
   */
  const testSessions = createTestSessions({
    db,
    createSession: async (userId, ttlMs, userAgent) => {
      // Better Auth's own row (never a hand-rolled token): the admin plugin's ban and the session table still apply. The TTL
      // is ours, so it goes in `overrideAll`: the third argument's expiresAt is overwritten by Better Auth's own default.
      const expiresAt = new Date(Date.now() + ttlMs);
      // The installed Better Auth types omit the fourth (overrideAll) argument though its runtime adapter takes it.
      const createSession = ctx.internalAdapter.createSession as unknown as (
        userId: string,
        dontRememberMe: boolean,
        session?: { expiresAt: Date; userAgent?: string },
        overrideAll?: { expiresAt: Date },
      ) => Promise<{ id: string; token: string; expiresAt: Date | string }>;
      const s = await createSession(userId, false, { expiresAt, userAgent }, { expiresAt });
      return { id: s.id, token: s.token, expiresAt: new Date(s.expiresAt).toISOString() };
    },
    deleteSession: async (id) => {
      const row = db.prepare("SELECT token FROM session WHERE id = ?").get(id) as { token: string } | undefined;
      if (row) await ctx.internalAdapter.deleteSession(row.token);
    },
    cookie: (token) => `${token}.${createHmac("sha256", ctx.secret).update(token).digest("base64")}`,
    // The listener's cookie is Better Auth's own signed form: only a signature this secret produced names a token.
    verifyCookie: (value) => {
      const [token, sig] = String(value ?? "").split(".");
      if (!token || !sig) return undefined;
      const want = createHmac("sha256", ctx.secret).update(token).digest("base64");
      const a = Buffer.from(sig), b = Buffer.from(want);
      return a.length === b.length && timingSafeEqual(a, b) ? token : undefined;
    },
    sessionLive: (id) => liveSession(id),
    testAccount: async (email) => {
      // First use makes it: no password, no invite, no mailbox, and never an account that already exists (an existing row is
      // refused rather than adopted, so the test user can never be the owner or an admin).
      const found = await ctx.internalAdapter.findUserByEmail(email);
      if (found) throw new AccountError(409, "that email is already an account: settings.edge.test_user.email must be its own");
      const user = await ctx.internalAdapter.createUser({ email, name: "AidenHQ test user", emailVerified: true, role: "user", owner: false }, { method: "admin" });
      // No credential at all: no password row, so no sign-in form, reset link or MCP consent can ever use this account. The
      // only way in is a minted test session, and only the gate's test listener accepts one.
      return { id: user.id, email };
    },
    testUser: () => o.gate?.()?.test,
    appHost: (app) => o.gate?.()?.apps?.[app]?.host,
    task: async (id) => {
      const r = await o.task?.(id);
      return r;
    },
    log,
    ...(o.now ? { now: o.now } : {}),
  });

  const toAccount = (u: Record<string, unknown>): Account => {
    const banExpires = u.banExpires ? new Date(u.banExpires as string | Date) : null;
    const banned = Boolean(u.banned) && (!banExpires || banExpires.getTime() > Date.now());
    const locked = rules.lockedUntil(String(u.email));
    return {
      id: String(u.id),
      email: String(u.email),
      name: String(u.name ?? ""),
      role: u.role === "admin" ? "admin" : "user",
      owner: Boolean(u.owner),
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
      disabled: banned,
      lockedUntil: locked ? new Date(locked).toISOString() : null,
      createdAt: new Date(u.createdAt as string | Date).toISOString(),
    };
  };

  async function find(id: string): Promise<Account> {
    const u = await ctx.internalAdapter.findUserById(id);
    if (!u) throw new AccountError(404, "no such account");
    return toAccount(u as unknown as Record<string, unknown>);
  }

  /** A one-time link token (LINK_TTL_MS); older unused links for the account stop working. */
  async function mintLink(userId: string): Promise<string> {
    await ctx.adapter.deleteMany({ model: "verification", where: [{ field: "value", value: userId }, { field: "identifier", operator: "starts_with", value: "reset-password:" }] });
    const token = randomBytes(24).toString("base64url");
    await ctx.internalAdapter.createVerificationValue({ value: userId, identifier: `reset-password:${token}`, expiresAt: new Date(Date.now() + LINK_TTL_MS) });
    return token;
  }

  /** A user's link opens on the gate's sign-in host, in password mode only (in access mode Cloudflare Access signs them in). */
  const signinUrl = () => {
    const g = o.gate?.();
    return g?.password && g.myAppsHost ? `https://${g.myAppsHost}` : undefined;
  };
  const linkFor = (a: Account, token: string) =>
    a.role === "admin" ? `${o.adminUrl ?? "http://localhost:3120"}/auth/set-password?token=${token}` : signinUrl() ? `${signinUrl()}/.auth/set-password#${token}` : null;

  /** One-time handoff codes (memory): code → the sign-in host's session, for one app host, for 60 s. */
  const handoffs = new Map<string, { userId: string; parentId: string; host: string; state: string; until: number }>();
  /** One-time module UI codes (memory): code → the admin listener's session, for one module's origin, for 60 s. */
  const uiCodes = new Map<string, { parentId: string; module: string; origin: string; state: string; until: number }>();
  /** A session that still exists and hasn't expired. */
  const liveSession = async (id: string) => {
    const row = db.prepare("SELECT expiresAt FROM session WHERE id = ?").get(id) as { expiresAt: string | number } | undefined;
    return Boolean(row && new Date(typeof row.expiresAt === "number" ? row.expiresAt : String(row.expiresAt)).getTime() > Date.now());
  };
  /** The session token in a request's cookies (`__Host-better-auth.session_token` on https, plain on http). */
  const sessionToken = (req: Pick<IncomingMessage, "headers">) => {
    const v = inboundCookies(req.headers.cookie, https(req)).split("; ").find((c) => c.startsWith("better-auth.session_token="))?.slice("better-auth.session_token=".length);
    return v ? decodeURIComponent(v).split(".")[0] : undefined;
  };
  const isHandoffSession = (token: string | undefined) => Boolean(token && db.prepare("SELECT 1 FROM handoff_session WHERE token = ?").get(token));
  /** A request's cookies, minus an app host's handed-off session (that one counts only on its app host, through the gate). */
  const cookieOf = (req: Pick<IncomingMessage, "headers">) => (isHandoffSession(sessionToken(req)) ? "" : inboundCookies(req.headers.cookie, https(req)));
  /** Ends an account's MCP grants (one client's, or all): tokens first, then the consent, so the client must ask again. */
  const endMcp = (userId: string, clientId?: string) => {
    const where = clientId ? "userId = ? AND clientId = ?" : "userId = ?";
    for (const t of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...(clientId ? [userId, clientId] : [userId]));
  };
  const endHostSession = async (token: string) => {
    await ctx.internalAdapter.deleteSession(token);
    db.prepare("DELETE FROM handoff_session WHERE token = ?").run(token);
  };

  async function create(input: { email: string; name: string; role: Role; owner?: boolean; password?: string }): Promise<Account> {
    const email = input.email.trim().toLowerCase();
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new AccountError(409, "an account with this email already exists");
    const user = await ctx.internalAdapter.createUser({ email, name: input.name || email, emailVerified: true, role: input.role, owner: Boolean(input.owner) }, { method: "admin" });
    // Without a password (invites, setup links), an unusable random one: the link sets the real one.
    await ctx.internalAdapter.linkAccount({ providerId: "credential", accountId: user.id, userId: user.id, password: await ctx.password.hash(input.password ?? randomBytes(32).toString("base64url")) });
    void changed().catch(() => {}); // nobody signs in with it before its link is claimed (that exports again)
    return find(user.id);
  }

  /** Reset links waiting for the owner channel to send them to the owner's Telegram (never back to the caller). */

  const accounts = {
    db,
    secret,
    /** The test-user page canary's own store (test-session.ts): mint, redeem, check, revoke, audit. */
    test: testSessions,

    /** Whether this email is the test user's (never a board account; app-access resolves its one membership). */
    isTestAccount: (email: string) => testSessions.isTestAccount(email),

    /** The account behind a request's cookie, or null (no, expired or revoked session; disabled account; an app host's session). */
    async sessionOf(req: Pick<IncomingMessage, "headers">): Promise<AdminSession | null> {
      const cookie = cookieOf(req);
      if (!cookie) return null;
      const s = await auth.api.getSession({ headers: new Headers({ cookie, host: String(req.headers.host ?? "") }) }).catch(() => null);
      // A test-user session is never an admin's, whatever cookie jar it reaches: only the gate's test listener accepts it.
      if (!s || isHandoffSession(s.session.token) || testSessions.isTestToken(s.session.token)) return null;
      const account = toAccount(s.user as unknown as Record<string, unknown>);
      if (account.disabled) return null;
      return { account, session: { id: s.session.id, expiresAt: new Date(s.session.expiresAt).toISOString() }, ready: account.role === "admin" && account.twoFactorEnabled };
    },

    /**
     * One Better Auth step for a kernel page: the form's fields as JSON, with the browser's own headers and cookies. Its
     * cookies come back host-only for this listener, its refusal as text.
     */
    async step(req: IncomingMessage, sub: string, body: Record<string, unknown>): Promise<Step> {
      const changing = sub === "/change-password" ? await accounts.sessionOf(req) : null;
      const r = await rules.call(auth, req, sub, "admin", { body: Buffer.from(JSON.stringify(body)), ...adminAddress(req), trusted: secretIs(req.headers[EDGE_HEADER], o.edgeSecret()), cookie: cookieOf(req) });
      const json = (await r.json().catch(() => ({}))) as Record<string, any>;
      const cookies = r.headers.getSetCookie().map((c) => outboundCookie(c, https(req), "admin"));
      if (r.ok && sub === "/sign-out") await accounts.endHandedOff(req);
      if (r.ok && changing) endMcp(changing.account.id);
      return { ok: r.ok, status: r.status, ...(r.headers.get("retry-after") ? { retryAfter: r.headers.get("retry-after")! } : {}), json, cookies, error: r.ok ? "" : String(json.message ?? json.error ?? json.code ?? `refused (${r.status})`) };
    },

    /** Serves one Better Auth endpoint on the gate's sign-in listener (`sub`, e.g. "/sign-in/email"), if exposed there; `host`: the host Better Auth sees. */
    async handle(req: IncomingMessage, res: ServerResponse, sub: string, search = "", host = String(req.headers.host ?? "").toLowerCase()): Promise<void> {
      const method = String(req.method ?? "GET").toUpperCase();
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, 64_000);
      const r = await rules.call(auth, req, sub, "signin", { ...(body ? { body } : {}), search, host, trusted: accounts.fromGate(req), cookie: inboundCookies(req.headers.cookie, https(req)) });
      await rules.write(r, res, https(req), "signin");
    },

    /**
     * The gate's handoff, step 1 (the gate, server-side, with the sign-in host's session cookie): a random single-use code
     * for one app host from gate.json `hosts`, bound to that host, the session's user and the gate's `state` nonce, valid
     * 60 s. Other hosts' codes stay valid.
     */
    async mintHandoff(req: Pick<IncomingMessage, "headers">, host: string, state: string): Promise<{ code: string }> {
      const who = await accounts.sessionOf(req);
      if (!who || (who.account.role === "admin" && !who.ready)) throw new AccountError(401, "sign in first");
      const target = host.toLowerCase();
      if (!isAppHost(o.gate?.(), target)) throw new AccountError(400, "not an app host");
      const now = Date.now();
      for (const [k, h] of handoffs) if (h.until < now) handoffs.delete(k);
      const code = randomBytes(32).toString("base64url");
      handoffs.set(code, { userId: who.account.id, parentId: who.session.id, host: target, state, until: now + HANDOFF_TTL_MS });
      log.info({ account: who.account.id, host: target }, "handoff code minted");
      return { code };
    },

    /**
     * Step 2 (the gate, server-side): spends the code once (a Map delete in one synchronous step), for the host and state
     * it was minted with, and opens a new session for that app host, linked to the sign-in host's session: signing out
     * there ends it (gateSession, endHandedOff), and a ban or reset ends every session anyway.
     * `token` is the signed cookie value Better Auth reads from __Host-better-auth.session_token.
     */
    async redeemHandoff(code: string, host: string, state: string): Promise<{ token: string }> {
      const h = handoffs.get(code);
      handoffs.delete(code);
      if (!h || h.until < Date.now() || h.host !== host.toLowerCase() || !same(h.state, state)) throw new AccountError(400, "invalid or expired handoff");
      if (!(await liveSession(h.parentId))) throw new AccountError(400, "invalid or expired handoff");
      // The admin plugin refuses a session for a banned (disabled or locked) account here.
      const session = await ctx.internalAdapter.createSession(h.userId).catch(() => null);
      if (!session) throw new AccountError(403, "this account can't sign in");
      db.prepare("INSERT INTO handoff_session (token, parent_id, host) VALUES (?, ?, ?)").run(session.token, h.parentId, h.host);
      log.info({ account: h.userId, host: h.host }, "handoff redeemed: app host session opened");
      return { token: `${session.token}.${createHmac("sha256", ctx.secret).update(session.token).digest("base64")}` };
    },

    /**
     * The gate's get-session, resolved once from the forwarded cookies: Better Auth's { session, user }, or null when there's
     * none, it's ambiguous (two session cookies), or it's an app host session for another host or whose sign-in host session
     * has ended.
     */
    async gateSession(req: Pick<IncomingMessage, "headers">, host: string, appHost = ""): Promise<unknown> {
      const cookie = inboundCookies(req.headers.cookie, https(req));
      if (!cookie) return null;
      const s = await auth.api.getSession({ headers: new Headers({ cookie, host }) }).catch(() => null);
      if (!s) return null;
      // The test user's sessions live only on the test listener: the sign-in host and the front door never see one.
      if (testSessions.isTestToken(s.session.token)) return null;
      const row = db.prepare("SELECT parent_id, host FROM handoff_session WHERE token = ?").get(s.session.token) as { parent_id: string; host: string } | undefined;
      // An app host's session counts only on the host it was handed to (`appHost`: the gate's X-Forwarded-Host). Cookies ignore
      // ports, so on plain-http *.localhost doors another host can be sent it (docs/design/app-doors.md).
      if (row && row.host !== appHost.toLowerCase().replace(/:\d+$/, "")) return null;
      if (row && !(await liveSession(row.parent_id))) {
        await endHostSession(s.session.token);
        return null;
      }
      return s;
    },

    /** The gate's sign-out on an app host: ends that host session (only one handed off to that host). */
    async revokeHostSession(req: Pick<IncomingMessage, "headers">, host: string): Promise<{ ok: true }> {
      const token = sessionToken(req);
      const row = token ? (db.prepare("SELECT host FROM handoff_session WHERE token = ?").get(token) as { host: string } | undefined) : undefined;
      if (!row || row.host !== host.toLowerCase()) throw new AccountError(400, "not an app host session for this host");
      await endHostSession(token!);
      return { ok: true };
    },

    /** Signing out: every app host session and module UI session handed off from this session ends with it. */
    async endHandedOff(req: Pick<IncomingMessage, "headers">): Promise<void> {
      const token = sessionToken(req);
      const parent = token ? (db.prepare("SELECT id FROM session WHERE token = ?").get(token) as { id: string } | undefined) : undefined;
      if (!parent) return;
      const children = db.prepare("SELECT token FROM handoff_session WHERE parent_id = ?").all(parent.id) as { token: string }[];
      for (const c of children) await endHostSession(c.token);
      db.prepare("DELETE FROM ui_session WHERE parent_id = ?").run(parent.id);
    },

    /**
     * Module UI handoff, step 1 (the admin listener's /auth/handoff, a ready admin's top-level request): a random single-use
     * code for one allowed module origin, bound to that origin, the module, the admin's session and the module's `state`
     * nonce (its own cookie in the browser that started it), valid 60 s.
     */
    mintUiCode(who: AdminSession, module: string, origin: string, state: string): string {
      if (!who.ready) throw new AccountError(403, "an admin with an authenticator");
      if (state.length < 16 || state.length > 256) throw new AccountError(400, "bad state");
      const now = Date.now();
      for (const [k, c] of uiCodes) if (c.until < now) uiCodes.delete(k);
      const code = randomBytes(32).toString("base64url");
      uiCodes.set(code, { parentId: who.session.id, module, origin, state, until: now + HANDOFF_TTL_MS });
      log.info({ account: who.account.id, module, origin }, "module UI code minted");
      return code;
    },

    /**
     * An app door's handoff (the admin listener's /auth/handoff with a door origin; docs/design/app-doors.md): the same code
     * the gate redeems for an app host (redeemHandoff), minted from the admin listener's own session, so a door never shows
     * a sign-in form of its own. A ready admin only, for exactly a door origin, bound to its host and the gate's state nonce.
     */
    mintDoorCode(who: AdminSession, origin: string, state: string): string {
      if (!who.ready) throw new AccountError(403, "an admin with an authenticator");
      if (!/^[0-9a-f]{32}$/.test(state)) throw new AccountError(400, "bad state");
      const host = doorHost(o.gate?.(), origin);
      if (!host) throw new AccountError(400, "that address isn't an app door");
      const now = Date.now();
      for (const [k, h] of handoffs) if (h.until < now) handoffs.delete(k);
      const code = randomBytes(32).toString("base64url");
      handoffs.set(code, { userId: who.account.id, parentId: who.session.id, host, state, until: now + HANDOFF_TTL_MS });
      log.info({ account: who.account.id, host }, "door handoff code minted");
      return code;
    },

    /**
     * Step 2 (the module, on the backplane with its own token): spends the code once, for the module, origin and state it
     * was minted for, while the admin's session lives → the module's session token (stored here as its hash only).
     */
    async exchangeUi(module: string, code: string, origin: string, state: string): Promise<{ token: string; admin: Pick<Account, "id" | "email" | "name" | "owner">; expires: string }> {
      const c = uiCodes.get(code);
      uiCodes.delete(code);
      if (!c || c.until < Date.now() || c.module !== module || c.origin !== origin || !same(c.state, state)) throw new AccountError(400, "invalid or expired handoff");
      const token = `ahqu_${randomBytes(32).toString("base64url")}`;
      db.prepare("INSERT INTO ui_session (hash, parent_id, module, origin) VALUES (?, ?, ?, ?)").run(sha(token), c.parentId, module, origin);
      const who = await accounts.uiSession(module, token);
      if (!who) throw new AccountError(400, "invalid or expired handoff");
      log.info({ account: who.account.id, module, origin }, "module UI session opened");
      return { token, admin: { id: who.account.id, email: who.account.email, name: who.account.name, owner: who.account.owner }, expires: who.session.expiresAt };
    },

    /** A module UI session: its ready admin while the admin listener's session it came from lives, else null (and it ends). */
    async uiSession(module: string, token: string): Promise<AdminSession | null> {
      if (!token.startsWith("ahqu_")) return null;
      const row = db.prepare("SELECT parent_id, module FROM ui_session WHERE hash = ?").get(sha(token)) as { parent_id: string; module: string } | undefined;
      if (!row || row.module !== module) return null;
      const s = db.prepare("SELECT userId, expiresAt FROM session WHERE id = ?").get(row.parent_id) as { userId: string; expiresAt: string | number } | undefined;
      const expires = s && new Date(typeof s.expiresAt === "number" ? s.expiresAt : String(s.expiresAt));
      if (!s || !expires || expires.getTime() <= Date.now()) {
        db.prepare("DELETE FROM ui_session WHERE hash = ?").run(sha(token));
        return null;
      }
      const account = await find(s.userId).catch(() => null);
      if (!account || account.disabled || account.role !== "admin" || !account.twoFactorEnabled) return null;
      return { account, session: { id: row.parent_id, expiresAt: expires.toISOString() }, ready: true };
    },

    /** A module UI session ends (the module's sign-out); the admin listener's session stays. */
    endUiSession(module: string, token: string): void {
      db.prepare("DELETE FROM ui_session WHERE hash = ? AND module = ?").run(sha(token), module);
    },

    /** An account's sessions for its Settings page (no tokens leave the kernel). */
    async sessionsOf(userId: string, currentId: string) {
      const list = await ctx.internalAdapter.listSessions(userId);
      return list
        .filter((s) => new Date(s.expiresAt).getTime() > Date.now())
        .map((s) => ({ id: s.id, userAgent: s.userAgent ?? null, ipAddress: s.ipAddress ?? null, createdAt: new Date(s.createdAt).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), current: s.id === currentId }));
    },

    /** Signs one of an account's own sessions out (and what was handed off from it). */
    async revokeSession(userId: string, sessionId: string): Promise<{ ok: true }> {
      const s = (await ctx.internalAdapter.listSessions(userId)).find((x) => x.id === sessionId);
      if (!s) throw new AccountError(404, "no such session");
      await ctx.internalAdapter.deleteSession(s.token);
      db.prepare("DELETE FROM handoff_session WHERE token = ?").run(s.token);
      db.prepare("DELETE FROM ui_session WHERE parent_id = ?").run(s.id);
      return { ok: true };
    },

    /**
     * The OAuth authorization server's endpoints on the admin listener (admin.ts routes them): metadata, authorize (with the
     * browser's session; admin.ts lets only a ready admin reach it), token, register and revoke (no cookies: a client's
     * own credentials).
     */
    async oauth(req: IncomingMessage, res: ServerResponse, sub: string, search = ""): Promise<void> {
      const body = req.method === "POST" ? await readBody(req, 64_000) : undefined;
      const r = await rules.call(auth, req, sub, "admin", { ...(body ? { body, type: String(req.headers["content-type"] ?? "application/json") } : {}), search, ...adminAddress(req), trusted: secretIs(req.headers[EDGE_HEADER], o.edgeSecret()), cookie: sub === "/oauth2/authorize" ? cookieOf(req) : "" });
      await rules.write(r, res, https(req), "admin");
    },

    /** An MCP client's name, as it registered or its metadata document says (the consent page). */
    mcpClientName(clientId: string): string {
      const row = db.prepare("SELECT name FROM oauthClient WHERE clientId = ?").get(clientId) as { name: string | null } | undefined;
      return row?.name || clientId;
    },

    /**
     * An MCP client's access token for `resource` (the board's /mcp): its ready admin, the client's name and when it
     * expires; null when it is unknown, expired, revoked, for another resource, or its account is no longer a ready admin.
     */
    async mcpGrant(token: string, resource: string): Promise<{ account: Account; client: string; expires: string } | null> {
      const row = db.prepare("SELECT t.userId, t.clientId, t.expiresAt, t.revoked, t.resources, c.name FROM oauthAccessToken t LEFT JOIN oauthClient c ON c.clientId = t.clientId WHERE t.token = ?")
        .get(createHash("sha256").update(token).digest("base64url")) as { userId: string | null; clientId: string; expiresAt: string | number; revoked: string | number | null; resources: string | null; name: string | null } | undefined;
      if (!row?.userId || row.revoked || dateOf(row.expiresAt).getTime() <= Date.now()) return null;
      if (!(JSON.parse(row.resources ?? "[]") as string[]).includes(resource)) return null;
      const account = await find(row.userId).catch(() => null);
      if (!account || account.disabled || account.role !== "admin" || !account.twoFactorEnabled) return null;
      return { account, client: row.name || row.clientId, expires: dateOf(row.expiresAt).toISOString() };
    },

    /** An account's MCP clients (each one it allowed): when each last got a token. */
    mcpGrants(accountId: string): { id: string; client: string; lastUsed: string | null }[] {
      const rows = db.prepare("SELECT g.id, g.clientId, c.name, (SELECT max(t.createdAt) FROM oauthAccessToken t WHERE t.userId = g.userId AND t.clientId = g.clientId) AS lastUsed FROM oauthConsent g LEFT JOIN oauthClient c ON c.clientId = g.clientId WHERE g.userId = ? ORDER BY g.createdAt")
        .all(accountId) as { id: string; clientId: string; name: string | null; lastUsed: string | number | null }[];
      return rows.map((r) => ({ id: r.id, client: r.name || r.clientId, lastUsed: r.lastUsed === null ? null : dateOf(r.lastUsed).toISOString() }));
    },

    /** Revokes one of an account's MCP clients: its tokens end at once, and it must ask the account again. */
    revokeMcpGrant(accountId: string, grantId: string): void {
      const g = db.prepare("SELECT clientId FROM oauthConsent WHERE id = ? AND userId = ?").get(grantId, accountId) as { clientId: string } | undefined;
      if (!g) throw new AccountError(404, "no such MCP client");
      endMcp(accountId, g.clientId);
      log.info({ account: accountId, client: g.clientId }, "MCP client revoked");
    },

    /** A server-side call from the gate: it carries the gate's shared secret (gate_board_secret). */
    fromGate(req: Pick<IncomingMessage, "headers">): boolean {
      return secretIs(req.headers[GATE_HEADER], o.gateSecret?.());
    },

    /** Per-app roles, defaults and in-app requests (app-access.ts). */
    apps,

    /**
     * Every minute and at start: each shared app's manifest from apps-mcp, waiting wakes, then the gate's accounts.json
     * (also how a removed app's rows leave and a failed write is retried). Never throws.
     */
    async syncGate(): Promise<void> {
      await apps.refreshManifests().catch((err) => log.warn({ err: String(err) }, "manifest refresh failed"));
      await apps.wakePending().catch((err) => log.warn({ err: String(err) }, "app-request wakes failed"));
      await changed().catch(() => {});
    },

    hasOwner(): boolean {
      return Boolean(db.prepare("SELECT 1 FROM user WHERE owner = 1 LIMIT 1").get());
    },

    hasAdmin(): boolean {
      return Boolean(db.prepare("SELECT 1 FROM user WHERE role = 'admin' LIMIT 1").get());
    },

    /** First run (ops/setup.sh --unattended, operator key): a single-use /setup link, while no admin exists; it replaces an older one. */
    mintSetup(): { url: string } {
      if (accounts.hasAdmin()) throw new AccountError(409, "an admin exists: first-run setup is over (a lost owner: ops/setup.sh --reset)");
      const token = randomBytes(32).toString("base64url");
      db.exec("DELETE FROM setup_token");
      db.prepare("INSERT INTO setup_token (hash, expires) VALUES (?, ?)").run(sha(token), Date.now() + LINK_TTL_MS);
      log.info({}, "first-run setup link minted");
      return { url: `${o.adminUrl ?? "http://localhost:3120"}/setup?token=${token}` };
    },

    /** `token` is the live setup token: no admin yet, unexpired, its hash compared in constant time. */
    setupOpen(token: string): boolean {
      if (accounts.hasAdmin()) return false;
      const row = db.prepare("SELECT hash, expires FROM setup_token").get() as { hash: string; expires: number } | undefined;
      return Boolean(row && row.expires > Date.now() && same(row.hash, sha(token)));
    },

    /**
     * /setup's submit: checks and spends the token in one synchronous step (before any await, so one request wins), then
     * makes the owner's account with the password they chose (an admin, TOTP next on /auth/enrol).
     */
    async claimSetup(token: string, input: { email: string; name: string; password: string }): Promise<Account> {
      const ownerEmail = o.ownerEmail?.()?.trim().toLowerCase();
      if (ownerEmail && input.email.trim().toLowerCase() !== ownerEmail) throw new AccountError(400, "the owner's account is settings.owner_email");
      if (!accounts.setupOpen(token)) throw new AccountError(410, "this setup link was used or has expired");
      const spent = db.prepare("SELECT hash, expires FROM setup_token").get() as { hash: string; expires: number };
      db.exec("DELETE FROM setup_token");
      // A refused account (a weak password, a taken email) hands the link back.
      const account = await create({ ...input, role: "admin", owner: true }).catch((e: unknown) => {
        if (!accounts.hasAdmin() && !db.prepare("SELECT 1 FROM setup_token").get()) db.prepare("INSERT INTO setup_token (hash, expires) VALUES (?, ?)").run(spent.hash, spent.expires);
        throw e;
      });
      log.info({ account: account.id }, "owner account created on the first-run page");
      return account;
    },

    async list(): Promise<Account[]> {
      const rows = await ctx.adapter.findMany<Record<string, unknown>>({ model: "user", sortBy: { field: "createdAt", direction: "asc" } });
      // The test user (test-session.ts) is not a board account: it is on no Accounts page, gets no invite, and can't be
      // promoted. Its own membership is app-access's (testMember), never an accounts.json row.
      return rows.map(toAccount).filter((a) => !testSessions.isTestAccount(a.email));
    },

    /** Bootstrap (ops/setup.sh, operator key): the owner's account and its link, only while no owner exists. */
    async setup(email: string, name: string): Promise<{ account: Account; url: string }> {
      if (accounts.hasOwner()) throw new AccountError(409, "the owner's account already exists (use ops/setup.sh --reset)");
      const ownerEmail = o.ownerEmail?.()?.trim().toLowerCase();
      if (ownerEmail && email.trim().toLowerCase() !== ownerEmail) throw new AccountError(400, "the owner's account is settings.owner_email");
      const account = await create({ email, name, role: "admin", owner: true });
      log.info({ account: account.id }, "owner account created");
      return { account, url: linkFor(account, await mintLink(account.id))! };
    },

    /** An admin adds an account; the link (none for a user in `access` mode) goes back to that admin. */
    async invite(by: Account, input: { email: string; name: string; role: Role }): Promise<{ account: Account; url: string | null }> {
      const account = await create(input);
      const needsLink = account.role === "admin" || Boolean(signinUrl());
      log.info({ account: account.id, role: account.role, by: by.id }, "account invited");
      return { account, url: needsLink ? linkFor(account, await mintLink(account.id)) : null };
    },

    /** A new link for an existing account (not the owner: only --reset touches him), replacing any older one. */
    async newLink(by: Account, id: string): Promise<{ url: string | null }> {
      const a = await find(id);
      if (a.owner) throw new AccountError(403, "only ops/setup.sh --reset makes the owner a new link");
      log.info({ account: id, by: by.id }, "account link re-issued");
      return { url: linkFor(a, await mintLink(id)) };
    },

    /** Promote or demote; the account's sessions end. Never the owner, never the test user. */
    async setRole(by: Account, id: string, role: Role): Promise<Account> {
      const a = await find(id);
      if (a.owner) throw new AccountError(403, "the owner's account can't be changed here");
      if (testSessions.isTestAccount(a.email)) throw new AccountError(403, "the test user isn't an account to manage");
      await ctx.internalAdapter.updateUser(id, { role });
      await ctx.internalAdapter.deleteUserSessions(id);
      endMcp(id);
      log.info({ account: id, role, by: by.id }, "account role changed");
      await exported();
      return find(id);
    },

    /** Disable (keeps its history) or enable an account; disabling ends its sessions. Never the owner. */
    async setDisabled(by: Account, id: string, disabled: boolean): Promise<Account> {
      const a = await find(id);
      if (a.owner) throw new AccountError(403, "the owner's account can't be disabled");
      if (testSessions.isTestAccount(a.email)) throw new AccountError(403, "the test user isn't an account to manage");
      await ctx.internalAdapter.updateUser(id, disabled ? { banned: true, banReason: "disabled", banExpires: null } : { banned: false, banReason: null, banExpires: null });
      if (disabled) { await ctx.internalAdapter.deleteUserSessions(id); endMcp(id); }
      log.info({ account: id, disabled, by: by.id }, disabled ? "account disabled" : "account enabled");
      await exported();
      return find(id);
    },

    /**
     * Recovery (ops/setup.sh --reset, operator key): lifts a ban, clears an admin's TOTP, ends every session, and returns a
     * fresh one-time link (null for an `access`-mode user: Cloudflare Access signs him in). The operator prints it on the server.
     */
    async reset(email: string): Promise<{ url: string | null }> {
      const found = await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase());
      if (!found) throw new AccountError(404, "no account with this email");
      // Never the test user: it has no credential to recover, and a link would be a way into it that no setting names.
      if (testSessions.isTestAccount(found.user.email)) throw new AccountError(403, "the test user isn't an account to manage");
      const a = toAccount(found.user as unknown as Record<string, unknown>);
      await ctx.internalAdapter.updateUser(a.id, { banned: false, banReason: null, banExpires: null, ...(a.role === "admin" ? { twoFactorEnabled: false } : {}) });
      if (a.role === "admin") await ctx.adapter.deleteMany({ model: "twoFactor", where: [{ field: "userId", value: a.id }] });
      await ctx.internalAdapter.deleteUserSessions(a.id);
      endMcp(a.id);
      rules.forget(a.email);
      await exported();
      // A user in `access` mode signs in through Cloudflare Access: there's no password to set.
      const url = linkFor(a, await mintLink(a.id));
      log.warn({ account: a.id }, url ? "account reset: one-time link issued" : "account reset (access mode: no link needed)");
      return { url };
    },

    close: () => db.close(),
  };
  return accounts;
}
export type Accounts = Awaited<ReturnType<typeof openAccounts>>;
