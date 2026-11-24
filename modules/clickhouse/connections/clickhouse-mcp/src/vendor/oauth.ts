// How a vendor MCP connection (src/vendor/proxy.ts) reaches its upstream as the owner: OAuth 2.1 with PKCE, started from
// the board (its Connect sends the browser here and back to the board's callback, at its https address or on loopback), with the scopes the owner picks
// there. The client is registered dynamically (RFC 7591) or is one the owner made in the vendor (HubSpot, Slack). Only this
// service sees the tokens: the pair lives in /state/token.json (0600), refreshed here, rotated pairs written back atomically.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it); third-party modules import
// @aidenhq/sdk/vendor/oauth.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Sign-in state for the board's banner and the healthcheck; `none`: the connection signs in to nothing. */
export interface AuthStatus {
  state: "missing" | "ok" | "expired" | "unknown" | "none";
  since: string;
  detail?: string;
  /** The scopes the vendor granted at the last sign-in. */
  scope?: string;
  /** Signs in by a pasted value (a service token), never a browser sign-in: the board's Connect asks for it while not ok. */
  paste?: boolean;
}

export class AuthError extends Error {}
export class SignInError extends Error {}

/** The board's sign-in: which scopes the owner may pick (and the ones pre-selected), then the round trip. */
export interface SignInFlow {
  scopes(): Promise<{ supported: string[]; recommended: string[] }>;
  start(redirectUri: string, scopes?: string[]): Promise<{ url: string }>;
  finish(state: string, code: string): Promise<void>;
}

/** A device sign-in (RFC 8628) as the board shows it: the code to type on the vendor's page, and how it is going. */
export interface DeviceStart {
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}
export interface DeviceState {
  state: "idle" | "pending" | "ok" | "expired" | "denied" | "cancelled" | "failed";
  detail?: string;
}
/**
 * A sign-in for a server without a browser (GitHub, like `gh`): start asks the vendor for a code, and this service polls for the
 * token itself until it lands, the code expires or the board cancels. One at a time: a new start cancels the one before.
 */
export interface DeviceFlow {
  start(onSignedIn?: () => void): Promise<DeviceStart>;
  state(): DeviceState;
  cancel(): void;
}

/** What the proxy needs from a sign-in: the headers for an upstream request, a refresh after a refusal, and its state. */
export interface Auth {
  headers(): Promise<Record<string, string>>;
  refresh(): Promise<void>;
  status(): AuthStatus;
  /** Verifies the sign-in with the vendor before its status is read (a token's cheap authenticated read, kept briefly). */
  check?(): Promise<void>;
  /** Whether the vendor refuses the current token right now (its own cheap authenticated read): a 401 or a refused refresh proves nothing alone. Absent: the connection can't tell. */
  refused?(): Promise<boolean>;
  mark(state: "ok" | "expired", detail?: string): void;
  signedIn(): boolean;
  signIn?: SignInFlow;
  device?: DeviceFlow;
}

/** A connection that signs in to nothing (a local server), with fixed headers. */
export function staticAuth(headers: Record<string, string> = {}): Auth {
  const since = new Date().toISOString();
  return { headers: async () => headers, refresh: async () => {}, status: () => ({ state: "none", since }), mark: () => {}, signedIn: () => true };
}

export interface OAuthOptions {
  /** The vendor's name in messages ("Glean"). */
  name: string;
  mcpUrl: string;
  /** token.json and client.json live here. */
  stateDir: string;
  /** Sent on every upstream request and on discovery's probe (Grafana Cloud: x-grafana-url). */
  headers?: Record<string, string>;
  /** A client the owner made in the vendor (HubSpot, Slack); without one the client is registered dynamically. */
  client?: () => { id: string; secret?: string } | undefined;
  /** The board's https address (default: BOARD_URL, from the host's BOARD_LAN_URL): the one redirect besides loopback. */
  boardUrl?: string;
  /** Fixed endpoints (Slack); without them they are discovered (RFC 9728, then RFC 8414). */
  endpoints?: { authorize: string; token: string };
  /**
   * `supported`: the scopes the owner may pick when the vendor doesn't list them (an empty list: never ask for scopes).
   * `recommended`: the ones pre-selected (default: all of them). `separator`: how they are joined (default a space).
   */
  scopes?: { supported?: string[]; recommended?: string[]; separator?: string };
  /** false: never send RFC 8707 `resource` (default: the MCP URL without its query). */
  resource?: false;
  /** A vendor's token answer in the standard shape (Slack nests the user token under authed_user). */
  tokenAnswer?: (json: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Sign in by device code (RFC 8628) instead of a redirect: `endpoint` is the vendor's device authorization endpoint, the token
   * endpoint is `endpoints.token` (else discovered). An empty `client_id` is a sign-in not configured yet.
   */
  device?: { endpoint: string; client_id: string; scopes?: string[] };
  fetchImpl?: typeof fetch;
  /** Whether the vendor still answers this access token (false only when it refuses it). With it, a refused refresh or a stray 401 never marks a working token expired, and an expired mark heals itself once the token answers. */
  accepts?: (accessToken: string) => Promise<boolean>;
  /** How often an expired mark re-asks `accepts` (default 30 s). */
  healMs?: number;
  /** How a device sign-in waits between polls (tests: no wait). */
  wait?: (ms: number) => Promise<void>;
}

/** token.json: the pair plus the client it belongs to. Extra fields a vendor answered (Slack's user_id) are kept. */
export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  client_id?: string;
  client_secret?: string;
  token_endpoint?: string;
  resource?: string;
  [extra: string]: unknown;
}

interface Endpoints {
  authorize: string;
  token: string;
  registration?: string;
  issuer: string;
  supported: string[];
  offline: boolean;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/;
/** A redirect this sign-in may send: a loopback callback (a tunnel), or a callback on the board's https origin. */
export function redirectAllowed(redirectUri: string, boardUrl = process.env.BOARD_URL ?? ""): boolean {
  if (LOOPBACK.test(redirectUri)) return true;
  const board = URL.canParse(boardUrl) ? new URL(boardUrl) : undefined;
  if (board?.protocol !== "https:" || !redirectUri.startsWith(`${board.origin}/`)) return false;
  return /^\/[\w/-]*$/.test(redirectUri.slice(board.origin.length));
}
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

/** The owner's OAuth sign-in to a vendor's MCP server. */
export function oauth(o: OAuthOptions): Auth {
  const fetchImpl = o.fetchImpl ?? fetch;
  const tokenPath = join(o.stateDir, "token.json");
  const clientPath = join(o.stateDir, "client.json");
  // The resource a token is for (RFC 8707): the MCP endpoint without its query (Atlassian's ?tools=all).
  const resourceOf = () => { if (o.resource === false) return undefined; const u = new URL(o.mcpUrl); return u.origin + u.pathname; };
  const pending = new Map<string, { verifier: string; redirectUri: string; ep: Endpoints; client: { id: string; secret?: string }; expires: number }>();
  let token: StoredToken | undefined;
  let refreshing: Promise<StoredToken> | undefined;
  // A stored token that nothing has refused is signed in: "unknown" after every restart read as "Needs setup" on the board.
  const usable = () => {
    try {
      const t = JSON.parse(readFileSync(tokenPath, "utf8")) as StoredToken;
      return Boolean(t.access_token) && (Boolean(t.refresh_token) || !t.expires_at || t.expires_at > Date.now());
    } catch {
      return false;
    }
  };
  let status: AuthStatus = { state: usable() ? "ok" : "unknown", since: new Date().toISOString() };

  // JSON asked for explicitly: GitHub's OAuth endpoints answer form-encoded otherwise.
  const json = async (url: string, init?: RequestInit) => {
    const res = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  /** A token answer as StoredToken fields; a refusal throws its error. */
  function parse(raw: Record<string, unknown>, now = Date.now()): Pick<StoredToken, "access_token" | "refresh_token" | "expires_at" | "scope"> {
    const a = o.tokenAnswer ? o.tokenAnswer(raw) : raw;
    if (typeof a.error === "string" || a.ok === false) throw new AuthError(`${o.name} OAuth error: ${String(a.error ?? "refused")}`);
    if (typeof a.access_token !== "string" || !a.access_token) throw new AuthError(`${o.name} OAuth answer had no access token`);
    const expiresIn = Number(a.expires_in);
    const { expires_in: _e, ok: _o, ...rest } = a;
    return {
      ...rest,
      access_token: a.access_token,
      refresh_token: typeof a.refresh_token === "string" ? a.refresh_token : undefined,
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
      scope: typeof a.scope === "string" ? a.scope : undefined,
    };
  }

  /** The vendor refuses the current token: true when `accepts` says so, or can't be asked (the old rule); a vendor that errors isn't a refusal. */
  async function refused(): Promise<boolean> {
    if (!o.accepts) return true;
    try {
      return !(await o.accepts(load().access_token));
    } catch {
      return false;
    }
  }

  // An expired mark is a claim about the token: while it stands, ask the vendor again, and a token that answers is signed in
  // (no container restart). A reconnect marks ok itself.
  let healer: ReturnType<typeof setInterval> | undefined;
  function mark(state: "ok" | "expired", detail?: string) {
    if (state === "ok" && healer) { clearInterval(healer); healer = undefined; }
    if (status.state === state && status.detail === detail) return;
    status = { state, since: new Date().toISOString(), ...(detail ? { detail } : {}) };
    if (state === "expired" && o.accepts && !healer) {
      healer = setInterval(() => void refused().then((r) => { if (!r && status.state === "expired") mark("ok"); }, () => undefined), o.healMs ?? 30_000);
      healer.unref?.();
    }
  }

  function load(): StoredToken {
    if (!token) {
      if (!existsSync(tokenPath)) throw new AuthError(`${o.name} isn't connected yet (Connect on the board)`);
      token = JSON.parse(readFileSync(tokenPath, "utf8")) as StoredToken;
    }
    return token;
  }

  function save(t: StoredToken) {
    const tmp = join(dirname(tokenPath), `.token.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, tokenPath);
    token = t;
  }

  async function doRefresh(): Promise<StoredToken> {
    const t = load();
    const endpoint = t.token_endpoint ?? o.endpoints?.token;
    const clientId = t.client_id ?? o.client?.()?.id;
    if (!t.refresh_token || !endpoint || !clientId) {
      if (await refused()) mark("expired", "the sign-in has no refresh token");
      throw new AuthError(`${o.name} token expired and can't be refreshed (Reconnect on the board)`);
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId });
    const secret = t.client_secret ?? o.client?.()?.secret;
    if (secret) body.set("client_secret", secret);
    if (t.resource) body.set("resource", t.resource);
    const res = await fetchImpl(endpoint, { method: "POST", body, headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // A reconnect saved a newer grant while this refresh was in flight: its answer, good or bad, is stale.
    if (token !== t) return token!;
    let next;
    try {
      if (!res.ok && typeof answer.error !== "string") throw new AuthError(`${o.name} token endpoint answered ${res.status}`);
      next = parse(answer);
    } catch (err) {
      // A refusal (invalid_grant and the like) needs the owner; a 5xx is the vendor's problem and may pass.
      // A refused refresh on a token the vendor still answers (a rotated refresh token reused after a restart) is not an expiry.
      if (res.status < 500 && (await refused())) mark("expired", String((err as Error).message));
      throw err;
    }
    save({ ...t, ...next, refresh_token: next.refresh_token ?? t.refresh_token, scope: next.scope ?? t.scope });
    return token!;
  }

  const refresh = (): Promise<StoredToken> => (refreshing ??= doRefresh().finally(() => (refreshing = undefined)));

  /** The vendor's endpoints and the scopes it lists: the server's 401 names its resource metadata (the MCP way), else the well-known paths. */
  async function discover(): Promise<Endpoints> {
    const listed = o.scopes?.supported;
    if (o.endpoints) return { ...o.endpoints, issuer: new URL(o.endpoints.authorize).origin, supported: listed ?? [], offline: false };
    const mcp = new URL(o.mcpUrl);
    const path = mcp.pathname.replace(/\/$/, "");
    const probe = await fetchImpl(o.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...o.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    const named = /resource_metadata="([^"]+)"/.exec(probe?.headers.get("www-authenticate") ?? "")?.[1];
    let issuer = mcp.origin;
    let resourceScopes: string[] | undefined;
    for (const u of [...(named ? [named] : []), `${mcp.origin}/.well-known/oauth-protected-resource${path}`, `${mcp.origin}/.well-known/oauth-protected-resource`]) {
      const r = await json(u).catch(() => undefined);
      const servers = r?.ok ? strings(r.body.authorization_servers) : undefined;
      if (servers?.[0]) {
        issuer = servers[0].replace(/\/$/, "");
        resourceScopes = strings(r!.body.scopes_supported);
        break;
      }
    }
    const is = new URL(issuer);
    const isPath = is.pathname.replace(/\/$/, "");
    for (const u of [`${is.origin}/.well-known/oauth-authorization-server${isPath}`, `${is.origin}${isPath}/.well-known/openid-configuration`, `${is.origin}/.well-known/oauth-authorization-server`]) {
      const r = await json(u).catch(() => undefined);
      if (r?.ok && typeof r.body.authorization_endpoint === "string" && typeof r.body.token_endpoint === "string") {
        const offered = strings(r.body.scopes_supported) ?? [];
        return {
          authorize: r.body.authorization_endpoint,
          token: r.body.token_endpoint,
          ...(typeof r.body.registration_endpoint === "string" ? { registration: r.body.registration_endpoint } : {}),
          issuer,
          // What the owner may pick: the resource's own list, else the server's (offline_access is added on its own).
          supported: (listed ?? (resourceScopes?.length ? resourceScopes : offered)).filter((s) => s !== "offline_access"),
          // Without offline_access there may be no refresh token, and the sign-in would end with the first access token.
          offline: offered.includes("offline_access") || Boolean(resourceScopes?.includes("offline_access")),
        };
      }
    }
    throw new SignInError(`couldn't find ${o.name}'s sign-in server for ${o.mcpUrl}`);
  }

  async function client(ep: Endpoints, redirectUri: string): Promise<{ id: string; secret?: string }> {
    if (o.client) {
      const c = o.client();
      if (!c) throw new SignInError(`${o.name}'s client isn't set up: add its client id (and secret) on the setup page`);
      return c;
    }
    const saved = existsSync(clientPath) ? (JSON.parse(readFileSync(clientPath, "utf8")) as { client_id?: string; client_secret?: string; redirect_uri?: string; issuer?: string }) : undefined;
    if (saved?.client_id && saved.redirect_uri === redirectUri && saved.issuer === ep.issuer) return { id: saved.client_id, ...(saved.client_secret ? { secret: saved.client_secret } : {}) };
    if (!ep.registration) throw new SignInError(`${o.name} doesn't offer client registration (ask an admin to enable its OAuth authorization server)`);
    const r = await json(ep.registration, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "AidenHQ", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!r.ok || typeof r.body.client_id !== "string") throw new SignInError(`${o.name} refused to register AidenHQ (${String(r.body.error_description ?? r.body.error ?? r.status).slice(0, 200)})`);
    const secret = typeof r.body.client_secret === "string" ? r.body.client_secret : undefined;
    writeFileSync(clientPath, JSON.stringify({ client_id: r.body.client_id, ...(secret ? { client_secret: secret } : {}), redirect_uri: redirectUri, issuer: ep.issuer }, null, 2), { mode: 0o600 });
    chmodSync(clientPath, 0o600);
    return { id: r.body.client_id, ...(secret ? { secret } : {}) };
  }

  const recommended = (supported: string[]) => {
    const want = o.scopes?.recommended;
    return want ? want.filter((s) => !supported.length || supported.includes(s)) : supported;
  };

  const signIn: SignInFlow = {
    async scopes() {
      const { supported } = await discover();
      return { supported, recommended: recommended(supported) };
    },

    /** The vendor's sign-in URL, asking for `scopes` (the owner's pick; default: the recommended ones). */
    async start(redirectUri, scopes) {
      if (!redirectAllowed(redirectUri, o.boardUrl)) throw new SignInError("redirect must be a loopback address or the board's own https address");
      const ep = await discover();
      const extra = (scopes ?? []).filter((s) => s !== "offline_access" && !ep.supported.includes(s));
      if (extra.length) throw new SignInError(`${o.name} doesn't offer ${extra.join(", ")}`);
      const picked = (scopes ?? recommended(ep.supported)).filter((s) => s !== "offline_access");
      const asked = picked.length && ep.offline ? [...picked, "offline_access"] : picked;
      const c = await client(ep, redirectUri);
      const now = Date.now();
      for (const [k, p] of pending) if (p.expires < now) pending.delete(k);
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      pending.set(state, { verifier, redirectUri, ep, client: c, expires: now + 10 * 60_000 });
      const resource = resourceOf();
      const url = new URL(ep.authorize);
      // Added to the endpoint's own query (Grafana's names the stack), never replacing it.
      const params: Record<string, string> = {
        response_type: "code",
        client_id: c.id,
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        ...(resource ? { resource } : {}),
        ...(asked.length ? { scope: asked.join(o.scopes?.separator ?? " ") } : {}),
      };
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return { url: url.toString() };
    },

    async finish(state, code) {
      const p = pending.get(state);
      pending.delete(state);
      if (!p || p.expires < Date.now()) throw new SignInError("this sign-in link expired or was already used; start again from the board");
      const resource = resourceOf();
      const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: p.client.id, code_verifier: p.verifier, redirect_uri: p.redirectUri, ...(resource ? { resource } : {}) });
      if (p.client.secret) body.set("client_secret", p.client.secret);
      const r = await json(p.ep.token, { method: "POST", body });
      let parsed;
      try {
        if (!r.ok && typeof r.body.error !== "string") throw new AuthError(String(r.body.error_description ?? r.body.message ?? r.status));
        parsed = parse(r.body);
      } catch (err) {
        throw new SignInError(`${o.name} refused the sign-in: ${String((err as Error).message).slice(0, 200)}`);
      }
      save({ ...parsed, client_id: p.client.id, ...(p.client.secret ? { client_secret: p.client.secret } : {}), token_endpoint: p.ep.token, ...(resource ? { resource } : {}) });
      mark("ok");
    },
  };

  // The device sign-in: one run at a time; its device_code never leaves this service.
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let run: { id: number; state: DeviceState } | undefined;
  let runs = 0;
  const vendorWords = (b: Record<string, unknown>) => String(b.error_description ?? b.error ?? "").slice(0, 200);
  const device: DeviceFlow | undefined = o.device && {
    async start(onSignedIn) {
      const d = o.device!;
      if (!d.client_id) throw new SignInError(`${o.name}'s sign-in isn't configured yet: it has no client ID`);
      const tokenUrl = o.endpoints?.token ?? (await discover()).token;
      const body = new URLSearchParams({ client_id: d.client_id, ...(d.scopes?.length ? { scope: d.scopes.join(o.scopes?.separator ?? " ") } : {}) });
      const r = await json(d.endpoint, { method: "POST", body });
      const b = r.body;
      const uri = b.verification_uri ?? b.verification_url;
      if (!r.ok || typeof b.device_code !== "string" || typeof b.user_code !== "string" || typeof uri !== "string") throw new SignInError(`${o.name} refused to start the sign-in: ${vendorWords(b) || `it answered ${r.status}`}`);
      const expiresIn = Number(b.expires_in) > 0 ? Number(b.expires_in) : 900;
      const deviceCode = b.device_code;
      const me = { id: ++runs, state: { state: "pending" } as DeviceState };
      run = me;
      const expires = Date.now() + expiresIn * 1000;
      let interval = Number(b.interval) > 0 ? Number(b.interval) : 5;
      const end = (state: DeviceState) => { if (run === me) run.state = state; };
      void (async () => {
        while (run === me && me.state.state === "pending") {
          await wait(interval * 1000);
          if (run !== me || me.state.state !== "pending") return;
          if (Date.now() >= expires) return end({ state: "expired", detail: "the code expired before it was entered" });
          const p = await json(tokenUrl, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: d.client_id }) }).catch(() => undefined);
          if (!p || p.status >= 500) continue; // the vendor's hiccup: ask again
          const err = typeof p.body.error === "string" ? p.body.error : "";
          if (err === "authorization_pending") continue;
          if (err === "slow_down") { interval += 5; continue; }
          if (err === "expired_token") return end({ state: "expired", detail: "the code expired before it was entered" });
          if (err === "access_denied") return end({ state: "denied", detail: `access was denied on ${o.name}'s page` });
          try {
            if (err || !p.ok) throw new AuthError(vendorWords(p.body) || `${o.name} answered ${p.status}`);
            const parsed = parse(p.body);
            if (run !== me || me.state.state !== "pending") return; // cancelled while the answer was on its way: nothing saved
            save({ ...parsed, client_id: d.client_id, token_endpoint: tokenUrl });
            mark("ok");
            end({ state: "ok" });
            onSignedIn?.();
          } catch (e) {
            return end({ state: "failed", detail: `${o.name} refused the sign-in: ${String((e as Error).message).slice(0, 200)}` });
          }
        }
      })();
      return { user_code: b.user_code, verification_uri: uri, ...(typeof b.verification_uri_complete === "string" ? { verification_uri_complete: b.verification_uri_complete } : {}), expires_in: expiresIn, interval };
    },
    state: () => run?.state ?? { state: "idle" },
    cancel() {
      if (run?.state.state === "pending") run.state = { state: "cancelled" };
    },
  };

  return {
    async headers() {
      const t = load();
      let access = t.access_token;
      if (t.expires_at && t.expires_at - 120_000 <= Date.now()) {
        try {
          access = (await refresh()).access_token;
        } catch (err) {
          // A refused refresh is no reason to drop a token that has not run out and still answers.
          if (status.state === "expired" || t.expires_at <= Date.now()) throw err;
        }
      }
      return { ...o.headers, authorization: `Bearer ${access}` };
    },
    async refresh() {
      await refresh();
    },
    status() {
      if (!existsSync(tokenPath)) return { state: "missing", since: status.since, ...(o.device && !o.device.client_id ? { detail: `${o.name}'s sign-in isn't configured yet: it has no client ID` } : {}) };
      const scope = (() => { try { return load().scope; } catch { return undefined; } })();
      return { ...status, ...(scope ? { scope } : {}) };
    },
    mark,
    ...(o.accepts ? { refused } : {}),
    signedIn: () => existsSync(tokenPath),
    signIn,
    ...(device ? { device } : {}),
  };
}
