import type { Logger } from "pino";

export interface McpAuthStatus {
  /** "none": the proxy signs in to nothing (grafana-mcp with GRAFANA_SOURCE=local): no Connect, no URL fields. */
  state: "missing" | "ok" | "expired" | "unknown" | "none";
  /** Whether the service's server is set (GLEAN_MCP_URL, GRAFANA_URL, CLICKHOUSE_MCP_URL): without it there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
  /** The scopes the stored token holds, space separated (the proxy adds it when signed in). */
  scope?: string;
  /** The account the sign-in is for, when the proxy knows it (GitHub). */
  login?: string;
  /**
   * Rows the proxy reports about itself for the sign-in's card; the board renders them as given (GitHub). A row's suggestion
   * (`hint` and its `action`) carries a `dismiss` key; once dismissed (app.ts), the board serves the row without them.
   */
  lines?: { label: string; value: string; time?: string; state: "ok" | "warn" | "error"; hint?: string; dismiss?: string; action?: { label: string; href?: string; admin?: string; reconnect?: true } }[];
  /** Signs in by a pasted value (a service token), never a browser sign-in: Connect asks for it until the state is ok. */
  paste?: boolean;
}

/** Whether Connect must ask for the sign-in's own values: its address isn't set, or its pasted value isn't working yet. */
export const asksValues = (s: McpAuthStatus | undefined) => !s?.configured || Boolean(s.paste && s.state !== "ok");

/**
 * Sign-in state from an MCP proxy that signs in with OAuth (glean-mcp, grafana-mcp; clickhouse-mcp), and
 * signing in through it, like Google's Reconnect: the board sends the browser to the
 * service's sign-in, which sends it back to the board's callback, and the proxy exchanges the code
 * and keeps the token. The board holds only the proxy's auth token; it never sees a service token.
 */
export class McpAuth {
  private cached: { at: number; status: McpAuthStatus } | undefined;
  private offered: { at: number; scopes: { supported: string[]; recommended: string[] } | undefined } | undefined;

  constructor(
    /** The service's name in logs and messages ("Glean"); its proxy is `<name>-mcp` in lower case. */
    private readonly name: string,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log?: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new McpAuthFailed(data.error ?? `${this.name.toLowerCase()}-mcp answered ${res.status}`);
    return data;
  }

  /**
   * Sign-in state, at most a minute old. While the proxy can't be asked (an apply recreating it) its last answer stands, so a
   * restart never reads as "signed out"; undefined only when it never answered.
   */
  async status(maxAgeMs = 60_000): Promise<McpAuthStatus | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        this.cached = { at: Date.now(), status: await this.call<McpAuthStatus>("GET", "/auth/status") };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, `${this.name} sign-in state unavailable`);
      }
    }
    return this.cached?.status;
  }

  /**
   * The scopes the owner may grant on this sign-in, and the ones pre-selected. Undefined when the proxy offers no choice (it
   * asks for none, or predates the choice).
   */
  async scopes(): Promise<{ supported: string[]; recommended: string[] } | undefined> {
    // The offer is the proxy's own config: kept ten minutes once it answers (every Connections and board load reads it). A
    // proxy without its address yet answers nothing, so that is asked again each time.
    if (this.offered && Date.now() - this.offered.at < 600_000) return this.offered.scopes;
    const scopes = await this.call<{ supported: string[]; recommended: string[] }>("GET", "/auth/scopes").catch(() => undefined);
    if (scopes) this.offered = { at: Date.now(), scopes };
    return scopes;
  }

  /** Whether Connect offers a choice of scopes: its button opens the picker first, and a Reconnect reads "Change access". */
  async offers(): Promise<boolean> {
    return ((await this.scopes())?.supported.length ?? 0) > 1;
  }

  /** The vendor's sign-in URL, asking for `scopes` (the owner's pick; unset: the proxy's recommended ones). */
  start(redirectUri: string, scopes?: string[]) {
    return this.call<{ url: string }>("POST", "/auth/start", { redirect_uri: redirectUri, ...(scopes ? { scopes } : {}) });
  }

  async finish(state: string, code: string): Promise<void> {
    await this.call<{ ok: true }>("POST", "/auth/finish", { state, code });
    this.cached = undefined;
  }

  /** The sign-in tried live (the proxy's /auth/check: one read upstream): works, or what is wrong and the one thing to do. */
  async check(): Promise<AuthCheck> {
    try {
      return await this.call<AuthCheck>("GET", "/auth/check");
    } catch (err) {
      return { ok: false, message: `${this.name.toLowerCase()}-mcp couldn't be asked: ${String((err as Error).message).slice(0, 150)}` };
    } finally {
      this.cached = undefined;
    }
  }

  /** A device sign-in (signins `mode: device` or `qr`): the code (or QR link) to show; the proxy then waits for the token itself. */
  deviceStart() {
    return this.call<DeviceCode>("POST", "/auth/device");
  }

  async deviceState(): Promise<DeviceState> {
    const s = await this.call<DeviceState>("GET", "/auth/device");
    if (s.state === "ok") this.cached = undefined;
    return s;
  }

  async deviceCancel(): Promise<void> {
    await this.call<{ ok: true }>("POST", "/auth/device/cancel");
  }

  /** The one transient secret a qr sign-in asked for (a password): passed on, never kept. A wrong value throws the proxy's words. */
  async deviceSecret(value: string): Promise<void> {
    await this.call<{ ok: true }>("POST", "/auth/device/secret", { value });
  }

  /** Revokes the sign-in at the vendor (signins `disconnect`). */
  async disconnect(): Promise<void> {
    await this.call<{ ok: true }>("POST", "/auth/disconnect", {});
    this.cached = undefined;
  }
}

/** What a sign-in's test says (`fix`: "Connect", "Reconnect", "Paste a new token"). */
export type AuthCheck = { ok: true } | { ok: false; message: string; fix?: string };
export type DeviceCode =
  | { user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }
  | { qr: string; expires_in: number; interval: number };
export interface DeviceState {
  state: "idle" | "pending" | "secret" | "ok" | "expired" | "denied" | "cancelled" | "failed";
  detail?: string;
  /** The link to show as a QR while pending; it refreshes. */
  qr?: string;
  /** While state is secret: what the proxy asks for. */
  secret?: { label: string; hint?: string };
}

/** OAuth's error codes (RFC 6749 §4.1.2.1, and the vendors' own common ones) in words: what happened, and what to do. */
const OAUTH_WORDS: Record<string, string> = {
  access_denied: "access was declined on the sign-in page; press Connect and choose Allow",
  invalid_client: "the vendor doesn't know this client ID; check it was copied whole, or choose your organisation again",
  unauthorized_client: "this app isn't allowed to sign in this way; check the app's OAuth settings",
  invalid_scope: "the app doesn't offer a permission that was asked for; add it to the app, or pick fewer",
  redirect_uri_mismatch: "the app doesn't list this board's redirect address; add it exactly as setup shows it",
  invalid_request: "the vendor refused the request",
  admin_policy_enforced: "your organisation's admin must approve this app first",
  org_internal: "this app is internal to another organisation; sign in with an account there, or use your own app",
  invalid_team_for_non_distributed_app: "this Slack app belongs to another workspace; sign in to its own workspace, or use your own app",
  server_error: "the vendor had a problem; try again in a minute",
  temporarily_unavailable: "the vendor is busy; try again in a minute",
};

/** A vendor's error on a sign-in's return, in words, with its own description after (plain text, capped). */
export function vendorWords(error: string, description?: string | null): string {
  const code = error.slice(0, 100);
  const said = description?.replace(/\s+/g, " ").trim().slice(0, 200);
  return `${OAUTH_WORDS[code] ?? `the vendor said ${code}`}${said ? ` (${said})` : ""}`;
}

export class McpAuthFailed extends Error {}

/**
 * Where a module sign-in returns by default (RFC 8252 loopback): the board's port on the owner's own machine. Vendors don't hold
 * a loopback redirect to a company's domain allowlist (Atlassian blocked the board's https name until an admin allowed it), so a
 * sign-in needs no admin. Without a tunnel the page doesn't load and the owner pastes its address on Connect; through the
 * documented tunnel (localhost:3121) it lands on the board's callback itself. Fixed, so a hand-made client (HubSpot) registers it
 * once; `localhost`, since HubSpot refuses IP addresses.
 */
export const SIGNIN_LOOPBACK = "http://localhost:3121";

/**
 * The state and code (or the vendor's error) from the address a loopback sign-in ended on, pasted by the owner: exactly the
 * sign-in's redirect (`expected`), on 127.0.0.1 or localhost. Anything else is refused without echoing it (it may hold a code).
 */
export function pastedCallback(pasted: string, expected: string): { state: string; code?: string; error?: string; description?: string } {
  const want = new URL(expected);
  const u = URL.canParse(pasted.trim()) ? new URL(pasted.trim()) : undefined;
  const ok =
    u?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && u.port === want.port && u.pathname === want.pathname && !u.username && !u.password;
  const state = u?.searchParams.get("state") ?? "";
  const code = u?.searchParams.get("code") ?? "";
  const error = u?.searchParams.get("error") ?? "";
  if (!ok || !state || (!code && !error)) throw new McpAuthFailed(`that isn't the address the sign-in ended on: copy the whole address of the tab that couldn't load (it starts with ${expected})`);
  const description = u?.searchParams.get("error_description") ?? "";
  return { state, ...(code ? { code } : { error: error.slice(0, 100), ...(description ? { description: description.slice(0, 200) } : {}) }) };
}
