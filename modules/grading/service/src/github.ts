// A PR's facts and diff for the grader, read from GitHub with a read token the kernel's broker mints for this module
// (POST /v1/codehost/token, under this module's `codehost:` grant). The token is cached per repo until shortly before it expires.
type Json = any;
type KernelCall = (method: string, path: string, body?: unknown) => Promise<Json>;

const PERMS = { pull_requests: "read", contents: "read", checks: "read", statuses: "read", issues: "read" };
const SLUG = /^[\w.-]+\/[\w.-]+$/;

// The PR as evidence.ts reads it (the code host's own PR query, trimmed to the fields the grader uses).
const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body url state headRefOid headRefName baseRefName mergedAt mergeCommit { oid }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      history: commits(last: 30) { nodes { commit { oid tree { oid } parents(first: 1) { totalCount } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
      baseRef { target { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;

// An issue as evidence.ts reads it: state, how and by whom it closed, its labels and its newest comments.
const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number url state stateReason closedAt labels(first: 20) { nodes { name } }
      closedEvents: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } }
      comments(last: 10) { nodes { author { login } authorAssociation createdAt body } }
    }
  }
}`;

export function createGithub({ kernel, fetchFn = fetch, api = "https://api.github.com" }: { kernel: KernelCall; fetchFn?: typeof fetch; api?: string }) {
  const tokens = new Map<string, { token: string; until: number; app: string }>();
  const token = async (repo: string) => {
    if (!SLUG.test(repo)) throw new Error(`${repo} is not owner/name`);
    const hit = tokens.get(repo.toLowerCase());
    if (hit && hit.until > Date.now()) return hit.token;
    const t = await kernel("POST", "/v1/codehost/token", { repo, perms: PERMS });
    tokens.set(repo.toLowerCase(), { token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000, app: String(t.app?.slug ?? "") });
    return t.token as string;
  };
  const appOf = (repo: string) => tokens.get(repo.toLowerCase())?.app ?? "";
  const call = async (repo: string, path: string, init: RequestInit, accept = "application/vnd.github+json") => {
    const r = await fetchFn(`${api}${path}`, { ...init, headers: { authorization: `Bearer ${await token(repo)}`, accept, "content-type": "application/json", "user-agent": "aidenhq-grading" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}`);
    return r;
  };
  return {
    /** The PR in the shape evidence.ts reads ({ repository: { pullRequest } }); a PR GitHub has no answer for throws. */
    async pr(repo: string, number: number): Promise<Json> {
      const [owner, name] = repo.split("/");
      const r = await (await call(repo, "/graphql", { method: "POST", body: JSON.stringify({ query: PR_QUERY, variables: { owner, repo: name, number } }) })).json();
      if (r.errors?.length || !r.data?.repository?.pullRequest) throw new Error(`GitHub has no readable ${repo}#${number}: ${JSON.stringify(r.errors ?? []).slice(0, 200)}`);
      return r.data;
    },
    /** The issue in the shape evidence.ts reads ({ repository: { issue } }); one GitHub has no answer for throws. */
    async issue(repo: string, number: number): Promise<Json> {
      const [owner, name] = repo.split("/");
      const r = await (await call(repo, "/graphql", { method: "POST", body: JSON.stringify({ query: ISSUE_QUERY, variables: { owner, repo: name, number } }) })).json();
      if (r.errors?.length || !r.data?.repository?.issue) throw new Error(`GitHub has no readable ${repo}#${number}: ${JSON.stringify(r.errors ?? []).slice(0, 200)}`);
      return { ...r.data, appSlug: appOf(repo) };
    },
    diff: async (repo: string, number: number): Promise<string> => (await call(repo, `/repos/${repo}/pulls/${number}`, {}, "application/vnd.github.diff")).text(),
  };
}
