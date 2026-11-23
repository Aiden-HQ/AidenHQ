import type { Logger } from "pino";

export interface GoogleAccountStatus {
  email: string;
  primary: boolean;
  state: "unknown" | "ok" | "expired" | "error";
  since: string;
  detail?: string;
}

/**
 * Google sign-in state from google-workspace-mcp, and re-consent through it. The board holds
 * only the auth token, which reads sign-in state and starts or finishes a sign-in; it never sees a
 * Google token.
 */
export class GoogleAuth {
  private cached: { at: number; accounts: GoogleAccountStatus[]; error?: string } | undefined;

  constructor(
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
    if (!res.ok) throw new GoogleAuthFailed(data.error ?? `google-workspace-mcp answered ${res.status}`);
    return data;
  }

  /** Sign-in state per account, at most a minute old. Undefined when the sidecar can't be asked. */
  async status(maxAgeMs = 60_000): Promise<{ accounts: GoogleAccountStatus[]; error?: string } | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        const s = await this.call<{ accounts: GoogleAccountStatus[]; error?: string }>("GET", "/auth/status");
        this.cached = { at: Date.now(), accounts: s.accounts ?? [], ...(s.error ? { error: s.error } : {}) };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, "Google sign-in state unavailable");
        this.cached = undefined;
      }
    }
    if (!this.cached) return undefined;
    const { at: _at, ...status } = this.cached;
    return status;
  }

  /** The sign-in tried live (the service's /auth/check: one Calendar read): works, or what is wrong and the one thing to do. */
  async check(): Promise<{ ok: true } | { ok: false; message: string; fix?: string }> {
    try {
      return await this.call("GET", "/auth/check");
    } catch (err) {
      return { ok: false, message: `google-workspace-mcp couldn't be asked: ${String((err as Error).message).slice(0, 150)}` };
    } finally {
      this.cached = undefined;
    }
  }

  /** A consent URL: reconnecting `account`, or (none given) connecting a new one. */
  start(account: string | undefined, redirectUri: string) {
    return this.call<{ url: string }>("POST", "/auth/start", { ...(account ? { account } : {}), redirect_uri: redirectUri });
  }

  /** Exchanges Google's code; with Google's `error` instead, the service says why in words. */
  async finish(state: string, code: string | undefined, error?: string) {
    const r = await this.call<{ email: string }>("POST", "/auth/finish", { state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
    this.cached = undefined;
    return r;
  }
}

export class GoogleAuthFailed extends Error {}

/** Connect needs a loopback address: Google sends a Desktop-app sign-in back only to one. */
export function loopbackPort(host: string | undefined): number | undefined {
  const m = /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(String(host ?? "").toLowerCase());
  return m ? Number(m[1]) : undefined;
}
