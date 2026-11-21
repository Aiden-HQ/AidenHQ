// GitHub as the owner (spec 2026-11-20-github-owner-identity §1, §9): the one client every GitHub call in this process goes
// through, with the owner's sign-in. One rate limiter: a call issued interactively (from a tool) fails at once as a typed
// `rate_limited` need when a limit blocks it, because a tool call can't sleep past its timeout; a background call (a job) waits
// while REST or GraphQL is below a 20% reserve. Content-creating writes go one at a time, at least a second apart, and wait out
// GitHub's secondary limit, as its guidance asks, but only inside the write's budget: every content-creating call fixes a
// 240 s budget when it starts (below the kernel's 300 s allowance), and a write that cannot start in it fails at once,
// `rate_limited` (with its `until`) or `write_busy` for a queue that is too deep.
// Typed needs name the cause and the one fix: a refusal the owner can fix (connect, reconnect, a scope, an org's SSO or app
// restriction) is needs_owner (vendor/needs.ts), which the kernel routes to the owner or the digest. The token never leaves this
// process: token() is for git children here only, and no answer carries it.
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
  | { cause: "rate_limited"; until: string }
  | { cause: "write_busy" };

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
    case "write_busy": return "GitHub's writes are backed up right now: try again in a minute";
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
  if (n.cause === "unreachable" || n.cause === "rate_limited" || n.cause === "write_busy") {
    const error = n.cause === "rate_limited" ? "github_rate_limited" : n.cause === "write_busy" ? "github_write_busy" : "github_unreachable";
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, need: n, detail: e.message }) }] };
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
/** Calls `fire` after `ms`; the returned function cancels it. */
type Timer = (ms: number, fire: () => void) => () => void;

/** GitHub: content-creating requests go serially, at least this far apart (its secondary-limit guidance). */
const WRITE_GAP_MS = 1000;
/** A secondary-limit refusal without retry-after waits this long, doubling per refusal in a row. */
const SECONDARY_BASE_MS = 60_000;
/** One attempt's own fetch limit; a write starts no attempt with less than this left in its budget. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** A content-creating call's whole budget, fixed when the call starts: the kernel gives a tool 300 s by default and then
 * allows 30 s more (kernel/src/proxy.ts:156,239), and the caller's own tool timeout is 300 s (services/computer/lib.ts:28), so
 * a write waits and retries only inside this, comfortably before either cuts the call off. The module can't read its own
 * allowance, so this is the conservative constant, fixed against that 300 s default. */
const WRITE_BUDGET_MS = 240_000;
const SECONDARY = /secondary rate limit|abuse detection|submitted too quickly/i;
/** Whether a request creates content: any non-read method, except a GraphQL query. */
const createsContent = (method: string, path: string, body: unknown) =>
  !["GET", "HEAD", "OPTIONS"].includes(method) && (path !== "/graphql" || /^\s*mutation\b/.test(String((body as { query?: unknown } | undefined)?.query ?? "")));

export function createAccess(o: {
  auth: Auth;
  /** The OAuth App's client ID: an org's restriction is lifted on its page (Grant, or Request) in the owner's GitHub settings. */
  clientId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: Sleep;
  timer?: Timer;
  /** Background calls wait while `remaining` is below this share of `limit`. */
  reserve?: number;
  /** GITHUB_FLEET_ORG and GITHUB_CI, for the status card. */
  env?: Record<string, string | undefined>;
}): GitHubAccess {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const sleep: Sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timer: Timer = o.timer ?? ((ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  });
  const reserve = o.reserve ?? 0.2;
  const rates = new Map<string, Rate>();
  /** After a rate-limit refusal: no call goes before this (epoch ms). */
  let blockedUntil = 0;
  /** After a secondary-limit refusal: no content-creating call goes before this (epoch ms); reads are unaffected. */
  let writeBlockedUntil = 0;
  let secondaryStreak = 0;
  let lastWriteEnd = 0;
  let writeTail: Promise<unknown> = Promise.resolve();
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

  /** Waits out a rate-limit refusal (background), or refuses (interactive: a tool call can't sleep past its timeout).
   * A background call sleeps on the reserve and on a refusal alike, but only where a write can still see its attempt through
   * inside its budget; anything it cannot wait out is the same typed need as an interactive call's. */
  async function admit(resource: string, background: boolean, deadline?: number): Promise<void> {
    for (;;) {
      const t = now();
      const r = rates.get(resource);
      const low = r && r.limit > 0 && r.remaining < r.limit * reserve && r.reset > t ? r.reset : 0;
      const until = Math.max(blockedUntil > t ? blockedUntil : 0, background ? low : 0);
      if (!until) return;
      if (!background || (deadline !== undefined && !fits(deadline, until))) fail({ cause: "rate_limited", until: new Date(until).toISOString() });
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
    if (res.status === 403 && SECONDARY.test(message)) {
      const until = now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : SECONDARY_BASE_MS * 2 ** Math.min(secondaryStreak, 6));
      secondaryStreak++;
      writeBlockedUntil = Math.max(writeBlockedUntil, until);
      return { cause: "rate_limited", until: new Date(until).toISOString() };
    }
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

  /** Whether an attempt that can only start at `at` still sees its 30 s through inside the write's budget. */
  const fits = (deadline: number, at = now()) => at + ATTEMPT_TIMEOUT_MS <= deadline;

  /** Fails a write that cannot start in budget: the real limit when one blocks it, the queue when that is the reason. */
  function noBudget(): never {
    if (writeBlockedUntil > now()) fail({ cause: "rate_limited", until: new Date(writeBlockedUntil).toISOString() });
    fail({ cause: "write_busy" });
  }

  function send(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string) {
    if (!createsContent(method, path, body)) return attempt(method, path, body, resource, background, accept);
    // The budget is fixed here, before the queue: a write that waited behind others has already spent that wait.
    const deadline = now() + WRITE_BUDGET_MS;
    return queued(deadline, () => paced(deadline, () => attempt(method, path, body, resource, background, accept, deadline)));
  }

  /** Runs a write behind the one queue: one at a time, a gap apart, and the whole queue waits out a refusal. The caller gets
   * its answer at its own deadline even while an earlier write still holds the queue; the entry is then marked dead and the
   * pre-attempt check keeps it from being sent, so no write lands after its caller was told it failed. */
  function queued<T>(deadline: number, go: () => Promise<T>): Promise<T> {
    let expired = false;
    const run = writeTail.then(() => {
      if (expired || !fits(deadline)) noBudget();
      return go();
    });
    writeTail = run.catch(() => {});
    let cancel = () => {};
    const expiry = new Promise<never>((_, reject) => {
      cancel = timer(Math.max(deadline - now(), 0), () => {
        expired = true;
        try { noBudget(); } catch (e) { reject(e); }
      });
    });
    void expiry.catch(() => {});
    return Promise.race([run, expiry]).finally(cancel);
  }

  async function paced<T>(deadline: number, go: () => Promise<T>): Promise<T> {
    for (;;) {
      const until = Math.max(lastWriteEnd + WRITE_GAP_MS, writeBlockedUntil);
      const wait = until - now();
      // The queue's wait counts against the call's budget: no sleeping into a moment where no attempt can start.
      if (wait > 0 && !fits(deadline, until)) noBudget();
      if (wait > 0) await sleep(wait);
      if (!fits(deadline)) noBudget();
      try {
        const r = await go();
        secondaryStreak = 0;
        return r;
      } catch (e) {
        if (!(e instanceof GitHubNeed) || e.need.cause !== "rate_limited") throw e;
        // Refused before it created anything: wait out the limit and send the same request again, inside the budget.
        const retryAt = Math.max(Date.parse(e.need.until), blockedUntil, writeBlockedUntil);
        if (!fits(deadline, retryAt)) fail({ cause: "rate_limited", until: new Date(retryAt).toISOString() });
        await sleep(Math.max(retryAt - now(), 0));
      } finally {
        lastWriteEnd = now();
      }
    }
  }

  async function attempt(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, deadline?: number) {
    // Only the path asked for: a `.` or `..` segment (encodeURIComponent leaves them) would move the request elsewhere.
    if (!path.startsWith("/") || new URL(path, API).pathname !== path.split("?")[0]) throw new Error(`refused a GitHub path that resolves elsewhere: ${path.slice(0, 200)}`);
    await admit(resource, background, deadline);
    const t = await token();
    // Never a fetch once the write's budget has run out: nothing lands after the caller was told it failed.
    if (deadline !== undefined && !fits(deadline)) noBudget();
    const res = await fetchImpl(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
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
    if (res.ok) o.auth.mark("ok"); // the sign-in's state starts "unknown" after every restart; a call that worked settles it
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
