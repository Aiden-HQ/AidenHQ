// Recurring tasks: the runner claims due runs from the board, adds the period's GitHub
// activity to the user's task for it, and starts the Researcher. The GitHub part is fixed, read-only
// GraphQL with your gh login (like reviews.ts); nothing is written to GitHub.
import { existsSync, readFileSync } from "node:fs";

/**
 * The board's internal API: the bearer token (which agents can also read) plus the runner's own key (reviewer_key, which they
 * can't) on every call: the board takes claims, outcomes and the runner's reports only with it.
 */
export class Board {
  url: string;
  token: string;
  keyFile: string | undefined;
  constructor(url: string, tokenFile: string, keyFile?: string) {
    this.url = url.replace(/\/$/, "");
    this.token = readFileSync(tokenFile, "utf8").trim();
    this.keyFile = keyFile;
  }

  headers(): Record<string, string> {
    const key = this.keyFile && existsSync(this.keyFile) ? readFileSync(this.keyFile, "utf8").trim() : "";
    return { authorization: `Bearer ${this.token}`, accept: "application/json", ...(key ? { "x-reviewer-key": key } : {}) };
  }

  async post(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`board POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async get(path: string): Promise<any> {
    const res = await fetch(`${this.url}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`board GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async claim(): Promise<RecurringRun[]> {
    return (await this.post("/internal/recurring/claim")).runs ?? [];
  }

  runState(run: RecurringRun, state: string) {
    return this.post(`/internal/recurring/runs/${run.definitionId}/${run.occurrence}`, { state });
  }
}

/** A routine run task, as far as staleRoutineRuns reads it. */
interface RoutineIssue {
  originKind?: string;
  originId?: string | null;
  status?: string;
  createdAt: string;
}

/**
 * Routine run tasks that ended blocked (e.g. configuration_incomplete) and were overtaken: a later run of the same routine
 * finished done. → [{ issue, by }] (by: the newest such run). Filters here too: a list may hold more than was asked for.
 * A routine in `perEvent` (concurrency always_enqueue: each run is its own event, such as one labelled issue) is never
 * overtaken: another event's run finishing says nothing about this one's work.
 */
export function staleRoutineRuns<I extends RoutineIssue>(blocked: I[], done: I[], perEvent: Set<string> = new Set()): { issue: I; by: I }[] {
  const run = (i: I | undefined, status: string) => i?.originKind === "routine_execution" && i.status === status && i.originId;
  return blocked.filter((b) => run(b, "blocked") && !perEvent.has(b.originId!)).flatMap((b) => {
    const by = done.filter((d) => run(d, "done") && d.originId === b.originId && d.createdAt > b.createdAt).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return by ? [{ issue: b, by }] : [];
  });
}

/** A due recurring run the board hands out (its claim). */
export interface RecurringRun {
  definitionId: string;
  occurrence: string;
  sinceLocal?: string;
  untilLocal?: string;
  timezone?: string;
  [k: string]: unknown;
}

const LIMIT = 40;

/** Search strings for one repository and window (ISO instants; GitHub accepts date-time ranges). */
export function activitySearches(repo: string, since: string, until: string) {
  const range = `${since.replace(/\.\d{3}Z$/, "Z")}..${until.replace(/\.\d{3}Z$/, "Z")}`;
  return {
    merged: `repo:${repo} is:pr is:merged merged:${range}`,
    opened: `repo:${repo} is:pr is:open created:${range}`,
    issuesOpened: `repo:${repo} is:issue created:${range}`,
    issuesClosed: `repo:${repo} is:issue is:closed closed:${range}`,
  };
}

export const ACTIVITY_QUERY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $merged: String!, $opened: String!, $issuesOpened: String!, $issuesClosed: String!) {
  merged: search(query: $merged, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on PullRequest { number title url author { login } } } }
  opened: search(query: $opened, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on PullRequest { number title url isDraft author { login } } } }
  issuesOpened: search(query: $issuesOpened, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on Issue { number title url author { login } } } }
  issuesClosed: search(query: $issuesClosed, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on Issue { number title url } } }
  repository(owner: $owner, name: $name) {
    releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { name tagName url publishedAt isDraft } }
    defaultBranchRef { name target { ... on Commit { history(since: $since, until: $until, first: ${LIMIT}) { totalCount nodes { messageHeadline url author { name user { login } } associatedPullRequests(first: 1) { nodes { number merged } } } } } } }
  }
}`;

// Titles are other people's text: no links, HTML, comments or line breaks of their own.
const clean = (s: unknown) => String(s ?? "").replace(/<!--|-->/g, "").replace(/[\[\]<>`|]/g, "").replace(/([*_])/g, "\\$1").replace(/\s+/g, " ").trim().slice(0, 160);

/** GitHub's GraphQL nodes: other people's text, read loosely. */
type Node = any;
type Search = { issueCount?: number; nodes?: Node[] } | null | undefined;

function list(label: string, result: Search, item: (n: Node) => string) {
  const nodes = (result?.nodes ?? []).filter((n) => n?.url);
  if (!nodes.length) return [];
  const more = (result!.issueCount ?? nodes.length) - nodes.length;
  return [`- **${label} (${result!.issueCount ?? nodes.length}):**`, ...nodes.map((n) => `  - ${item(n)}`), ...(more > 0 ? [`  - …and ${more} more`] : [])];
}

const by = (n: Node) => (n.author?.login ? ` by ${clean(n.author.login)}` : "");
const ref = (n: Node) => `[#${n.number}](${n.url}) ${clean(n.title)}`;

/** Commits on the default branch that didn't come in through a merged PR (direct pushes). */
function directCommits(data: Node) {
  const branch = data?.repository?.defaultBranchRef;
  const history = branch?.target?.history;
  const direct: Node[] = (history?.nodes ?? []).filter((c: Node) => !(c.associatedPullRequests?.nodes ?? []).some((pr: Node) => pr.merged));
  if (!direct.length) return [];
  const author = (c: Node) => c.author?.user?.login ?? c.author?.name;
  const more = history.totalCount > history.nodes.length ? [`  - …and more (${history.totalCount} commits in all)`] : [];
  return [`- **Pushed to ${clean(branch.name)} without a PR (${direct.length}):**`, ...direct.map((c) => `  - [${clean(c.messageHeadline)}](${c.url})${author(c) ? ` by ${clean(author(c))}` : ""}`), ...more];
}

/** One repository's section of the comment, from the GraphQL result (or the error reading it). */
export function formatRepo(repo: string, data: Node, since: string, until: string, err?: unknown): string {
  if (err) return `### ${repo}\n_Couldn't read this repository: ${clean(err).slice(0, 200)}_`;
  const releases: Node[] = (data?.repository?.releases?.nodes ?? []).filter((r: Node) => !r.isDraft && r.publishedAt && r.publishedAt >= since && r.publishedAt < until);
  const lines = [
    ...list("Merged PRs", data?.merged, (n) => `${ref(n)}${by(n)}`),
    ...list("Opened PRs, still open", data?.opened, (n) => `${ref(n)}${by(n)}${n.isDraft ? " (draft)" : ""}`),
    ...directCommits(data),
    ...(releases.length ? [`- **Releases (${releases.length}):**`, ...releases.map((r) => `  - [${clean(r.name || r.tagName)}](${r.url})`)] : []),
    ...list("Issues opened", data?.issuesOpened, (n) => `${ref(n)}${by(n)}`),
    ...list("Issues closed", data?.issuesClosed, ref),
  ];
  return `### ${repo}\n${lines.length ? lines.join("\n") : "_Nothing in this period._"}`;
}

/** The comment the runner adds to the user's task for the period. */
export function activityComment(run: RecurringRun, sections: string[]): string {
  return [`**GitHub activity, ${run.sinceLocal} to ${run.untilLocal}** (${run.timezone}), for the Researcher to draft from.`, ...sections].join("\n\n");
}
