// Accounts' rules (the access design doc; lean 3a, 3g): one Better Auth configuration for data/kernel/auth/auth.db, which only
// the kernel opens: the admin listener (3120: the owner's and admins' sign-in, TOTP, links) and the gate-facing sign-in
// listener (3129: shared apps' sign-in and app access) share one instance.
// Better Auth does the passwords (argon2id), sessions, TOTP and reset tokens; this is the glue: which endpoints each listener
// exposes, the admin-TOTP rules, the fixed 15-minute lockout, the per-address ban, the owner's sign-in alerts and notices, and
// TOTP replay (spent codes live in the file, so a code used on one listener is spent on the other too).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash, verify } from "@node-rs/argon2";
import { type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { admin, twoFactor } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";

/** Which listener a request came in on: the kernel's admin listener (3120) or the gate-facing sign-in listener (3129). */
export type Listener = "admin" | "signin";
export type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

/** What each listener lets through to Better Auth; everything else is a 404 (admin routes, sign-up, backup codes, trust-device...). */
export const EXPOSED: Record<Listener, Set<string>> = {
  admin: new Set(["POST /sign-in/email", "POST /sign-out", "GET /get-session", "POST /reset-password", "POST /two-factor/enable", "POST /two-factor/verify-totp", "POST /change-password",
    // The OAuth authorization server for the owner's MCP clients (oauthProvider below); /oauth2/consent only from the kernel's consent page.
    "GET /.well-known/oauth-authorization-server", "GET /oauth2/authorize", "POST /oauth2/token", "POST /oauth2/register", "POST /oauth2/revoke", "POST /oauth2/consent"]),
  signin: new Set(["POST /sign-in/email", "POST /sign-out", "GET /get-session", "POST /reset-password", "POST /two-factor/verify-totp"]),
};

/**
 * The client's address a proxy names (it deletes any copy a client sends: all x-aidenhq-*): the gate on the sign-in
 * listener, the front door on the admin listener. Trusted only beside that proxy's shared secret (GATE_HEADER with
 * gate_board_secret, EDGE_HEADER with edge_board_secret). X-Forwarded-For and CF-Connecting-IP are never read here.
 */
export const CLIENT_IP_HEADER = "x-aidenhq-client-ip";
export const GATE_HEADER = "x-aidenhq-gate";
export const EDGE_HEADER = "x-aidenhq-edge";
const LISTENER_HEADER = "x-aidenhq-listener";
const PEER_HEADER = "x-aidenhq-peer";
/** Set (internally) only when a proxy holding its secret named the address: the only addresses a ban may hold against. */
const NAMED_HEADER = "x-aidenhq-named";

/** A secret header against its expected value, in constant time; no expected value matches nothing. */
export function secretIs(given: string | string[] | undefined, secret: string | undefined): boolean {
  const g = Buffer.from(String(given ?? ""));
  return Boolean(secret) && g.length === Buffer.byteLength(secret!) && timingSafeEqual(g, Buffer.from(secret!));
}

/** A proxy-named address, if it is one: no IPv4-mapped prefix, no zone, lowercase; else "". */
export function ipOr(v: unknown): string {
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

/** The scheme the browser used: the front door says so in X-Forwarded-Proto; direct requests are plain http. */
export function forwardedProto(req: Pick<IncomingMessage, "headers">): "https" | "http" {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
}

/**
 * Better Auth reads its cookies by their plain names. On https only the exact `__Host-better-auth.*` ones count (host-only,
 * Secure: no sibling host can plant them) and any plain `better-auth.*` cookie is dropped; on plain http only plain ones.
 */
export function inboundCookies(header: string | string[] | undefined, https: boolean): string {
  const kept = String(header ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && (https ? !c.startsWith("better-auth.") : !c.startsWith("__Host-better-auth.")))
    .map((c) => (https ? c.replace(/^__Host-better-auth\./, "better-auth.") : c));
  // Two session cookies (one planted beside the real one): no session at all, rather than guessing which one counts.
  const isSession = (c: string) => c.startsWith("better-auth.session_token=");
  return (kept.filter(isSession).length > 1 ? kept.filter((c) => !isSession(c)) : kept).join("; ");
}

/** A Set-Cookie from Better Auth, made host-only: `__Host-`, Secure and Path=/ on https; Lax on the gate's sign-in host, Strict on the admin listener. */
export function outboundCookie(c: string, https: boolean, listener: Listener): string {
  let parts = c.split(";").map((p) => p.trim()).filter((p) => !/^domain=/i.test(p) && !/^samesite=/i.test(p) && !/^secure$/i.test(p) && !/^path=/i.test(p));
  if (https) parts[0] = `__Host-${parts[0]}`;
  parts = [...parts, "Path=/", `SameSite=${listener === "signin" ? "Lax" : "Strict"}`, ...(https ? ["Secure"] : [])];
  return parts.join("; ");
}

/**
 * The accounts file, mode 600, with a busy timeout. WAL with synchronous=NORMAL: readers and the writer don't block each
 * other, and a write syncs to disk at checkpoints rather than three times a transaction (a lost last write after a power cut
 * is a session to sign in again; the file never corrupts). Its -wal and -shm siblings live in the same directory.
 */
export function openAuthDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
  // totp_spent: codes used, on either listener. handoff_session: app host sessions the gate's handoff opened.
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS totp_spent (k TEXT PRIMARY KEY, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS handoff_session (token TEXT PRIMARY KEY, parent_id TEXT NOT NULL, host TEXT NOT NULL)`);
  return db;
}

/**
 * The secret beside the accounts file (auth.secret): it signs cookies and encrypts TOTP secrets. Made only with the file
 * itself: an existing file without its secret refuses, since a new secret would silently void every TOTP and session.
 */
export function authSecret(dbPath: string): string {
  if (dbPath === ":memory:") return randomBytes(32).toString("base64url");
  const file = join(dirname(dbPath), "auth.secret");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(dbPath)) throw new Error(`${dbPath} exists without its auth.secret: refusing to make a new one (it would void every TOTP)`);
    try { writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  return readFileSync(file, "utf8").trim();
}

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new AccountError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Per email + listener + address: 5 failures pause that pair; per email across all addresses on the sign-in listener (the
 * internet-facing path): 20 pause the account there. 15 minutes each.
 */
const LOCKOUT = { failures: 5, accountFailures: 20, windowMs: 15 * 60_000 };
/** Per proxy-named address (any emails): 20 failures in 15 minutes refuse its sign-in steps on that listener for an hour. */
const BAN = { failures: 20, windowMs: 15 * 60_000, forMs: 3_600_000 };
/** Per account, every address: more than 30 failures in an hour tell the owner (once an hour); nothing is locked. */
const ALERT = { failures: 30, windowMs: 3_600_000 };
/**
 * Unidentified peers (neither the front door's secret nor a tailnet identity): per email, one check in flight (a stuck one
 * frees itself after `busyMs`), a stepped hold after the first `free` failures (1 s, x4 each, at most `maxMs`) and past
 * `ceiling` failures in an hour no unnamed sign-in for that email until the hour is up (the owner hears once). Across every
 * email: at most `inFlight` checks at once and `perMinute` failures a minute.
 */
const UNNAMED = { free: 2, maxMs: 5 * 60_000, busyMs: 10_000, ceiling: 10, hourMs: 3_600_000, inFlight: 4, perMinute: 30 };

/**
 * A request `tailscale serve` passed on (it adds Tailscale-User-Login): only on the admin listener it targets, from the host's
 * loopback (where it connects from), and never beside the front door's secret header (Caddy's path, which strips client
 * copies); the gate's sign-in listener never reads it. Every such request is the one peer `tailnet`, whatever login it
 * names, so a forged or varied login makes no new bucket. Only host processes reach that loopback listener (Engineer jobs
 * are network-jailed), and it decides which limits apply, never who is signed in.
 */
export function tailnetPeer(req: Pick<IncomingMessage, "headers" | "socket">, listener: Listener): string {
  if (listener !== "admin" || req.headers[EDGE_HEADER] !== undefined) return "";
  const peer = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  return String(req.headers["tailscale-user-login"] ?? "").trim() ? "tailnet" : "";
}
/** Wrong codes per account in 15 minutes before each next one waits (TOTP back-off). */
const TOTP_FREE = 5;
/** Failures a minute from the tailnet peer (rate limit only: it is never locked or banned). */
const TAILNET_PER_MINUTE = 20;
/** At most this many failed-sign-in alerts an hour; new-session notices are never capped (only someone who got in triggers one). */
const ALERTS_PER_HOUR = 5;
/** The steps a ban refuses: signing in and claiming a link. Open sessions keep working. */
const BAN_STEPS = new Set(["/sign-in/email", "/two-factor/verify-totp", "/reset-password"]);

export interface AuthCoreOptions {
  db: DatabaseSync;
  secret: string;
  /** Host headers Better Auth answers to. */
  hosts: string[];
  /** Origins besides the request's own that may post (the gate's sign-in host). */
  trustedOrigins?: () => string[];
  /** Setup, invite and reset links last this long (ms). */
  linkTtlMs: number;
  /** The board's MCP (`<board>/mcp`): the one resource (RFC 8707 audience) OAuth access tokens are issued for. */
  mcpResource: string;
  /** One line to the owner's channel: sign-in alerts and new-sign-in notices. */
  notify?: (line: string) => void;
  /** After a link is claimed (the gate's account map is exported again). */
  onPasswordReset?: (user: { id: string; email: string }) => void;
  log: Log;
  /** The clock (tests). */
  now?: () => number;
}

/** Better Auth's options for the accounts file, with the lockout, bans, alerts and TOTP rules, and the per-listener handler. */
export function authCore(o: AuthCoreOptions) {
  const { log, db } = o;
  const clock = o.now ?? Date.now;
  /**
   * The lockout, per email + listener + client address (memory only): 5 failed passwords or codes in 15 minutes block new
   * sign-ins for that pair for 15 minutes, for a named peer: an address the front door names with its secret, or the tailnet
   * login `tailscale serve` passes on (the owner's usual way in). An unidentified peer is shared by everyone behind it, so
   * it has the UNNAMED limits instead: a stranger there can't hold a named peer, and gets few guesses.
   * Sessions already open stay (nobody can sign the owner out by failing on purpose).
   * The account-wide ceiling (`${email}|signin|*`) is counted and enforced only on the sign-in listener: strangers on the
   * internet can pause an account's sign-ins through the gate, never the owner's own sign-in on the admin listener.
   */
  const failures = new Map<string, number[]>();
  const locks = new Map<string, number>();
  const lockKey = (email: string, listener: Listener | null | undefined, ip: string) => `${email}|${listener ?? "admin"}|${ip}`;
  /** Unnamed peers' failures (the last hour) and next allowed attempt, per email + listener. */
  const unnamed = new Map<string, { fails: number[]; next: number; busy: number; told: number }>();
  /**
   * The tailnet peer is rate-limited only, never locked or banned (the tailnet is the owner's own: one member slowing another
   * is accepted): checks in flight per email (one each, `inFlight` in all) and failures in the last minute (`TAILNET_PER_MINUTE`).
   */
  const tailnetBusy = new Map<string, number>();
  let tailnetFails: number[] = [];
  /**
   * Wrong codes per account, whatever the peer: past 5 in 15 minutes the next code check waits (1 s, doubling, at most a
   * minute). About one guess a minute, even with the password on the owner's tailnet; never more than a minute's wait.
   */
  const totpBackoff = new Map<string, { fails: number[]; next: number }>();
  const totpBusy = new Map<string, number>();
  /** Unnamed failures across every email, the last minute. */
  let unnamedFails: number[] = [];
  const forget = (email: string) => {
    for (const m of [failures, locks, unnamed]) for (const k of [...m.keys()]) if (k.startsWith(`${email}|`)) m.delete(k);
  };
  const lockedUntil = (email: string): number => Math.max(0, ...[...locks].filter(([k, t]) => k.startsWith(`${email}|`) && t > Date.now()).map(([, t]) => t));
  const listenerOf = (ctx: { headers?: Headers }) => ctx.headers?.get(LISTENER_HEADER) as Listener | null | undefined;
  const ipOf = (ctx: { headers?: Headers }) => ctx.headers?.get(PEER_HEADER) ?? "server";
  const isNamed = (ctx: { headers?: Headers }) => Boolean(ctx.headers?.get(NAMED_HEADER));
  const unnamedOf = (email: string, ctx: { headers?: Headers }) => {
    const k = `${email}|${listenerOf(ctx) ?? "admin"}|unnamed`;
    const now = clock();
    const u = unnamed.get(k) ?? { fails: [], next: 0, busy: 0, told: 0 };
    u.fails = u.fails.filter((t) => now - t < UNNAMED.hourMs);
    unnamed.set(k, u);
    return u;
  };
  const hold = (n: number) => (n > UNNAMED.free ? Math.min(UNNAMED.maxMs, 1000 * 4 ** (n - UNNAMED.free - 1)) : 0);
  /** Takes a check slot (refused with 429 when none is free) and returns what gives it back. */
  const held = (until: number, now: number) =>
    new APIError("TOO_MANY_REQUESTS", { message: "Invalid email or password" }, { "Retry-After": String(Math.ceil((until - now) / 1000)) });
  /**
   * Every check the step must pass before any hashing (the lock, the account's code back-off, the peer's limits), then a
   * check slot taken for the tailnet or an unidentified peer; returns what gives the slot back. 429s carry the wrong-password
   * words: a stranger learns nothing about the account from waiting.
   */
  const refuseIfLocked = async (email: string, ctx: { headers?: Headers }, code: boolean): Promise<(() => void) | undefined> => {
    const now = clock();
    const listener = listenerOf(ctx);
    const pair = isNamed(ctx) && (locks.get(lockKey(email, listener, ipOf(ctx))) ?? 0) > now;
    const account = listener === "signin" && (locks.get(lockKey(email, "signin", "*")) ?? 0) > now;
    if (pair || account) throw new APIError("FORBIDDEN", { message: "too many failed sign-ins: try again in 15 minutes, or ask the owner for a new link" });
    const t = code ? totpBackoff.get(email) : undefined;
    if (t && t.next > now) throw held(t.next, now);
    if (ipOf(ctx) === "tailnet") {
      tailnetFails = tailnetFails.filter((x) => now - x < 60_000);
      const busy = [...tailnetBusy.values()].filter((x) => x > now).length;
      const until = Math.max((tailnetBusy.get(email) ?? 0) > now || busy >= UNNAMED.inFlight ? now + 2000 : 0, tailnetFails.length >= TAILNET_PER_MINUTE ? tailnetFails[0]! + 60_000 : 0);
      if (until > now) throw held(until, now);
      tailnetBusy.set(email, now + UNNAMED.busyMs);
      return slot(email, code, now, () => void tailnetBusy.delete(email));
    }
    if (!isNamed(ctx)) {
      const u = unnamedOf(email, ctx);
      unnamedFails = unnamedFails.filter((x) => now - x < 60_000);
      const busy = [...unnamed.values()].filter((x) => x.busy > now).length;
      const until = Math.max(u.fails.length >= UNNAMED.ceiling ? u.fails[0]! + UNNAMED.hourMs : 0, u.next, u.busy > now ? now + 2000 : 0,
        busy >= UNNAMED.inFlight ? now + 2000 : 0, unnamedFails.length >= UNNAMED.perMinute ? unnamedFails[0]! + 60_000 : 0);
      if (until > now) throw held(until, now);
      u.busy = now + UNNAMED.busyMs; // taken before the hash: concurrent attempts are refused, not all checked at once
      return slot(email, code, now, () => void (u.busy = 0));
    }
    return slot(email, code, now, () => {});
  };
  /**
   * A code check takes the account's one code slot, whatever the peer: the back-off is set only once a code has been
   * checked, so parallel checks would otherwise all pass it. A second one at the same time gets 429 at once.
   */
  const slot = (email: string, code: boolean, now: number, release: () => void): (() => void) => {
    if (!code) return release;
    if ((totpBusy.get(email) ?? 0) > now) { release(); throw held(now + 1000, now); }
    totpBusy.set(email, now + UNNAMED.busyMs);
    return () => { totpBusy.delete(email); release(); };
  };

  /** The per-address ban (memory only): `${listener}|${key}`; only an address a proxy named with its secret counts. */
  const addrFailures = new Map<string, number[]>();
  const bans = new Map<string, number>();
  const accountFailures = new Map<string, { at: number; addr: string }[]>();
  const alerted = new Map<string, number>();
  const alertsSent: number[] = [];
  const heldBack = new Set<string>();
  /** Drops what has aged out once a map grows: its keys come from strangers (emails, addresses). */
  const prune = (now: number) => {
    const old = (t: number, win: number) => now - t >= win;
    for (const [m, win] of [[failures, LOCKOUT.windowMs], [addrFailures, BAN.windowMs]] as const)
      if (m.size > 1000) for (const [k, ts] of m) if (ts.every((t) => old(t, win))) m.delete(k);
    for (const m of [locks, bans]) if (m.size > 1000) for (const [k, t] of m) if (t <= now) m.delete(k);
    if (accountFailures.size > 1000) for (const [k, ts] of accountFailures) if (ts.every((f) => old(f.at, ALERT.windowMs))) accountFailures.delete(k);
    if (totpBusy.size > 1000) for (const [k, t] of totpBusy) if (t <= now) totpBusy.delete(k);
    if (totpBackoff.size > 1000) for (const [k, t] of totpBackoff) if (t.next <= now && t.fails.every((x) => old(x, LOCKOUT.windowMs))) totpBackoff.delete(k);
    if (tailnetBusy.size > 1000) for (const [k, t] of tailnetBusy) if (t <= now) tailnetBusy.delete(k);
    if (unnamed.size > 1000) for (const [k, u] of unnamed) if (u.busy <= now && u.next <= now && u.fails.every((t) => old(t, UNNAMED.hourMs))) unnamed.delete(k);
  };
  const tell = (line: string) => (o.notify ? o.notify(line) : log.warn({ line }, "no owner channel for sign-in notices"));
  /** A failed-sign-in alert, within the hourly cap; false when this one was held back. */
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
    return named && named !== "tailnet" ? `${listenerOf(ctx) ?? "admin"}|${addressKey(named)}` : undefined;
  };
  const when = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

  /** The account a TOTP step is for: the pending sign-in's two-factor cookie, else the signed-in session (enrolment). */
  async function pendingUser(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]): Promise<string | undefined> {
    const name = ctx.context.createAuthCookie("two_factor").name;
    const challenge = await ctx.getSignedCookie(name, ctx.context.secret);
    if (challenge) return (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
    return (await getSessionFromCtx(ctx).catch(() => null))?.user.id;
  }

  const options = {
    appName: "AidenHQ",
    database: db,
    secret: o.secret,
    // Endpoints at the root, so the OAuth issuer is the admin listener's own origin (AIDENHQ_ADMIN_URL) with its metadata at
    // /.well-known/oauth-authorization-server; only the kernel's own requests reach Better Auth (call below).
    basePath: "/",
    // One instance per process: the request's host decides the URL (fallback for server-side calls).
    baseURL: { allowedHosts: o.hosts, protocol: "auto", fallback: `http://${o.hosts[0] ?? "localhost:3120"}` },
    trustedOrigins: () => o.trustedOrigins?.() ?? [],
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
      resetPasswordTokenExpiresIn: o.linkTtlMs / 1000,
      revokeSessionsOnPasswordReset: true,
      // A claimed link lifts a lockout (not a disable) and forgets the failures.
      onPasswordReset: async ({ user }: { user: { id: string; email: string } }) => {
        forget(user.email.toLowerCase());
        log.info({ account: user.id }, "account link claimed: password set");
        o.onPasswordReset?.(user);
      },
    },
    user: { additionalFields: { owner: { type: "boolean", defaultValue: false, input: false } } },
    session: { expiresIn: 30 * 86_400, updateAge: 86_400 },
    advanced: {
      // Secure, __Host- and SameSite are set per request (outboundCookie): 127.0.0.1:3120 is plain http.
      useSecureCookies: false,
      defaultCookieAttributes: { sameSite: "strict", httpOnly: true, path: "/" },
      // The peer address the wrapper sets from the socket (a client can't choose it): the IP rate limit's key.
      ipAddress: { ipAddressHeaders: [PEER_HEADER] },
    },
    // A global ceiling per address (behind the front door everyone shares one); the per-account lockout is ours.
    // Better Auth's limits run on the real clock, so a test that sets its own clock (o.now) turns them off to reach the ones here.
    rateLimit: {
      enabled: !o.now,
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
      // The owner's MCP clients (docs/architecture.md, AidenHQ MCP): authorization code + PKCE, opaque
      // tokens bound to the board's /mcp (1 hour; refresh 30 days, rotated on use), clients by metadata document (CIMD) or
      // open registration. The kernel's pages do sign-in and consent (admin.ts); only a ready admin gets that far.
      oauthProvider({
        loginPage: "/auth/sign-in",
        consentPage: "/oauth/consent",
        disableJwtPlugin: true,
        scopes: ["offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 30 * 86_400,
        resources: [o.mcpResource],
        resourceSeedMode: "overwrite",
        clientRegistrationDefaultResources: [o.mcpResource],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
      }),
      cimd({ fetchClientMetadataResource }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const listener = listenerOf(ctx);
        // A check this hook refuses itself (a spent code, an account without access) never reaches the after hook: the
        // shared peer's turn is handed back here.
        let held: (() => void) | undefined;
        try {
          if (ctx.path === "/sign-in/email") {
            const email = String((ctx.body as { email?: unknown })?.email ?? "").toLowerCase();
            held = await refuseIfLocked(email, ctx, false);
            const found = (await ctx.context.internalAdapter.findUserByEmail(email))?.user as { role?: string; twoFactorEnabled?: boolean } | undefined;
            if (listener === "admin" && found && found.role !== "admin") throw new APIError("FORBIDDEN", { message: "this account has no admin access" });
            if (listener === "signin" && found?.role === "admin" && !found.twoFactorEnabled) throw new APIError("FORBIDDEN", { message: "set up your authenticator on the admin sign-in page first" });
          }
          if (ctx.path === "/two-factor/verify-totp") {
            const body = ctx.body as { code?: unknown; trustDevice?: unknown };
            if (body?.trustDevice) throw new APIError("BAD_REQUEST", { message: "trusted devices are off: every sign-in asks for a code" });
            const userId = await pendingUser(ctx);
            const pendingEmail = userId ? (await ctx.context.internalAdapter.findUserById(userId))?.email : undefined;
            if (pendingEmail) held = await refuseIfLocked(pendingEmail.toLowerCase(), ctx, true);
            if (userId) {
              // Better Auth accepts a code for its whole ±1 step window, more than once: a code is spent once, on any listener.
              const now = Date.now();
              db.prepare("DELETE FROM totp_spent WHERE until < ?").run(now);
              const spent = db.prepare("INSERT OR IGNORE INTO totp_spent (k, until) VALUES (?, ?)").run(`${userId}:${String(body?.code ?? "")}`, now + 90_000);
              if (spent.changes === 0) throw new APIError("UNAUTHORIZED", { message: "that code was already used: wait for the next one" });
            }
          }
        } catch (e) {
          held?.();
          throw e;
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
        const now = clock();
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
        if (!isNamed(ctx)) {
          const u = unnamedOf(email, ctx);
          u.busy = 0;
          if (!failed) u.next = 0; // the right password: the code step follows at once
        } else if (ipOf(ctx) === "tailnet") tailnetBusy.delete(email);
        if (ctx.path === "/two-factor/verify-totp") {
          totpBusy.delete(email);
          if (!failed) totpBackoff.delete(email);
          else {
            const t = totpBackoff.get(email) ?? { fails: [], next: 0 };
            t.fails = [...t.fails.filter((x) => now - x < LOCKOUT.windowMs), now].slice(-50);
            if (t.fails.length >= TOTP_FREE) t.next = now + Math.min(60_000, 1000 * 2 ** (t.fails.length - TOTP_FREE));
            totpBackoff.set(email, t);
          }
        }
        if (!failed) {
          if (returned instanceof APIError) return;
          log.info({ email, step: ctx.path, listener: listenerOf(ctx) }, "sign-in step passed");
          // A session opened (not the password step before the authenticator's): every new admin session tells the owner,
          // with the time and the address (never the user agent: the client wrote it), uncapped.
          const s = fresh && !enrolment && (await ctx.context.internalAdapter.findSession(fresh.session.token));
          const u = s ? (s.user as { role?: string; twoFactorEnabled?: boolean }) : undefined;
          if (s && u?.role === "admin" && !(ctx.path === "/sign-in/email" && u.twoFactorEnabled))
            tell(`🔑 **New admin sign-in**: ${email} from ${ip} at ${when(now)}. Not you? Sign that session out in Settings → Accounts and run ops/setup.sh --reset.`);
          return;
        }
        // Every address, one account (an existing one: made-up emails reach nobody): the owner hears, nothing locks.
        if (await ctx.context.internalAdapter.findUserByEmail(email)) {
          prune(now);
          const recent = [...(accountFailures.get(email) ?? []).filter((f) => now - f.at < ALERT.windowMs), { at: now, addr: addressKey(ip) }].slice(-1000);
          accountFailures.set(email, recent);
          if (recent.length > ALERT.failures && now - (alerted.get(email) ?? 0) >= ALERT.windowMs) {
            const from = new Set(recent.map((f) => f.addr)).size;
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
        prune(now);
        const listener = listenerOf(ctx);
        let n: number;
        if (ip === "tailnet") {
          tailnetFails.push(now);
          n = tailnetFails.length;
        } else if (isNamed(ctx)) n = count(lockKey(email, listener, ip), LOCKOUT.failures);
        else {
          const u = unnamedOf(email, ctx);
          u.fails = [...u.fails, now].slice(-UNNAMED.ceiling);
          u.next = now + hold(u.fails.length);
          unnamedFails.push(now);
          n = u.fails.length;
          if (n >= UNNAMED.ceiling && now - u.told >= UNNAMED.hourMs) {
            u.told = now;
            alert(email, `🛡 **Sign-in held**: ${n} failed sign-ins for ${email} in the last hour from an unidentified address, so unidentified sign-in for it is off until the hour is up. Over the tailnet, or through the front door with its client address, you still sign in. If they aren't yours, check Settings → Accounts.`);
            log.warn({ email }, "unnamed sign-in held for the hour");
          }
        }
        if (listener === "signin") count(lockKey(email, "signin", "*"), LOCKOUT.accountFailures);
        log.warn({ email, ip, step: ctx.path, failures: n }, "sign-in failed");
      }),
    },
  } satisfies BetterAuthOptions;

  /**
   * One Better Auth endpoint (`sub`, e.g. "/sign-in/email") as this listener exposes it: a 404 otherwise, a 429 for a banned
   * address. The listener and the peer address are set here, never passed through. `trusted`: the request carries its
   * proxy's secret, so the proxy-named client address counts. `host` (and `proto`, else the forwarded scheme): the address
   * Better Auth sees. `cookie`: the cookies to send (already filtered by the caller).
   */
  async function call(auth: { handler: (r: Request) => Promise<Response> }, req: IncomingMessage, sub: string, listener: Listener, a: { body?: Buffer; type?: string; search?: string; host: string; proto?: "https" | "http"; trusted: boolean; cookie: string }): Promise<Response> {
    const method = String(req.method ?? "GET").toUpperCase();
    if (!EXPOSED[listener].has(`${method} ${sub}`)) return Response.json({ error: "not found" }, { status: 404 });
    const https = (a.proto ?? forwardedProto(req)) === "https";
    const headers = fromNodeHeaders(req.headers);
    headers.set("host", a.host);
    headers.delete("cookie");
    if (a.cookie) headers.set("cookie", a.cookie);
    for (const k of [...headers.keys()]) if (k.startsWith("x-aidenhq-")) headers.delete(k);
    headers.set(LISTENER_HEADER, listener);
    const named = (a.trusted ? ipOr(req.headers[CLIENT_IP_HEADER]) : "") || tailnetPeer(req, listener);
    headers.set(PEER_HEADER, named || ipOr(req.socket?.remoteAddress) || "unknown");
    if (named) headers.set(NAMED_HEADER, named);
    if (a.body) headers.set("content-type", a.type ?? "application/json");
    // A banned address is refused before Better Auth (its per-minute limit would answer first) and before any hashing.
    const ban = BAN_STEPS.has(sub) ? banKey({ headers }) : undefined;
    if (ban && (bans.get(ban) ?? 0) > Date.now()) return Response.json({ code: "BANNED", message: "too many failed sign-ins from this address: try again in an hour" }, { status: 429 });
    return auth.handler(new Request(`${https ? "https" : "http"}://${a.host}${sub}${a.search ?? ""}`, { method, headers, body: a.body && new Uint8Array(a.body) }));
  }

  /** A Better Auth response written to the client: no-store, host-only cookies for this listener. */
  async function write(r: Response, res: ServerResponse, https: boolean, listener: Listener): Promise<void> {
    const out: Record<string, string | string[]> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    r.headers.forEach((v, k) => {
      if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") out[k] = v;
    });
    const cookies = r.headers.getSetCookie().map((c) => outboundCookie(c, https, listener));
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
  }

  return { options, forget, lockedUntil, call, write };
}
