// GitHub as the owner (spec 2026-11-20-github-owner-identity §1, §9): the one client every GitHub call in this process goes
// through, with the owner's sign-in. One rate limiter: a call issued interactively (from a tool) fails at once as a typed
// `rate_limited` need when a limit blocks it, because a tool call can't sleep past its timeout; a background call (a job) waits
// while REST or GraphQL is below a 20% reserve. Content-creating writes go one at a time per identity (the owner, or code
// review's App installation, which `as` names: each has its own limits and queue), at least a second apart, and wait out
// GitHub's secondary limit, as its guidance asks, but only inside the write's budget: the writes of one tool invocation share
// one 240 s budget, fixed when the invocation starts so its own reads spend it too (below the kernel's 300 s allowance), and a
// write that cannot start in what is left fails at once, `rate_limited` (with its `until`) or `write_busy` for a queue that is
// too deep. A background write (a job's) is not on that clock and keeps waiting a limit out, as before.
// Typed needs name the cause and the one fix: a refusal the owner can fix (connect, reconnect, a scope, an org's SSO or app
// restriction) is needs_owner (vendor/needs.ts), which the kernel routes to the owner or the digest. The token never leaves this
// process: token() is for git children here only, and no answer carries it.
import { AsyncLocalStorage } from "node:async_hooks";
import { needsOwner } from "./vendor/needs.js";
import type { Auth } from "./vendor/oauth.js";

const API = "https://api.github.com";

export type Need =
  | { cause: "not_connected" }
  | { cause: "expired" }
  | { cause: "scope"; scope: string }
  | { cause: "sso"; org: string; url: string; /** GitHub's own words, in full, when it gave them (a GraphQL refusal). */ message?: string }
  | { cause: "restricted"; org: string; url: string; message?: string }
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
    case "write_busy": return "This GitHub write can't finish in time right now: run the call again in a minute";
  }
}

export class GitHubNeed extends Error {
  readonly need: Need;
  readonly ownerFixable: boolean;
  /** `detail` adds what a caller should know about this particular call (the cause and its fields are kept). */
  constructor(need: Need, detail?: string) {
    super(detail ?? needText(need));
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

/**
 * One row of the board's sign-in card (what works, or what is wrong and its one fix). The board renders these as given. `time` is
 * an ISO instant the board shows after `value` in the viewer's local time; an `href` is GitHub's page or a board path (`#/...`),
 * an `admin` path a page on the kernel's admin listener. A suggestion (`hint` and its action) carries a `dismiss` key: once the
 * owner dismisses it, the board drops both from the row for good.
 */
export type StatusLine = { label: string; value: string; time?: string; state: "ok" | "warn" | "error"; hint?: string; dismiss?: string; action?: { label: string; href?: string; admin?: string; reconnect?: true } };

export type GitHubStatus = {
  login?: string;
  scopes: string[];
  problems: { org: string; cause: "sso" | "restricted"; url: string; message?: string }[];
  rate?: { remaining: number; limit: number; reset: string };
  /** The card's rows; empty while not connected. */
  lines: StatusLine[];
};

/** Another identity's calls (the code review App's installation): its own token, pacing and rate limits; never the sign-in's state. */
export type Identity = {
  key: string;
  token(fresh?: boolean): Promise<string>;
  /** Each write as it was answered: a refusal (its words) or a success (undefined), so its owner sees when it stops working. */
  wrote?(refusal?: string): void;
};
/** `etag`: a conditional read (If-None-Match): GitHub answers 304, free of the rate budget, when nothing changed. */
type CallOpts = { background?: boolean; accept?: string; as?: Identity; etag?: string };

export interface GitHubAccess {
  connected(): boolean;
  identity(): Promise<{ login: string; name: string; email: string }>;
  /** For git children inside this process only (credential env); never returned by any route. */
  token(): Promise<string>;
  /** `as`: another identity than the owner's (the code review App's installation); everything else is the owner's sign-in. */
  rest(method: string, path: string, body?: unknown, o?: CallOpts): Promise<{ status: number; body: any; headers: Headers }>;
  /** The whole GraphQL answer ({data, errors}). */
  graphql(query: string, variables: Record<string, unknown>, o?: { background?: boolean; as?: Identity }): Promise<any>;
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
/**
 * One identity's limits (the owner, or one App installation): GitHub counts each separately, so each has its own rate limits,
 * its own serial write queue and its own secondary-limit backoff; a new installation token keeps its identity's.
 */
type Pace = {
  rates: Map<string, Rate>;
  /** After a rate-limit refusal: no call goes before this (epoch ms). */
  blockedUntil: number;
  /** After a secondary-limit refusal: no content-creating call goes before this (epoch ms); reads are unaffected. */
  writeBlockedUntil: number;
  secondaryStreak: number;
  lastWriteEnd: number;
  writeTail: Promise<unknown>;
  /** Content-creating writes sent this hour (the log's per-identity count). */
  hour: { at: number; writes: number };
};
const newPace = (): Pace => ({ rates: new Map(), blockedUntil: 0, writeBlockedUntil: 0, secondaryStreak: 0, lastWriteEnd: 0, writeTail: Promise.resolve(), hour: { at: 0, writes: 0 } });
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
/** One tool invocation's writes share one budget: the store holds the deadline, fixed at the invocation's entry. */
const invocation = new AsyncLocalStorage<{ deadline: number }>();

/** Runs `fn` as one tool invocation (main.ts's tool wrapper): every write it makes shares one 240 s budget, fixed when the
 * invocation starts, so a preflight read and a second write both spend that same budget and no write is sent after it. */
export function withWriteBudget<T>(fn: () => Promise<T>, at: () => number = Date.now): Promise<T> {
  return invocation.run({ deadline: at() + WRITE_BUDGET_MS }, fn);
}
/** The deadline of the tool invocation this call belongs to, or undefined outside a tool call. */
export function writeBudgetDeadline(): number | undefined {
  return invocation.getStore()?.deadline;
}
/** Whether what is left of this tool invocation's budget can still start a write's attempt. A caller that waits for another
 * write past this point must fail fast instead: its own reads and writes would otherwise run after the caller was told it
 * failed. Outside a tool call there is no budget, so this is false. */
export function writeBudgetSpent(at: number = Date.now()): boolean {
  const deadline = writeBudgetDeadline();
  return deadline !== undefined && at + ATTEMPT_TIMEOUT_MS > deadline;
}
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
  /** Each content-creating write, by identity (how much of the owner's limit code review's App takes off it). */
  log?: (msg: string, f: Record<string, unknown>) => void;
  /** A successful call by the owner that named an org (REST, search or GraphQL): the org's need is the owner's fix made. */
  onOrgOk?: (org: string) => void;
}): GitHubAccess {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const sleep: Sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timer: Timer = o.timer ?? ((ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  });
  const reserve = o.reserve ?? 0.2;
  const paces = new Map<string, Pace>([["owner", newPace()]]);
  const owner = paces.get("owner")!;
  const paceOf = (as?: Identity) => { const k = as?.key ?? "owner"; let p = paces.get(k); if (!p) paces.set(k, (p = newPace())); return p; };
  let granted: string[] | undefined;
  /** The sign-in's scopes as they stood when the API gave `granted`: a reconnect that changes them makes the cache stale. */
  let grantedFor: string | undefined;
  /** `at`: when a GraphQL refusal last came (those warnings expire, see PROBLEM_TTL_MS); REST's are cleared by an org call that works. */
  const problems = new Map<string, { org: string; cause: "sso" | "restricted"; url: string; message?: string; at?: number }>();
  let me: { login: string; name: string; email: string; for: string } | undefined;

  const connected = () => o.auth.signedIn() && o.auth.status().state !== "expired";

  /** The orgs a successful owner call named: a REST `/orgs/<org>` or `/repos/<org>` path, or a search's `org:`/`user:` qualifiers. */
  const restOrgs = (path: string): string[] => {
    const one = ownerOf(path);
    if (one) return [one];
    if (/^\/search\/issues(?:[?#]|$)/.test(path)) {
      const q = new URL(path, API).searchParams.get("q") ?? "";
      return [...q.matchAll(/\b(?:org|user):([A-Za-z0-9-]+)/gi)].map((m) => m[1]!);
    }
    return [];
  };
  /** A served org's REST warning is the owner's fix made: a retry that works removes it (GraphQL ones keep their TTL). */
  const clearProblems = (orgs: string[]) => {
    for (const org of orgs) if (problems.get(org.toLowerCase())?.at === undefined) problems.delete(org.toLowerCase());
  };
  const orgOk = (orgs: string[]) => {
    for (const org of orgs) {
      try { o.onOrgOk?.(org); } catch { /* a report never breaks the call it reports */ }
    }
  };

  async function token(): Promise<string> {
    if (!o.auth.signedIn()) fail({ cause: "not_connected" });
    if (o.auth.status().state === "expired") fail({ cause: "expired" });
    const t = String((await o.auth.headers()).authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!t) fail({ cause: "not_connected" });
    return t;
  }

  function fail(n: Need, refusedAt?: number): never {
    if (n.cause === "sso" || n.cause === "restricted") problems.set(n.org.toLowerCase(), { org: n.org, cause: n.cause, url: n.url, ...(n.message ? { message: n.message } : {}), ...(refusedAt ? { at: refusedAt } : {}) });
    throw new GitHubNeed(n, (n.cause === "sso" || n.cause === "restricted") && n.message ? `${needText(n)}. GitHub said: ${n.message}` : undefined);
  }

  /** Waits out a rate-limit refusal (background), or refuses (interactive: a tool call can't sleep past its timeout).
   * A background call sleeps on the reserve and on a refusal alike, but only where a write can still see its attempt through
   * inside its budget; anything it cannot wait out is the same typed need as an interactive call's. */
  async function admit(p: Pace, resource: string, background: boolean, deadline?: number): Promise<void> {
    for (;;) {
      const t = now();
      const r = p.rates.get(resource);
      const low = r && r.limit > 0 && r.remaining < r.limit * reserve && r.reset > t ? r.reset : 0;
      const until = Math.max(p.blockedUntil > t ? p.blockedUntil : 0, background ? low : 0);
      if (!until) return;
      if (!background || (deadline !== undefined && !fits(deadline, until))) fail({ cause: "rate_limited", until: new Date(until).toISOString() });
      await sleep(until - t);
    }
  }

  /**
   * `sentFor`: the sign-in's scopes when the request went out. A call that started under the old grant and answered after a
   * reconnect still carries the old grant's header, so it is labelled with the sign-in it was sent under, never the current one.
   */
  function observe(p: Pace, res: Response, sentFor: string): void {
    const s = res.headers.get("x-oauth-scopes");
    if (s !== null && p === owner) {
      granted = split(s);
      grantedFor = sentFor;
    }
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 && Number.isFinite(reset)) {
      p.rates.set(res.headers.get("x-ratelimit-resource") ?? "core", { remaining, limit, reset: reset * 1000 });
    }
  }

  /**
   * The need a refusal means, or undefined when the answer is just an answer. For another identity (`app`) only the rate limits
   * are needs: its 401 and 403s are its own errors, never the owner's sign-in to fix.
   */
  function classify(p: Pace, path: string, res: Response, body: any, app: boolean): Need | undefined {
    if (res.status === 401 && !app) return { cause: "expired" };
    if (res.status !== 403 && res.status !== 404 && res.status !== 429) return undefined;
    const message = String(body?.message ?? "");
    const retry = Number(res.headers.get("retry-after"));
    // A secondary limit: its words, or a 429 while the primary quota isn't used up (with or without Retry-After).
    const primaryOut = res.headers.get("x-ratelimit-remaining") === "0";
    if ((res.status === 403 || res.status === 429) && (SECONDARY.test(message) || (res.status === 429 && !primaryOut))) {
      const until = now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : SECONDARY_BASE_MS * 2 ** Math.min(p.secondaryStreak, 6));
      p.secondaryStreak++;
      p.writeBlockedUntil = Math.max(p.writeBlockedUntil, until);
      return { cause: "rate_limited", until: new Date(until).toISOString() };
    }
    if (res.status === 429 || (res.status === 403 && (Number.isFinite(retry) && retry > 0 || res.headers.get("x-ratelimit-remaining") === "0"))) {
      const until = Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : Number(res.headers.get("x-ratelimit-reset")) * 1000 || now() + 60_000;
      p.blockedUntil = Math.max(p.blockedUntil, until);
      return { cause: "rate_limited", until: new Date(until).toISOString() };
    }
    if (app) return undefined;
    const sso = res.headers.get("x-github-sso") ?? "";
    const ssoUrl = /\burl=(\S+)/.exec(sso)?.[1];
    if (res.status === 403 && /^required/i.test(sso) && ssoUrl) {
      return { cause: "sso", org: /\/orgs\/([^/]+)\/sso/.exec(ssoUrl)?.[1] ?? ownerOf(path) ?? "", url: ssoUrl };
    }
    if (res.status === 403 && /OAuth App access restrictions/i.test(message)) {
      const org = /the [`'"]?([A-Za-z0-9-]+)[`'"]? organization/i.exec(message)?.[1] ?? ownerOf(path) ?? "";
      return { cause: "restricted", org, url: `https://github.com/settings/connections/applications/${o.clientId ?? ""}` };
    }
    const accepted = split(res.headers.get("x-accepted-oauth-scopes"));
    if (accepted.length && !accepted.some((a) => covers(scopes(), a))) return { cause: "scope", scope: accepted[0]! };
    const repo = res.status === 404 ? repoOf(path) : null;
    if (repo) return { cause: "unreachable", repo: `${repo[1]}/${repo[2]}` };
    return undefined;
  }

  /** Whether an attempt that can only start at `at` still sees its 30 s through inside the write's budget. A background
   * write has no deadline: it is a job, not a tool call, so it may wait as long as it must (as it always has). */
  const fits = (deadline: number | undefined, at = now()) => deadline === undefined || at + ATTEMPT_TIMEOUT_MS <= deadline;

  /** Fails a write that cannot start in budget: the real limit when one blocks it, the queue when that is the reason. */
  function noBudget(p: Pace): never {
    if (p.writeBlockedUntil > now()) fail({ cause: "rate_limited", until: new Date(p.writeBlockedUntil).toISOString() });
    fail({ cause: "write_busy" });
  }

  function send(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, as?: Identity, etag?: string) {
    const p = paceOf(as);
    if (!createsContent(method, path, body)) return attempt(p, method, path, body, resource, background, accept, undefined, as, false, etag);
    // One budget for the tool invocation this write belongs to, fixed at its entry so preflight reads and earlier writes
    // have already spent it (and before the queue: a write that waited behind others has spent that wait too); outside a
    // tool call, each write gets its own. A background write (a job's, never a tool's) is not on a caller's clock: it keeps
    // the patience it always had and waits a limit out, inside the queue like every other write.
    const deadline = background ? undefined : invocation.getStore()?.deadline ?? now() + WRITE_BUDGET_MS;
    return queued(p, deadline, () => paced(p, deadline, () => attempt(p, method, path, body, resource, background, accept, deadline, as)));
  }

  /** Runs a write behind its identity's queue: one at a time, a gap apart, and the whole queue waits out a refusal. A write that is
   * still queued at the deadline fails there and is marked dead (the pre-attempt check keeps it from being sent), so no write
   * lands after its caller was told it failed. Once the entry takes its turn, its own budget checks and its fetch's 30 s
   * timeout govern it: the timer never reports a failure for a request already in flight, which GitHub may have completed. */
  function queued<T>(p: Pace, deadline: number | undefined, go: () => Promise<T>): Promise<T> {
    let expired = false;
    let cancel = () => {};
    const run = p.writeTail.then(() => {
      cancel(); // its turn: the queue wait is over, so the queue timer cannot fire into the running request
      if (expired || !fits(deadline)) noBudget(p);
      return go();
    });
    p.writeTail = run.catch(() => {});
    // A background write has no deadline, so nothing to expire it.
    if (deadline === undefined) return run.finally(() => cancel());
    const expiry = new Promise<never>((_, reject) => {
      cancel = timer(Math.max(deadline - now(), 0), () => {
        expired = true;
        try { noBudget(p); } catch (e) { reject(e); }
      });
    });
    void expiry.catch(() => {});
    return Promise.race([run, expiry]).finally(() => cancel());
  }


  async function paced<T>(p: Pace, deadline: number | undefined, go: () => Promise<T>): Promise<T> {
    for (;;) {
      const until = Math.max(p.lastWriteEnd + WRITE_GAP_MS, p.writeBlockedUntil);
      const wait = until - now();
      // The queue's wait counts against the call's budget: no sleeping into a moment where no attempt can start.
      if (wait > 0 && !fits(deadline, until)) noBudget(p);
      if (wait > 0) await sleep(wait);
      if (!fits(deadline)) noBudget(p);
      try {
        const r = await go();
        p.secondaryStreak = 0;
        return r;
      } catch (e) {
        if (!(e instanceof GitHubNeed) || e.need.cause !== "rate_limited") throw e;
        // Refused before it created anything: wait out the limit and send the same request again, inside the budget.
        const retryAt = Math.max(Date.parse(e.need.until), p.blockedUntil, p.writeBlockedUntil);
        if (!fits(deadline, retryAt)) fail({ cause: "rate_limited", until: new Date(retryAt).toISOString() });
        await sleep(Math.max(retryAt - now(), 0));
      } finally {
        p.lastWriteEnd = now();
      }
    }
  }

  async function attempt(p: Pace, method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, deadline?: number, as?: Identity, retried = false, etag?: string): Promise<{ status: number; body: any; headers: Headers }> {
    // Only the path asked for: a `.` or `..` segment (encodeURIComponent leaves them) would move the request elsewhere.
    if (!path.startsWith("/") || new URL(path, API).pathname !== path.split("?")[0]) throw new Error(`refused a GitHub path that resolves elsewhere: ${path.slice(0, 200)}`);
    await admit(p, resource, background, deadline);
    const t = as ? await as.token(retried) : await token();
    // The sign-in the request goes out under, kept for the header it may answer with (see `observe`).
    const sentFor = signInScopes();
    // Never a fetch once the write's budget has run out: nothing lands after the caller was told it failed.
    if (deadline !== undefined && !fits(deadline)) noBudget(p);
    const res = await fetchImpl(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: { authorization: `Bearer ${t}`, accept: accept ?? "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq", ...(etag ? { "if-none-match": etag } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (createsContent(method, path, body)) {
      // Counted as sent, per identity: how much of the owner's write limit the App takes off it.
      if (now() - p.hour.at >= 3_600_000) p.hour = { at: now(), writes: 0 };
      p.hour.writes++;
      o.log?.("github write", { identity: as ? "app" : "owner", key: as?.key ?? "owner", method, path: path.replace(/[0-9a-f]{40}/g, ":sha").replace(/\/[0-9]+/g, "/:n").split("?")[0], status: res.status, writes_this_hour: p.hour.writes });
    }
    observe(p, res, sentFor);
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a non-JSON answer (a diff, a log) stays text */ }
    // Another identity's token GitHub refused (revoked, or the installation changed): once more with a new token.
    if (as && res.status === 401 && !retried) return attempt(p, method, path, body, resource, background, accept, deadline, as, true, etag);
    const need = classify(p, path, res, parsed, Boolean(as));
    if (need?.cause === "expired") o.auth.mark("expired", "GitHub refused the token (401)");
    if (need) fail(need);
    if (as) {
      // Its writes' answers are its health (a permission the installation hasn't granted is a 403 here, not at the token).
      if (createsContent(method, path, body) && (res.ok || res.status === 401 || res.status === 403)) as.wrote?.(res.ok ? undefined : `GitHub refused ${method} ${path.split("?")[0]!.replace(/[0-9a-f]{40}/g, ":sha")}: ${res.status} ${String(parsed?.message ?? "").slice(0, 120)}`);
      return { status: res.status, body: parsed, headers: res.headers };
    }
    if (res.ok) o.auth.mark("ok"); // the sign-in's state starts "unknown" after every restart; a call that worked settles it
    // A 304 is a conditional read that succeeded: the org answered, so its need is cleared too. `partial-results` says the org's
    // SSO blocked part of the answer (a search that omits what it protects), so the org did not answer for everything asked.
    if ((res.ok || res.status === 304) && !/^partial-results/i.test(res.headers.get("x-github-sso") ?? "")) {
      const orgs = restOrgs(path);
      clearProblems(orgs);
      orgOk(orgs);
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** The sign-in's own scopes as one comparable string: empty when the sign-in doesn't record any (a pasted service token). */
  function signInScopes(): string {
    return split((o.auth.status().scope ?? "").replace(/\s+/g, ",")).sort().join(",");
  }

  function scopes(): string[] {
    // The header names the grant GitHub saw, but GitHub fixes a grant at sign-in: after the owner reconnects with different scopes,
    // the cached header still names the old grant and would keep a fixed gap (the `workflow` row) on the board. The sign-in's
    // current scopes win once they differ from the ones the header was read under; an unreadable sign-in keeps the header.
    if (granted && signInScopes() === grantedFor) return granted;
    return split((o.auth.status().scope ?? "").replace(/\s+/g, ","));
  }

  return {
    connected,
    token: () => token(),
    scopes,
    rest: (method, path, body, opts = {}) => send(method.toUpperCase(), path, body, path === "/graphql" ? "graphql" : "core", Boolean(opts.background), opts.accept, opts.as, opts.etag),
    graphql: async (query, variables, opts = {}) => {
      const res = await send("POST", "/graphql", { query, variables }, "graphql", Boolean(opts.background), undefined, opts.as);
      const body = res.body;
      if (opts.as) return body;
      // A failed answer (a 502 with no `errors`) is not an empty result: a caller would read it as "no items" and drop what it holds.
      if (res.status >= 300) throw new Error(`GitHub GraphQL answered ${res.status}`);
      const org = typeof variables.org === "string" ? variables.org : "";
      // GraphQL answers 200 with the refusal inside `errors`: the same need REST's 403 is. A refusal inside one item's content (an
      // issue of another org) is recorded but leaves the rest of the board readable. The warning stays while refusals keep coming.
      for (const { need, fatal } of graphqlNeeds(body?.errors, org, o.clientId)) {
        if (fatal) fail(need, now());
        problems.set(need.org.toLowerCase(), { org: need.org, cause: need.cause, url: need.url, ...(need.message ? { message: need.message } : {}), at: now() });
      }
      if (org && !(Array.isArray(body?.errors) && body.errors.length)) orgOk([org]);
      return body;
    },
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
      const core = owner.rates.get("core");
      const have = scopes();
      const rate = core ? { remaining: core.remaining, limit: core.limit, reset: new Date(core.reset).toISOString() } : undefined;
      for (const [k, p] of problems) if (p.at !== undefined && now() - p.at > PROBLEM_TTL_MS) problems.delete(k);
      const list = [...problems.values()].map(({ at: _at, ...p }) => p);
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

/**
 * The need a GraphQL `FORBIDDEN` error means: single sign-on (GitHub flags it), or an org that restricts OAuth apps (its message
 * opens "Although you appear to have the correct authorization credentials"; an IP allow list sets its own flag and is no
 * sign-in problem). The org is the one the message names (as REST's classifier reads it), else the one asked about. Any other
 * error is just an error. The full message is kept. `fatal`: the refusal hit the read itself, not one item's `content`.
 */
function graphqlNeeds(errors: unknown, org: string, clientId?: string): { need: Extract<Need, { cause: "sso" | "restricted" }>; fatal: boolean }[] {
  const out: { need: Extract<Need, { cause: "sso" | "restricted" }>; fatal: boolean }[] = [];
  for (const e of Array.isArray(errors) ? errors : []) {
    if (e?.type !== "FORBIDDEN") continue;
    const message = String(e.message ?? "").slice(0, 1000);
    const named = /the [`'"]?([A-Za-z0-9-]+)[`'"]? organization/i.exec(message)?.[1];
    const fatal = !(Array.isArray(e.path) && e.path.includes("content"));
    const who = named ?? (fatal ? org : ""); // an item's own refusal that names no org can't be pinned to the board's
    if (!who) continue;
    if (e.extensions?.saml_failure === true) out.push({ need: { cause: "sso", org: who, url: `https://github.com/orgs/${who}/sso`, message }, fatal });
    else if (e.extensions?.ip_allow_list_failure !== true && /OAuth App|authorization credentials/i.test(message)) out.push({ need: { cause: "restricted", org: who, url: `https://github.com/settings/connections/applications/${clientId ?? ""}`, message }, fatal });
  }
  return out;
}

/** A GraphQL refusal's warning goes when its org has had none for this long: two board reads (a board's items are read hourly). */
const PROBLEM_TTL_MS = 2 * 60 * 60_000;

const RECONNECT = { label: "Reconnect", reconnect: true } as const;

/** The board card's rows from the token's scopes, the orgs that refused it, the fleet org and the rate limit (spec §8). */
function statusLines(have: string[], problems: GitHubStatus["problems"], rate: GitHubStatus["rate"], fleetOrg: string, ci: boolean): StatusLine[] {
  const needs = (label: string, scope: string): StatusLine => (covers(have, scope) ? { label, value: "working", state: "ok" } : { label, value: "needs permission", state: "warn", action: RECONNECT });
  const lines: StatusLine[] = [
    needs("Reads, issues, comments", "repo"),
    needs("Pull requests and merges", "repo"),
    // A push that creates or updates `.github/workflows/` is refused without this grant (GitHub's OAuth workflow scope), and a
    // grant made before the sign-in asked for it keeps its old scopes: the row is how the owner sees the gap before a push.
    needs("Workflow files", "workflow"),
    { label: "Fleet repos", value: fleetOrg ? `in ${fleetOrg}` : "on this server", state: "ok", action: { label: "Change", href: "#/modules/github/settings" } },
    ...(ci ? [needs("CI runners", "admin:org")] : []),
    needs("Projects boards", "project"),
    ...problems.map((p): StatusLine => (p.cause === "sso" ? { label: p.org, value: p.message ? `GitHub needs you to authorize single sign-on: ${p.message.slice(0, 300)}` : "GitHub needs you to authorize single sign-on", state: "warn", action: { label: "Authorize", href: p.url } } : { label: p.org, value: p.message ? `the org restricts OAuth apps: ${p.message.slice(0, 300)}` : "the org restricts OAuth apps", state: "warn", action: { label: "Grant access", href: p.url } })),
  ];
  if (rate) {
    lines.push({ label: "Rate limit", value: `${rate.remaining.toLocaleString("en-US")} of ${rate.limit.toLocaleString("en-US")} left, resets`, time: new Date(rate.reset).toISOString(), state: rate.remaining < rate.limit * 0.2 ? "warn" : "ok" });
  }
  return lines;
}
