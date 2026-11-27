// The one client every GitHub call in this process goes through (docs/design/github-identity.md). Every write names its actor,
// chosen by `actorFor(target, op)`: the instance's GitHub App where it is installed on the target and its installation has
// accepted every permission the op needs (OPS), else the owner's sign-in; nothing else switches it (no fallback on an error or a
// rate limit, and a broken App throws). A write with no actor, or a GraphQL mutation outside MUTATIONS, is refused. Reads go as the
// App where its installation holds the read's permission (readerFor), else as the owner. One rate limiter: a call issued
// interactively (from a tool) fails at once as a typed
// `rate_limited` need when a limit blocks it, because a tool call can't sleep past its timeout; a background call (a job) waits
// while REST or GraphQL is below a 20% reserve. Content-creating writes go one at a time per identity (the owner, or one App
// installation: each has its own limits and queue), at least a second apart, and wait out
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
import { AppError, covers as levelCovers, type GitHubApp, type Installation } from "./github-app.js";

const API = "https://api.github.com";

/**
 * What a write does, and the installation permissions it needs to go as the App (GitHub's "Permissions required for GitHub Apps").
 * `null`: never the App (no permission is asked for it), so always the owner. `push` always needs `workflows`, so who pushes
 * depends on the repo, never on the diff.
 */
export const OPS = {
  push: { contents: "write", workflows: "write" },
  merge: { contents: "write" },
  update_branch: { pull_requests: "write", contents: "write" },
  pr: { pull_requests: "write" },
  dequeue: { pull_requests: "write" },
  issue: { issues: "write" },
  status: { statuses: "write" },
  actions: { actions: "write" },
  actions_read: { actions: "read" },
  contents: { contents: "write" },
  project: { organization_projects: "write" },
  create_repo: null,
  runner_token: null,
} as const satisfies Record<string, Record<string, "read" | "write"> | null>;
export type Op = keyof typeof OPS;
/** Where a write lands: a repository (`owner/name`), or an account (an org's project, repo creation, runner registration). */
export type Target = { repo: string } | { org: string };

/** The GraphQL mutations this process may send, each with the variable that names its target (the write's actor is chosen for it). */
export const MUTATIONS = {
  /** target: input.branch.repositoryNameWithOwner */
  CREATE_COMMIT: `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }`,
  /** target: input.repositoryId (a ref update bound to its current sha; an all-zero afterOid deletes it) */
  UPDATE_REFS: `mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`,
  /** target: the PR `id` */
  DEQUEUE: `mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { state } } }`,
  /** target: the org project `project` */
  ADD_PROJECT_ITEM: `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
  /** target: the org project `project` */
  SET_PROJECT_FIELD: `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
} as const;
export type Mutation = keyof typeof MUTATIONS;
/** The most review threads one RESOLVE_THREAD request resolves. */
export const RESOLVE_MAX = 100;
/** RESOLVE_THREAD for `n` threads (target: the threads' PR): aliased mutations `t0..t<n-1>`, each with its own `$t<i>`. */
export const resolveThreadsDoc = (n: number) => `mutation(${Array.from({ length: n }, (_, i) => `$t${i}: ID!`).join(", ")}) { ${Array.from({ length: n }, (_, i) => `t${i}: resolveReviewThread(input: { threadId: $t${i} }) { thread { id isResolved } }`).join(" ")} }`;
const REGISTERED = new Set<string>([...Object.values(MUTATIONS), ...Array.from({ length: RESOLVE_MAX }, (_, i) => resolveThreadsDoc(i + 1))]);

export type Need =
  | { cause: "not_connected" }
  | { cause: "expired" }
  | { cause: "scope"; scope: string }
  | { cause: "sso"; org: string; url: string; /** GitHub's own words, in full, when it gave them (a GraphQL refusal). */ message?: string }
  | { cause: "restricted"; org: string; url: string; message?: string }
  | { cause: "unreachable"; repo: string }
  | { cause: "rate_limited"; until: string; /** GitHub itself refused the request (not this process's reserve). */ by?: "github" }
  | { cause: "write_busy" }
  /** The App is set up but doesn't work (its saved files, its key, a suspension, GitHub's refusal or outage). Never the owner instead. */
  | { cause: "app_broken"; detail: string }
  /** GitHub refused the App a call its installation's accepted permissions should allow: the installation is read again next time. */
  | { cause: "app_refused"; target: string; message: string };

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
    case "app_broken": return `AidenHQ's GitHub App isn't working (${n.detail}): replace it on its setup page (/setup/github-app)`;
    case "app_refused": return `GitHub refused AidenHQ's GitHub App on ${n.target} (${n.message}): its installation is read again, and the next attempt chooses again`;
  }
}

/** The plain error word a tool or route answers for a need nobody can fix by signing in. */
export const needError = (n: Need) => (n.cause === "rate_limited" ? "github_rate_limited" : n.cause === "write_busy" ? "github_write_busy" : n.cause === "app_broken" ? "github_app_broken" : n.cause === "app_refused" ? "github_app_refused" : "github_unreachable");

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
  if (n.cause === "unreachable" || n.cause === "rate_limited" || n.cause === "write_busy" || n.cause === "app_broken" || n.cause === "app_refused") {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: needError(n), need: n, detail: e.message }) }] };
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

/** An App installation's calls (inside this module): its own token, pacing and rate limits; never the sign-in's state. */
type Identity = {
  key: string;
  token(fresh?: boolean): Promise<string>;
  /** The repo or account its installation was looked up for: evicted when GitHub refuses it a permission. */
  target: string;
  /** Each call as it was answered: a refusal (its words) or a success (undefined), so the card sees when it stops working. */
  wrote?(refusal?: string): void;
};
type Rest = (method: string, path: string, body?: unknown, o?: Omit<CallOpts, "actor">) => Promise<{ status: number; body: any; headers: Headers }>;
/**
 * Who one write attempt goes as (actorFor): every call of the attempt (the reads that decide it, the git token, the mutation and
 * the reads after it) goes through it, so the attempt never changes identity part-way.
 */
export type Actor = {
  kind: "app" | "owner";
  /** The pacing key: `owner`, or `app:<installation id>`. */
  key: string;
  /** The App's bot user id (GitHub's `user.id` on what it writes); the owner has none here. */
  botId?: number;
  /** Its login and git identity: the owner's account, or the App's bot (`<slug>[bot]`). */
  identity(): Promise<{ login: string; name: string; email: string }>;
  rest: Rest;
  /** The whole GraphQL answer ({data, errors}); a mutation must be one of MUTATIONS. */
  graphql(query: string, variables: Record<string, unknown>, o?: { background?: boolean }): Promise<any>;
  /** A registered mutation (MUTATIONS) by name, answered as REST answers (status and the whole GraphQL body). */
  mutate(name: Mutation, variables: Record<string, unknown>): Promise<{ status: number; body: any; headers: Headers }>;
  /** A token for one git child's env here (never returned by any route). */
  gitToken(): Promise<string>;
};
type CallOpts = {
  background?: boolean; accept?: string;
  /** Who the call goes as; required for a write (a write with none is refused). */
  actor?: Actor;
  /** A conditional read with the caller's own ETag (the change feed keeps its own): a 304 is answered as the 304. Every other GET
   * goes through the shared ETag cache instead (`cached`), which answers an unchanged read from the body it kept. */
  etag?: string;
  /** Who is calling, for the hourly count of calls by caller and status (the change feed, the sync, …). The change feed ("feed")
   * skips the background reserve down to a small floor: its 304s are free and its 200s are the changes every consumer needs. */
  caller?: string;
  /** The latest this call may spend waiting out a rate limit (a read) or waiting out a quota before its write is retried.
   * Past it the call refuses at once as a typed rate_limited need instead of sleeping until the reset, which is what a
   * background scan wants for work it can defer to its next pass. On a read it bounds the wait, not the request: a read that
   * starts at the deadline still gets its own attempt timeout. A write that cannot see its attempt through inside it fails
   * (a write must never land after its caller was told it failed). */
  deadline?: number;
  /** The owner's own sign-in, never the App: a read that probes what the owner's credential reaches (a failed git fetch's cause). */
  owner?: true;
};

/** The instance's optional GitHub App as this client uses it (github-app.ts). */
export type AppSource = Pick<GitHubApp, "installed" | "installedOn" | "evict" | "token" | "identity" | "wrote">;

export interface GitHubAccess {
  connected(): boolean;
  identity(): Promise<{ login: string; name: string; email: string }>;
  /** The owner's token, for git children inside this process only (a fetch; a push takes its actor's gitToken). */
  token(): Promise<string>;
  /** The one chooser: the App where installed on `target` with every permission `op` needs, else the owner. A broken App throws. */
  actorFor(target: Target, op: Op): Promise<Actor>;
  /** The actor a pacing key names (an async merge request read back as the identity that made it). */
  actorByKey(key: string): Promise<Actor>;
  /** A read (as the App where it can, else the owner), or a write as `actor`, which a write must name. */
  rest(method: string, path: string, body?: unknown, o?: CallOpts): Promise<{ status: number; body: any; headers: Headers }>;
  /** The whole GraphQL answer ({data, errors}): a query; a mutation goes through an actor. */
  graphql(query: string, variables: Record<string, unknown>, o?: { background?: boolean; actor?: Actor }): Promise<any>;
  scopes(): string[];
  status(): GitHubStatus;
  /** Calls `fn` after each content-creating write this process sends (any identity): the change feed reads that repo again soon. */
  onWrite(fn: (method: string, path: string) => void): void;
  /** Runs `fn` with every GitHub call it makes counted under `caller` in the hourly count (a call's own `caller` wins). */
  withCaller<T>(caller: string, fn: () => T): T;
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
/** A repo-scoped path: the repo and the rest of the path (no query). */
const inRepo = (path: string) => /^\/repos\/([\w.-]+)\/([\w.-]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(path);
/**
 * The installation permission a repo read needs, by the path after `/repos/o/r` (GitHub's per-endpoint permission tables); none: a
 * path not listed here, which the owner reads. An installation without the permission would not see the read at all, or (an issue
 * list without `issues`) would see a filtered list, so a read goes as the App only where the installation holds it.
 */
const PERMISSIONS: [RegExp, string][] = [
  [/^$/, "metadata"],
  [/^\/collaborators\//, "metadata"],
  [/^\/actions\//, "actions"],
  [/^(?:\/commits\/[^/]+)?\/check-(?:runs|suites)\b/, "checks"],
  [/^\/commits\/[^/]+\/(?:status|statuses)$/, "statuses"],
  [/^\/pulls\b/, "pull_requests"],
  [/^\/(?:issues|labels|milestones)\b/, "issues"],
  [/^\/(?:contents|git|commits|compare|branches|readme|tags|releases)\b/, "contents"],
];
const permissionOf = (rest: string) => PERMISSIONS.find(([re]) => re.test(rest))?.[1];
/** GitHub's words for a call its installation's permissions don't allow. */
const NOT_ACCESSIBLE = /not accessible by integration/i;
/** The shared ETag cache's bounds: its whole size, and the largest answer it keeps. */
const CACHE_BYTES = 32 * 1024 * 1024, CACHE_ENTRY_BYTES = 1024 * 1024;
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

/** The change feed's reads stop only this close to empty (the rest of the reserve is theirs). */
const FEED_FLOOR = 100;
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
const invocation = new AsyncLocalStorage<{ deadline: number; owner: boolean }>();
/** Who the calls in this async context are for (the hourly count's caller): a tool, a route, a loop. */
const callers = new AsyncLocalStorage<string>();

/** Runs `fn` as one tool invocation (main.ts's tool wrapper): every write it makes shares one 240 s budget, fixed when the
 * invocation starts, so a preflight read and a second write both spend that same budget and no write is sent after it. */
export function withWriteBudget<T>(fn: () => Promise<T>, at: () => number = Date.now): Promise<T> {
  return invocation.run({ deadline: at() + WRITE_BUDGET_MS, owner: false }, fn);
}
/** Runs `fn` as one tool invocation (withWriteBudget) and says whether the owner's sign-in answered any of its calls: a tool
 * whose every read the App served proves nothing about the sign-in, so it must not mark it working. */
export async function withOwnerTrace<T>(fn: () => Promise<T>, at: () => number = Date.now): Promise<{ value: T; owner: boolean }> {
  const store = { deadline: at() + WRITE_BUDGET_MS, owner: false };
  const value = await invocation.run(store, fn);
  return { value, owner: store.owner };
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
  /** The owner's GraphQL org query answered with no errors: the org's sso/restricted need is the owner's fix made. */
  onOrgOk?: (org: string) => void;
  /** The instance's optional GitHub App: writes go as it where actorFor picks it, repo reads where `readerFor` can. */
  app?: AppSource;
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
  /** `at`: when a GraphQL refusal last came (those warnings expire, see PROBLEM_TTL_MS); an org's GraphQL answer that works clears it. */
  const problems = new Map<string, { org: string; cause: "sso" | "restricted"; url: string; message?: string; at?: number }>();
  let me: { login: string; name: string; email: string; for: string } | undefined;

  const connected = () => o.auth.signedIn() && o.auth.status().state !== "expired";

  /** An org's GraphQL answer came back with no errors: the restriction is lifted, so the card's warning and the kernel's row go. */
  const orgOk = (org: string) => {
    problems.delete(org.toLowerCase());
    try { o.onOrgOk?.(org); } catch { /* a report never breaks the call it reports */ }
  };

  async function token(): Promise<string> {
    if (!o.auth.signedIn()) fail({ cause: "not_connected" });
    if (o.auth.status().state === "expired") fail({ cause: "expired" }); // the sign-in heals itself when GitHub answers the token again
    const t = String((await o.auth.headers()).authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!t) fail({ cause: "not_connected" });
    return t;
  }

  function fail(n: Need, refusedAt?: number): never {
    if (n.cause === "sso" || n.cause === "restricted") {
      problems.set(n.org.toLowerCase(), { org: n.org, cause: n.cause, url: n.url, ...(n.message ? { message: n.message } : {}), ...(refusedAt ? { at: refusedAt } : {}) });
    }
    throw new GitHubNeed(n, (n.cause === "sso" || n.cause === "restricted") && n.message ? `${needText(n)}. GitHub said: ${n.message}` : undefined);
  }

  /** Waits out a rate-limit refusal (background), or refuses (interactive: a tool call can't sleep past its timeout).
   * A background call sleeps on the reserve and on a refusal alike, but only where a write can still see its attempt through
   * inside its budget; anything it cannot wait out is the same typed need as an interactive call's. A read's `deadline` bounds
   * the wait itself (`read`), never the attempt: a read that starts just before it still gets its own fetch timeout. */
  async function admit(p: Pace, resource: string, background: boolean, deadline?: number, read = false, feed = false): Promise<void> {
    for (;;) {
      const t = now();
      const r = p.rates.get(resource);
      const low = r && r.limit > 0 && r.remaining < (feed ? Math.min(FEED_FLOOR, r.limit * reserve) : r.limit * reserve) && r.reset > t ? r.reset : 0;
      const until = Math.max(p.blockedUntil > t ? p.blockedUntil : 0, background ? low : 0);
      if (!until) return;
      const canWait = read ? deadline === undefined || until <= deadline : fits(deadline, until);
      if (!background || (deadline !== undefined && !canWait)) fail({ cause: "rate_limited", until: new Date(until).toISOString() });
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

  function send(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, as?: Identity, etag?: string, readDeadline?: number, caller?: string, ownerOnly = false) {
    const p = paceOf(as);
    if (!createsContent(method, path, body)) return read(method, path, body, resource, background, accept, as, etag, readDeadline, caller, ownerOnly);
    // One budget for the tool invocation this write belongs to, fixed at its entry so preflight reads and earlier writes
    // have already spent it (and before the queue: a write that waited behind others has spent that wait too); outside a
    // tool call, each write gets its own. A background write (a job's, never a tool's) is not on a caller's clock: it keeps
    // the patience it always had and waits a limit out, inside the queue like every other write — unless its caller gave one
    // (a recovery write that must not hold the scan), which bounds that wait the same way a tool's budget does.
    const deadline = readDeadline ?? (background ? undefined : invocation.getStore()?.deadline ?? now() + WRITE_BUDGET_MS);
    return queued(p, deadline, () => paced(p, deadline, () => attempt(p, method, path, body, resource, background, accept, deadline, as, false, undefined, caller)));
  }

  /** An App answer as a typed need: a broken App is `app_broken`, never a reason to call as the owner instead. */
  const appCall = async <T>(go: () => Promise<T>): Promise<T> => {
    try { return await go(); } catch (e) { if (e instanceof AppError) fail({ cause: "app_broken", detail: e.message }); throw e; }
  };
  /** An installation's identity for this client's calls (its own pacing key and token). */
  const installationOf = (app: AppSource, inst: Installation, target: string): Identity => ({ key: `app:${inst.id}`, target, token: (fresh) => app.token(inst.id, fresh), wrote: (refusal) => app.wrote(refusal) });

  /**
   * Who reads a repo when the caller named nobody: the App's installation where the App is installed on the repo and its
   * installation holds the permission the read needs (PERMISSIONS), else the owner (undefined). REST only: GraphQL reads stay the
   * owner's unless an actor makes them. A broken App throws (app_broken), and a read GitHub refuses the App is `app_refused`.
   */
  async function readerFor(method: string, path: string): Promise<Identity | undefined> {
    if (!o.app || method !== "GET") return undefined;
    const m = inRepo(path);
    const permission = m && permissionOf(m[3] ?? "");
    if (!m || !permission || [m[1], m[2]].some((x) => /^\.+$/.test(x!))) return undefined;
    const r = `${m[1]}/${m[2]}`.toLowerCase();
    const app = o.app;
    const inst = await appCall(() => app.installed(r));
    if (!inst || !levelCovers(inst.permissions[permission], "read")) return undefined;
    return installationOf(app, inst, r);
  }

  /** A read, as the caller's identity (an actor's), else as the App where it can (readerFor), else as the owner. */
  async function read(method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, as?: Identity, etag?: string, deadline?: number, caller?: string, ownerOnly = false) {
    const who = as ?? (ownerOnly ? undefined : await readerFor(method, path));
    return cached(method, path, body, resource, background, accept, who, etag, deadline, caller);
  }

  /** The owner's sign-in as an actor. */
  const ownerActor: Actor = {
    kind: "owner", key: "owner",
    identity: () => identity(),
    rest: (method, path, body, opts = {}) => restAs(undefined, method, path, body, opts),
    graphql: (query, variables, opts = {}) => graphqlAs(undefined, query, variables, opts),
    mutate: (name, variables) => restAs(undefined, "POST", "/graphql", { query: MUTATIONS[name], variables }, {}),
    gitToken: () => token(),
  };
  const appActor = async (app: AppSource, inst: Installation, target: string): Promise<Actor> => {
    const id = installationOf(app, inst, target);
    const bot = await appCall(() => app.identity());
    if (!bot) fail({ cause: "app_broken", detail: "the GitHub App's identity couldn't be read" });
    return {
      kind: "app", key: id.key, botId: bot.botId,
      identity: async () => ({ login: bot.login, name: bot.login, email: `${bot.botId}+${bot.login}@users.noreply.github.com` }),
      rest: (method, path, body, opts = {}) => restAs(id, method, path, body, opts),
      graphql: (query, variables, opts = {}) => graphqlAs(id, query, variables, opts),
      mutate: (name, variables) => restAs(id, "POST", "/graphql", { query: MUTATIONS[name], variables }, {}),
      gitToken: () => appCall(() => app.token(inst.id)),
    };
  };
  /** The one chooser (docs/design/github-identity.md): the App iff set up, installed on `target`, and every permission `op` needs accepted. */
  async function actorFor(target: Target, op: Op): Promise<Actor> {
    const needs = OPS[op];
    const app = o.app;
    if (!app || !needs) return ownerActor;
    const at = "repo" in target ? target.repo.toLowerCase() : target.org.toLowerCase();
    const inst = await appCall(() => ("repo" in target ? app.installed(target.repo) : app.installedOn(target.org)));
    if (!inst || !Object.entries(needs).every(([p, level]) => levelCovers(inst.permissions[p], level))) return ownerActor;
    return appActor(app, inst, at);
  }
  async function actorByKey(key: string): Promise<Actor> {
    const m = /^app:([0-9]{1,12})$/.exec(key);
    if (!m) return ownerActor;
    if (!o.app) fail({ cause: "app_broken", detail: "the GitHub App that made this request isn't set up any more" });
    return appActor(o.app, { id: Number(m[1]), permissions: {}, html_url: "", account: "" }, "");
  }

  /** The shared ETag cache, least recently used first: per identity (the owner's per sign-in), accept header and path. */
  const etags = new Map<string, { etag: string; status: number; text: string }>();
  let etagBytes = 0;
  const forget = (k: string) => { const e = etags.get(k); if (e) { etagBytes -= e.text.length; etags.delete(k); } };
  /**
   * A GET through the shared ETag cache: sent with the ETag of the answer kept for it, and a 304 (free of the rate limit) answers
   * with that kept body (parsed afresh, so no caller shares an object). A call with its own `etag` (the change feed's) bypasses it.
   */
  async function cached(method: string, path: string, body: unknown, resource: string, background: boolean, accept: string | undefined, as: Identity | undefined, etag: string | undefined, deadline: number | undefined, caller: string | undefined) {
    const p = paceOf(as);
    if (method !== "GET" || etag !== undefined) return attempt(p, method, path, body, resource, background, accept, deadline, as, false, etag, caller);
    const key = `${as?.key ?? `owner#${o.auth.signInCount?.() ?? 0}`} ${accept ?? ""} ${path}`;
    const hit = etags.get(key);
    const r = await attempt(p, method, path, body, resource, background, accept, deadline, as, false, hit?.etag, caller);
    if (r.status === 304 && hit) {
      // Most recently used, unless another read replaced or evicted it meanwhile (that one's answer stands).
      if (etags.get(key) === hit) { etags.delete(key); etags.set(key, hit); }
      return { status: hit.status, body: JSON.parse(hit.text), headers: r.headers };
    }
    forget(key);
    const tag = r.headers.get("etag");
    if (r.status === 200 && tag) {
      const text = JSON.stringify(r.body ?? null);
      if (text.length <= CACHE_ENTRY_BYTES) {
        etags.set(key, { etag: tag, status: r.status, text });
        etagBytes += text.length;
        for (const k of etags.keys()) { if (etagBytes <= CACHE_BYTES) break; forget(k); }
      }
    }
    return r;
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

  const writeListeners: ((method: string, path: string) => void)[] = [];
  /** Calls answered this hour, by caller, identity, resource (GraphQL and search have their own limits) and status ("feed owner
   * 304"; a 304 is free), logged as the hour turns with the owner's REST limit left: what each reader really costs. */
  let calls = { at: now(), n: new Map<string, number>() };
  const count = (caller: string | undefined, as: Identity | undefined, resource: string, status: number) => {
    if (now() - calls.at >= 3_600_000) {
      const core = owner.rates.get("core");
      if (calls.n.size) o.log?.("github calls this hour", { since: new Date(calls.at).toISOString(), calls: Object.fromEntries([...calls.n].sort((a, b) => b[1] - a[1])), ...(core ? { owner_core_left: core.remaining, owner_core_limit: core.limit } : {}) });
      calls = { at: now(), n: new Map() };
    }
    const k = `${caller ?? callers.getStore() ?? "other"} ${as ? "app" : "owner"}${resource === "core" ? "" : ` ${resource}`} ${status}`;
    calls.n.set(k, (calls.n.get(k) ?? 0) + 1);
  };

  async function attempt(p: Pace, method: string, path: string, body: unknown, resource: string, background: boolean, accept?: string, deadline?: number, as?: Identity, retried = false, etag?: string, caller?: string, since?: number): Promise<{ status: number; body: any; headers: Headers }> {
    // Only the path asked for: a `.` or `..` segment (encodeURIComponent leaves them) would move the request elsewhere.
    if (!path.startsWith("/") || new URL(path, API).pathname !== path.split("?")[0]) throw new Error(`refused a GitHub path that resolves elsewhere: ${path.slice(0, 200)}`);
    // A read's `deadline` bounds only its rate-limit wait (admit): the attempt that follows has its own timeout, and a read
    // creates nothing, so nothing lands after a caller was told it failed.
    const read = !createsContent(method, path, body);
    await admit(p, resource, background, deadline, read, caller === "feed");
    // The sign-in this request belongs to: a 401 is retried only within it (see `replaced` below). A retry keeps the count its
    // first attempt captured, so a sign-in that lands between the two is not mistaken for the same one.
    const signedInAt = as ? undefined : (since ?? o.auth.signInCount?.());
    const t = as ? await as.token(retried) : await token();
    // The sign-in the request goes out under, kept for the header it may answer with (see `observe`).
    const sentFor = signInScopes();
    // Never a fetch once the write's budget has run out: nothing lands after the caller was told it failed.
    if (!read && deadline !== undefined && !fits(deadline)) noBudget(p);
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
      for (const fn of writeListeners) { try { fn(method, path); } catch { /* a listener never breaks the write */ } }
      o.log?.("github write", { identity: as ? "app" : "owner", key: as?.key ?? "owner", method, path: path.replace(/[0-9a-f]{40}/g, ":sha").replace(/\/[0-9]+/g, "/:n").split("?")[0], status: res.status, writes_this_hour: p.hour.writes });
    }
    observe(p, res, sentFor);
    count(caller, as, resource, res.status);
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a non-JSON answer (a diff, a log) stays text */ }
    // Another identity's token GitHub refused (revoked, or the installation changed): once more with a new token.
    if (as && res.status === 401 && !retried) return attempt(p, method, path, body, resource, background, accept, deadline, as, true, etag, caller);
    // The owner's 401 is a refusal only when GitHub refuses the token itself: a stray 401 (another resource, a blip) is an answer.
    let stray = false;
    if (!as && res.status === 401) {
      // Another call (or a refresh) replaced the token this one was sent with: its 401 is the old token's, so send again with the
      // new one. Only within the same sign-in: a different account's sign-in is a new identity, and resending would return its
      // private data to the caller who asked under the old one, so the request fails instead.
      const replaced = async () => {
        if (signedInAt !== undefined && o.auth.signInCount?.() !== signedInAt) return false;
        const now = String((await o.auth.headers().catch(() => ({}) as Record<string, string>)).authorization ?? "").replace(/^Bearer\s+/i, "");
        return now !== "" && now !== t;
      };
      const again = () => attempt(p, method, path, body, resource, background, accept, deadline, as, true, etag, caller, signedInAt);
      // Replaced while the probe was out: its verdict is on the old token, so the saved one is left alone.
      const replacedNow = async () => {
        if (!(await replaced())) return false;
        if (!retried) return true;
        stray = true;
        o.log?.("github 401 on a token another call replaced; sign-in kept", { method, path: path.replace(/\/[0-9]+/g, "/:n").split("?")[0] });
        return false;
      };
      if (await replacedNow()) return again();
      const refusedNow = o.auth.refused ? await o.auth.refused() : true;
      if (await replacedNow()) return again();
      if (!refusedNow) {
        stray = true;
        o.log?.("github 401 on a token GitHub still accepts; sign-in kept", { method, path: path.replace(/\/[0-9]+/g, "/:n").split("?")[0] });
      } else if (!retried) {
        // A different account signed in while this request ran: its answer belongs to the owner who asked, so it is not refreshed
        // or resent under the new account. The 401 is the old sign-in's, and nothing about the saved one is decided here.
        if (signedInAt !== undefined && o.auth.signInCount?.() !== signedInAt) {
          stray = true;
          o.log?.("github 401 on a token a different sign-in replaced; not retried", { method, path: path.replace(/\/[0-9]+/g, "/:n").split("?")[0] });
        } else {
          // A token that ran out: refresh once and send again. A refusal marks the sign-in expired inside the refresh; any other
          // failure (the token endpoint's 5xx) is passed on as it is, so the next call tries again and nothing is marked.
          try { await o.auth.refresh(); } catch (err) {
            if (o.auth.status().state !== "expired") throw err;
          }
          // A different account signed in while the refresh ran: the retry would go out under it, and its answer (private data
          // included) would reach the caller who asked under the old one, so the 401 stays the answer instead.
          if (signedInAt !== undefined && o.auth.signInCount?.() !== signedInAt) {
            stray = true;
            o.log?.("github 401 on a sign-in a refresh replaced; not retried", { method, path: path.replace(/\/[0-9]+/g, "/:n").split("?")[0] });
          } else return again();
        }
      }
    }
    const need = classify(p, path, res, parsed, Boolean(as) || stray);
    if (need?.cause === "rate_limited") need.by = "github";
    if (need?.cause === "expired") o.auth.mark("expired", "GitHub refused the token (401)");
    if (need) fail(need);
    if (as) {
      // Its writes' answers are its health (a permission the installation hasn't granted is a 403 here, not at the token).
      if (createsContent(method, path, body) && (res.ok || res.status === 401 || res.status === 403)) as.wrote?.(res.ok ? undefined : `GitHub refused ${method} ${path.split("?")[0]!.replace(/[0-9a-f]{40}/g, ":sha")}: ${res.status} ${String(parsed?.message ?? "").slice(0, 120)}`);
      // A permission its installation's answer said it holds, refused: the installation is read again next time, and this attempt
      // fails as itself (never sent again as the owner).
      if (res.status === 403 && NOT_ACCESSIBLE.test(String(parsed?.message ?? ""))) refusedApp(as, String(parsed?.message ?? ""));
      const forbidden = path === "/graphql" && Array.isArray(parsed?.errors) ? parsed.errors.find((e: { type?: unknown; message?: unknown }) => e?.type === "FORBIDDEN" && NOT_ACCESSIBLE.test(String(e.message ?? ""))) : undefined;
      if (forbidden) refusedApp(as, String(forbidden.message));
      return { status: res.status, body: parsed, headers: res.headers };
    }
    if (res.ok) o.auth.mark("ok"); // the sign-in's state starts "unknown" after every restart; a call that worked settles it
    // This tool invocation's own sign-in answered (withOwnerTrace): what lets the tool say the sign-in works.
    const inv = invocation.getStore();
    if (inv && (res.ok || res.status === 304)) inv.owner = true;
    return { status: res.status, body: parsed, headers: res.headers };
  }

  function refusedApp(as: Identity, message: string): never {
    if (as.target) o.app?.evict(as.target);
    o.log?.("github refused the App", { key: as.key, target: as.target, said: message.slice(0, 200) });
    fail({ cause: "app_refused", target: as.target || as.key, message: message.slice(0, 200) });
  }

  /** A REST call as `as` (an App installation) or the owner (undefined). */
  function restAs(as: Identity | undefined, method: string, path: string, body: unknown, opts: Omit<CallOpts, "actor">) {
    const m = method.toUpperCase();
    if (path === "/graphql") registered(body);
    return send(m, path, body, path === "/graphql" ? "graphql" : path.startsWith("/search/") ? "search" : "core", Boolean(opts.background), opts.accept, as, opts.etag, opts.deadline, opts.caller, opts.owner === true);
  }
  /** A mutation must be one of MUTATIONS: anything else is refused before it leaves the process. */
  function registered(body: unknown) {
    const q = String((body as { query?: unknown } | undefined)?.query ?? "");
    if (/^\s*mutation\b/.test(q) && !REGISTERED.has(q)) throw new Error("refused a GraphQL mutation that isn't one of the registered ones (client.ts MUTATIONS)");
  }
  async function graphqlAs(as: Identity | undefined, query: string, variables: Record<string, unknown>, opts: { background?: boolean }) {
    registered({ query });
    const res = await send("POST", "/graphql", { query, variables }, "graphql", Boolean(opts.background), undefined, as);
    const body = res.body;
    // A failed answer (a 502 with no `errors`) is not an empty result: a caller would read it as "no items" and drop what it holds.
    if (res.status >= 300) throw new Error(`GitHub GraphQL answered ${res.status}`);
    // The App's refusals (attempt: a FORBIDDEN "not accessible by integration" is the REST 403's) are thrown already.
    if (as) return body;
    const org = typeof variables.org === "string" ? variables.org : "";
    // GraphQL answers 200 with the refusal inside `errors`: the same need REST's 403 is. A refusal inside one item's content (an
    // issue of another org) is recorded but leaves the rest of the board readable. The warning stays while refusals keep coming.
    for (const { need, fatal } of graphqlNeeds(body?.errors, org, o.clientId)) {
      if (fatal) fail(need, now());
      problems.set(need.org.toLowerCase(), { org: need.org, cause: need.cause, url: need.url, ...(need.message ? { message: need.message } : {}), at: now() });
    }
    // The org query is what an org's restriction blocks (a search or a public read answers anyway), so its answer with no
    // errors is the one that says the org is reachable again. `partial-results` still means the org's SSO filtered it.
    if (org && !(Array.isArray(body?.errors) && body.errors.length) && !/^partial-results/i.test(res.headers.get("x-github-sso") ?? "")) orgOk(org);
    return body;
  }
  async function identity(): Promise<{ login: string; name: string; email: string }> {
    const t = await token();
    if (me?.for === t) return { login: me.login, name: me.name, email: me.email };
    const r = await send("GET", "/user", undefined, "core", false);
    if (r.status !== 200) throw new Error(`couldn't read the signed-in GitHub account (GitHub said ${r.status})`);
    const login = String(r.body.login);
    me = { login, name: String(r.body.name || login), email: `${r.body.id}+${login}@users.noreply.github.com`, for: t };
    return { login: me.login, name: me.name, email: me.email };
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
    onWrite: (fn) => void writeListeners.push(fn),
    withCaller: (caller, fn) => callers.run(caller, fn),
    token: () => token(),
    scopes,
    actorFor,
    actorByKey,
    rest: (method, path, body, opts = {}) => {
      const { actor, ...rest } = opts;
      if (actor) return actor.rest(method, path, body, rest);
      // A write names its actor (actorFor): never a silent owner write.
      if (createsContent(method.toUpperCase(), path, body)) throw new Error(`a GitHub write names no actor: ${method.toUpperCase()} ${path.split("?")[0]}`);
      return restAs(undefined, method, path, body, rest);
    },
    graphql: (query, variables, opts = {}) => {
      if (opts.actor) return opts.actor.graphql(query, variables, { background: opts.background });
      if (/^\s*mutation\b/.test(query)) throw new Error("a GitHub mutation names no actor");
      return graphqlAs(undefined, query, variables, opts);
    },
    identity,
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
    { label: "Fleet repos", value: fleetOrg ? `in ${fleetOrg}` : "on this server", state: "ok", action: { label: "Change", href: "#/team/modules/github/settings" } },
    ...(ci ? [needs("CI runners", "admin:org")] : []),
    needs("Projects boards", "project"),
    ...problems.map((p): StatusLine => (p.cause === "sso" ? { label: p.org, value: p.message ? `GitHub needs you to authorize single sign-on: ${p.message.slice(0, 300)}` : "GitHub needs you to authorize single sign-on", state: "warn", action: { label: "Authorize", href: p.url } } : { label: p.org, value: p.message ? `the org restricts OAuth apps: ${p.message.slice(0, 300)}` : "the org restricts OAuth apps", state: "warn", action: { label: "Grant access", href: p.url } })),
  ];
  if (rate) {
    lines.push({ label: "Rate limit", value: `${rate.remaining.toLocaleString("en-US")} of ${rate.limit.toLocaleString("en-US")} left, resets`, time: new Date(rate.reset).toISOString(), state: rate.remaining < rate.limit * 0.2 ? "warn" : "ok" });
  }
  return lines;
}
