// GitHub REST client for AidenHQ's GitHub tools, as the owner (the one sign-in, client.ts), which can do anything the owner
// can (push, delete branches, change settings). The only thing standing between that sign-in and these requests is `guard`:
// every request goes through it, and it allows a fixed list of read endpoints plus the writes an agent asks for: a comment on
// an issue or pull request, a new issue, and adding that issue to an organization project with a status, through the GraphQL
// documents fixed in `GRAPHQL`; and closing or reopening an issue, its labels and assignees, a comment review on a pull
// request (never an approval: an agent's review mustn't count as the owner's), and re-running failed CI jobs. Text it posts
// ends with the AidenHQ footer naming the agent. Which repos a write may touch is the AI reviewer's call on each record, plus
// what the owner's account can reach. Never add a route or a GraphQL document without checking what it does.

import { hasFooter, withFooter } from "./aidenhq-sdk/attribution.js";
import { CLOSED_EVENT_SELECTION, closedBy } from "./aidenhq-sdk/closed-event.js";
import { GitHubNeed, type GitHubAccess, type Identity } from "./client.js";

const API = "https://api.github.com";
const NAME = "[A-Za-z0-9_.-]{1,100}";
const NUM = "[1-9][0-9]{0,9}";
const RUN = "[1-9][0-9]{0,15}";
/** A label name in a path, percent-encoded: no slashes. */
const LABEL = "[^/]{1,300}";

/** Requests the token may make. Anything else is refused before it leaves the process. */
export const ROUTES: { method: Method; path: RegExp }[] = [
  { method: "GET", path: /^\/user$/ },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}$`) },
  // Code review's watcher reads (code-review-read.ts): the open PRs, the PR conversation comments since a time, a login's permission.
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/comments$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/collaborators/${NAME}/permission$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/compare/[0-9a-f]{40}\\.\\.\\.[0-9a-f]{40}$`) },
  { method: "GET", path: /^\/user\/repos$/ },
  // A PR's true merge base (code-review-read.ts mergeBase): its base branch's tip, or a merge commit's first parent.
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/branches/${LABEL}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/commits/[0-9a-f]{40}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },
  // A review's own line comments (review-post.ts records their ids).
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews/${RUN}/comments$`) },
  // One review comment by id (repository-scoped, as GitHub documents it): whether it is on a pull request, and (a reply)
  // which comment it answers.
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/comments/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/files$`) },
  // A PR's commits (code-review-read.ts messages: the agents its trailers name).
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/commits$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/commits/[0-9a-f]{40}/status$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/commits/[0-9a-f]{40}/check-runs$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/labels$`) },
  { method: "GET", path: /^\/search\/issues$/ },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/jobs/${RUN}/logs$`) },
  // The writes, in the user's allowed organizations: a comment, a new issue, and GraphQL,
  // which `guard` limits to the documents in GRAPHQL.
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues$`) },
  { method: "POST", path: /^\/graphql$/ },
  // Close or reopen an issue (`guard` allows only state fields in the body), add or remove
  // labels and assignees, review a pull request, re-run a workflow run's failed jobs.
  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels$`) },
  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels/${LABEL}$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },
  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },
  // Code review's posting (review-post.ts): the acknowledgement comment edited in place, a review's summary updated with its
  // threads' links, a file comment for a finding on a file without diff lines, and the one commit status it mirrors its verdict to.
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/comments/${NUM}$`) },
  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/comments/${NUM}$`) },
  { method: "PUT", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews/${RUN}$`) },
  // An agent's reply on a review thread (github_pr_thread_reply): how a finding is answered (fixed / disputed …).
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/comments/${NUM}/replies$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/comments$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/statuses/[0-9a-f]{40}$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}/rerun-failed-jobs$`) },
];

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Body fields each write may carry: an issue edit can only change its state and text, a review only its verdict and text. */
const BODY_FIELDS: { path: RegExp; method: Method; fields: string[] }[] = [
  { method: "PATCH", path: /\/issues\/[0-9]+$/, fields: ["state", "state_reason", "body"] },
  { method: "POST", path: /\/pulls\/[0-9]+\/reviews$/, fields: ["event", "body", "commit_id", "comments"] },
  { method: "PATCH", path: /\/issues\/comments\/[0-9]+$/, fields: ["body"] },
  { method: "PUT", path: /\/pulls\/[0-9]+\/reviews\/[0-9]+$/, fields: ["body"] },
  { method: "POST", path: /\/comments\/[0-9]+\/replies$/, fields: ["body"] },
  { method: "POST", path: /\/pulls\/[0-9]+\/comments$/, fields: ["commit_id", "path", "subject_type", "body"] },
  { method: "POST", path: /\/statuses\/[0-9a-f]{40}$/, fields: ["state", "context", "description", "target_url"] },
];
/** The one commit status context the token may set (code review's verdict mirror, review-post.ts). */
const STATUS = "aidenhq/review";
const COMMENT_FIELDS = ["path", "line", "side", "start_line", "start_side", "body"];

/** The only GraphQL the token may send: read an organization project, add an issue to it, set its status. */
export const GRAPHQL = {
  project: `query($org: String!, $number: Int!) { organization(login: $org) { projectV2(number: $number) { id title url closed field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } items(last: 50) { nodes { content { ... on Issue { repository { nameWithOwner } } } } } } } }`,
  addItem: `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
  setStatus: `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
  issueCloser: `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { ${CLOSED_EVENT_SELECTION} } } }`,
  // Review threads of a pull request (their first comment's author and body, and the replies) and resolving one by id
  // (review-post.ts resolves only the threads it posted itself).
  // Comment ids are 64-bit: `fullDatabaseId` (a BigInt, a JSON string). `databaseId` is the deprecated 32-bit Int and isn't read.
  reviewThreads: `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated viewerCanResolve path line comments(first: 100) { nodes { fullDatabaseId url body author { __typename login } } } } } } } }`,
} as const;
/** The most threads one resolve request takes (a post resolves at most 100). */
export const RESOLVE_MAX = 100;
/** One request resolving `n` threads: aliased mutations `t0..t<n-1>`, each with its own `$t<i>` variable. */
const resolveDoc = (n: number) => `mutation(${Array.from({ length: n }, (_, i) => `$t${i}: ID!`).join(", ")}) { ${Array.from({ length: n }, (_, i) => `t${i}: resolveReviewThread(input: { threadId: $t${i} }) { thread { id isResolved } }`).join(" ")} }`;
const GRAPHQL_DOCS = new Set<string>([...Object.values(GRAPHQL), ...Array.from({ length: RESOLVE_MAX }, (_, i) => resolveDoc(i + 1))]);

export class GitHubRefused extends Error {}

/** GitHub's non-2xx answer to a request: `status` lets a caller tell a not-found from an outage. */
export class GitHubHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * A review comment's id from `fullDatabaseId` (a BigInt, sent as a JSON string; GitHub's `databaseId` is 32-bit and deprecated),
 * or null when GitHub sent none this can use: one such comment is skipped, never taken for an id of its own.
 */
export function reviewCommentId(c: { fullDatabaseId?: string | null }): number | null {
  const id = Number(c.fullDatabaseId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function guard(method: string, path: string, body?: unknown): void {
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) throw new GitHubRefused(`refused a GitHub request that isn't allowed: ${method} ${path}`);
  if (path === "/graphql" && !GRAPHQL_DOCS.has(String((body as { query?: unknown } | undefined)?.query))) throw new GitHubRefused("refused a GraphQL request that isn't one of the fixed documents");
  const limit = BODY_FIELDS.find((b) => b.method === method && b.path.test(path));
  if (limit && Object.keys((body as object | undefined) ?? {}).some((k) => !limit.fields.includes(k))) throw new GitHubRefused(`refused a GitHub request with fields that aren't allowed: ${method} ${path}`);
  // A comment review only: an approval (or a change request) as the owner would count as the owner's own review.
  if (method === "POST" && /\/reviews$/.test(path) && (body as { event?: unknown } | undefined)?.event !== "COMMENT") throw new GitHubRefused("refused a review that isn't a comment: agents post COMMENT reviews only");
  // A standalone review comment is a file comment only (code review's thread for a finding on a file without diff lines).
  if (method === "POST" && /\/pulls\/[0-9]+\/comments$/.test(path) && (body as { subject_type?: unknown } | undefined)?.subject_type !== "file") throw new GitHubRefused("refused a pull request comment that isn't a file comment");
  if (method === "POST" && /\/statuses\//.test(path) && (body as { context?: unknown } | undefined)?.context !== STATUS) throw new GitHubRefused(`refused a commit status that isn't ${STATUS}`);
  // Inline comments are advice: only on a plain comment review, each with only the fields of a line comment.
  const comments = (body as { comments?: unknown } | undefined)?.comments;
  if (method === "POST" && /\/reviews$/.test(path) && comments !== undefined) {
    if (!Array.isArray(comments) || (body as { event?: unknown }).event !== "COMMENT" || comments.some((c) => !c || Object.keys(c).some((k) => !COMMENT_FIELDS.includes(k)))) throw new GitHubRefused("refused review comments that aren't line comments on a COMMENT review");
  }
}

export interface Ref {
  owner: string;
  repo: string;
  number: number;
}

/** An issue or PR as AidenHQ's records name it (`github:<owner>/<repo>#<n>`, lower case): what a write's outcome carries. */
export const objectRef = (r: Ref) => `github:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}#${r.number}`;

/** Parses "owner/repo#12", an issue or pull request URL, or owner/repo plus a number. */
export function parseRef(input: { url?: string; repo?: string; number?: number }): Ref {
  const re = new RegExp(`^(?:https?://(?:www\\.)?github\\.com/)?(${NAME})/(${NAME})(?:/(?:issues|pull)/|#)(${NUM})(?:[/?#].*)?$`);
  const m = input.url?.trim().match(re);
  if (m) return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), number: Number(m[3]) };
  const r = input.repo?.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//, "").replace(/\/$/, "").match(new RegExp(`^(${NAME})/(${NAME})$`));
  if (r && input.number && Number.isInteger(input.number) && input.number > 0) return { owner: r[1]!, repo: r[2]!, number: input.number };
  throw new Error("give an issue or pull request URL (https://github.com/owner/repo/issues/12), owner/repo#12, or repo (owner/repo) and number");
}

export interface ProjectRef {
  org: string;
  number: number;
}

/** Parses an organization project URL (https://github.com/orgs/acme/projects/16, with or without /views/…). */
export function parseProject(url: string): ProjectRef {
  const m = url.trim().match(new RegExp(`^(?:(?:https?://)?(?:www\\.)?github\\.com/)?orgs/(${NAME})/projects/(${NUM})(?:[/?#].*)?$`));
  if (!m) throw new Error("give an organization project URL (https://github.com/orgs/owner/projects/16); user projects aren't supported");
  return { org: m[1]!, number: Number(m[2]) };
}

const labelNames = (i: GhIssue) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

/** "🔍  Triage" and "triage" are the same status. */
const statusKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const LOG_BYTES = 64_000;
/** The most of a log that is read; a bigger one is refused up front or its read stops here. */
const LOG_READ_MAX = 50_000_000;

/** The last LOG_BYTES characters of a response body, read as a stream (never the whole body in memory). `total` counts what was read. */
/** The hosts GitHub redirects a job's log to: Actions' own pipelines hosts and its Azure results blob storage. */
const LOG_HOSTS = [/(^|\.)actions\.githubusercontent\.com$/, /^productionresultssa\d*\.blob\.core\.windows\.net$/];
function logHostAllowed(to: string): boolean {
  try {
    const u = new URL(to);
    return u.protocol === "https:" && LOG_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

async function tailOf(res: Response): Promise<{ tail: string; total: number; capped: boolean }> {
  if (Number(res.headers.get("content-length") ?? 0) > LOG_READ_MAX) return { tail: "", total: Number(res.headers.get("content-length")), capped: true };
  const decoder = new TextDecoder();
  let tail = "";
  let total = 0;
  let capped = false;
  const reader = res.body?.getReader();
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    total += r.value.length;
    tail = (tail + decoder.decode(r.value, { stream: true })).slice(-LOG_BYTES);
    if (total >= LOG_READ_MAX) {
      capped = true;
      await reader!.cancel();
      break;
    }
  }
  return { tail, total, capped };
}
const PATCH_FILE = 4_000;
const PATCH_TOTAL = 60_000;

function splitRepo(repo: string): { owner: string; name: string } {
  const m = repo.match(new RegExp(`^(${NAME})/(${NAME})$`));
  if (!m) throw new Error("repo is owner/repo");
  return { owner: m[1]!, name: m[2]! };
}

type Fetch = typeof fetch;

/** GitHub's refusal, with the `errors[]` entries that name the rejected field (a 422 otherwise reads only "Validation Failed"). */
function errorDetail(body: unknown): string {
  if (typeof body !== "object" || body === null) return JSON.stringify(body ?? "").slice(0, 200);
  const b = body as { message?: unknown; errors?: unknown };
  const message = typeof b.message === "string" ? b.message : "";
  const errors = Array.isArray(b.errors) ? b.errors : [];
  const parts = errors.slice(0, 10).flatMap((e) => {
    if (typeof e === "string") return [e];
    if (typeof e !== "object" || e === null) return [];
    const o = e as { resource?: unknown; field?: unknown; code?: unknown; message?: unknown };
    const where = [o.resource, o.field].filter((x): x is string => typeof x === "string" && Boolean(x)).join(".");
    const code = typeof o.code === "string" ? o.code : "";
    const text = typeof o.message === "string" ? o.message : "";
    return [[where, code, text].filter(Boolean).join(": ")];
  }).filter(Boolean);
  const detail = [message, ...parts].filter(Boolean).join("; ");
  return (detail || JSON.stringify(body)).slice(0, 600);
}

export class GitHub {
  constructor(
    private readonly access: GitHubAccess,
    private readonly fetchImpl: Fetch = fetch,
    /** Another identity than the owner's (code review's App installation, review-post.ts reviewWriter); the same guard. */
    private readonly identity?: Identity,
  ) {}

  /** The same client, every request as `identity`. */
  as(identity: Identity): GitHub {
    return new GitHub(this.access, this.fetchImpl, identity);
  }

  available(): boolean {
    return this.access.connected();
  }

  async request<T>(method: Method, path: string, opts: { query?: Record<string, string | number>; body?: unknown; text?: boolean } = {}): Promise<T> {
    guard(method, path, opts.body);
    const url = new URL(path, API);
    // ".." passes the name pattern but URL resolution would move the path.
    if (url.origin !== API || url.pathname !== path) throw new GitHubRefused(`refused a GitHub request that isn't allowed: ${method} ${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    if (!opts.text) {
      // Through the owner's client: its rate limiter, and a typed need (client.ts) for what the owner must fix.
      const r = await this.access.rest(method, `${url.pathname}${url.search}`, opts.body, this.identity ? { as: this.identity } : {});
      // GitHub answers 404 for private repositories the account can't see.
      if (r.status >= 300) throw new GitHubHttpError(r.status, `GitHub ${r.status} for ${method} ${url.pathname}${r.status === 404 ? " (not found, or the user has no access)" : ""}: ${errorDetail(r.body)}`);
      // DELETE …/labels answers with the remaining labels; some writes answer 201/204 with nothing.
      return (r.body ?? {}) as T;
    }
    // A job's log answers with a redirect to a pre-signed download: asked for with the owner's token, followed once without it.
    if (this.identity) throw new GitHubRefused("a job log is read as the owner only");
    const res = await this.fetchImpl(url, {
      method,
      redirect: "manual",
      headers: { authorization: `Bearer ${await this.access.token()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq-github-mcp" },
      signal: AbortSignal.timeout(30_000),
    });
    {
      const to = res.headers.get("location");
      if (res.status !== 302 || !to || !logHostAllowed(to)) throw new Error(`GitHub ${res.status} for ${method} ${url.pathname}: no log download`);
      const dl = await this.fetchImpl(to, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!dl.ok) throw new Error(`log download answered ${dl.status}`);
      return (await tailOf(dl)) as T;
    }
  }

  async whoami(): Promise<{ login: string }> {
    const u = await this.request<{ login: string }>("GET", "/user");
    return { login: u.login };
  }

  /** An issue or pull request with its conversation (the latest `limit` comments, oldest first). */
  async read(ref: Ref, limit = 50): Promise<unknown> {
    const base = `/repos/${ref.owner}/${ref.repo}`;
    const issue = await this.request<GhIssue>("GET", `${base}/issues/${ref.number}`);
    const isPr = Boolean(issue.pull_request);
    // Comments come oldest first; fetch the last page(s) so long threads keep their newest.
    const pages = Math.max(1, Math.ceil(issue.comments / 100));
    const comments: GhComment[] = [];
    for (let p = pages; p >= 1 && comments.length < limit; p--) {
      const page = await this.request<GhComment[]>("GET", `${base}/issues/${ref.number}/comments`, { query: { per_page: 100, page: p } });
      comments.unshift(...page);
    }
    const shown = comments.slice(-limit);
    const out: Record<string, unknown> = {
      repo: `${ref.owner}/${ref.repo}`,
      number: issue.number,
      kind: isPr ? "pull_request" : "issue",
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      state_reason: issue.state_reason ?? undefined,
      author: issue.user?.login,
      labels: labelNames(issue),
      assignees: issue.assignees?.map((a) => a.login),
      milestone: issue.milestone?.title,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? undefined,
      body: issue.body ?? "",
      comments_total: issue.comments,
      comments_shown: shown.length,
      comments: shown.map((c) => ({ id: c.id, author: c.user?.login, created_at: c.created_at, url: c.html_url, body: c.body ?? "" })),
    };
    if (!isPr && issue.state === "closed") {
      const c = await this.optional(() => this.graphql<{ repository?: { issue?: Parameters<typeof closedBy>[0] } | null }>("issueCloser", { owner: ref.owner, name: ref.repo, number: ref.number }));
      const by = closedBy(c.value?.repository?.issue);
      if (by) out.closed_by = by;
      if (c.error) out.closed_by_error = c.error;
    }
    if (isPr) {
      const pr = await this.request<GhPull>("GET", `${base}/pulls/${ref.number}`);
      const reviews = await this.request<GhReview[]>("GET", `${base}/pulls/${ref.number}/reviews`, { query: { per_page: 100 } });
      // The changed files' names (first 100), e.g. for the UI Reviewer to find the screens a PR touches.
      const files = await this.request<{ filename: string }[]>("GET", `${base}/pulls/${ref.number}/files`, { query: { per_page: 100 } }).catch(() => []);
      // Commit statuses on the head (e.g. `aidenhq/review`) and the Actions check runs (CI) are separate lists:
      // a name missing from `statuses` may still be a check run, so both are read. A read that fails is reported
      // rather than flattened to [] (which reads as "no checks").
      const sha = /^[0-9a-f]{40}$/.test(String(pr.head?.sha)) ? pr.head!.sha! : undefined;
      const statuses = sha ? await this.optional(() => this.request<{ statuses?: GhStatus[] }>("GET", `${base}/commits/${sha}/status`)) : {};
      const checks = sha ? await this.optional(() => this.request<{ check_runs?: GhCheckRun[] }>("GET", `${base}/commits/${sha}/check-runs`, { query: { filter: "latest", per_page: 100 } })) : {};
      out.pull_request = {
        draft: pr.draft,
        merged: pr.merged,
        merged_at: pr.merged_at ?? undefined,
        merge_commit_sha: pr.merge_commit_sha ?? undefined,
        base: pr.base?.ref,
        head: pr.head?.ref,
        head_sha: pr.head?.sha,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        files: files.map((f) => f.filename),
        statuses: (statuses.value?.statuses ?? []).map((s) => ({ context: s.context, state: s.state, description: s.description ?? "" })),
        check_runs: (checks.value?.check_runs ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, run_id: runIdOf(c), job_id: c.id, url: c.html_url })),
        ...(statuses.error ? { statuses_error: statuses.error } : {}),
        ...(checks.error ? { check_runs_error: checks.error } : {}),
        reviews: reviews.map((r) => ({ author: r.user?.login, state: r.state, submitted_at: r.submitted_at, body: r.body ?? "" })),
      };
    }
    return out;
  }

  /** The tail of a failed (or any finished) job's log, at most LOG_BYTES characters. */
  async jobLog(repo: string, jobId: number): Promise<unknown> {
    const { owner, name } = splitRepo(repo);
    const { tail, total, capped } = await this.request<{ tail: string; total: number; capped: boolean }>("GET", `/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, { text: true });
    const clipped = capped || total > LOG_BYTES;
    return { repo: `${owner}/${name}`, job_id: jobId, clipped, ...(clipped ? { note: capped ? `the log is over ${LOG_READ_MAX} bytes: ${total ? "the tail of its first part" : "not read"}` : `only the last ${LOG_BYTES} of ${total} bytes` } : {}), log: tail };
  }

  /** A pull request's changed files with their patches: each patch clipped, the whole capped (first 100 files). */
  async prFiles(ref: Ref): Promise<unknown> {
    const files = await this.request<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`, { query: { per_page: 100 } });
    let budget = PATCH_TOTAL;
    return {
      repo: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      files: files.map((f) => {
        const patch = f.patch ?? "";
        const shown = patch.slice(0, Math.min(PATCH_FILE, budget));
        budget -= shown.length;
        return { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: shown, ...(shown.length < patch.length ? { patch_clipped: true } : {}) };
      }),
      ...(files.length === 100 ? { note: "the first 100 files; more may exist" } : {}),
    };
  }

  async search(query: string, limit = 20): Promise<unknown> {
    const res = await this.request<{ total_count: number; items: GhIssue[] }>("GET", "/search/issues", { query: { q: query, per_page: limit } });
    return {
      total: res.total_count,
      items: res.items.map((i) => ({
        repo: i.repository_url.replace(`${API}/repos/`, ""),
        number: i.number,
        kind: i.pull_request ? "pull_request" : "issue",
        title: i.title,
        state: i.state,
        author: i.user?.login,
        updated_at: i.updated_at,
        url: i.html_url,
      })),
    };
  }

  /** A comment as the owner, signed by `agent` (the AidenHQ footer); `objects` names it for AidenHQ's records. */
  async comment(ref: Ref, body: string, agent: string): Promise<{ url: string; id: number; objects: string[] }> {
    const c = await this.request<GhComment>("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body: { body: withFooter(body, agent) } });
    return { url: c.html_url, id: c.id, objects: [`${objectRef(ref)}/comment/${c.id}`] };
  }

  /** The repository's own labels, with their exact names, for what the user wrote; refuses one that doesn't exist (GitHub would create it). */
  private async matchLabels(owner: string, name: string, wanted: string[]): Promise<string[]> {
    // agent-build is the owner's own word that a feature may be built, and these writes post as the owner (an admin): so the
    // owner adds it on GitHub itself, never through a tool an agent holds.
    if (wanted.some((l) => l.trim().toLowerCase() === "agent-build")) throw new GitHubRefused("agent-build is the owner's label: add it on GitHub, not through this tool");
    const existing = await this.labels(owner, name);
    const hits = wanted.map((l) => existing.find((e) => e.toLowerCase() === l.trim().toLowerCase()));
    const missing = wanted.filter((_, i) => !hits[i]);
    if (missing.length) throw new GitHubRefused(`${owner}/${name} has no label ${missing.map((m) => `"${m}"`).join(", ")}; its labels: ${existing.slice(0, 40).join(", ") || "(none)"}`);
    return hits as string[];
  }

  /** The repository's labels with their exact names, for matching what the user wrote. */
  private async labels(owner: string, name: string): Promise<string[]> {
    const existing: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<{ name: string }[]>("GET", `/repos/${owner}/${name}/labels`, { query: { per_page: 100, page } });
      existing.push(...batch.map((l) => l.name));
      if (batch.length < 100) break;
    }
    return existing;
  }

  /**
   * Changes an issue: replace its body (signed by `agent`, as a new issue's is), close or reopen it, add or remove labels and
   * assignees. Pull requests take labels and assignees, but closing one or replacing its text isn't done here. A body replaces only the body of an AidenHQ-written issue that already holds the new body's opening marker comment. Labels must
   * already exist. Checks everything before the first write, and reports each change it made.
   */
  async updateIssue(ref: Ref, input: { body?: string; state?: "open" | "closed"; reason?: "completed" | "not_planned"; addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[] }, agent = "AidenHQ"): Promise<unknown> {
    const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const issue = await this.request<GhIssue>("GET", base);
    if (input.state && issue.pull_request) throw new GitHubRefused("pull requests aren't closed or reopened from here");
    if (input.body !== undefined && issue.pull_request) throw new GitHubRefused("a pull request's text isn't replaced from here");
    // A body is replaced only on an issue AidenHQ wrote (it ends with the AidenHQ footer) whose first line is the new body's marker (its first line, an HTML comment): a refresh never overwrites someone else's issue.
    const marker = input.body === undefined ? undefined : /^<!-- [^\n]+ -->$/.exec(input.body.split("\n")[0]!.trim())?.[0];
    if (input.body !== undefined && !(marker && hasFooter(issue.body ?? "") && (issue.body ?? "").split("\n")[0]!.trim() === marker)) throw new GitHubRefused(`#${ref.number} isn't an AidenHQ issue holding the marker line that opens the new body (an HTML comment); its text isn't replaced`);
    const current = labelNames(issue);
    const add = input.addLabels?.length ? await this.matchLabels(ref.owner, ref.repo, input.addLabels) : [];
    const remove = (input.removeLabels ?? []).map((l) => current.find((c) => c.toLowerCase() === l.trim().toLowerCase())).filter((l): l is string => Boolean(l));
    const done: string[] = [];
    if (input.body !== undefined) await this.request("PATCH", base, { body: { body: withFooter(input.body, agent) } }), done.push("replaced the body");
    if (add.length) await this.request("POST", `${base}/labels`, { body: { labels: add } }), done.push(`added labels ${add.join(", ")}`);
    for (const l of remove) await this.request("DELETE", `${base}/labels/${encodeURIComponent(l)}`), done.push(`removed label ${l}`);
    if (input.addAssignees?.length) await this.request("POST", `${base}/assignees`, { body: { assignees: input.addAssignees } }), done.push(`assigned ${input.addAssignees.join(", ")}`);
    if (input.removeAssignees?.length) await this.request("DELETE", `${base}/assignees`, { body: { assignees: input.removeAssignees } }), done.push(`unassigned ${input.removeAssignees.join(", ")}`);
    if (input.state && input.state !== issue.state) {
      await this.request("PATCH", base, { body: { state: input.state, ...(input.state === "closed" ? { state_reason: input.reason ?? "completed" } : {}) } });
      done.push(input.state === "closed" ? `closed as ${(input.reason ?? "completed").replace("_", " ")}` : "reopened");
    }
    const after = await this.request<GhIssue>("GET", base);
    return { url: after.html_url, state: after.state, labels: labelNames(after), assignees: after.assignees?.map((a) => a.login), done: done.length ? done : ["nothing to change"] };
  }

  /**
   * A comment review on a pull request as the owner, signed by `agent`, with optional line comments. Never an approval or a
   * change request: an agent's review mustn't satisfy branch protection as the owner's.
   */
  async review(ref: Ref, body: string, agent: string, opts: { comments?: { path: string; line: number; end_line?: number; body: string }[] } = {}): Promise<{ url: string; id: number; state: string }> {
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const pr = await this.request<GhPull & { state: string; user?: GhUser; head: { sha: string } }>("GET", base);
    if (pr.state !== "open") throw new GitHubRefused(`${ref.owner}/${ref.repo}#${ref.number} isn't open`);
    if (!body.trim()) throw new GitHubRefused("a review comment needs text");
    const comments = opts.comments?.map((c) => ({ path: c.path, line: c.end_line && c.end_line > c.line ? c.end_line : c.line, side: "RIGHT", ...(c.end_line && c.end_line > c.line ? { start_line: c.line, start_side: "RIGHT" } : {}), body: c.body }));
    // Reviewed at the head we looked at: if someone pushes meanwhile, GitHub refuses rather than reviewing unseen commits.
    const r = await this.request<{ id: number; html_url: string; state: string }>("POST", `${base}/reviews`, { body: { event: "COMMENT", commit_id: pr.head.sha, body: withFooter(body, agent), ...(comments?.length ? { comments } : {}) } });
    return { url: r.html_url, id: r.id, state: r.state };
  }

  /**
   * The first comment of the pull request's review thread that `comment` is in, and the pull request's canonical
   * repository (GitHub follows a rename), or a refusal naming why there is none. GitHub takes a reply only on a thread
   * root: a direct read of the comment says whether it is on this pull request and, for a reply, which comment it
   * answers, so the top of that chain is the root — no dependence on where a thread is listed.
   */
  private async threadRoot(ref: Ref, comment: number): Promise<{ root: number; owner: string; repo: string }> {
    type Comment = { id: number; pull_request_url: string; in_reply_to_id?: number | null };
    // The PR's own answer names its canonical repository: a saved URL from before a rename still resolves, and the reply
    // is posted under the name GitHub knows it by now.
    const pr = await this.request<{ url: string }>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    const canonical = pr.url.match(new RegExp(`^${API}/repos/(${NAME})/(${NAME})/pulls/${NUM}$`, "i"));
    if (!canonical) throw new GitHubRefused(`GitHub answered ${ref.owner}/${ref.repo}#${ref.number} with an unexpected URL (${pr.url.slice(0, 200)}): there is no thread to reply on`);
    const [, owner, repo] = canonical as unknown as [string, string, string];
    const read = async (id: number): Promise<Comment> => {
      try {
        return await this.request<Comment>("GET", `/repos/${owner}/${repo}/pulls/comments/${id}`);
      } catch (e) {
        // A 404 is the answer "no such comment here"; a rate limit, a 5xx or a lost connection is not, and is passed on as it is.
        if (e instanceof GitHubHttpError && e.status === 404) throw new GitHubRefused(`comment ${id} isn't a review comment of ${owner}/${repo} (${e.message.slice(0, 240)}): there is no thread to reply on`);
        throw e;
      }
    };
    let current = await read(comment);
    const seen = new Set([comment]);
    // A reply names the comment it answers; walk to the top-level one GitHub takes replies on. A cycle or a very long chain is
    // refused rather than looped on.
    for (let depth = 0; current.in_reply_to_id; depth++) {
      const parent = current.in_reply_to_id;
      if (depth >= 20 || seen.has(parent)) throw new GitHubRefused(`comment ${comment} on ${owner}/${repo}#${ref.number} has a broken reply chain (in_reply_to_id ${parent}): there is no thread root to reply on`);
      seen.add(parent);
      current = await read(parent);
    }
    // The comment's own URL is the pull request it is on, compared with the PR's canonical one (a rename changes both together).
    if (current.pull_request_url.toLowerCase() !== pr.url.toLowerCase()) throw new GitHubRefused(`comment ${comment} is on ${current.pull_request_url}, not ${owner}/${repo}#${ref.number}: there is no thread here to reply on`);
    return { root: current.id, owner, repo };
  }

  /** A reply on a pull request's review thread (its first comment's id, or any comment in it), signed by the agent. */
  async reply(ref: Ref, comment: number, body: string, agent: string): Promise<{ url: string; id: number }> {
    if (!body.trim()) throw new GitHubRefused("a reply needs text");
    const { root, owner, repo } = await this.threadRoot(ref, comment);
    const r = await this.request<{ id: number; html_url: string }>("POST", `/repos/${owner}/${repo}/pulls/${ref.number}/comments/${root}/replies`, { body: { body: withFooter(body, agent) } });
    return { url: r.html_url, id: r.id };
  }

  /** Resolves the review thread `comment` is in (a repo may require resolved threads to merge), as the owner. */
  async resolveThread(ref: Ref, comment: number): Promise<{ resolved: boolean }> {
    const { root, owner, repo } = await this.threadRoot(ref, comment);
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; comments: { nodes: { fullDatabaseId?: string }[] } }[] } } | null } | null } = await this.graphql("reviewThreads", { owner, name: repo, number: ref.number, after });
      const t = d.repository?.pullRequest?.reviewThreads;
      if (!t) break;
      const thread = t.nodes.find((n) => String(n.comments.nodes[0]?.fullDatabaseId) === String(root));
      if (thread) return { resolved: (await this.resolveThreads([thread.id])).length === 1 };
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    throw new GitHubRefused(`no review thread with the root comment ${root} on ${owner}/${repo}#${ref.number}`);
  }

  /**
   * Re-runs the failed jobs of a pull request's latest workflow runs, or of one workflow run.
   * Only runs that finished as failed (or were cancelled or timed out) are touched.
   */
  async rerunFailed(input: { pr?: Ref; run?: { owner: string; repo: string; id: number } }): Promise<unknown> {
    type Run = { id: number; name: string; html_url: string; status: string; conclusion: string | null; head_sha: string; workflow_id: number; created_at: string };
    const failed = (r: Run) => r.status === "completed" && ["failure", "cancelled", "timed_out", "startup_failure"].includes(r.conclusion ?? "");
    let owner: string, repo: string, runs: Run[];
    if (input.run) {
      ({ owner, repo } = input.run);
      runs = [await this.request<Run>("GET", `/repos/${owner}/${repo}/actions/runs/${input.run.id}`)];
    } else if (input.pr) {
      ({ owner, repo } = input.pr);
      const pr = await this.request<GhPull & { head: { sha: string } }>("GET", `/repos/${owner}/${repo}/pulls/${input.pr.number}`);
      const all = (await this.request<{ workflow_runs: Run[] }>("GET", `/repos/${owner}/${repo}/actions/runs`, { query: { head_sha: pr.head.sha, per_page: 100 } })).workflow_runs;
      // The latest run of each workflow: an older failure that already passed on a re-run doesn't count.
      const latest = new Map<number, Run>();
      for (const r of all) if (!latest.has(r.workflow_id) || latest.get(r.workflow_id)!.created_at < r.created_at) latest.set(r.workflow_id, r);
      runs = [...latest.values()];
    } else throw new Error("give a pull request or a workflow run URL");
    const targets = runs.filter(failed);
    const rerun: { name: string; url: string }[] = [];
    for (const r of targets) {
      await this.request("POST", `/repos/${owner}/${repo}/actions/runs/${r.id}/rerun-failed-jobs`);
      rerun.push({ name: r.name, url: r.html_url });
    }
    return { repo: `${owner}/${repo}`, rerun, not_failed: runs.filter((r) => !failed(r)).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })) };
  }

  async graphql<T>(doc: keyof typeof GRAPHQL, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { body: { query: GRAPHQL[doc], variables } });
    if (res.errors?.length || !res.data) throw new Error(`GitHub GraphQL: ${res.errors?.map((e) => e.message).join("; ").slice(0, 300) ?? "no data"}`);
    return res.data;
  }

  /** Resolves the review threads (at most RESOLVE_MAX) in one request; returns the ids GitHub resolved (a stale id fails alone). */
  async resolveThreads(ids: string[]): Promise<string[]> {
    const res = await this.request<{ data?: Record<string, unknown> | null; errors?: { message: string }[] }>("POST", "/graphql", { body: { query: resolveDoc(ids.length), variables: Object.fromEntries(ids.map((id, i) => [`t${i}`, id])) } });
    if (!res.data) throw new Error(`GitHub GraphQL: ${res.errors?.map((e) => e.message).join("; ").slice(0, 300) ?? "no data"}`);
    return ids.filter((_, i) => res.data![`t${i}`]);
  }

  /** A read whose failure is reported in the output (as `<field>_error`) instead of thrown or flattened to empty. */
  private async optional<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
      return { value: await fn() };
    } catch (err) {
      if (err instanceof GitHubNeed || err instanceof GitHubRefused) throw err;
      return { error: (err as Error).message.slice(0, 200) };
    }
  }

  /**
   * Opens an issue as the user, with labels, optionally on an organization project with a
   * status. Everything that can be refused (organization, project, status, labels) is checked before
   * the issue exists. The issue can't be undone from here, so a failure after it is created is
   * returned with the issue rather than thrown: the caller must not try again.
   */
  async createIssue(input: { repo?: string; title: string; body: string; labels?: string[]; project?: string; status?: string }, agent: string): Promise<IssueCreated> {
    let project: { id: string; title: string; url: string; field?: { id: string; options: { id: string; name: string }[] }; option?: { id: string; name: string }; repos: string[] } | undefined;
    if (input.project) {
      const p = parseProject(input.project);
      const data = await this.graphql<{ organization?: { projectV2?: GhProject | null } | null }>("project", { org: p.org, number: p.number });
      const proj = data.organization?.projectV2;
      if (!proj) throw new Error(`project ${p.number} not found in ${p.org} (or the GitHub sign-in lacks the project scope: reconnect GitHub on the board)`);
      if (proj.closed) throw new GitHubRefused(`project "${proj.title}" is closed`);
      const counts = new Map<string, number>();
      for (const n of proj.items.nodes) {
        const r = n.content?.repository?.nameWithOwner;
        if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
      project = { id: proj.id, title: proj.title, url: proj.url, field: proj.field ?? undefined, repos: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r) };
      if (input.status) {
        const options = project.field?.options ?? [];
        project.option = options.find((o) => statusKey(o.name) === statusKey(input.status!));
        if (!project.option) throw new GitHubRefused(`project "${proj.title}" has no status "${input.status}"; its statuses are: ${options.map((o) => o.name).join(", ") || "(no Status field)"}`);
      }
    }

    // Without a repository, the one the project's issues live in.
    const repo = input.repo?.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//, "").replace(/\/$/, "") || project?.repos[0];
    const r = repo?.match(new RegExp(`^(${NAME})/(${NAME})$`));
    if (!r) throw new Error(project ? `name the repository (owner/repo): project "${project.title}" has no issues to take it from` : "name the repository (owner/repo)");
    const [owner, name] = [r[1]!, r[2]!];

    const labels = input.labels?.length ? await this.matchLabels(owner, name, input.labels) : [];

    const issue = await this.request<GhIssue & { node_id: string }>("POST", `/repos/${owner}/${name}/issues`, { body: { title: input.title, body: withFooter(input.body, agent), ...(labels.length ? { labels } : {}) } });
    const out: IssueCreated = { repo: `${owner}/${name}`, number: issue.number, url: issue.html_url, labels: labelNames(issue), objects: [objectRef({ owner, repo: name, number: issue.number })] };
    if (!project) return out;
    out.project = { title: project.title, url: project.url };
    try {
      const added = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>("addItem", { project: project.id, content: issue.node_id });
      out.project.added = true;
      if (project.option && project.field) {
        await this.graphql("setStatus", { project: project.id, item: added.addProjectV2ItemById.item.id, field: project.field.id, option: project.option.id });
        out.project.status = project.option.name;
      }
    } catch (err) {
      out.project.error = `the issue was opened, but ${out.project.added ? "setting its status" : "adding it to the project"} failed: ${(err as Error).message.slice(0, 200)}. Don't open it again; tell the user.`;
    }
    return out;
  }
}

export interface IssueCreated {
  /** The issue (and its labels) for AidenHQ's records. */
  objects: string[];
  repo: string;
  number: number;
  url: string;
  labels: string[];
  project?: { title: string; url: string; added?: boolean; status?: string; error?: string };
}
interface GhProject {
  id: string;
  title: string;
  url: string;
  closed: boolean;
  field?: { id: string; options: { id: string; name: string }[] } | null;
  items: { nodes: { content?: { repository?: { nameWithOwner: string } } | null }[] };
}

interface GhUser {
  login: string;
}
interface GhIssue {
  number: number;
  html_url: string;
  repository_url: string;
  title: string;
  state: string;
  state_reason?: string | null;
  user?: GhUser;
  labels: (string | { name: string })[];
  assignees?: GhUser[];
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  body?: string | null;
  comments: number;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  html_url: string;
  user?: GhUser;
  created_at: string;
  body?: string | null;
}
interface GhPull {
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { ref: string };
  head?: { ref: string; sha?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}
interface GhReview {
  user?: GhUser;
  state: string;
  submitted_at?: string;
  body?: string | null;
}
interface GhStatus {
  context: string;
  state: string;
  description?: string | null;
}
/** An Actions check run on a commit (`/commits/:sha/check-runs`); `id` is the job id GitHub links to. */
interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

/** The workflow run a check run belongs to: the `…/actions/runs/<id>/job/<id>` link GitHub gives it. */
const runIdOf = (c: GhCheckRun): number | undefined => {
  const id = (c.details_url ?? c.html_url ?? "").match(/\/actions\/runs\/([1-9][0-9]{0,15})(?:[/?#]|$)/)?.[1];
  return id ? Number(id) : undefined;
};
