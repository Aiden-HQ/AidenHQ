// Board accounts (docs/design/access.md): the board's half until 3g. The accounts file is the kernel's
// (data/kernel/auth/auth.db, mounted at /data/auth) and so are the Better Auth options (auth-rules.ts, synced): admins sign in on
// the kernel's admin listener, and the same session cookie is the board's. Here: the gate-facing sign-in listener (3129) and its
// handoffs, app access, account admin, the setup / invite / reset links, and the gate's account map.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type { Logger } from "pino";
import { createAppAccess, type Manifest, type SharedApp } from "./app-access.js";
import { AccountError, GATE_HEADER, authCore, authSecret, forwardedProto, inboundCookies, openAuthDb, readBody, secretIs } from "./auth-rules.js";

export { AccountError, forwardedProto };
export type Role = "admin" | "user";

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

/** A signed-in browser: its account and Better Auth session. `ready`: an admin with TOTP enrolled (the board's bar). */
export interface AccountSession {
  account: Account;
  session: { id: string; expiresAt: string };
  ready: boolean;
}

/**
 * What the board reads from the gate's config (config/gate.json, scripts/edge.mjs), re-read on use: the sign-in host
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
}

export function readGate(file: string): GateInfo | undefined {
  try {
    const g = JSON.parse(readFileSync(file, "utf8")) as { login?: string; my_apps?: { host?: string }; hosts?: Record<string, { app?: string; default_role?: string }>; previews?: unknown };
    const apps = Object.fromEntries(Object.entries(g.hosts ?? {}).map(([host, h]) => [String(h.app), { host: host.toLowerCase(), ...(h.default_role ? { defaultRole: h.default_role } : {}) }]));
    return { password: g.login === "password", myAppsHost: g.my_apps?.host?.toLowerCase(), appHosts: Object.keys(g.hosts ?? {}).map((h) => h.toLowerCase()), previews: !!g.previews, apps };
  } catch {
    return undefined;
  }
}

/**
 * An app host the gate serves: one of gate.json's, or (with previews) a preview of one, `pr-<n>.<host>`, as
 * services/gate/gate.ts derives it. Whether that preview runs is the gate's to check.
 */
export function isAppHost(g: GateInfo | undefined, host: string): boolean {
  if (!g) return false;
  if (g.appHosts.includes(host)) return true;
  const m = /^pr-[1-9][0-9]{0,5}\.(.+)$/.exec(host);
  return !!g.previews && !!m && g.appHosts.includes(m[1]!);
}

/** `next` after sign-in: a path on the same host (the gate sends `/.auth/go?…` or `/`), else nothing (no open redirect). */
export function safeNext(next: string | null | undefined): string | undefined {
  // Browsers drop tabs and newlines from URLs ("/\t/evil" is "//evil"): no control characters, and it must stay on this origin.
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return undefined;
  try {
    return new URL(next, "https://same.invalid").origin === "https://same.invalid" && !next.startsWith("//") ? next : undefined;
  } catch {
    return undefined;
  }
}

const HANDOFF_TTL_MS = 60_000;

export interface AccountsOptions {
  /** /data/auth/auth.db (the kernel's data/kernel/auth); its auth.secret beside it. */
  dbPath: string;
  /** Host headers Better Auth answers to: the sign-in listener's. */
  hosts: string[];
  /** The kernel's admin listener (AIDENHQ_ADMIN_URL): where admin links open. */
  adminUrl: string;
  /** The gate's config, re-read on use (none: no shared apps, so no user links and no handoffs). */
  gate?: () => GateInfo | undefined;
  /** data/gate/accounts.json: the gate's account map, rewritten in place after every change (single-file mount). */
  gateAccountsFile?: string;
  /** The gate's shared secret (gate_board_secret): only a sign-in request carrying it may name the client's address. */
  gateSecret?: string;
  /** Setup, invite and reset links last this long (hours; default 72; public exposure: 24, decision D9). */
  linkTtlHours?: number;
  /** One line to the owner's channel (the board's owner-line queue): sign-in alerts. */
  notify?: (line: string) => void;
  /** settings.owner_email: when set, setup makes only this email the owner's account. */
  ownerEmail?: string;
  /** apps-mcp's manifest of one shared app at its running commit (custom roles, default). */
  manifest?: (app: string) => Promise<Manifest>;
  /** Wakes an app's maintaining agent when in-app requests wait (the app-request routine's webhook). */
  wake?: (app: string, count: number) => Promise<boolean>;
  /** Runs an app's "App feedback: <app>" routine (app-access.ts notify). */
  feedbackWake?: (app: string, count: number) => Promise<boolean>;
  log: Logger;
}

export type Accounts = Awaited<ReturnType<typeof createAccounts>>;

export async function createAccounts(o: AccountsOptions) {
  const { log } = o;
  const LINK_TTL_MS = (o.linkTtlHours ?? 72) * 3_600_000;
  const secret = authSecret(o.dbPath); // before the file: an existing file without its secret refuses
  const db = openAuthDb(o.dbPath);
  const https = (req: Pick<IncomingMessage, "headers">) => forwardedProto(req) === "https";

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
    const accountRows = (await accounts.list()).map((a) => ({ email: a.email, name: a.name, role: a.role, disabled: a.disabled }));
    const text = JSON.stringify({ accounts: accountRows, apps: apps.exportApps() }, null, 2) + "\n";
    if (!existsSync(dirname(file))) throw new Error(`the gate's accounts.json directory isn't mounted (${dirname(file)})`);
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

  const core = authCore({
    db,
    secret,
    hosts: o.hosts,
    // The gate's sign-in host posts from its own https origin.
    trustedOrigins: () => {
      const h = o.gate?.()?.myAppsHost;
      return h ? [`https://${h}`] : [];
    },
    linkTtlMs: LINK_TTL_MS,
    notify: o.notify,
    onPasswordReset: () => void changed().catch(() => {}),
    log,
  });
  await (await getMigrations(core.options)).runMigrations();
  // Ours: per-app roles, defaults, the change log and in-app requests (app-access.ts), by email.
  const apps = createAppAccess({
    db,
    gate: () => o.gate?.(),
    account: (email) => {
      const u = db.prepare("SELECT role, banned, banExpires FROM user WHERE email = ?").get(email) as { role: string; banned: number | null; banExpires: string | number | null } | undefined;
      if (!u) return undefined;
      const disabled = Boolean(u.banned) && (!u.banExpires || new Date(u.banExpires).getTime() > Date.now());
      return { role: u.role === "admin" ? "admin" : "user", disabled };
    },
    manifest: o.manifest,
    exported: changed,
    wake: o.wake,
    feedbackWake: o.feedbackWake,
    log,
  });
  const auth = betterAuth(core.options);
  const ctx = await auth.$context;

  const toAccount = (u: Record<string, unknown>): Account => {
    const banExpires = u.banExpires ? new Date(u.banExpires as string | Date) : null;
    const banned = Boolean(u.banned) && (!banExpires || banExpires.getTime() > Date.now());
    const locked = core.lockedUntil(String(u.email));
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
    a.role === "admin" ? `${o.adminUrl}/auth/set-password?token=${token}` : signinUrl() ? `${signinUrl()}/.auth/set-password#${token}` : null;

  /** One-time handoff codes (memory): code → the sign-in host's session cookie, for one app host, for 60 s. */
  const handoffs = new Map<string, { userId: string; parentId: string; host: string; state: string; until: number }>();
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
  const endHostSession = async (token: string) => {
    await ctx.internalAdapter.deleteSession(token);
    db.prepare("DELETE FROM handoff_session WHERE token = ?").run(token);
  };

  async function create(input: { email: string; name: string; role: Role; owner?: boolean }): Promise<Account> {
    const email = input.email.trim().toLowerCase();
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new AccountError(409, "an account with this email already exists");
    const user = await ctx.internalAdapter.createUser({ email, name: input.name || email, emailVerified: true, role: input.role, owner: Boolean(input.owner) }, { method: "admin" });
    // An unusable random password: the link sets the real one.
    await ctx.internalAdapter.linkAccount({ providerId: "credential", accountId: user.id, userId: user.id, password: await ctx.password.hash(randomBytes(32).toString("base64url")) });
    void changed().catch(() => {}); // nobody signs in with it before its link is claimed (that exports again)
    return find(user.id);
  }

  /** Reset links waiting for the owner channel to send them to the owner's Telegram (never back to the caller). */
  const outbox: { email: string; url: string; at: number }[] = [];

  const accounts = {
    auth,

    /** The signed-in account behind a request's cookie, or null (no, expired or revoked session; disabled account). */
    async sessionOf(req: Pick<IncomingMessage, "headers">): Promise<AccountSession | null> {
      if (!req.headers.cookie) return null;
      const s = await auth.api.getSession({ headers: new Headers({ cookie: inboundCookies(req.headers.cookie, https(req)), host: String(req.headers.host ?? "") }) }).catch(() => null);
      // An app host's handed-off session is for that app only: never a board session, never a parent for another handoff.
      if (!s || isHandoffSession(s.session.token)) return null;
      const account = toAccount(s.user as unknown as Record<string, unknown>);
      if (account.disabled) return null;
      return { account, session: { id: s.session.id, expiresAt: new Date(s.session.expiresAt).toISOString() }, ready: account.role === "admin" && account.twoFactorEnabled };
    },

    /** Serves one Better Auth endpoint on the gate's sign-in listener (`sub`, e.g. "/sign-in/email"), if exposed there; `host`: the host Better Auth sees. */
    async handle(req: IncomingMessage, res: ServerResponse, sub: string, search = "", host = String(req.headers.host ?? "").toLowerCase()): Promise<void> {
      const method = String(req.method ?? "GET").toUpperCase();
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, 64_000);
      const r = await core.call(auth, req, sub, "signin", { ...(body ? { body } : {}), search, host, trusted: accounts.fromGate(req), cookie: inboundCookies(req.headers.cookie, https(req)) });
      await core.write(r, res, https(req), "signin");
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
     * none, it's ambiguous (two session cookies), or it's an app host session whose sign-in host session has ended.
     */
    async gateSession(req: Pick<IncomingMessage, "headers">): Promise<unknown> {
      const cookie = inboundCookies(req.headers.cookie, https(req));
      if (!cookie) return null;
      const s = await auth.api.getSession({ headers: new Headers({ cookie, host: o.hosts[0] ?? "" }) }).catch(() => null);
      if (!s) return null;
      const row = db.prepare("SELECT parent_id FROM handoff_session WHERE token = ?").get(s.session.token) as { parent_id: string } | undefined;
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

    /** Signing out on the sign-in host: every app host session handed off from this session ends with it. */
    async endHandedOff(req: Pick<IncomingMessage, "headers">): Promise<void> {
      const token = sessionToken(req);
      const parent = token ? (db.prepare("SELECT id FROM session WHERE token = ?").get(token) as { id: string } | undefined) : undefined;
      if (!parent) return;
      const children = db.prepare("SELECT token FROM handoff_session WHERE parent_id = ?").all(parent.id) as { token: string }[];
      for (const c of children) await endHostSession(c.token);
    },

    /** An account's sessions for its Settings page (no tokens leave the server). */
    async sessionsOf(userId: string, currentId: string) {
      const list = await ctx.internalAdapter.listSessions(userId);
      return list
        .filter((s) => new Date(s.expiresAt).getTime() > Date.now())
        .map((s) => ({ id: s.id, userAgent: s.userAgent ?? null, ipAddress: s.ipAddress ?? null, createdAt: new Date(s.createdAt).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), current: s.id === currentId }));
    },

    /** Signs one of an account's own sessions out. */
    async revokeSession(userId: string, sessionId: string): Promise<{ ok: true }> {
      const s = (await ctx.internalAdapter.listSessions(userId)).find((x) => x.id === sessionId);
      if (!s) throw new AccountError(404, "no such session");
      await ctx.internalAdapter.deleteSession(s.token);
      db.prepare("DELETE FROM handoff_session WHERE token = ?").run(s.token);
      return { ok: true };
    },

    /** A server-side call from the gate: it carries the gate's shared secret (gate_board_secret). */
    fromGate(req: Pick<IncomingMessage, "headers">): boolean {
      return secretIs(req.headers[GATE_HEADER], o.gateSecret);
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

    async list(): Promise<Account[]> {
      const rows = await ctx.adapter.findMany<Record<string, unknown>>({ model: "user", sortBy: { field: "createdAt", direction: "asc" } });
      return rows.map(toAccount);
    },

    /** Bootstrap (ops/setup.sh, operator key): the owner's account and its link, only while no owner exists. */
    async setup(email: string, name: string): Promise<{ account: Account; url: string }> {
      if (accounts.hasOwner()) throw new AccountError(409, "the owner's account already exists (use ops/setup.sh --reset)");
      if (o.ownerEmail && email.trim().toLowerCase() !== o.ownerEmail) throw new AccountError(400, "the owner's account is settings.owner_email");
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

    /** Promote or demote; the account's sessions end. Never the owner. */
    async setRole(by: Account, id: string, role: Role): Promise<Account> {
      const a = await find(id);
      if (a.owner) throw new AccountError(403, "the owner's account can't be changed here");
      await ctx.internalAdapter.updateUser(id, { role });
      await ctx.internalAdapter.deleteUserSessions(id);
      log.info({ account: id, role, by: by.id }, "account role changed");
      await exported();
      return find(id);
    },

    /** Disable (keeps its history) or enable an account; disabling ends its sessions. Never the owner. */
    async setDisabled(by: Account, id: string, disabled: boolean): Promise<Account> {
      const a = await find(id);
      if (a.owner) throw new AccountError(403, "the owner's account can't be disabled");
      await ctx.internalAdapter.updateUser(id, disabled ? { banned: true, banReason: "disabled", banExpires: null } : { banned: false, banReason: null, banExpires: null });
      if (disabled) await ctx.internalAdapter.deleteUserSessions(id);
      log.info({ account: id, disabled, by: by.id }, disabled ? "account disabled" : "account enabled");
      await exported();
      return find(id);
    },

    /**
     * Recovery (ops/setup.sh --reset, operator key): lifts a ban, clears an admin's TOTP, ends every session, and queues a
     * fresh link for the owner's Telegram. The caller never sees the link.
     */
    async reset(email: string): Promise<void> {
      const found = await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase());
      if (!found) throw new AccountError(404, "no account with this email");
      const a = toAccount(found.user as unknown as Record<string, unknown>);
      await ctx.internalAdapter.updateUser(a.id, { banned: false, banReason: null, banExpires: null, ...(a.role === "admin" ? { twoFactorEnabled: false } : {}) });
      if (a.role === "admin") await ctx.adapter.deleteMany({ model: "twoFactor", where: [{ field: "userId", value: a.id }] });
      await ctx.internalAdapter.deleteUserSessions(a.id);
      core.forget(a.email);
      await exported();
      // A user in `access` mode signs in through Cloudflare Access: there's no password to set.
      const url = linkFor(a, await mintLink(a.id));
      if (!url) return log.warn({ account: a.id }, "account reset (access mode: no link needed)");
      outbox.push({ email: a.email, url, at: Date.now() });
      log.warn({ account: a.id }, "account reset: link queued for the owner's Telegram");
    },

    /** The owner channel collects queued reset links once (fresh ones only); they're forgotten after. */
    takeResetLinks(): { email: string; url: string }[] {
      const fresh = Date.now() - 10 * 60_000;
      return outbox.splice(0).filter((l) => l.at >= fresh).map(({ email, url }) => ({ email, url }));
    },

    close() {
      db.close();
    },
  };
  return accounts;
}
