import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type CredentialsFile, readCredentials } from "./accounts.js";
import { REQUEST_SCOPES } from "./google.js";
import { explainApi, explainGoogle } from "./google-errors.js";

/**
 * Connect a Google account, or reconnect one whose sign-in expired, started from the board. The same
 * flow as src/auth.ts (PKCE, SCOPES, the client on file), except the board receives Google's redirect
 * at its loopback address (the client is a Desktop app) and hands the code back here. Only this service sees the
 * refresh token.
 */
export class Reconnect {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; account?: string; expires: number }>();

  constructor(
    private readonly credsPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  private creds(): CredentialsFile {
    return readCredentials(this.credsPath);
  }

  /** Whether a Google client is set up (pasted on the board, or in the credentials file). */
  hasClient(): boolean {
    try {
      return Boolean(this.creds().client_id);
    } catch {
      return true; // an unreadable file is its own error (the status carries it), not a missing client
    }
  }

  /** Google's consent URL: for `account`, which must already be connected, or (none given) for a new account. */
  start(account: string | undefined, redirectUri: string): { url: string } {
    const creds = this.creds();
    if (!creds.client_id) throw new ReconnectError("no Google client yet (paste one at #/setup/google on the board, or run scripts/google-auth.sh once)");
    if (account && !creds.accounts?.[account]) throw new ReconnectError(`${account} isn't a connected account`);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri)) throw new ReconnectError("redirect must be a loopback address");
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, redirectUri, account, expires: now + this.ttlMs });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: REQUEST_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      ...(account ? { login_hint: account } : {}),
    }).toString();
    return { url: url.toString() };
  }

  /**
   * Exchanges Google's code and stores the new refresh token: for the account the flow was started for, or a new
   * account (the first one connected becomes the primary: Calendar and meeting documents).
   */
  async finish(state: string, code: string, error?: string): Promise<{ email: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    // Google sent the browser back with an error (the person refused, or the project doesn't allow them): say why in words.
    if (error) throw new ReconnectError(explainGoogle(error));
    if (!p || p.expires < Date.now()) throw new ReconnectError("this sign-in link expired or was already used; start again from the board");
    const creds = this.creds();
    const body = new URLSearchParams({ code, client_id: creds.client_id!, code_verifier: p.verifier, grant_type: "authorization_code", redirect_uri: p.redirectUri });
    if (creds.client_secret) body.set("client_secret", creds.client_secret);
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const tokens = (await res.json()) as { refresh_token?: string; access_token?: string; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !tokens.refresh_token || !tokens.access_token) throw new ReconnectError(explainGoogle(tokens.error ?? String(res.status), tokens.error_description));
    // Saved as granted: Google adds the scopes the client already holds (an older sign-in's readonly ones), and the owner may
    // untick one at consent. Tool tags and grants decide what agents do; a write checks its own scope (MultiWorkspace.write).
    const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
    const email = await this.emailFor(tokens.access_token);
    // The chooser can sign in as someone else; that must not replace (or add) a different account.
    if (p.account && email.toLowerCase() !== p.account.toLowerCase()) throw new ReconnectError(`you signed in as ${email}, not ${p.account}; nothing changed`);
    const name = p.account ?? email;
    const latest = readCredentials(this.credsPath, true); // the file may have changed while the user was at Google
    latest.accounts = { ...(latest.accounts ?? {}), [name]: { ...(latest.accounts?.[name] ?? {}), client_id: creds.client_id!, client_secret: creds.client_secret, refresh_token: tokens.refresh_token, scopes: granted } };
    if (!latest.primary || !latest.accounts[latest.primary]) latest.primary = name;
    // Written in place: the file is a single-file bind mount, which a rename would not replace.
    writeFileSync(this.credsPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    return { email: name };
  }

  private async emailFor(accessToken: string): Promise<string> {
    const r = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { emailAddress?: string; error?: { message?: string } };
    if (!j.emailAddress) throw new ReconnectError(j.error ? explainApi(r.status, j) : "couldn't tell which account signed in");
    return j.emailAddress;
  }
}

export class ReconnectError extends Error {}
