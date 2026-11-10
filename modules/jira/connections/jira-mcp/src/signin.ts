import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SCOPES } from "./policy.js";
import { parseTokenResponse, type TokenStore } from "./tokens.js";

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  issuer: string;
}

export class SignInError extends Error {}

/**
 * Signing AidenHQ in to Atlassian's remote MCP server (Rovo MCP) as the owner, started from the board (like Glean):
 * OAuth 2.1 with PKCE, the client registered dynamically once per redirect address and kept in
 * /state. The browser comes back to the board's loopback address, which hands the code to finish().
 * Only this service sees the tokens.
 */
export class SignIn {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; meta: Metadata; client: RegisteredClient; expires: number }>();

  constructor(
    private readonly mcpUrl: string,
    private readonly clientPath: string,
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The resource the token is for: the MCP endpoint without its query (?tools=all). */
  private get resource(): string {
    const u = new URL(this.mcpUrl);
    return u.origin + u.pathname;
  }

  private async json(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** The authorization server for the MCP endpoint (RFC 9728 resource metadata, then RFC 8414). */
  async discover(): Promise<{ issuer: string; meta: Metadata; scopes?: string[] }> {
    const mcp = new URL(this.mcpUrl);
    let issuer = mcp.origin;
    let scopes: string[] | undefined;
    for (const u of [`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname.replace(/\/$/, "")}`, `${mcp.origin}/.well-known/oauth-protected-resource`]) {
      const r = await this.json(u).catch(() => undefined);
      const servers = r?.ok ? r.body.authorization_servers : undefined;
      if (Array.isArray(servers) && typeof servers[0] === "string") {
        issuer = servers[0].replace(/\/$/, "");
        // Only the scopes AidenHQ uses (src/policy.ts), never everything Atlassian offers (writes, deletes, Bitbucket, ...).
        if (Array.isArray(r!.body.scopes_supported)) scopes = (r!.body.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string" && SCOPES.includes(s));
        break;
      }
    }
    const is = new URL(issuer);
    const path = is.pathname.replace(/\/$/, "");
    for (const u of [`${is.origin}/.well-known/oauth-authorization-server${path}`, `${is.origin}${path}/.well-known/openid-configuration`, `${is.origin}/.well-known/oauth-authorization-server`]) {
      const r = await this.json(u).catch(() => undefined);
      if (r?.ok && typeof r.body.authorization_endpoint === "string" && typeof r.body.token_endpoint === "string") {
        // Without offline_access there may be no refresh token, and the sign-in would end with the first access token.
        const offered = Array.isArray(r.body.scopes_supported) ? r.body.scopes_supported : [];
        if (scopes?.length && offered.includes("offline_access") && !scopes.includes("offline_access")) scopes = [...scopes, "offline_access"];
        return { issuer, meta: r.body as unknown as Metadata, ...(scopes?.length ? { scopes } : {}) };
      }
    }
    throw new SignInError(`couldn't find Atlassian's sign-in server for ${this.mcpUrl}`);
  }

  private async client(issuer: string, meta: Metadata, redirectUri: string): Promise<RegisteredClient> {
    const saved = existsSync(this.clientPath) ? (JSON.parse(readFileSync(this.clientPath, "utf8")) as RegisteredClient) : undefined;
    if (saved?.client_id && saved.redirect_uri === redirectUri && saved.issuer === issuer) return saved;
    if (!meta.registration_endpoint) throw new SignInError("Atlassian doesn't offer client registration (ask an admin to enable the OAuth authorization server)");
    const r = await this.json(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "AidenHQ", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!r.ok || typeof r.body.client_id !== "string") throw new SignInError(`Atlassian refused to register AidenHQ (${String(r.body.error_description ?? r.body.error ?? r.status).slice(0, 200)})`);
    const client: RegisteredClient = { client_id: r.body.client_id, ...(typeof r.body.client_secret === "string" ? { client_secret: r.body.client_secret } : {}), redirect_uri: redirectUri, issuer };
    writeFileSync(this.clientPath, JSON.stringify(client, null, 2), { mode: 0o600 });
    chmodSync(this.clientPath, 0o600);
    return client;
  }

  /** Atlassian's sign-in URL; Atlassian sends the browser back to `redirectUri` (the board's loopback address). */
  async start(redirectUri: string): Promise<{ url: string }> {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri)) throw new SignInError("redirect must be a loopback address");
    const { issuer, meta, scopes } = await this.discover();
    const client = await this.client(issuer, meta, redirectUri);
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, redirectUri, meta, client, expires: now + 10 * 60_000 });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      resource: this.resource,
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    }).toString();
    return { url: url.toString() };
  }

  async finish(state: string, code: string): Promise<void> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new SignInError("this sign-in link expired or was already used; start again from the board");
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: p.client.client_id, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: this.resource });
    if (p.client.client_secret) body.set("client_secret", p.client.client_secret);
    const r = await this.json(p.meta.token_endpoint, { method: "POST", body });
    if (!r.ok || typeof r.body.access_token !== "string") throw new SignInError(`Atlassian refused the sign-in: ${String(r.body.error ?? r.status)}`);
    this.tokens.replace({
      ...parseTokenResponse(r.body),
      client_id: p.client.client_id,
      ...(p.client.client_secret ? { client_secret: p.client.client_secret } : {}),
      token_endpoint: p.meta.token_endpoint,
      resource: this.resource,
    });
  }
}
