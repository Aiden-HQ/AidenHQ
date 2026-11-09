import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { CredentialsFile } from "./accounts.js";
import { SCOPES } from "./google.js";

/**
 * Connect a Google account, or reconnect one whose sign-in expired, started from the board. The same
 * flow as src/auth.ts (PKCE, read-only scopes, the client on file), except the board receives Google's redirect
 * and hands the code back here: at its loopback address (a Desktop-app client), or at the board's own https
 * address (`boardRedirects`, a Web-app client with that redirect registered). Only this service sees the
 * refresh token.
 */
export class Reconnect {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; account?: string; expires: number }>();

  constructor(
    private readonly credsPath: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
    /** Exact non-loopback redirects allowed: the board's https address + /google/callback (BOARD_URL). */
    private readonly boardRedirects: string[] = [],
  ) {}

  private creds(): CredentialsFile {
    return JSON.parse(readFileSync(this.credsPath, "utf8")) as CredentialsFile;
  }

  /** Google's consent URL: for `account`, which must already be connected, or (none given) for a new account. */
  start(account: string | undefined, redirectUri: string): { url: string } {
    const creds = this.creds();
    if (!creds.client_id) throw new ReconnectError("no OAuth client on file (ops/setup.sh writes the company's; or run scripts/google-auth.sh once)");
    if (account && !creds.accounts?.[account]) throw new ReconnectError(`${account} isn't a connected account`);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri) && !this.boardRedirects.includes(redirectUri)) throw new ReconnectError("redirect must be a loopback address or the board's own address");
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
      scope: SCOPES.join(" "),
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
  async finish(state: string, code: string): Promise<{ email: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new ReconnectError("this sign-in link expired or was already used; start again from the board");
    const creds = this.creds();
    const body = new URLSearchParams({ code, client_id: creds.client_id!, code_verifier: p.verifier, grant_type: "authorization_code", redirect_uri: p.redirectUri });
    if (creds.client_secret) body.set("client_secret", creds.client_secret);
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const tokens = (await res.json()) as { refresh_token?: string; access_token?: string; scope?: string; error?: string };
    if (!res.ok || !tokens.refresh_token || !tokens.access_token) throw new ReconnectError(`Google refused the sign-in: ${tokens.error ?? res.status}`);
    const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
    const extra = granted.filter((s) => !SCOPES.includes(s) && !["openid", "email", "profile"].includes(s));
    if (extra.length) throw new ReconnectError(`unexpected scopes granted (${extra.join(", ")}); nothing saved`);
    const email = await this.emailFor(tokens.access_token);
    // The chooser can sign in as someone else; that must not replace (or add) a different account.
    if (p.account && email.toLowerCase() !== p.account.toLowerCase()) throw new ReconnectError(`you signed in as ${email}, not ${p.account}; nothing changed`);
    const name = p.account ?? email;
    const latest = this.creds(); // the file may have changed while the user was at Google
    latest.accounts = { ...(latest.accounts ?? {}), [name]: { ...(latest.accounts?.[name] ?? {}), refresh_token: tokens.refresh_token, scopes: granted } };
    if (!latest.primary || !latest.accounts[latest.primary]) latest.primary = name;
    // Written in place: the file is a single-file bind mount, which a rename would not replace.
    writeFileSync(this.credsPath, JSON.stringify(latest, null, 2), { mode: 0o600 });
    return { email: name };
  }

  private async emailFor(accessToken: string): Promise<string> {
    const r = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { emailAddress?: string };
    if (!j.emailAddress) throw new ReconnectError("couldn't tell which account signed in");
    return j.emailAddress;
  }
}

export class ReconnectError extends Error {}
