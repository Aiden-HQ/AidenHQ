// The gate (docs/design/access.md): the only door from Cloudflare Access to a shared app.
// cloudflared → gate on its unix socket (believes CF-Connecting-IP there only; 127.0.0.1:<port> for everything else) → the
// app's 127.0.0.1:<port>. Per request: the Host names the app (unknown: 404);
// the visitor is signed in (`login: access`: the Access token for that host's audience tag, RS256 from the team's JWKS;
// `login: password`: the board's Better Auth session, checked on the auth listener, cached 60 s; a host with an aud still
// needs the Access token too; `login: header-jwt`: a front door's signed ES256 token in a configured header, for that host's
// aud, no /.auth at all). Every inbound identity header and the Access token/cookie are stripped. Writes and WebSocket
// upgrades need a same-origin Origin (or Sec-Fetch-Site: same-origin), since sibling app hostnames are same-site.
// The app gets X-AidenHQ-Identity: a JWT the gate mints per request (docs/design/app-identity.md; Ed25519, 5 minutes, aud =
// the app), verified by the app with the shared middleware and the public keys. The upstream port comes only from the
// compiled config (config/gate.json, written by scripts/compile.ts at the owner's apply).
// App access (docs/design/access.md): the board's accounts.json says who is an
// account (email, name, role, disabled) and each shared app's default role and assignments by email. A member is an enabled
// account in password mode, and any Access-verified email whose account isn't disabled in access mode. Their role on an app:
// admin for an AidenHQ admin account, else their assignment, else the app's default, else blocked. The gate enforces only
// `blocked` (403, and the app is off their my-apps list); the app gets the identity token (sub, email, name, role) and
// decides the rest. `/.aidenhq/*` on an app host is the gate's own: access (→ the Access page),
// request (an in-app request, identity attached here) and requests (the visitor's own, with the agent's reply). The my-apps
// host lists the visitor's apps and serves each app's Access page to its admins; the board decides every change. Sign-in
// (password mode) is served only on the my-apps host; an app host gets its own host-only __Host- cookie through a one-time
// handoff. Whatever the gate can't read or check (keys, accounts, sessions) refuses with a 503.
// Preview hosts (cfg.previews; modules/apps-platform/apps-mcp/src/previews.ts): pr-<n>.<host> is the preview of the shared app at
// <host> for its pull request n, when apps-mcp's previews file names that preview with a port inside the compiled band.
// The gate derives everything else itself: the parent's Access audience (its Access application covers *.<host>) and the
// parent's role for the visitor; an identity token for the preview (so preview code can't replay it at the live app);
// requests and My apps stay the parent's. A preview runs unreviewed code under its parent's host, so with previews on every
// cookie an app sets through the gate is host-only (its Domain dropped): a preview can't toss cookies at the live app or
// any other, and a live app's cookies never reach its previews.
// Doors (cfg.doors; docs/design/app-doors.md): without settings.edge, on a local or public install, every exposed app opens
// for AidenHQ admins at <app>.<base> (`localhost` on loopback over http, or <ip-with-dashes>.sslip.io behind Caddy), its
// port from apps-mcp's doors file. A door has no sign-in of its own: a visitor without a session goes to the kernel's admin
// listener (`signin`), which signs them in and hands a one-time code back to the app host. `origin` (scheme and port) is
// how a browser names every host this gate serves; absent, https on the default port.
// The module door (a `hosts` entry with `door` and its own `origin`): a module service shared with no host, on every exposure
// mode without edge, at the board's own host name on the door port, which the front door passes to this gate. It is a door
// like the others (admins only, the admin listener's sign-in). It shares a host name with the board and the admin listener,
// whose cookies ignore ports, so an app host's session is the gate's own cookie (APP_SESSION_COOKIE), never Better Auth's
// name, and every aidenhq- cookie (the board's) is stripped like Better Auth's before any app.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { signinPage } from "./signin-pages.ts";

/**
 * Trust brands: a value of a branded type comes only from the place that checked it (an inline `as` at that site and nowhere
 * else). Anything read from a request (headers, cookies, query, body) is plain `string` and can't stand in for one.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };
/** An email a sign-in method verified (the Access token's, or the board's session's), trimmed and lowercased. */
export type VerifiedEmail = Brand<string, "VerifiedEmail">;
/** The identity JWT the gate minted for one request to one app (X-AidenHQ-Identity). */
export type IdentityToken = Brand<string, "IdentityToken">;

/** A shared app's host in the compiled config. */
export interface HostSite { app: string; port: number; aud?: string; default_role?: string; door?: true; origin?: string }
/** The site a request is for: a shared app's host, a preview of one (`parent`: the live app), or a door (`door`). */
export type Site = HostSite & { parent?: string; door?: true };
/** config/gate.json, as scripts/edge.ts compiles it (my_apps, auth_url and hosts are always written). */
export interface GateConfig {
  port: number;
  login?: string;
  issuer?: string;
  certs_url?: string;
  auth_url: string;
  auth_secret_file?: string;
  accounts_file?: string;
  owner_email?: string;
  /** login "header-jwt": a front door's signed ES256 identity token in `header`, from `issuer`'s keys at `jwks_url`. */
  identity?: { header: string; issuer: string; jwks_url: string; auth_method?: string };
  /** A second listener (a tailnet address the front door reaches) beside 127.0.0.1:port; same handler. */
  front?: { address: string; port: number };
  /** cloudflared's own way in: a unix socket only it and the gate mount. Only requests over it name the visitor (CF-Connecting-IP). */
  socket?: string;
  /** The sign-in and My apps host (settings.edge); a door has none (it signs in on the admin listener). */
  my_apps?: { host: string; aud?: string };
  /** How browsers name this gate's hosts: the scheme and, unless the default, the port. Absent: https. */
  origin?: { scheme: "http" | "https"; port?: number };
  /** Doors: every exposed app at <app>.<base>, its port from apps-mcp's `file`. */
  doors?: { base: string; file: string };
  /** settings.edge.test_user (scripts/edge.ts): the one non-owner account an allowlisted agent may sign in as, for these apps. */
  test_user?: { email: string; apps: string[] };
  /** The test listener's own bridge address (never the gate's port, the front door's socket or the tailnet): `*.canary.localhost`. */
  test_listener?: { address: string; port: number };
  /** Where a door's visitor signs in: the kernel's admin listener (every door, the module door included). */
  signin?: string;
  identity_key_file: string;
  hosts: Record<string, HostSite>;
  previews?: { file: string; ports: [number, number] };
}
export interface Account { role: "admin" | "user"; disabled: boolean; name: string }
export interface AppRoles { default?: string; roles?: Record<string, string> }
export interface AccountState { accounts: Map<string, Account>; apps: Record<string, AppRoles> }
interface Signer { key: KeyObject; kid: string }
export interface IdentityClaims { iss: string; aud: string; sub: string; kind: string; email: VerifiedEmail; name?: string; role: string; idp?: string; iat: number; exp: number }
type KeyLookup = (kid: string) => Promise<KeyObject | undefined>;
/** The board's answer for an app's Access page (modules/apps-platform/src/app-access.ts, in the kernel). */
export interface AccessPageData {
  app: string;
  host: string;
  default: string;
  roles: { name: string; meaning: string }[];
  assignments: { email: string; role: string; set_by: string; declared: boolean }[];
  log: { at: string; subject: string; before: string | null; after: string | null; by: string; asked_by: string | null; request_id: string | null }[];
}
/** One of the visitor's in-app requests, as the board lists them. */
export interface RequestRow { at: string; text: string; status: string; reply?: string | null }
/** The board's JSON answers the gate reads fields of. */
interface BoardReply { error?: string; code?: unknown; token?: unknown; requests?: RequestRow[] }
/** A refusal (or a redirect to sign-in): the status and a short text. */
interface Refusal { status: number; msg: string; location?: string; cookie?: string; email?: undefined }
/** A sign-in method's answer: the email it verified. */
interface SignIn { email: VerifiedEmail; idp: "access" | "password" | "header-jwt" }
interface Visitor { email: VerifiedEmail; name: string; idp: string | undefined }
/** What authorize() decided; each kind's flags are absent (undefined) on every other kind, so a truthy flag narrows. */
type Decision =
  | Refusal
  | { handoff: true; query: URLSearchParams }
  | { signOut: true }
  | { go: true; query: URLSearchParams }
  | { auth: true; path: string }
  | (Visitor & { mine: true; roleOf: (app: string) => string; access: boolean })
  | (Visitor & { requests: true; site: Site; role: string })
  | (Visitor & { request: true; site: Site; role: string })
  | (Visitor & { notify: true; site: Site; role: string })
  | (Visitor & { site: Site; role: string; app: string; token: IdentityToken });
type KeysOf<T> = T extends unknown ? keyof T : never;
type Exclusive<U, All extends PropertyKey = KeysOf<U>> = U extends unknown ? U & { [K in Exclude<All, keyof U>]?: undefined } : never;
type Authz = Exclusive<Decision>;
type Log = (o: Record<string, unknown>) => void;

const JWKS_MAX_AGE_MS = 3600_000;
const JWKS_HARD_MAX_MS = 2 * JWKS_MAX_AGE_MS; // past this without a good refresh, trust no cached key
const JWKS_REFETCH_MS = 30_000; // an unknown kid refetches at most this often
const LEEWAY_S = 60; // nbf only; exp is strict
const STRIP = /^(x-aidenhq-|tailscale-|cf-access-)/; // cf-access-jwt-assertion, -authenticated-user-email, -client-id…
const AUTH_PATH = "/.auth/"; // sign-in pages (the gate's own, signin-pages.ts) and Better Auth's endpoints (the kernel's sign-in listener)
// The only auth paths the gate passes on, and only on the sign-in host (my_apps): the pages (GET) and the endpoints that
// sign in, finish TOTP, set a password from a link and sign out (POST). Never get-session, list-sessions, change-*, token.
const AUTH_PAGES = new Set(["/.auth/sign-in", "/.auth/two-factor", "/.auth/set-password"]);
const AUTH_ASSETS = "/.auth/assets/";
const AUTH_API = new Set(["/.auth/api/sign-in/email", "/.auth/api/two-factor/verify-totp", "/.auth/api/reset-password", "/.auth/api/sign-out"]);
// Better Auth's cookies (to the auth listener only) and AidenHQ's own (the gate's app session, the board's on a shared host
// name): never to an app, and no app may set one.
const AUTH_COOKIE = /^(__secure-|__host-)?(better-auth\.|aidenhq-)/i;
// The session cookie, host-only on every host (the __Host- prefix forbids Domain, so no sibling host can toss one in).
// The my-apps host gets Better Auth's at sign-in; an app host gets the gate's own through a one-time handoff, sent on to the
// kernel under Better Auth's name. Its own name: the module door shares a host name with the admin listener (cookies ignore
// ports), whose Better Auth session it must never overwrite.
const SESSION_COOKIE = "__Host-better-auth.session_token";
const APP_SESSION_COOKIE = "__Host-aidenhq-gate.session";
const GO_PATH = "/.auth/go"; // my-apps host: signed in → a handoff code for ?to=<app URL> → that app's HANDOFF_PATH
const HANDOFF_PATH = "/.auth/handoff"; // app host: ?code=…&state=…&next=<path> → redeem with the board → host-only cookie
const SIGN_OUT_PATH = "/.auth/sign-out"; // app host: POST → the board revokes this host's session
const ACCESS_PATH = "/access"; // my-apps host: GET ?app= → that app's Access page (its admins); POST (a form) → a change, by the board
const RESERVED = "/.aidenhq"; // app hosts: the gate's own paths, never proxied
const REQUEST_MAX = 32 * 1024;
const FORM_MAX = 8 * 1024;
// The handoff's browser binding (login CSRF): the app host sets a random nonce in this cookie and sends it as `state`; the
// board binds the code to it and the handoff needs both to match. __Host- needs Path=/; its name matches AUTH_COOKIE, so it
// never reaches an app and an app can't set it.
const STATE_COOKIE = "__Host-better-auth.handoff_state";
const STATE = /^[0-9a-f]{32}$/;
const STATE_TTL_S = 300;
const STATE_CLEAR = `${STATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
const ENCODED = /%2e|%2f|%5c|\\/i; // no encoded dots or slashes, no backslashes, anywhere near /.auth
const AUTH_BODY_MAX = 64 * 1024;
const SESSION_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 1000;
const HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

const b64json = (s: string): unknown => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const IDENTITY_HEADER = "x-aidenhq-identity";
const IDENTITY_TTL_S = 300;

/** A person's stable, opaque id: the same under every sign-in method, from the email that method verified. */
export const subOf = (email: VerifiedEmail) => `u_${createHash("sha256").update(`aidenhq-user:${email.trim().toLowerCase()}`).digest("base64url").slice(0, 22)}`;
/**
 * The test user's subject: its own namespace, never `subOf`'s. A person with no Better Auth account (Access or header-JWT
 * mode, or an app's default role) can hold any email, so an email alone would give the canary that person's own subject and
 * the app could serve their records. The `u_` form stays (every app's own verifier requires it); the hash's namespace is the
 * test user's alone, so no real person's `subOf(email)` can ever equal it.
 */
export const testSubOf = (email: VerifiedEmail) => `u_${createHash("sha256").update(`aidenhq-test-user:${email.trim().toLowerCase()}`).digest("base64url").slice(0, 22)}`;

/** The gate's signing key (identity_key_file, Ed25519 PKCS#8), re-read when the file changes; its kid as scripts/identity.ts computes it. */
export function signingKey(file: string): () => Signer {
  let cached: Signer | undefined, mtime = -1;
  return () => {
    const m = statSync(file).mtimeMs;
    if (m !== mtime) {
      const key = createPrivateKey(readFileSync(file, "utf8"));
      const x = createPublicKey(key).export({ format: "jwk" }).x;
      cached = { key, kid: createHash("sha256").update(Buffer.from(x!, "base64url")).digest("base64url").slice(0, 16) };
      mtime = m;
    }
    return cached!;
  };
}

/** The gate's signer for `file`, cached across calls (the test listener mints with the same key and kid the gate uses). */
const signersByFile = new Map<string, () => Signer>();
export function signerFor(file: string): () => Signer {
  return signersByFile.get(file) ?? signersByFile.set(file, signingKey(file)).get(file)!;
}

/** A compact EdDSA JWT. */
export function mint({ key, kid }: Signer, claims: IdentityClaims): IdentityToken {
  const body = `${b64url({ alg: "EdDSA", kid, typ: "JWT" })}.${b64url(claims)}`;
  return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}` as IdentityToken;
}

/** Thrown when the gate can't trust any keys (never loaded, or the last good load is too old): the request gets a 503. */
export class KeysUnavailable extends Error {}

/**
 * The team's signing keys by kid, cached; refetched hourly or on an unknown kid (rate-limited). Fails closed: once the
 * last successful load is older than JWKS_HARD_MAX_MS (a rotated-out key may have been revoked), no key is trusted.
 */
export function jwks(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): KeyLookup {
  let keys = new Map<string, KeyObject>(), at = 0, tried = -Infinity, inflight: Promise<void> | undefined;
  const load = async () => {
    tried = now();
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`jwks ${r.status}`);
    const next = new Map();
    for (const k of ((await r.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? []) if ((k.kty === "RSA" || (k.kty === "EC" && k.crv === "P-256")) && k.kid) next.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
    keys = next;
    at = now();
  };
  return async (kid: string) => {
    if ((now() - at > JWKS_MAX_AGE_MS || !keys.has(kid)) && now() - tried > JWKS_REFETCH_MS) {
      inflight ??= load().catch((e) => console.error(JSON.stringify({ msg: "jwks fetch failed", err: String(e) }))).finally(() => (inflight = undefined));
      await inflight;
    }
    if (!at || now() - at > JWKS_HARD_MAX_MS) throw new KeysUnavailable("no fresh Access signing keys");
    return keys.get(kid);
  };
}

/** The token's claims, or throws: the one `alg` (RS256, or ES256 as JOSE's raw r||s), a known kid, valid signature, the issuer, this app's aud, not expired. */
export async function verifyToken(token: string, { issuer, aud, key, alg = "RS256" }: { issuer: string | undefined; aud: string; key: KeyLookup; alg?: "RS256" | "ES256" }) {
  const parts = String(token).split(".") as [string, string, string];
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64json(parts[0]) as { alg?: unknown; kid?: unknown };
  if (header.alg !== alg) throw new Error(`alg ${header.alg} not allowed`);
  const k = await key(String(header.kid ?? ""));
  if (!k) throw new Error("unknown signing key");
  if (k.asymmetricKeyType !== (alg === "ES256" ? "ec" : "rsa")) throw new Error("signing key type doesn't match alg"); // never mix key types
  if (!verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), alg === "ES256" ? { key: k, dsaEncoding: "ieee-p1363" } : k, Buffer.from(parts[2], "base64url"))) throw new Error("bad signature");
  const c = b64json(parts[1]) as { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown; auth_method?: unknown };
  const now = Date.now() / 1000;
  if (c.iss !== issuer) throw new Error("wrong issuer");
  if (![c.aud].flat().includes(aud)) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || now >= c.exp) throw new Error("expired");
  if (typeof c.nbf === "number" && now < c.nbf - LEEWAY_S) throw new Error("not yet valid");
  return c;
}

/** A Set-Cookie without any Domain attribute: host-only (a preview's cookies never reach a sibling host). */
export const hostOnly = (c: string) => c.replace(/;\s*domain\s*=[^;]*/gi, "");
export const hostOf = (req: IncomingMessage) => String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
const cookies = (req: IncomingMessage) => String(req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter(Boolean);
const cookieName = (c: string) => c.split("=")[0]!.trim();
/** Only Better Auth's cookies (for the auth listener), "" when there are none. */
const authCookies = (req: IncomingMessage) => cookies(req).filter((c) => AUTH_COOKIE.test(cookieName(c))).join("; ");
/** The session cookie's value (`name`: Better Auth's on the my-apps host, the gate's own on an app host) when the request carries exactly one, else "". */
const sessionCookie = (req: IncomingMessage, name: string) => {
  const found = cookies(req).filter((c) => cookieName(c) === name);
  return found.length === 1 ? found[0]!.slice(name.length + 1).trim() : "";
};
/** A same-host path to send a visitor back to, or "/". */
const localPath = (p: unknown) => {
  if (typeof p !== "string" || /[\x00-\x20\x7f\\]/.test(p)) return "/";
  try {
    const u = new URL(p, "https://x"); // as a browser resolves it: anything that leaves this origin goes home instead
    return u.origin === "https://x" ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
};

/** A host's origin as browsers name it: the module door's own, else cfg.origin (scheme and port; default https on 443). */
export const originOf = (cfg: Pick<GateConfig, "origin">, host: string, site?: Site) => site?.origin ?? `${cfg.origin?.scheme ?? "https"}://${host}${cfg.origin?.port ? `:${cfg.origin.port}` : ""}`;

/** The Access page and the request channel: the exact origin of this host, nothing else. */
const exactOrigin = (req: IncomingMessage, origin: string) => req.headers.origin === origin;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Same-origin for a state-changing request or an upgrade: the exact origin of this host, else Sec-Fetch-Site. */
export function sameOrigin(req: IncomingMessage, origin: string) {
  const o = req.headers.origin;
  if (o !== undefined) return o === origin;
  return req.headers["sec-fetch-site"] === "same-origin";
}

/** The request headers the app sees: no inbound identity, no Access token or cookie, no sign-in cookie; our token set. */
export function upstreamHeaders(req: IncomingMessage, token: IdentityToken, { upgrade = false, strip, proto = "https" }: { upgrade?: boolean; strip?: string; proto?: string } = {}): OutgoingHttpHeaders {
  const h: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!STRIP.test(k) && k !== strip && (upgrade ? !["proxy-connection", "keep-alive"].includes(k) : !HOP.includes(k))) h[k] = v;
  if (h.cookie) {
    const kept = cookies(req).filter((c) => cookieName(c).toLowerCase() !== "cf_authorization" && !AUTH_COOKIE.test(cookieName(c)));
    if (kept.length) h.cookie = kept.join("; ");
    else delete h.cookie;
  }
  return { ...h, [IDENTITY_HEADER]: token, "x-forwarded-proto": proto, "x-forwarded-host": req.headers.host ?? "" };
}

/**
 * The visitor's address: Cloudflare's CF-Connecting-IP (its edge always overwrites it), and only on the listener cloudflared
 * alone reaches (`socket`, `fromTunnel`): anything on the host's loopback reaches 127.0.0.1:<port> and could name any address
 * there. Elsewhere, absent or not an IP: "" (no header; the board counts the gate's socket address and bans nothing).
 */
export function clientIp(req: IncomingMessage, fromTunnel: boolean) {
  if (!fromTunnel) return "";
  const v = String(req.headers["cf-connecting-ip"] ?? "").trim().replace(/^::ffff:/, "");
  return isIP(v) ? v : "";
}

/** The board's shared secret (auth_secret_file): the auth listener trusts our client-IP header only beside it. */
const boardSecret = (cfg: GateConfig) => {
  try { return cfg.auth_secret_file ? readFileSync(cfg.auth_secret_file, "utf8").trim() : ""; } catch { return ""; }
};

/**
 * Sign-in traffic for the auth listener: no identity headers or Access token (STRIP drops any x-aidenhq-* a client sent),
 * only Better Auth's cookies, our forwarding, the visitor's address (failures count against it) and the board's secret.
 */
export function authHeaders(req: IncomingMessage, secret = "", fromTunnel = false): OutgoingHttpHeaders {
  const h: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!STRIP.test(k) && !HOP.includes(k) && !k.startsWith("x-forwarded-") && k !== "cookie" && k !== "accept-encoding") h[k] = v;
  const c = authCookies(req);
  const ip = clientIp(req, fromTunnel);
  return { ...h, ...(c ? { cookie: c } : {}), "x-forwarded-host": hostOf(req), "x-forwarded-proto": "https", ...(ip ? { "x-aidenhq-client-ip": ip } : {}), ...(secret ? { "x-aidenhq-gate": secret } : {}) };
}

const ROLE = /^[a-z][a-z0-9-]{1,30}$/;
/**
 * accounts.json → { accounts: Map(email → { role, disabled, name }), apps: { <app>: { default, roles: { email: role } } } }.
 * Roles arrive resolved by the board (one it doesn't know is already `blocked`). Throws on anything malformed (the gate then
 * refuses with a 503).
 */
export function parseAccounts(text: string): AccountState {
  const doc = JSON.parse(text) as { accounts?: unknown; apps?: unknown } | null;
  const list = doc?.accounts;
  if (!Array.isArray(list)) throw new Error("accounts.json: no accounts list");
  const accounts = new Map<string, Account>();
  for (const a of list as ({ email?: unknown; role?: unknown; disabled?: unknown; name?: unknown } | null)[]) {
    if (typeof a?.email !== "string" || !a.email.includes("@") || !(["admin", "user"] as unknown[]).includes(a.role) || typeof a.disabled !== "boolean") throw new Error("accounts.json: bad account entry");
    accounts.set(a.email.trim().toLowerCase(), { role: a.role as Account["role"], disabled: a.disabled, name: typeof a.name === "string" ? a.name : "" });
  }
  const apps = (doc!.apps ?? {}) as Record<string, { default?: unknown; roles?: unknown } | null>;
  if (typeof apps !== "object" || Array.isArray(apps)) throw new Error("accounts.json: bad apps");
  for (const r of Object.values(apps)) {
    const roles = r?.roles ?? {};
    if (!ROLE.test(String(r?.default)) || r!.default === "admin" || typeof roles !== "object" || Array.isArray(roles) || !Object.values(roles).every((x) => ROLE.test(String(x)))) throw new Error("accounts.json: bad app roles");
  }
  return { accounts, apps: apps as Record<string, AppRoles> };
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const STYLE = `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem}a{color:inherit}table{border-collapse:collapse;width:100%}td{padding:6px 8px 6px 0;vertical-align:middle}form{display:inline}.muted{color:#777;font-size:14px}input,select,button{font:inherit;padding:4px 8px}code{word-break:break-all}.note{padding:10px;border:1px solid #ccc;border-radius:8px}</style>`;
const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body>${body}</body></html>\n`;
/** The my-apps page: the apps this visitor may open, with their role; the apps they admin link to their Access page. */
export function myAppsPage(email: string, apps: { host: string; app: string; role: string }[]) {
  const items = apps.map((a) => `<li><a href="https://${esc(a.host)}/">${esc(a.app)}</a> <span class="muted">${esc(a.role)}</span>${a.role === "admin" ? ` · <a class="muted" href="${ACCESS_PATH}?app=${encodeURIComponent(a.app)}">Access</a>` : ""}</li>`).join("");
  return html("My apps", `<h1>My apps</h1><p>Signed in as ${esc(email)}.</p>${items ? `<ul>${items}</ul>` : "<p>No apps are shared with you yet.</p>"}`);
}
/** One app's Access page (its admins only): the roles, the default, who has which role, and the last changes. */
export function accessPage(p: AccessPageData) {
  const app = esc(p.app);
  const hidden = `<input type="hidden" name="app" value="${app}">`;
  const options = (pick: string, omit: string[] = []) => p.roles.filter((r) => !omit.includes(r.name)).map((r) => `<option value="${esc(r.name)}"${r.name === pick ? " selected" : ""}>${esc(r.name)}</option>`).join("");
  const form = (action: string, inner: string) => `<form method="post" action="${ACCESS_PATH}"><input type="hidden" name="action" value="${action}">${hidden}${inner}</form>`;
  const row = (a: AccessPageData["assignments"][number]) => `<tr><td>${esc(a.email)}</td><td>${form("role", `<input type="hidden" name="email" value="${esc(a.email)}"><select name="role">${options(a.role)}</select> <button>Save</button>`)}${a.declared ? "" : ` <span class="muted">${esc(a.role)}: no longer declared, so blocked</span>`}</td><td>${form("remove", `<input type="hidden" name="email" value="${esc(a.email)}"><button>Remove</button>`)}</td><td class="muted">${esc(a.set_by)}</td></tr>`;
  const change = (l: AccessPageData["log"][number]) => `<tr><td class="muted">${esc(String(l.at).slice(0, 16).replace("T", " "))}</td><td>${esc(l.subject)}</td><td>${esc(l.before ?? "none")} → ${esc(l.after ?? "none")}</td><td class="muted">${esc(l.by)}${l.asked_by ? `, asked by ${esc(l.asked_by)}` : ""}${l.request_id ? ` (${esc(l.request_id)})` : ""}</td></tr>`;
  return html(`${p.app}: access`, `<p><a href="/">My apps</a> · <a href="https://${esc(p.host)}/">Open ${app}</a></p><h1>${app}: access</h1>
<h2>Default</h2><p class="muted">What someone with no role below gets. AidenHQ admins are admins of every app.</p>${form("default", `<select name="role">${options(p.default, ["admin"])}</select> <button>Save</button>`)}
<h2>People</h2>${form("role", `<input name="email" type="email" placeholder="Email" required> <select name="role">${options("member")}</select> <button>Set</button>`)}
<table>${p.assignments.map(row).join("")}</table>
<h2>Roles</h2><dl>${p.roles.map((r) => `<dt><b>${esc(r.name)}</b></dt><dd class="muted">${esc(r.meaning)}</dd>`).join("")}</dl>
<h2>Changes</h2><table>${p.log.map(change).join("") || `<tr><td class="muted">None yet.</td></tr>`}</table>`);
}
/** The visitor's own in-app requests on this app, with the agent's reply. */
export function requestsPage(app: string, rows: RequestRow[]) {
  const row = (r: RequestRow) => `<tr><td class="muted">${esc(String(r.at).slice(0, 16).replace("T", " "))}</td><td>${esc(String(r.text).slice(0, 300))}</td><td>${esc(r.status)}</td><td>${esc(r.reply ?? "")}</td></tr>`;
  return html(`${app}: your requests`, `<p><a href="/">Back to ${esc(app)}</a></p><h1>Your requests</h1>${rows.length ? `<table><tr><th>When</th><th>Request</th><th>Status</th><th>Reply</th></tr>${rows.map(row).join("")}</table>` : "<p>None yet.</p>"}`);
}

const PREVIEW_HOST = /^pr-([1-9][0-9]{0,5})\.(.+)$/;
/**
 * A preview host's site, or undefined: its parent must be a compiled app host (whose Access audience it takes), and the previews file (apps-mcp's, re-read
 * when it changes; absent = none) must name the preview with a port in the compiled band. Throws when the file is unreadable.
 */
export function previewSites(): (cfg: GateConfig, host: string) => Site | undefined {
  let text: string | undefined, map: Record<string, unknown> = {};
  return (cfg, host) => {
    const pv = cfg.previews;
    const m = pv && PREVIEW_HOST.exec(host);
    const parent = m && (Object.hasOwn(cfg.hosts ?? {}, m[2]!) ? cfg.hosts[m[2]!] : undefined);
    if (!parent) return undefined;
    let t: string;
    try { t = readFileSync(pv!.file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") t = "{}"; else throw e; }
    if (t !== text) {
      const next = JSON.parse(t) as Record<string, unknown> | null;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("previews file: not a map");
      map = next;
      text = t;
    }
    const app = `${parent.app}-pr-${m[1]}`;
    const port = (Object.hasOwn(map, app) ? map[app] : undefined) as number; // checked next
    if (!Number.isInteger(port) || port < pv!.ports[0] || port > pv!.ports[1]) return undefined;
    return { app, parent: parent.app, port, ...(parent.aud ? { aud: parent.aud } : {}) };
  };
}

// apps-mcp's registry ports the gate must never be pointed at (modules/apps-platform/apps-mcp/src/policy.ts RESERVED), and
// the kernel's admin and sign-in listeners and the board's (3120-3122, 3129).
const PLATFORM_PORTS = new Set([443, 3100, 3120, 3121, 3122, 3129, 3130, 8090, 8443]);
const DOOR_NAME = /^[a-z][a-z0-9-]{1,30}$/;
/**
 * A door host's site, or undefined: <name>.<base> where apps-mcp's doors file (re-read when it changes; absent = none) names
 * the app with a port the gate may use. Throws when the file is unreadable.
 */
export function doorSites(): (cfg: GateConfig, host: string) => Site | undefined {
  let text: string | undefined, map: Record<string, unknown> = {};
  return (cfg, host) => {
    const d = cfg.doors;
    if (!d || !host.endsWith(`.${d.base}`)) return undefined;
    const app = host.slice(0, -d.base.length - 1);
    if (!DOOR_NAME.test(app)) return undefined;
    let t: string;
    try { t = readFileSync(d.file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") t = "{}"; else throw e; }
    if (t !== text) {
      const next = JSON.parse(t) as Record<string, unknown> | null;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("doors file: not a map");
      map = next;
      text = t;
    }
    const port = (Object.hasOwn(map, app) ? map[app] : undefined) as number; // checked next
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || PLATFORM_PORTS.has(port)) return undefined;
    // A name a compiled host already serves (the module door's service, e.g. primer) is never an app door's: its token would be
    // good at that service.
    if (Object.values(cfg.hosts ?? {}).some((h) => h.app === app)) return undefined;
    return { app, port, door: true };
  };
}

/**
 * createGate({ config, fetch }) → http.Server. `config()` returns the compiled gate config (re-read by the caller as it
 * changes): { login, issuer?, certs_url?, auth_url?, auth_secret_file?, accounts_file, owner_email, my_apps?: { host, aud? },
 * identity_key_file, hosts: { <host>: { app, port, aud?, default_role? } }, previews?: { file, ports: [min, max] } }.
 * identity_key_file: the gate's Ed25519 signing key (vault identity/gate.pem, mounted read-only): it mints each app's token.
 * auth_secret_file: the board's (gate_board_secret), sent as X-AidenHQ-Gate to the auth listener in password mode.
 * accounts_file: the board's account map and app roles (mounted read-only), re-read when its content changes.
 * fromTunnel: this server listens on cloudflared's socket (main.ts), so CF-Connecting-IP names the visitor.
 */
export function createGate({ config, fetch: fetchImpl = fetch, now = Date.now, log = (o) => console.log(JSON.stringify(o)), fromTunnel = false }: { config: () => GateConfig; fetch?: typeof fetch; now?: () => number; log?: Log; fromTunnel?: boolean }): Server {
  const keysets = new Map<string, KeyLookup>(); // certs_url → key lookup (one in practice)
  const keyFor = (url: string) => keysets.get(url) ?? keysets.set(url, jwks(url, fetchImpl, now)).get(url)!;
  // identity_key_file → its key (one in practice), shared with the test listener through signerFor().
  const previewOf = previewSites();
  const doorOf = doorSites();

  let state: AccountState | undefined, stateText: string | undefined;
  /** The board's accounts and app roles, re-parsed when the file's text changes; throws when it can't be read. */
  const accountState = (file: string | undefined): AccountState => {
    if (!file) throw new Error("no accounts_file");
    const text = readFileSync(file, "utf8");
    if (text !== stateText) {
      state = parseAccounts(text);
      stateText = text; // only after a good parse: a torn write is read again on the next request
    }
    return state!;
  };

  const sessions = new Map<string, { at: number; email: VerifiedEmail }>(); // sha256(auth cookies) → { at, email }
  /** The signed-in email from the board's get-session; null for no session; throws when the answer can't be trusted. */
  async function sessionEmail(req: IncomingMessage, cfg: GateConfig): Promise<VerifiedEmail | null> {
    const v = sessionCookie(req, cfg.my_apps?.host === hostOf(req) ? SESSION_COOKIE : APP_SESSION_COOKIE);
    if (!v) return null;
    const c = `${SESSION_COOKIE}=${v}`;
    // Per host: an app host's session is bound to the host it was handed to (the kernel checks), so its cached answer is too.
    const key = createHash("sha256").update(`${hostOf(req)}\n${c}`).digest("hex");
    const hit = sessions.get(key);
    if (hit && now() - hit.at < SESSION_TTL_MS) return hit.email;
    const secret = boardSecret(cfg);
    const r = await fetchImpl(new URL("/.auth/api/get-session", cfg.auth_url), { headers: { cookie: c, "x-forwarded-host": hostOf(req), "x-forwarded-proto": "https", ...(secret ? { "x-aidenhq-gate": secret } : {}) }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`get-session ${r.status}`);
    const body = (await r.json()) as { user?: { banned?: unknown; email?: unknown } } | null;
    if (body === null || body?.user?.banned === true) return null;
    // The board checked the session: the brand is minted here and in accessEmail only.
    const email = (typeof body?.user?.email === "string" ? body.user.email.trim().toLowerCase() : "") as VerifiedEmail;
    if (!email.includes("@")) throw new Error("get-session: no user email");
    if (sessions.size >= SESSION_CACHE_MAX) sessions.clear();
    sessions.set(key, { at: now(), email });
    return email;
  }

  /** → { email } from the Access token for this host's aud, or a refusal. */
  async function accessEmail(req: IncomingMessage, cfg: GateConfig, host: string, aud: string | undefined): Promise<{ email: VerifiedEmail } | Refusal> {
    const token = req.headers["cf-access-jwt-assertion"];
    try {
      if (!aud) throw new Error("no aud for this host");
      if (!token || Array.isArray(token)) throw new Error("no token");
      // compile writes certs_url whenever a host has an aud (an aud needs the team: scripts/edge.ts)
      const claims = await verifyToken(token, { issuer: cfg.issuer, aud, key: keyFor(cfg.certs_url!) });
      // The Access token checked out: the brand is minted here and in sessionEmail only.
      const email = (typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "") as VerifiedEmail;
      return email ? { email } : { status: 403, msg: "forbidden: no email in the token" };
    } catch (e) {
      log({ msg: "denied", host, why: (e as Error).message });
      return e instanceof KeysUnavailable ? { status: 503, msg: "unavailable: can't verify sign-ins right now" } : { status: 403, msg: "forbidden" };
    }
  }

  /**
   * Sign-in methods (docs/design/app-identity.md): authenticate(req, cfg, host, aud) → { email, idp } with an email the
   * provider verified, null for no credential, or a refusal { status, msg }. `access` admits (and identifies in access mode);
   * `password` identifies. When both run (a password host with an aud), both must pass and the session names the person.
   * A new method (direct OIDC, Google, Tailscale) is one more entry here plus its place in authorize().
   */
  const adapters = {
    access: { authenticate: async (req: IncomingMessage, cfg: GateConfig, host: string, aud: string | undefined): Promise<SignIn | Refusal> => { const a = await accessEmail(req, cfg, host, aud); return a.email ? { email: a.email, idp: "access" } : (a as Refusal); } },
    // A front door's signed identity header (docs/design/access.md): its token for this host's aud, a verified email, and the
    // configured auth_method when there is one (a magic-link sign-in is refused where only SSO is meant).
    headerJwt: { authenticate: async (req: IncomingMessage, cfg: GateConfig, host: string, aud: string | undefined): Promise<SignIn | Refusal> => {
      const id = cfg.identity;
      const token = id && req.headers[id.header];
      try {
        if (!id || !aud) throw new Error("no identity settings or aud for this host");
        if (!token || Array.isArray(token)) throw new Error("no token");
        const claims = await verifyToken(token, { issuer: id.issuer, aud, key: keyFor(id.jwks_url), alg: "ES256" });
        if (id.auth_method && claims.auth_method !== id.auth_method) throw new Error(`auth_method ${String(claims.auth_method)} not allowed`);
        const email = (typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "") as VerifiedEmail;
        return email ? { email, idp: "header-jwt" } : { status: 401, msg: "unauthorized: no email in the token" };
      } catch (e) {
        log({ msg: "denied", host, why: (e as Error).message });
        return e instanceof KeysUnavailable ? { status: 503, msg: "unavailable: can't verify sign-ins right now" } : { status: 401, msg: "unauthorized" };
      }
    } },
    password: { authenticate: async (req: IncomingMessage, cfg: GateConfig): Promise<SignIn | null> => { const email = await sessionEmail(req, cfg); return email ? { email, idp: "password" } : null; } },
  };

  /**
   * → { status, msg, location? } to refuse (or send to sign-in), { auth: true } for the auth listener,
   * { mine: true, email, name, roleOf, access } for the my-apps host, { request | requests: true, site, email, role } for
   * the gate's own /.aidenhq paths, or { site, email, name, role, app, secret } to proxy.
   */
  async function authorize(req: IncomingMessage, { upgrade }: { upgrade: boolean }): Promise<Authz> {
    const cfg = config();
    const host = hostOf(req);
    let site: Site | undefined;
    try {
      site = Object.hasOwn(cfg.hosts ?? {}, host) ? cfg.hosts[host] : (previewOf(cfg, host) ?? (cfg.my_apps?.host === host ? undefined : doorOf(cfg, host)));
    } catch (e) {
      log({ msg: "previews or doors unreadable", err: String(e) });
      return { status: 503, msg: "unavailable: can't read the app list right now" };
    }
    const origin = originOf(cfg, host, site);
    const mine = !site && cfg.my_apps?.host === host;
    if (!site && !mine) return { status: 404, msg: "not found" };
    const url = String(req.url ?? "");
    if (!url.startsWith("/")) return { status: 400, msg: "bad request" };
    const login = cfg.login ?? "access";
    if (!["access", "password", "header-jwt"].includes(login)) {
      log({ msg: "unknown login mode", login });
      return { status: 503, msg: "unavailable: misconfigured" };
    }
    const read = req.method === "GET" || req.method === "HEAD";
    const aud = (site ?? cfg.my_apps)?.aud;

    // Access: always in access mode (a host without an aud is refused), and on a password-mode host that has an aud.
    let email: VerifiedEmail | undefined, idp: string | undefined;
    if (login === "header-jwt") {
      const a = await adapters.headerJwt.authenticate(req, cfg, host, aud);
      if (!a.email) return a as Refusal;
      ({ email, idp } = a);
    } else if (login === "access" || aud) {
      const a = await adapters.access.authenticate(req, cfg, host, aud);
      if (!a.email) return a as Refusal; // a verified email is never empty
      ({ email, idp } = a);
    }
    // /.auth is judged on the normalised path (what a server behind us would see), and anything encoded is refused.
    const rawPath = url.split("?")[0]!;
    let norm: URL;
    try { norm = new URL(`http://gate${url}`); } catch { return { status: 400, msg: "bad request" }; }
    if (norm.pathname === "/.auth" || norm.pathname.startsWith(AUTH_PATH) || /(^|\/)(\.|%2e)auth([/\\]|%2f|%5c|$)/i.test(rawPath)) {
      if (ENCODED.test(rawPath)) return { status: 400, msg: "bad request" };
      const path = norm.pathname;
      if (login !== "password" || upgrade) return { status: 404, msg: "not found" };
      // App hosts: only the handoff. The my-apps host: the handoff source and the allowlisted sign-in pages and endpoints.
      if (site) {
        if (read && path === HANDOFF_PATH) return { handoff: true, query: norm.searchParams };
        if (req.method === "POST" && path === SIGN_OUT_PATH) return sameOrigin(req, origin) ? { signOut: true } : { status: 403, msg: "forbidden: cross-origin" };
        return { status: 404, msg: "not found" };
      }
      if (read && path === GO_PATH) return { go: true, query: norm.searchParams };
      const page = read && (AUTH_PAGES.has(path) || path.startsWith(AUTH_ASSETS));
      const api = req.method === "POST" && AUTH_API.has(path);
      if (!page && !api) return { status: 404, msg: "not found" };
      // Sibling app hosts are same-site: another host's page must not sign a visitor in or out here.
      return read || sameOrigin(req, origin) ? { auth: true, path: `${path}${norm.search}` } : { status: 403, msg: "forbidden: cross-origin" };
    }
    if (login === "password") {
      try {
        ({ email, idp } = (await adapters.password.authenticate(req, cfg)) ?? ({} as Partial<SignIn>));
      } catch (e) {
        log({ msg: "session check failed", host, err: String(e) });
        return { status: 503, msg: "unavailable: can't check sign-ins right now" };
      }
      if (!email) {
        if (upgrade || !read) return { status: 401, msg: "sign in first" };
        if (mine) return { status: 302, msg: "sign in", location: `${AUTH_PATH}sign-in?next=${encodeURIComponent(url)}` };
        const state = randomBytes(16).toString("hex");
        const cookie = `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_S}; Secure; HttpOnly; SameSite=Lax`;
        // A door signs in on the kernel's admin listener, which hands a code back to this host (never a sign-in form here).
        if (site?.door) return { status: 302, msg: "sign in", location: `${cfg.signin}/auth/handoff?${new URLSearchParams({ to: origin, state, next: url })}`, cookie };
        if (!cfg.my_apps) return { status: 503, msg: "unavailable: misconfigured" };
        return { status: 302, msg: "sign in", location: `https://${cfg.my_apps.host}${GO_PATH}?to=${encodeURIComponent(`https://${host}${url}`)}&state=${state}`, cookie };
      }
    }

    let st: AccountState;
    try {
      st = accountState(cfg.accounts_file);
    } catch (e) {
      log({ msg: "accounts unreadable", err: String(e) });
      return { status: 503, msg: "unavailable: can't read accounts right now" };
    }
    // Signed in by now: the login is access (the Access check named them above) or password (the session did).
    const acct = st.accounts.get(email!);
    if (acct?.disabled) {
      log({ msg: "denied", host, email, why: "disabled" });
      return { status: 403, msg: "forbidden: this account is disabled" };
    }
    // Password mode: a member is an account (a session with none, removed or not yet in the map, gets nothing). Access mode:
    // every email the Access policy admits is a member, account or not.
    if (login === "password" && !acct) return { status: 403, msg: "forbidden: no account" };
    // An AidenHQ admin by its account (the owner's is one) is an admin of every app; else the app's assignment, its default,
    // or blocked.
    const roleOf = (app: string): string => {
      if (acct?.role === "admin") return "admin";
      const a = Object.hasOwn(st.apps, app) ? st.apps[app] : undefined;
      return (a && Object.hasOwn(a.roles ?? {}, email!) ? a.roles![email!] : a?.default) ?? "blocked";
    };
    const who: Visitor = { email: email!, name: acct?.name ?? "", idp };
    if (mine) {
      const p = url.split("?")[0];
      if (upgrade || (p !== "/" && p !== ACCESS_PATH) || (p === "/" && !read)) return { status: 404, msg: "not found" };
      if (p === ACCESS_PATH && !read && !exactOrigin(req, origin)) return { status: 403, msg: "forbidden: cross-origin" };
      return { mine: true, ...who, roleOf, access: p === ACCESS_PATH };
    }

    // Not the my-apps host, so an app host: site is set (else the 404 above). A door is for AidenHQ admins only, whatever
    // the app or accounts.json say: other people get an app by sharing it.
    if (site!.door && acct?.role !== "admin") {
      log({ msg: "denied", host, email, why: "door: not an admin" });
      return { status: 403, msg: "forbidden: this app opens only for AidenHQ admins until it is shared" };
    }
    const role = roleOf(site!.parent ?? site!.app); // a preview: its parent app's access
    if (role === "blocked") {
      log({ msg: "denied", host, email, why: "blocked" });
      return { status: 403, msg: "forbidden: this app isn't shared with you" };
    }
    // The gate's own paths on an app host (judged on the normalised path; anything encoded near them is refused).
    if (norm.pathname === RESERVED || norm.pathname.startsWith(`${RESERVED}/`) || /(^|\/)(\.|%2e)aidenhq([/\\]|%2f|%5c|$)/i.test(rawPath)) {
      if (ENCODED.test(rawPath) || upgrade) return { status: 400, msg: "bad request" };
      const path = norm.pathname;
      if (read && path === `${RESERVED}/access`) return cfg.my_apps?.host ? { status: 302, msg: "access", location: `https://${cfg.my_apps.host}${ACCESS_PATH}?app=${encodeURIComponent(site!.parent ?? site!.app)}` } : { status: 404, msg: "not found" };
      if (site!.parent || site!.door) return { status: 404, msg: "not found" }; // requests are a shared live app's, never a preview's or a door's
      if (read && path === `${RESERVED}/requests`) return { requests: true, site: site!, ...who, role };
      if (req.method === "POST" && path === `${RESERVED}/request`) return exactOrigin(req, origin) ? { request: true, site: site!, ...who, role } : { status: 403, msg: "forbidden: cross-origin" };
      if (req.method === "POST" && path === `${RESERVED}/notify`) return exactOrigin(req, origin) ? { notify: true, site: site!, ...who, role } : { status: 403, msg: "forbidden: cross-origin" };
      return { status: 404, msg: "not found" };
    }
    if ((upgrade || !read) && !sameOrigin(req, origin)) return { status: 403, msg: "forbidden: cross-origin" };
    // The app's identity token for this request: without the signing key, refuse rather than send one the app must reject.
    let token: IdentityToken;
    try {
      const iat = Math.floor(now() / 1000);
      token = mint(signerFor(cfg.identity_key_file)(), { iss: "aidenhq-gate", aud: site!.app, sub: subOf(email!), kind: "person", email: email!, name: who.name, role, idp, iat, exp: iat + IDENTITY_TTL_S });
    } catch (e) {
      log({ msg: "can't sign identity", host, err: String(e) });
      return { status: 503, msg: "unavailable: can't sign you in to this app right now" };
    }
    return { site: site!, ...who, role, app: site!.app, token };
  }

  /** The my-apps list: every shared app whose role for the visitor isn't blocked, with that role. */
  const appsFor = (cfg: GateConfig, roleOf: (app: string) => string) => Object.entries(cfg.hosts ?? {})
    .map(([host, s]) => ({ host, app: s.app, role: roleOf(s.app) }))
    .filter((a) => a.role !== "blocked")
    .sort((x, y) => x.app.localeCompare(y.app));

  /** An auth endpoint's answer without any `token` field (Better Auth returns the session token in sign-in bodies). */
  const tokenless = (r: IncomingMessage, res: ServerResponse, h: IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    let size = 0;
    r.on("data", (c: Buffer) => {
      size += c.length;
      if (size > AUTH_BODY_MAX) return void r.destroy(), res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway\n");
      chunks.push(c);
    });
    r.on("end", () => {
      if (res.headersSent) return;
      let body = Buffer.concat(chunks);
      if (h["content-encoding"]) return void res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway\n"); // asked for identity
      if (/json/i.test(String(h["content-type"] ?? "")) && body.length) {
        try {
          body = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8")), (k, v) => (k.toLowerCase() === "token" ? undefined : v)));
        } catch {
          return void res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway\n");
        }
      } else if (body.length) return void res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway\n"); // only JSON from the API
      res.writeHead(r.statusCode ?? 502, r.statusMessage, { ...h, "content-length": body.length }).end(body);
    });
  };

  const plain = (res: ServerResponse, status: number, msg: string, headers: OutgoingHttpHeaders = {}) => void res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", ...headers }).end(`${msg}\n`);
  /**
   * POST JSON to the kernel's sign-in listener → { status, body }. The cookie is a browser's on an https host: the board reads
   * the __Host- names only with x-forwarded-proto https.
   */
  const board = async (cfg: GateConfig, path: string, body: Record<string, unknown>, cookie?: string): Promise<{ status: number; body: BoardReply | null }> => {
    const secret = boardSecret(cfg);
    const headers = { "content-type": "application/json", "x-forwarded-proto": "https", ...(cookie ? { cookie } : {}), ...(secret ? { "x-aidenhq-gate": secret } : {}) };
    const r = await fetchImpl(new URL(path, cfg.auth_url), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: (await r.json().catch(() => null)) as BoardReply | null };
  };

  const PAGE = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
  /** A form post's fields (urlencoded, small). */
  const form = async (req: IncomingMessage) => {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return null;
    let text = "";
    for await (const c of req) if ((text += c).length > FORM_MAX) return null;
    return new URLSearchParams(text);
  };

  /** A JSON body (small), or null. */
  const jsonBody = async (req: IncomingMessage): Promise<unknown> => {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return null;
    let text = "";
    for await (const c of req) if ((text += c).length > REQUEST_MAX) return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  /** The board's answer to a refused change, as plain text with its status (never a 5xx: those throw). */
  const refused = (res: ServerResponse, r: { status: number; body: BoardReply | null }) => plain(res, [400, 403, 404, 409, 429].includes(r.status) ? r.status : 400, r.body?.error ?? "bad request");

  /**
   * My-apps host, /access?app=<name>: the app's Access page for its admins (AidenHQ admins and the app's own). The gate says
   * who is asking (the email it signed in or verified); the board checks they're an admin of that app and makes every change.
   */
  async function access(req: IncomingMessage, res: ServerResponse, email: VerifiedEmail) {
    const cfg = config();
    try {
      let app = new URL(`http://gate${req.url}`).searchParams.get("app") ?? "";
      if (req.method === "POST") {
        const f = await form(req);
        if (!f) return plain(res, 400, "bad request");
        app = f.get("app") ?? "";
        const action = f.get("action");
        const call: [string, Record<string, unknown>] | null = action === "role" ? ["role", { email: f.get("email") ?? "", role: f.get("role") ?? "" }]
          : action === "remove" ? ["role", { email: f.get("email") ?? "", role: null }]
          : action === "default" ? ["default", { role: f.get("role") ?? "" }] : null;
        if (!call) return plain(res, 400, "bad request");
        const r = await board(cfg, `/.auth/api/app-access/${call[0]}`, { by: email, app, ...call[1] });
        if (r.status >= 500) throw new Error(`app-access ${action} ${r.status}: ${r.body?.error ?? ""}`);
        if (r.status !== 200) return refused(res, r);
        // Back to the page (a reload doesn't post it again).
        return plain(res, 303, "done", { location: `${ACCESS_PATH}?app=${encodeURIComponent(app)}` });
      }
      const m = await board(cfg, "/.auth/api/app-access/page", { by: email, app });
      if (m.status >= 500) throw new Error(`app-access page ${m.status}`);
      if (m.status !== 200) return refused(res, m);
      res.writeHead(200, PAGE).end(req.method === "HEAD" ? undefined : accessPage(m.body as unknown as AccessPageData));
    } catch (e) {
      log({ msg: "app access failed", err: String(e) });
      plain(res, 503, "unavailable: the change may not have reached the gate; reload and check");
    }
  }

  /** App host, POST /.aidenhq/request {text, context?}: an in-app request; the identity is the gate's, never the app's. */
  async function inAppRequest(req: IncomingMessage, res: ServerResponse, a: { email: VerifiedEmail; site: Site }) {
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    const b = (await jsonBody(req)) as { text?: unknown; context?: unknown } | null;
    const text = typeof b?.text === "string" ? b.text.trim() : "";
    const context = b?.context === undefined ? undefined : typeof b.context === "string" ? b.context : JSON.stringify(b.context);
    if (!text || text.length > 4000 || (context !== undefined && context.length > 500)) return json(400, { error: "text (1 to 4000 characters) and an optional context (up to 500)" });
    try {
      const r = await board(config(), "/.auth/api/app-request/new", { email: a.email, app: a.site.app, text, ...(context !== undefined ? { context } : {}) });
      if (r.status >= 500) throw new Error(`app-request ${r.status}`);
      json(r.status, r.body ?? {});
    } catch (e) {
      log({ msg: "app request failed", err: String(e) });
      json(503, { error: "unavailable: try again" });
    }
  }

  /**
   * App host, POST /.aidenhq/notify: the page says people sent something into the app's own intake, so the board wakes the
   * agent the registry names for it. The app is this host's and the body is never read: no text reaches the board.
   */
  async function notifyOwner(req: IncomingMessage, res: ServerResponse, a: { email: VerifiedEmail; site: Site }) {
    req.resume(); // drained unread
    try {
      const r = await board(config(), "/.auth/api/app-feedback/new", { email: a.email, app: a.site.app });
      if (r.status >= 500) throw new Error(`app-feedback ${r.status}`);
      res.writeHead(r.status === 200 ? 204 : r.status, { "cache-control": "no-store" }).end();
    } catch (e) {
      log({ msg: "app notify failed", err: String(e) });
      res.writeHead(503, { "cache-control": "no-store" }).end();
    }
  }

  /** App host, GET /.aidenhq/requests: the visitor's own requests on this app, with status and reply. */
  async function myRequests(req: IncomingMessage, res: ServerResponse, a: { email: VerifiedEmail; site: Site }) {
    try {
      const r = await board(config(), "/.auth/api/app-request/mine", { email: a.email, app: a.site.app });
      if (r.status !== 200) throw new Error(`app-request mine ${r.status}`);
      res.writeHead(200, PAGE).end(req.method === "HEAD" ? undefined : requestsPage(a.site.app, r.body!.requests ?? []));
    } catch (e) {
      log({ msg: "my requests failed", err: String(e) });
      plain(res, 503, "unavailable: try again");
    }
  }

  /** My-apps host, GET /.auth/go?to=<app URL>&state=<nonce>: signed in here → a code for that app host and browser → its handoff. */
  async function go(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
    const cfg = config();
    const to = query.get("to") ?? "";
    const state = query.get("state") ?? "";
    let t: URL | undefined;
    try { t = new URL(to); } catch {}
    const known = (h: string) => { try { return Object.hasOwn(cfg.hosts ?? {}, h) || !!previewOf(cfg, h); } catch { return false; } };
    if (!t || t.protocol !== "https:" || t.username || t.password || t.port || !known(t.hostname) || !STATE.test(state)) return plain(res, 400, "bad request");
    try {
      const email = await sessionEmail(req, cfg);
      if (!email) return plain(res, 302, "sign in", { location: `${AUTH_PATH}sign-in?next=${encodeURIComponent(`${GO_PATH}?to=${encodeURIComponent(t.href)}&state=${state}`)}` });
      const m = await board(cfg, "/.auth/api/handoff/mint", { host: t.hostname, state }, `${SESSION_COOKIE}=${sessionCookie(req, SESSION_COOKIE)}`);
      if (m.status >= 400 && m.status < 500) return plain(res, 403, "forbidden");
      const code = m.body?.code;
      if (m.status !== 200 || typeof code !== "string" || !code) throw new Error(`handoff mint ${m.status}`);
      plain(res, 302, "continue", { location: `https://${t.hostname}${HANDOFF_PATH}?code=${encodeURIComponent(code)}&state=${state}&next=${encodeURIComponent(t.pathname + t.search + t.hash)}`, "referrer-policy": "no-referrer" });
    } catch (e) {
      log({ msg: "handoff mint failed", err: String(e) });
      plain(res, 503, "unavailable: can't sign you in right now");
    }
  }

  /**
   * App host, GET /.auth/handoff?code=…&state=…&next=<path>: only in the browser that started it (the state cookie this host
   * set equals `state`), the board redeems the code for this host → a host-only session cookie. The state cookie is cleared.
   */
  async function handoff(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
    const cfg = config();
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    const clear = { "set-cookie": [STATE_CLEAR] };
    if (!code || code.length > 512 || !STATE.test(state)) return plain(res, 400, "bad request", clear);
    const mine = cookies(req).filter((c) => cookieName(c) === STATE_COOKIE).map((c) => c.slice(STATE_COOKIE.length + 1).trim());
    if (mine.length !== 1 || !safeEqual(mine[0]!, state)) {
      log({ msg: "handoff refused", host: hostOf(req), why: "state mismatch" });
      // Over plain http a browser that keeps no Secure cookie there (Safari on localhost) never has one: say so.
      return plain(res, 403, cfg.origin?.scheme === "http" && !mine.length ? "Open this app in Chrome or Firefox. Safari doesn't keep the sign-in for apps on a local install." : "forbidden: this sign-in didn't start in this browser; open the app again", clear);
    }
    try {
      const r = await board(cfg, "/.auth/api/handoff/redeem", { code, host: hostOf(req), state });
      if (r.status >= 400 && r.status < 500) return plain(res, 403, "forbidden: this sign-in link is used or expired; open the app again", clear);
      const token = r.body?.token;
      if (r.status !== 200 || typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]{16,1024}$/.test(token)) throw new Error(`handoff redeem ${r.status}`);
      plain(res, 302, "signed in", { location: localPath(query.get("next")), "set-cookie": [`${APP_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`, STATE_CLEAR], "referrer-policy": "no-referrer" });
    } catch (e) {
      log({ msg: "handoff redeem failed", err: String(e) });
      plain(res, 503, "unavailable: can't sign you in right now", clear);
    }
  }

  /** App host, POST /.auth/sign-out: the board revokes this host's session; the cookie expires and the cache forgets it. */
  async function signOut(req: IncomingMessage, res: ServerResponse) {
    const cfg = config();
    const v = sessionCookie(req, APP_SESSION_COOKIE);
    sessions.clear(); // a sign-out through the gate ends every cached answer at once, not within 60 s
    const headers = { "set-cookie": [`${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`], location: cfg.my_apps ? `https://${cfg.my_apps.host}/` : `${cfg.signin ?? ""}/` };
    if (!v) return plain(res, 303, "signed out", headers);
    try {
      const r = await board(cfg, "/.auth/api/handoff/revoke", { host: hostOf(req) }, `${SESSION_COOKIE}=${v}`);
      if (r.status >= 500) throw new Error(`handoff revoke ${r.status}`);
      plain(res, 303, "signed out", headers);
    } catch (e) {
      log({ msg: "sign-out failed", err: String(e) });
      plain(res, 503, "unavailable: the session may still be valid; try again", { "set-cookie": headers["set-cookie"] });
    }
  }

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // Caddy's on-demand TLS asks here (on loopback) before ordering a certificate: only for a door that serves an app.
    const cfg0 = config();
    if (cfg0.doors && hostOf(req) === "127.0.0.1" && req.method === "GET" && String(req.url).startsWith("/.aidenhq/door-ask?")) {
      let ok = false;
      try { ok = !!doorOf(cfg0, (new URL(`http://gate${req.url}`).searchParams.get("domain") ?? "").toLowerCase()); } catch {}
      return plain(res, ok ? 200 : 404, ok ? "ok" : "not found");
    }
    const a = await authorize(req, { upgrade: false });
    const cfg = config(); // read again after the sign-in checks and kept for this response: the callbacks below never read it
    if (a.go) return go(req, res, a.query);
    if (a.handoff) return handoff(req, res, a.query);
    if (a.signOut) return signOut(req, res);
    if (a.auth && a.path.startsWith(`${AUTH_PATH}api/sign-out`)) sessions.clear(); // the my-apps sign-out ends cached answers too
    // The sign-in pages are the gate's own; only their steps (/.auth/api/*) go on to the kernel.
    const pg = a.auth && (req.method === "GET" || req.method === "HEAD") ? signinPage(a.path) : undefined;
    if (pg) return void res.writeHead(pg.status, pg.headers).end(req.method === "HEAD" ? undefined : pg.body);
    if (a.mine && a.access) return access(req, res, a.email);
    if (a.mine) return void res.writeHead(200, PAGE).end(req.method === "HEAD" ? undefined : myAppsPage(a.email, appsFor(cfg, a.roleOf)));
    if (a.request) return inAppRequest(req, res, a);
    if (a.requests) return myRequests(req, res, a);
    if (a.notify) return notifyOwner(req, res, a);
    let target: { host: string; port: number; headers: OutgoingHttpHeaders };
    if (a.auth) {
      const u = new URL(cfg.auth_url);
      target = { host: u.hostname, port: Number(u.port) || 80, headers: authHeaders(req, boardSecret(cfg), fromTunnel) };
    } else if (a.site) target = { host: "127.0.0.1", port: a.site.port, headers: upstreamHeaders(req, a.token, { strip: cfg.identity?.header, proto: cfg.origin?.scheme }) };
    else return void res.writeHead(a.status, { "content-type": "text/plain", ...(a.location ? { location: a.location, "cache-control": "no-store" } : {}), ...(a.cookie ? { "set-cookie": a.cookie } : {}) }).end(`${a.msg}\n`);
    const up = httpRequest({ ...target, method: req.method, path: a.auth ? a.path : req.url });
    up.on("response", (r) => {
      const h = { ...r.headers };
      for (const k of HOP) delete h[k];
      delete h["set-auth-token"]; // Better Auth's bearer header: the session token never leaves through the gate
      // An app can't set (or overwrite) any auth cookie; the auth listener's must be host-only (no Domain).
      let cur = cfg;
      if (h["set-cookie"]) {
        try {
          cur = config(); // cookie isolation follows the policy as of now; unreadable refuses just this response (outside serve()'s .catch)
        } catch {
          r.destroy();
          return plain(res, 503, "unavailable: the gate can't read its config right now");
        }
      }
      const kept = [h["set-cookie"] ?? []].flat().filter((c) => !AUTH_COOKIE.test(cookieName(c)) || (a.auth && !/;\s*domain\s*=/i.test(c))).map((c) => (a.site && (cur.previews || cur.login === "header-jwt" || a.site.door) ? hostOnly(c) : c));
      if (kept.length) h["set-cookie"] = kept;
      else delete h["set-cookie"];
      if (a.auth && (/json/i.test(String(h["content-type"] ?? "")) || a.path.startsWith(`${AUTH_PATH}api/`))) return void tokenless(r, res, h);
      res.writeHead(r.statusCode ?? 502, r.statusMessage, h);
      res.flushHeaders(); // SSE: the client sees the response before the first event
      r.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway\n")));
    res.on("close", () => up.destroy());
    req.pipe(up);
  };
  // An unreadable gate.json (a torn write) or any other throw refuses the request: the gate never serves from a stale policy.
  const server = createServer((req, res) => {
    serve(req, res).catch((e) => {
      log({ msg: "request failed", err: String(e) });
      if (res.headersSent) res.destroy();
      else plain(res, 503, "unavailable: the gate can't read its config right now");
    });
  });

  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const a = await authorize(req, { upgrade: true });
    // An upgrade is refused or proxied: authorize() returns no other kind for one.
    if (!a.site) {
      const r = a as Refusal;
      return void socket.end(`HTTP/1.1 ${r.status} ${({ 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 503: "Service Unavailable" } as Record<number, string>)[r.status] ?? "Forbidden"}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${r.msg.length + 1}\r\n\r\n${r.msg}\n`);
    }
    const cfg = config(); // read again after the sign-in checks and kept for this upgrade: the callbacks below never read it
    const up = httpRequest({ host: "127.0.0.1", port: a.site.port, method: req.method, path: req.url, headers: upstreamHeaders(req, a.token!, { upgrade: true, strip: cfg.identity?.header, proto: cfg.origin?.scheme }) });
    const raw = (cur: GateConfig, status: number | undefined, message: string | undefined, rawHeaders: string[]) => {
      let s = `HTTP/1.1 ${status} ${message}\r\n`;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i]!.toLowerCase() === "set-cookie" && AUTH_COOKIE.test(cookieName(rawHeaders[i + 1]!))) continue; // as for responses
        s += `${rawHeaders[i]}: ${rawHeaders[i]!.toLowerCase() === "set-cookie" && (cur.previews || cur.login === "header-jwt" || a.site!.door) ? hostOnly(rawHeaders[i + 1]!) : rawHeaders[i + 1]}\r\n`;
      }
      return `${s}\r\n`;
    };
    up.on("upgrade", (r, usock, uhead) => {
      usock.on("error", () => socket.destroy());
      usock.on("close", () => socket.destroy());
      socket.on("close", () => usock.destroy());
      let cur = cfg;
      if (r.rawHeaders.some((x, i) => i % 2 === 0 && x.toLowerCase() === "set-cookie")) {
        try {
          cur = config();
        } catch {
          usock.destroy();
          return void socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
      }
      socket.write(raw(cur, r.statusCode, r.statusMessage, r.rawHeaders));
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
      log({ msg: "upgrade failed", err: String(e) });
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
  return server;
}
