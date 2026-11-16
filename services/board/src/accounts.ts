// Board accounts (docs/design/access.md): Better Auth in the board, with its own SQLite file.
// Better Auth does the passwords (argon2id here), sessions, TOTP and reset tokens; this file is the glue: which of its
// endpoints each listener exposes, the admin-TOTP and board-access rules, the fixed 15-minute lockout, the per-address ban,
// the owner's sign-in alerts and notices, TOTP replay, and the setup / invite / reset links.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import { admin, twoFactor } from "better-auth/plugins";
import type { Logger } from "pino";
import { createAppAccess, type Manifest, type SharedApp } from "./app-access.js";

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

/** Which listener a request came in on: the board's (3120/3121) or the gate-facing sign-in listener (3129). */
export type Listener = "board" | "signin";

/** What each listener lets through to Better Auth; everything else is a 404 (admin routes, sign-up, backup codes, trust-device...). */
const EXPOSED: Record<Listener, Set<string>> = {
  board: new Set([
    "POST /sign-in/email",
    "POST /sign-out",
    "GET /get-session",
    "POST /reset-password",
    "POST /two-factor/enable",
    "POST /two-factor/verify-totp",
    "POST /change-password",
  ]),
  // The gate's sign-in host: signing in and out, claiming a link, and the session check. Nothing else.
  signin: new Set(["POST /sign-in/email", "POST /sign-out", "GET /get-session", "POST /reset-password", "POST /two-factor/verify-totp"]),
};

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

/**
 * The client's address a proxy names (it deletes any copy a client sends: all x-aidenhq-*): the gate on the sign-in
 * listener, the front door on the board's. Trusted only beside that proxy's shared secret (GATE_HEADER with
 * gate_board_secret, EDGE_HEADER with edge_board_secret): anything else on the host's loopback could otherwise pick the
 * address a failure counts against. X-Forwarded-For and CF-Connecting-IP are never read here.
 */
export const CLIENT_IP_HEADER = "x-aidenhq-client-ip";
export const GATE_HEADER = "x-aidenhq-gate";
export const EDGE_HEADER = "x-aidenhq-edge";

/** A secret header against its expected value, in constant time; no expected value matches nothing. */
function secretIs(given: string | string[] | undefined, secret: string | undefined): boolean {
  const g = Buffer.from(String(given ?? ""));
  return Boolean(secret) && g.length === Buffer.byteLength(secret!) && timingSafeEqual(g, Buffer.from(secret!));
}

/** A proxy-named address, if it is one: no IPv4-mapped prefix, no zone, lowercase; else "". */
function ipOr(v: unknown): string {
  const ip = String(v ?? "").trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return !ip.includes("%") && isIP(ip) ? ip : "";
}

/** What a ban holds against: an IPv4 address, or an IPv6 address's /64 (one subscriber's whole range). */
export function addressKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [l = "", r] = ip.split("::");
  const left = l ? l.split(":") : [], right = r ? r.split(":") : [];
  const dotted = (right.at(-1) ?? left.at(-1) ?? "").includes(".") ? 1 : 0; // an embedded IPv4 tail is two groups
  const groups = r === undefined ? left : [...left, ...Array(8 - left.length - right.length - dotted).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const HANDOFF_TTL_MS = 60_000;

/**
 * Better Auth reads its cookies by their plain names. On https only the exact `__Host-better-auth.*` ones count (host-only,
 * Secure: no sibling host can plant them) and any plain `better-auth.*` cookie is dropped; on plain http only plain ones.
 */
function inboundCookies(header: string | string[] | undefined, https: boolean): string {
  const kept = String(header ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && (https ? !c.startsWith("better-auth.") : !c.startsWith("__Host-better-auth.")))
    .map((c) => (https ? c.replace(/^__Host-better-auth\./, "better-auth.") : c));
  // Two session cookies (one planted beside the real one): no session at all, rather than guessing which one counts.
  const isSession = (c: string) => c.startsWith("better-auth.session_token=");
  return (kept.filter(isSession).length > 1 ? kept.filter((c) => !isSession(c)) : kept).join("; ");
}
const httpsOf = (req: Pick<IncomingMessage, "headers">) => forwardedProto(req) === "https";

/**
 * A Set-Cookie from Better Auth, made host-only: `__Host-`, Secure and Path=/ on https; Lax on the gate's sign-in host,
 * Strict on the board.
 */
function outboundCookie(c: string, https: boolean, listener: Listener): string {
  let parts = c.split(";").map((p) => p.trim()).filter((p) => !/^domain=/i.test(p) && !/^samesite=/i.test(p) && !/^secure$/i.test(p) && !/^path=/i.test(p));
  const lax = listener === "signin";
  if (https) parts[0] = `__Host-${parts[0]}`;
  parts = [...parts, "Path=/", `SameSite=${lax ? "Lax" : "Strict"}`, ...(https ? ["Secure"] : [])];
  return parts.join("; ");
}

/**
 * Per email + listener + address: 5 failures pause that pair; per email across all addresses on the sign-in listener (the
 * internet-facing path): 20 pause the account there. 15 minutes each.
 */
const LOCKOUT = { failures: 5, accountFailures: 20, windowMs: 15 * 60_000 };
/** Per proxy-named address (any emails): 20 failures in 15 minutes refuse its sign-in steps on that listener for an hour. */
const BAN = { failures: 20, windowMs: 15 * 60_000, forMs: 3_600_000 };
/** Per account, every address: more than 30 failures in an hour tell the owner (once an hour); nothing is locked (D8). */
const ALERT = { failures: 30, windowMs: 3_600_000 };
/**
 * At most this many failed-sign-in alerts an hour (strangers trigger them; the owner's queue keeps 20 lines, shared with
 * monitoring alerts). New-session notices are never capped: only someone who got in triggers one.
 */
const ALERTS_PER_HOUR = 5;
/** The steps a ban refuses: signing in and claiming a link. Open sessions keep working. */
const BAN_STEPS = new Set(["/sign-in/email", "/two-factor/verify-totp", "/reset-password"]);
const LISTENER_HEADER = "x-aidenhq-listener";
const PEER_HEADER = "x-aidenhq-peer";
/** Set (internally) only when a proxy holding its secret named the address: the only addresses a ban may hold against. */
const NAMED_HEADER = "x-aidenhq-named";

export interface AccountsOptions {
  /** data/board/auth.db; its secret (cookie signing, TOTP encryption) is kept beside it as auth.secret, both mode 600. */
  dbPath: string;
  /** Host headers Better Auth answers to: the board's and the sign-in listener's. */
  hosts: string[];
  /** Where admin links open: the board's address (e.g. https://<host>.<tailnet>.ts.net). */
  boardUrl: string;
  /** The gate's config, re-read on use (none: no shared apps, so no user links and no handoffs). */
  gate?: () => GateInfo | undefined;
  /** data/gate/accounts.json: the gate's account map, rewritten in place after every change (single-file mount). */
  gateAccountsFile?: string;
  /** The gate's shared secret (gate_board_secret): only a sign-in request carrying it may name the client's address. */
  gateSecret?: string;
  /** The front door's shared secret (edge_board_secret): only a board request carrying it may name the client's address. */
  edgeSecret?: string;
  /** Setup, invite and reset links last this long (hours; default 72; public exposure: 24, decision D9). */
  linkTtlHours?: number;
  /** One line to the owner's channel (the board's owner-line queue): sign-in alerts and new-sign-in notices. */
  notify?: (line: string) => void;
  /** settings.owner_email: when set, setup makes only this email the owner's account. */
  ownerEmail?: string;
  /** apps-mcp's manifest of one shared app at its running commit (custom roles, default). */
  manifest?: (app: string) => Promise<Manifest>;
  /** Wakes an app's maintaining agent when in-app requests wait (the app-request routine's webhook). */
  wake?: (app: string, count: number) => Promise<boolean>;
  log: Logger;
}

export type Accounts = Awaited<ReturnType<typeof createAccounts>>;

/** A stable secret beside the database: it signs cookies and encrypts TOTP secrets, so it must survive restarts. */
function secretFor(dbPath: string): string {
  const file = join(dirname(dbPath), "auth.secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

export async function createAccounts(o: AccountsOptions) {
  const { log } = o;
  const LINK_TTL_MS = (o.linkTtlHours ?? 72) * 3_600_000;
  if (o.dbPath !== ":memory:") mkdirSync(dirname(o.dbPath), { recursive: true });
  const db = new DatabaseSync(o.dbPath);
  if (o.dbPath !== ":memory:") chmodSync(o.dbPath, 0o600);

  /**
   * The lockout, per email + listener + client address (memory only): 5 failed passwords or codes in 15 minutes block new
   * sign-ins for that pair for 15 minutes. Sessions already open stay (nobody can sign the owner out by failing on purpose).
   * The account-wide ceiling (`${email}|signin|*`) is counted and enforced only on the sign-in listener: strangers on the
   * internet can pause an account's sign-ins through the gate, never the owner's own sign-in on the board's listeners.
   */
  const failures = new Map<string, number[]>();
  const locks = new Map<string, number>();
  const lockKey = (email: string, listener: Listener | null | undefined, ip: string) => `${email}|${listener ?? "board"}|${ip}`;
  const forget = (email: string) => {
    for (const m of [failures, locks]) for (const k of [...m.keys()]) if (k.startsWith(`${email}|`)) m.delete(k);
  };
  const lockedUntil = (email: string): number => Math.max(0, ...[...locks].filter(([k, t]) => k.startsWith(`${email}|`) && t > Date.now()).map(([, t]) => t));
  const ipOf = (ctx: { headers?: Headers }) => ctx.headers?.get(PEER_HEADER) ?? "server";
  const refuseIfLocked = (email: string, ctx: { headers?: Headers }) => {
    const now = Date.now();
    const listener = listenerOf(ctx);
    const pair = (locks.get(lockKey(email, listener, ipOf(ctx))) ?? 0) > now;
    const account = listener === "signin" && (locks.get(lockKey(email, "signin", "*")) ?? 0) > now;
    if (pair || account) throw new APIError("FORBIDDEN", { message: "too many failed sign-ins: try again in 15 minutes, or ask the owner for a new link" });
  };
  /** TOTP codes already spent, per account: Better Auth accepts a code for its whole ±1 step window, more than once. */
  const spentCodes = new Map<string, number>();

  /**
   * The per-address ban (memory only), separate from the lockout's maps (those are keyed by email): `${listener}|${key}`.
   * Only an address a proxy named with its secret counts: without a front door every client shares the socket's address
   * (a tailnet proxy, Docker's port publishing), and banning that would lock the owner out with everyone else.
   */
  const addrFailures = new Map<string, number[]>();
  const bans = new Map<string, number>();
  /** Failures per existing account (any address), for the owner's alert; when each account was last alerted. */
  const accountFailures = new Map<string, { at: number; addr: string }[]>();
  const alerted = new Map<string, number>();
  const alertsSent: number[] = [];
  const heldBack = new Set<string>(); // accounts whose alert the cap held back since the last one went out
  /** Drops what has aged out once a map grows: its keys come from strangers (emails, addresses). */
  const prune = (now: number) => {
    const old = (t: number, win: number) => now - t >= win;
    for (const [m, win] of [[failures, LOCKOUT.windowMs], [addrFailures, BAN.windowMs]] as const)
      if (m.size > 1000) for (const [k, ts] of m) if (ts.every((t) => old(t, win))) m.delete(k);
    for (const m of [locks, bans]) if (m.size > 1000) for (const [k, t] of m) if (t <= now) m.delete(k);
    if (accountFailures.size > 1000) for (const [k, ts] of accountFailures) if (ts.every((f) => old(f.at, ALERT.windowMs))) accountFailures.delete(k);
  };
  const tell = (line: string) => (o.notify ? o.notify(line) : log.warn({ line }, "no owner channel for sign-in notices"));
  /**
   * A failed-sign-in alert, within the hourly cap. Past it the owner gets one line saying alerts are held back, and the
   * next alert that goes out says for how many accounts; false when this one was held back.
   */
  const alert = (email: string, line: string): boolean => {
    const now = Date.now();
    while (alertsSent.length && now - alertsSent[0]! >= 3_600_000) alertsSent.shift();
    if (alertsSent.length >= ALERTS_PER_HOUR) {
      if (!heldBack.size) tell(`🛡 **Sign-in attempts on more accounts**: failed-sign-in alerts are capped at ${ALERTS_PER_HOUR} an hour, so further ones are held back. Nothing is locked; check Settings → Accounts.`);
      heldBack.add(email);
      log.warn({ email }, "failed-sign-in alert held back (hourly cap)");
      return false;
    }
    alertsSent.push(now);
    heldBack.delete(email);
    const n = heldBack.size;
    tell(n ? `${line} (Alerts for ${n} more account${n === 1 ? " was" : "s were"} held back.)` : line);
    heldBack.clear();
    return true;
  };
  const banKey = (ctx: { headers?: Headers }) => {
    const named = ctx.headers?.get(NAMED_HEADER);
    return named ? `${listenerOf(ctx) ?? "board"}|${addressKey(named)}` : undefined;
  };
  const when = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

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

  const listenerOf = (ctx: { headers?: Headers }) => ctx.headers?.get(LISTENER_HEADER) as Listener | null | undefined;

  const options = {
    appName: "AidenHQ",
    database: db,
    secret: o.dbPath === ":memory:" ? randomBytes(32).toString("base64url") : secretFor(o.dbPath),
    // One instance for every listener: the request's host decides the URL (fallback for server-side calls).
    baseURL: { allowedHosts: o.hosts, protocol: "auto", fallback: `http://${o.hosts[0] ?? "localhost:3120"}` },
    // The gate's sign-in host posts from its own https origin (requests reach Better Auth under the listener's own host).
    trustedOrigins: () => {
      const h = o.gate?.()?.myAppsHost;
      return h ? [`https://${h}`] : [];
    },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      // argon2id (PHC strings), m=19 MiB, t=2, p=1.
      password: {
        hash: (password: string) => hash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        verify: ({ hash: h, password }: { hash: string; password: string }) => verify(h, password),
      },
      resetPasswordTokenExpiresIn: LINK_TTL_MS / 1000,
      revokeSessionsOnPasswordReset: true,
      // A claimed link lifts a lockout (not a disable) and forgets the failures.
      onPasswordReset: async ({ user }: { user: { id: string; email: string } }) => {
        forget(user.email.toLowerCase());
        log.info({ account: user.id }, "account link claimed: password set");
        void changed().catch(() => {});
      },
    },
    user: { additionalFields: { owner: { type: "boolean", defaultValue: false, input: false } } },
    session: { expiresIn: 30 * 86_400, updateAge: 86_400 },
    advanced: {
      // Secure, __Host- and SameSite are set per request (outboundCookie): 127.0.0.1:3120 and the LAN name are plain http.
      useSecureCookies: false,
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true, path: "/" },
      // The peer address the wrapper sets from the socket (a client can't choose it): the IP rate limit's key.
      ipAddress: { ipAddressHeaders: [PEER_HEADER] },
    },
    // A global ceiling per address (behind `tailscale serve` everyone shares one); the per-account lockout is ours.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 200,
      storage: "memory",
      customRules: {
        "/sign-in/email": { window: 60, max: 20 },
        "/two-factor/verify-totp": { window: 60, max: 20 },
        "/two-factor/enable": { window: 60, max: 10 },
        "/reset-password": { window: 60, max: 20 },
      },
    },
    plugins: [
      // role admin|user, ban (our lockout and disable); its HTTP endpoints are never exposed (EXPOSED above).
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // Our lockout covers TOTP failures too (one lockout, not two).
      twoFactor({ issuer: "AidenHQ", accountLockout: { enabled: false } }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const listener = listenerOf(ctx);
        if (ctx.path === "/sign-in/email") {
          const email = String((ctx.body as { email?: unknown })?.email ?? "").toLowerCase();
          refuseIfLocked(email, ctx);
          const found = (await ctx.context.internalAdapter.findUserByEmail(email))?.user as { role?: string; twoFactorEnabled?: boolean } | undefined;
          if (listener === "board" && found && found.role !== "admin") throw new APIError("FORBIDDEN", { message: "this account has no board access" });
          if (listener === "signin" && found?.role === "admin" && !found.twoFactorEnabled) throw new APIError("FORBIDDEN", { message: "set up your authenticator on the board first" });
        }
        if (ctx.path === "/two-factor/verify-totp") {
          const body = ctx.body as { code?: unknown; trustDevice?: unknown };
          if (body?.trustDevice) throw new APIError("BAD_REQUEST", { message: "trusted devices are off: every sign-in asks for a code" });
          const userId = await pendingUser(ctx);
          const pendingEmail = userId ? (await ctx.context.internalAdapter.findUserById(userId))?.email : undefined;
          if (pendingEmail) refuseIfLocked(pendingEmail.toLowerCase(), ctx);
          if (userId) {
            const now = Date.now();
            for (const [k, until] of spentCodes) if (until < now) spentCodes.delete(k);
            const key = `${userId}:${String(body?.code ?? "")}`;
            if (spentCodes.has(key)) throw new APIError("UNAUTHORIZED", { message: "that code was already used: wait for the next one" });
            // Three steps covers Better Auth's ±1 window.
            spentCodes.set(key, now + 90_000);
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" && ctx.path !== "/two-factor/verify-totp") return;
        const returned = ctx.context.returned;
        // Enrolment done (a code checked with a session, not a sign-in challenge): sessions opened with the password alone,
        // before the authenticator existed, end; only the browser that enrolled stays signed in.
        const fresh = ctx.context.newSession;
        const enrolment = ctx.path === "/two-factor/verify-totp" && !!fresh && !(returned instanceof APIError) && !(await ctx.getSignedCookie(ctx.context.createAuthCookie("two_factor").name, ctx.context.secret));
        if (enrolment) {
          for (const other of await ctx.context.internalAdapter.listSessions(fresh.user.id)) if (other.token !== fresh.session.token) await ctx.context.internalAdapter.deleteSession(other.token);
          log.info({ account: fresh.user.id }, "authenticator enrolled: other sessions ended");
        }
        const failed = returned instanceof APIError && returned.status === "UNAUTHORIZED";
        const now = Date.now();
        const ip = ipOf(ctx);
        const ban = failed ? banKey(ctx) : undefined;
        if (ban) {
          prune(now);
          const recent = [...(addrFailures.get(ban) ?? []).filter((t) => now - t < BAN.windowMs), now];
          addrFailures.set(ban, recent);
          if (recent.length >= BAN.failures) {
            bans.set(ban, now + BAN.forMs);
            addrFailures.delete(ban);
            log.warn({ address: ban }, "address banned from signing in for an hour");
          }
        }
        // A finished authenticator step has spent its challenge: the new session names the account.
        const email =
          fresh && !(returned instanceof APIError)
            ? fresh.user.email.toLowerCase()
            : ctx.path === "/sign-in/email"
            ? String((ctx.body as { email?: unknown })?.email ?? "").toLowerCase()
            : ((await ctx.context.internalAdapter.findUserById((await pendingUser(ctx)) ?? ""))?.email ?? "").toLowerCase();
        if (!email) return;
        if (!failed) {
          if (returned instanceof APIError) return;
          log.info({ email, step: ctx.path, listener: listenerOf(ctx) }, "sign-in step passed");
          // A session opened (not the password step before the authenticator's, whose session goes again): every new admin
          // session tells the owner, with the time and the address (never the user agent: the client wrote it), uncapped.
          const s = fresh && !enrolment && (await ctx.context.internalAdapter.findSession(fresh.session.token));
          const u = s ? (s.user as { role?: string; twoFactorEnabled?: boolean }) : undefined;
          if (s && u?.role === "admin" && !(ctx.path === "/sign-in/email" && u.twoFactorEnabled))
            tell(`🔑 **New board sign-in**: ${email} from ${ip} at ${when(now)}. Not you? Sign that session out in Settings → Accounts (${o.boardUrl}/#/settings/accounts) and run ops/setup.sh --reset.`);
          return;
        }
        // Every address, one account (an existing one: made-up emails reach nobody): the owner hears, nothing locks (D8).
        if (await ctx.context.internalAdapter.findUserByEmail(email)) {
          prune(now);
          const recent = [...(accountFailures.get(email) ?? []).filter((f) => now - f.at < ALERT.windowMs), { at: now, addr: addressKey(ip) }].slice(-1000);
          accountFailures.set(email, recent);
          if (recent.length > ALERT.failures && now - (alerted.get(email) ?? 0) >= ALERT.windowMs) {
            const from = new Set(recent.map((f) => f.addr)).size;
            // Once an hour per account, counted from when an alert about it actually went out.
            if (alert(email, `🛡 **Sign-in attempts**: ${recent.length} failed sign-ins for ${email} in the last hour, from ${from} address${from === 1 ? "" : "es"}. Nothing is locked; the password and authenticator still guard it. If they aren't yours, check Settings → Accounts.`)) alerted.set(email, now);
            log.warn({ email, failures: recent.length, addresses: from }, "owner alerted: many failed sign-ins for one account");
          }
        }
        const count = (key: string, limit: number) => {
          const recent = [...(failures.get(key) ?? []).filter((t) => now - t < LOCKOUT.windowMs), now];
          failures.set(key, recent);
          if (recent.length < limit) return recent.length;
          locks.set(key, now + LOCKOUT.windowMs);
          failures.delete(key);
          log.warn({ email, ip: key.endsWith("|*") ? "any" : ip }, "sign-ins paused for 15 minutes");
          return recent.length;
        };
        const listener = listenerOf(ctx);
        const n = count(lockKey(email, listener, ip), LOCKOUT.failures);
        if (listener === "signin") count(lockKey(email, "signin", "*"), LOCKOUT.accountFailures);
        log.warn({ email, ip, step: ctx.path, failures: n }, "sign-in failed");
      }),
    },
  } satisfies BetterAuthOptions;

  /** The account a TOTP step is for: the pending sign-in's two-factor cookie, else the signed-in session (enrolment). */
  async function pendingUser(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]): Promise<string | undefined> {
    const name = ctx.context.createAuthCookie("two_factor").name;
    const challenge = await ctx.getSignedCookie(name, ctx.context.secret);
    if (challenge) return (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
    return (await getSessionFromCtx(ctx).catch(() => null))?.user.id;
  }

  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  // Ours: app host sessions opened by a handoff, and the sign-in host session each one hangs off.
  db.exec("CREATE TABLE IF NOT EXISTS handoff_session (token TEXT PRIMARY KEY, parent_id TEXT NOT NULL, host TEXT NOT NULL)");
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
    log,
  });
  const auth = betterAuth(options);
  const ctx = await auth.$context;

  const toAccount = (u: Record<string, unknown>): Account => {
    const banExpires = u.banExpires ? new Date(u.banExpires as string | Date) : null;
    const banned = Boolean(u.banned) && (!banExpires || banExpires.getTime() > Date.now());
    const locked = lockedUntil(String(u.email));
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
    a.role === "admin" ? `${o.boardUrl}/#/set-password/${token}` : signinUrl() ? `${signinUrl()}/.auth/set-password#${token}` : null;

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
    const v = inboundCookies(req.headers.cookie, httpsOf(req)).split("; ").find((c) => c.startsWith("better-auth.session_token="))?.slice("better-auth.session_token=".length);
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
      const s = await auth.api.getSession({ headers: new Headers({ cookie: inboundCookies(req.headers.cookie, httpsOf(req)), host: String(req.headers.host ?? "") }) }).catch(() => null);
      // An app host's handed-off session is for that app only: never a board session, never a parent for another handoff.
      if (!s || isHandoffSession(s.session.token)) return null;
      const account = toAccount(s.user as unknown as Record<string, unknown>);
      if (account.disabled) return null;
      return { account, session: { id: s.session.id, expiresAt: new Date(s.session.expiresAt).toISOString() }, ready: account.role === "admin" && account.twoFactorEnabled };
    },

    /** Serves one Better Auth endpoint (`sub`, e.g. "/sign-in/email") if this listener exposes it, else 404. */
    /**
     * Serves one Better Auth endpoint (`sub`, e.g. "/sign-in/email") if this listener exposes it, else 404. `host`: the
     * host Better Auth sees (the sign-in listener passes its own; the browser's Origin is then checked as a trusted origin).
     */
    async handle(req: IncomingMessage, res: ServerResponse, sub: string, listener: Listener, search = "", host = String(req.headers.host ?? "").toLowerCase()): Promise<void> {
      const method = String(req.method ?? "GET").toUpperCase();
      if (!EXPOSED[listener].has(`${method} ${sub}`)) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "not found" }));
        return;
      }
      const https = forwardedProto(req) === "https";
      const headers = fromNodeHeaders(req.headers);
      headers.set("host", host);
      // A handed-off app host session never reaches the board's own endpoints.
      const cookie = req.headers.cookie ? inboundCookies(req.headers.cookie, https) : "";
      headers.delete("cookie");
      if (cookie && !(listener === "board" && isHandoffSession(sessionToken(req)))) headers.set("cookie", cookie);
      for (const k of [...headers.keys()]) if (k.startsWith("x-aidenhq-") && k !== "x-aidenhq-board") headers.delete(k);
      // Overwritten, never passed through: the hooks' listener and the rate limit's peer.
      headers.set(LISTENER_HEADER, listener);
      // The client's address: the gate's header on the sign-in listener with the gate's secret, the front door's on the
      // board's with the edge secret (read from the raw request: the copy above dropped every x-aidenhq-*), and only a real
      // IP address; else the socket's.
      const trusted = listener === "signin" ? accounts.fromGate(req) : secretIs(req.headers[EDGE_HEADER], o.edgeSecret);
      const named = trusted ? ipOr(req.headers[CLIENT_IP_HEADER]) : "";
      headers.set(PEER_HEADER, named || ipOr(req.socket?.remoteAddress) || "unknown");
      if (named) headers.set(NAMED_HEADER, named);
      // A banned address is refused before Better Auth (its per-minute limit would answer first) and before any hashing.
      const ban = BAN_STEPS.has(sub) ? banKey({ headers }) : undefined;
      if (ban && (bans.get(ban) ?? 0) > Date.now()) {
        res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ code: "BANNED", message: "too many failed sign-ins from this address: try again in an hour" }));
        return;
      }
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, 64_000);
      const r = await auth.handler(new Request(`${https ? "https" : "http"}://${host}/api/auth${sub}${search}`, { method, headers, body: body && new Uint8Array(body) }));
      const out: Record<string, string | string[]> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
      r.headers.forEach((v, k) => {
        if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") out[k] = v;
      });
      const cookies = r.headers.getSetCookie().map((c) => outboundCookie(c, https, listener));
      if (cookies.length) out["set-cookie"] = cookies;
      const data = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, out).end(data);
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
      const cookie = inboundCookies(req.headers.cookie, httpsOf(req));
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
      forget(a.email);
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

export class AccountError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The scheme the browser used: `tailscale serve` (https) says so in X-Forwarded-Proto; direct requests are plain http. */
export function forwardedProto(req: Pick<IncomingMessage, "headers">): "https" | "http" {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new AccountError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
