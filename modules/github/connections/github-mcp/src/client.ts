// GitHub as the owner (spec 2026-11-20-github-owner-identity §1, §9): the one client every GitHub call in this process goes
// through, with the owner's sign-in. One rate limiter (background work waits while REST or GraphQL is below a 20% reserve,
// every call waits out a rate-limit refusal) and typed needs: a refusal the owner can fix (connect, reconnect, a scope, an
// org's SSO or app restriction) names the cause and the one link, and a tool answers it as needs_owner (vendor/needs.ts), which
// the kernel routes to the owner or the digest. The token never leaves this process: token() is for git children here only, and
// no answer carries it.
import { needsOwner } from "./vendor/needs.js";
import type { Auth } from "./vendor/oauth.js";

const API = "https://api.github.com";

export type Need =
  | { cause: "not_connected" }
  | { cause: "expired" }
  | { cause: "scope"; scope: string }
  | { cause: "sso"; org: string; url: string }
  | { cause: "restricted"; org: string; url: string }
  | { cause: "unreachable"; repo: string }
  | { cause: "rate_limited"; until: string };

const OWNER_FIXABLE = new Set<Need["cause"]>(["not_connected", "expired", "scope", "sso", "restricted"]);

/** The cause and its fix, in one sentence. */
export function needText(n: Need): string {
  switch (n.cause) {
    case "not_connected": return "GitHub isn't connected";
    case "expired": return "GitHub's sign-in stopped working: reconnect GitHub on the board (Settings, Connections)";
    case "scope": return `GitHub needs the \`${n.scope}\` permission: reconnect GitHub on the board (Settings, Connections)`;
    case "sso": return `The ${n.org} organization needs you to authorize single sign-on for AidenHQ: ${n.url}`;
    case "restricted": return `The ${n.org} organization restricts OAuth apps: open ${n.url} and press Grant next to ${n.org} (anyone but an owner of ${n.org} presses Request and an owner approves)`;
    case "unreachable": return `${n.repo} isn't reachable with your GitHub account`;
    case "rate_limited": return `GitHub's rate limit is used up until ${n.until}`;
  }
}

export class GitHubNeed extends Error {
  readonly need: Need;
  readonly ownerFixable: boolean;
  constructor(need: Need) {
    super(needText(need));
    this.need = need;
    this.ownerFixable = OWNER_FIXABLE.has(need.cause);
  }
}

/** A tool's answer for a need: an owner-fixable one is needs_owner (the kernel tells whoever should hear it); the rest plain. */
export function needResult(e: GitHubNeed): { isError: true; content: { type: "text"; text: string }[] } {
  const n = e.need;
  if (n.cause === "unreachable" || n.cause === "rate_limited") {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: n.cause === "rate_limited" ? "github_rate_limited" : "github_unreachable", need: n, detail: e.message }) }] };
  }
  return needsOwner({ cause: n.cause, detail: e.message, ...(n.cause === "scope" ? { scope: n.scope } : {}), ...(n.cause === "sso" || n.cause === "restricted" ? { org: n.org, url: n.url } : {}) });
}

/** One row of the board's sign-in card (what works, or what is wrong and its one fix). The board renders these as given. */
/** A card row; `time` is an ISO instant the board shows after `value` in the viewer's local time; an `href` is GitHub's page or a
 * board path (`#/...`). */
export type StatusLine = { label: string; value: string; time?: string; state: "ok" | "warn" | "error"; action?: { label: string; href?: string; reconnect?: true } };

export type GitHubStatus = {
  login?: string;
  scopes: string[];
  problems: { org: string; cause: "sso" | "restricted"; url: string }[];
  rate?: { remaining: number; limit: number; reset: string };
  /** The card's rows; empty while not connected. */
  lines: StatusLine[];
};

export interface GitHubAccess {
  connected(): boolean;
  identity(): Promise<{ login: string; name: string; email: string }>;
  /** For git children inside this process only (credential env); never returned by any route. */
  token(): Promise<string>;
  rest(method: string, path: string, body?: unknown, o?: { background?: boolean; accept?: string }): Promise<{ status: number; body: any; headers: Headers }>;
  /** The whole GraphQL answer ({data, errors}). */
  graphql(query: string, variables: Record<string, unknown>, o?: { background?: boolean }): Promise<any>;
  scopes(): string[];
  status(): GitHubStatus;
}

/** Scopes that include others (GitHub's OAuth scope tree). */
const IMPLIES: Record<string, string[]> = {
  repo: ["repo:status", "repo_deployment", "public_repo", "repo:invite", "security_events"],
  "admin:org": ["write:org", "read:org", "manage_runners:org"],
  "write:org": ["read:org"],
  project: ["read:project"],
  user: ["read:user", "user:email", "user:follow"],
};
const covers = (have: string[], want: string) => have.some((h) => h === want || IMPLIES[h]?.includes(want));
const split = (h: string | null) => (h ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** The repo a path names when the path is the repository itself (`/repos/o/r`); its sub-resources' 404s are answers. */
const repoOf = (path: string) => /^\/repos\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/.exec(path);
const ownerOf = (path: string) => /^\/(?:repos|orgs)\/([^/?#]+)/.exec(path)?.[1];

type Rate = { remaining: number; limit: number; reset: number };
type Sleep = (ms: number) => Promise<void>;

export function createAccess(o: {
  auth: Auth;
  /** The OAuth App's client ID: an org's restriction is lifted on its page (Grant, or Request) in the owner's GitHub settings. */
  clientId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: Sleep;
  /** Background calls wait while `remaining` is below this share of `limit`. */
  reserve?: number;
  /** GITHUB_FLEET_ORG and GITHUB_CI, for the status card. */
  env?: Record<string, string | undefined>;
}): GitHubAccess {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const sleep: Sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const reserve = o.reserve ?? 0.2;
  const rates = new Map<string, Rate>();
  /** After a rate-limit refusal: no call goes before this (epoch ms). */
  let blockedUntil = 0;
  let granted: string[] | undefined;
  const problems = new Map<string, { org: string; cause: "sso" | "restricted"; url: string }>();
  let me: { login: string; name: string; email: string; for: string } | undefined;

  const connected = () => o.auth.signedIn() && o.auth.status().state !== "expired";

  async function token(): Promise<string> {
    if (!o.auth.signedIn()) fail({ cause: "not_connected" });
    if (o.auth.status().state === "expired") fail({ cause: "expired" });
    const t = String((await o.auth.headers()).authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!t) fail({ cause: "not_connected" });
    return t;
  }

  function fail(n: Need): never {
    if (n.cause === "sso" || n.cause === "restricted") problems.set(n.org.toLowerCase(), { org: n.org, cause: n.cause, url: n.url });
    throw new GitHubNeed(n);
  }

  /** Waits out a rate-limit refusal (background), or refuses (interactive: a tool call can't sleep past its timeout). */
  async function admit(resource: string, background: boolean): Promise<void> {
    for (;;) {
      const t = now();
      const r = rates.get(resource);
      const low = r && r.limit > 0 && r.remaining < r.limit * reserve && r.reset > t ? r.reset : 0;
      const until = Math.max(blockedUntil > t ? blockedUntil : 0, background ? low : 0);
      if (!until) return;
      if (!background) fail({ cause: "rate_limited", until: new Date(until).toISOString() });
      await sleep(until - t);
    }
  }

  function observe(res: Response): void {
    const s = res.headers.get("x-oauth-scopes");
    if (s !== null) granted = split(s);
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 && Number.isFinite(reset)) {
      rates.set(res.headers.get("x-ratelimit-resource") ?? "core", { remaining, limit, reset: reset * 1000 });
    }
  }

  /** The need a refusal means, or undefined when the answer is just an answer. */
  function classify(path: string, res: Response, body: any, hadToken: boolean): Need | undefined {
    if (res.status === 401) return hadToken ? { cause: "expired" } : { cause: "not_connected" };
    if (res.status !== 403 && res.status !== 404 && res.status !== 429) return undefined;
    const sso = res.headers.get("x-github-sso") ?? "";
    const ssoUrl = /\burl=(\S+)/.exec(sso)?.[1];
    if (res.status === 403 && /^required/i.test(sso) && ssoUrl) {
      return { cause: "sso", org: /\/orgs\/([^/]+)\/sso/.exec(ssoUrl)?.[1] ?? ownerOf(path) ?? "", url: ssoUrl };
    }
    const message = String(body?.message ?? "");
    if (res.status === 403 && /OAuth App access restrictions/i.test(message)) {
      const org = /the [`'"]?([A-Za-z0-9-]+)[`'"]? organization/i.exec(message)?.[1] ?? ownerOf(path) ?? "";
      return { cause: "restricted", org, url: `https://github.com/settings/connections/applications/${o.clientId ?? ""}` };
    }
    const retry = Number(res.headers.get("retry-after"));
    if (res.status === 429 || (res.status === 403 && (Number.isFinite(retry) && retry > 0 || res.headers.get("x-ratelimit-remaining") === "0"))) {
      const until = Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : Number(res.headers.get("x-ratelimit-reset")) * 1000 || now() + 60_000;
      blockedUntil = Math.max(blockedUntil, until);
      return { cause: "rate_limited", until: new Date(until).toISOString() };
    }
    const accepted = split(res.headers.get("x-accepted-oauth-scopes"));
    if (accepted.length && !accepted.some((a) => covers(scopes(), a))) return { cause: "scope", scope: accepted[0]! };
    const repo = res.status === 404 ? repoOf(path) : null;
    if (repo) return { cause: "unreachable", repo: `${repo[1]}/${repo[2]}` };
    return undefined;
  }

  async function send(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string) {
    // Only the path asked for: a `.` or `..` segment (encodeURIComponent leaves them) would move the request elsewhere.
    if (!path.startsWith("/") || new URL(path, API).pathname !== path.split("?")[0]) throw new Error(`refused a GitHub path that resolves elsewhere: ${path.slice(0, 200)}`);
    await admit(resource, background);
    const t = await token();
    const res = await fetchImpl(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${t}`, accept: accept ?? "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    observe(res);
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a non-JSON answer (a diff, a log) stays text */ }
    const need = classify(path, res, parsed, true);
    if (need?.cause === "expired") o.auth.mark("expired", "GitHub refused the token (401)");
    if (need) fail(need);
    if (res.ok && /^\/orgs\/([^/]+)/.test(path)) problems.delete(ownerOf(path)!.toLowerCase());
    return { status: res.status, body: parsed, headers: res.headers };
  }

  function scopes(): string[] {
    return granted ?? split((o.auth.status().scope ?? "").replace(/\s+/g, ","));
  }

  return {
    connected,
    token: () => token(),
    scopes,
    rest: (method, path, body, opts = {}) => send(method.toUpperCase(), path, body, path === "/graphql" ? "graphql" : "core", Boolean(opts.background), opts.accept),
    graphql: async (query, variables, opts = {}) => (await send("POST", "/graphql", { query, variables }, "graphql", Boolean(opts.background))).body,
    async identity() {
      const t = await token();
      if (me?.for === t) return { login: me.login, name: me.name, email: me.email };
      const r = await send("GET", "/user", undefined, "core", false);
      if (r.status !== 200) throw new Error(`couldn't read the signed-in GitHub account (GitHub said ${r.status})`);
      const login = String(r.body.login);
      me = { login, name: String(r.body.name || login), email: `${r.body.id}+${login}@users.noreply.github.com`, for: t };
      return { login: me.login, name: me.name, email: me.email };
    },
    status() {
      const core = rates.get("core");
      const have = scopes();
      const rate = core ? { remaining: core.remaining, limit: core.limit, reset: new Date(core.reset).toISOString() } : undefined;
      const list = [...problems.values()];
      const env = o.env ?? process.env;
      return {
        ...(me ? { login: me.login } : {}),
        scopes: have,
        problems: list,
        ...(rate ? { rate } : {}),
        lines: connected() ? statusLines(have, list, rate, (env.GITHUB_FLEET_ORG ?? "").trim(), env.GITHUB_CI === "1") : [],
      };
    },
  };
}

const RECONNECT = { label: "Reconnect", reconnect: true } as const;

/** The board card's rows from the token's scopes, the orgs that refused it, the fleet org and the rate limit (spec §8). */
function statusLines(have: string[], problems: GitHubStatus["problems"], rate: GitHubStatus["rate"], fleetOrg: string, ci: boolean): StatusLine[] {
  const needs = (label: string, scope: string): StatusLine => (covers(have, scope) ? { label, value: "working", state: "ok" } : { label, value: "needs permission", state: "warn", action: RECONNECT });
  const lines: StatusLine[] = [
    needs("Reads, issues, comments", "repo"),
    needs("Pull requests and merges", "repo"),
    { label: "Fleet repos", value: fleetOrg ? `in ${fleetOrg}` : "on this server", state: "ok", action: { label: "Change", href: "#/modules/github/settings" } },
    ...(ci ? [needs("CI runners", "admin:org")] : []),
    needs("Projects boards", "project"),
    ...problems.map((p): StatusLine => (p.cause === "sso" ? { label: p.org, value: "GitHub needs you to authorize single sign-on", state: "warn", action: { label: "Authorize", href: p.url } } : { label: p.org, value: "the org restricts OAuth apps", state: "warn", action: { label: "Grant access", href: p.url } })),
  ];
  if (rate) {
    lines.push({ label: "Rate limit", value: `${rate.remaining.toLocaleString("en-US")} of ${rate.limit.toLocaleString("en-US")} left, resets`, time: new Date(rate.reset).toISOString(), state: rate.remaining < rate.limit * 0.2 ? "warn" : "ok" });
  }
  return lines;
}
