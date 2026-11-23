import { explainGoogle } from "./google-errors.js";

/**
 * The scopes requested at consent time: calendar events and Gmail read and write (each write a reviewed tool), Drive read.
 * `gmail.modify` covers reading, drafts, sending and labels. src/auth.ts keeps a copy (a test checks they match).
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];
/** The scope each write needs, by its short name (the needs_owner `scope`). */
export const WRITE_SCOPE = { calendar: "calendar.events", gmail: "gmail.modify" } as const;

export interface StoredCredentials {
  client_id: string;
  client_secret?: string;
  refresh_token: string;
  scopes?: string[];
}

/** A sign-in failure. `expired`: Google refused the sign-in itself (a dead refresh token, a rejected access token), which only
 * the owner's reconnect fixes; otherwise it may pass on its own. */
export class GoogleAuthError extends Error {
  /** The account whose sign-in refused, set by the caller that knows it (MultiWorkspace); absent for a whole-connection error. */
  account?: string;
  constructor(message: string, readonly expired = false) {
    super(message);
  }
}

/**
 * Whether an account's sign-in still works, from its last token refresh. "expired": Google refused
 * the refresh token (invalid_grant: past the OAuth app's 7-day Testing limit, or revoked), so only
 * re-consent helps. "error": Google couldn't be reached or answered oddly; it may pass on its own.
 */
export interface AuthStatus {
  state: "unknown" | "ok" | "expired" | "error";
  /** When the account entered this state. */
  since: string;
  checkedAt?: string;
  detail?: string;
}

/** Token endpoint errors that mean the refresh token itself is dead. */
const DEAD_GRANT = new Set(["invalid_grant", "unauthorized_client", "invalid_client"]);

/** Minimal Google REST client with refresh-token auth. */
export class GoogleClient {
  private accessToken?: { value: string; expiresAt: number };
  private auth: AuthStatus = { state: "unknown", since: new Date().toISOString() };

  constructor(
    private readonly creds: StoredCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > Date.now()) return this.accessToken.value;
    const body = new URLSearchParams({ client_id: this.creds.client_id, refresh_token: this.creds.refresh_token, grant_type: "refresh_token" });
    if (this.creds.client_secret) body.set("client_secret", this.creds.client_secret);
    let res: Response;
    let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      res = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
      json = (await res.json()) as typeof json;
    } catch (err) {
      this.record("error", `token refresh failed: ${(err as Error).message}`);
      throw err;
    }
    if (!res.ok || !json.access_token) {
      const dead = json.error && DEAD_GRANT.has(json.error);
      const detail = `token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim() + (dead ? `. ${explainGoogle(json.error)}` : "");
      this.record(dead ? "expired" : "error", detail);
      throw new GoogleAuthError(detail, Boolean(dead));
    }
    this.record("ok");
    this.accessToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.accessToken.value;
  }

  private record(state: AuthStatus["state"], detail?: string) {
    const now = new Date().toISOString();
    this.auth = { state, since: state === this.auth.state ? this.auth.since : now, checkedAt: now, ...(detail ? { detail: detail.slice(0, 700) } : {}) };
  }

  authStatus(): AuthStatus {
    return { ...this.auth };
  }

  /** Refreshes the token now rather than from cache, so a dead refresh token shows up before a tool needs it. */
  async checkAuth(): Promise<AuthStatus> {
    this.accessToken = undefined;
    await this.token().catch(() => {});
    return this.authStatus();
  }

  get<T>(url: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.request<T>("GET", url, params);
  }

  /** One JSON call; `body` is sent as JSON, `ifMatch` an ETag the change applies to. A 204 (a delete) answers undefined. */
  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, params: Record<string, string | number | boolean | undefined> = {}, body?: unknown, ifMatch?: string): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    const res = await this.fetchImpl(u, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ifMatch ? { "if-match": ifMatch } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      throw new GoogleAuthError(`Google API ${res.status}: ${text.slice(0, 300)}`, res.status === 401);
    }
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getText(url: string, params: Record<string, string> = {}, maxBytes = 2_000_000): Promise<{ text: string; truncated: boolean }> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes };
  }
}
