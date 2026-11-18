import type { Logger } from "pino";

export interface McpAuthStatus {
  /** "none": the proxy signs in to nothing (grafana-mcp with GRAFANA_SOURCE=local): no Connect, no URL fields. */
  state: "missing" | "ok" | "expired" | "unknown" | "none";
  /** Whether the service's server is set (GLEAN_MCP_URL, GRAFANA_URL, CLICKHOUSE_MCP_URL): without it there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
}

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

  /** Sign-in state, at most a minute old. Undefined when the proxy can't be asked. */
  async status(maxAgeMs = 60_000): Promise<McpAuthStatus | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        this.cached = { at: Date.now(), status: await this.call<McpAuthStatus>("GET", "/auth/status") };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, `${this.name} sign-in state unavailable`);
        this.cached = undefined;
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
export function pastedCallback(pasted: string, expected: string): { state: string; code?: string; error?: string } {
  const want = new URL(expected);
  const u = URL.canParse(pasted.trim()) ? new URL(pasted.trim()) : undefined;
  const ok =
    u?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && u.port === want.port && u.pathname === want.pathname && !u.username && !u.password;
  const state = u?.searchParams.get("state") ?? "";
  const code = u?.searchParams.get("code") ?? "";
  const error = u?.searchParams.get("error") ?? "";
  if (!ok || !state || (!code && !error)) throw new McpAuthFailed(`that isn't the address the sign-in ended on: copy the whole address of the tab that couldn't load (it starts with ${expected})`);
  return { state, ...(code ? { code } : { error: error.slice(0, 100) }) };
}
