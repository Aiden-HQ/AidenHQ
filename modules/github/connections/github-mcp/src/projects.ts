// The instance's GitHub App, without its key: every App token comes from the kernel (POST /v1/codehost/token, with this
// module's own token, under its `codehost:` grant; the kernel asks codehost-github, the App key's only holder), narrowed to one repo or org and the permissions each call needs. Read-only
// GitHub Projects (v2) boards of an organization (the user's own token can't read org projects: one fixed GraphQL query with
// an org token), the src_github sync, product issues and the Maintainer's App calls go through here; github.ts uses
// `repoToken` for read-only access to repositories the App covers.
import { AGENT_FIX } from "./maintainer.js";
import { scrubProblems } from "./scrub.js";

const API = "https://api.github.com";
const PERMISSIONS = { organization_projects: "read", issues: "read", pull_requests: "read" };
const ORG_READ = { issues: "read", pull_requests: "read" };
// What github.ts's read endpoints need, as read-only permissions: issues and their comments, pull requests and their
// reviews/files, commit statuses, and workflow runs.
const REPO_READ = { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read" };
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const QUERY = `query($org:String!,$number:Int!,$first:Int!,$after:String){organization(login:$org){projectV2(number:$number){
  title url closed
  fields(first:50){nodes{... on ProjectV2FieldCommon{name dataType} ... on ProjectV2SingleSelectField{options{name}} ... on ProjectV2IterationField{configuration{iterations{title startDate}}}}}
  items(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{
    content{__typename ... on Issue{title url state repository{nameWithOwner} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}}
      ... on PullRequest{title url state repository{nameWithOwner} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}} ... on DraftIssue{title}}
    fieldValues(first:30){nodes{__typename
      ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
      ... on ProjectV2ItemFieldIterationValue{title startDate field{... on ProjectV2FieldCommon{name}}}
      ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}
      ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
      ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}}}`;

/** The kernel's codehost route (its URL, and this module's own token as the bearer); undefined: no App here. */
export type Codehost = { url: string; key: () => string };
/** The kernel's error ({error: {message}}) or codehost-github's passed through ({error: "…"}). */
const errorOf = (b: any) => String(b?.error?.message ?? b?.error ?? "");

/**
 * Where product issues go: only the configured product repo (no tool input names a repo), and only for a caller holding the
 * product-issues role (the chief of staff, and Fleet Ops), whatever its grant says.
 */
export function productTarget(roles: readonly string[] | undefined, configured: string): [string, string] {
  if (!roles?.includes("product-issues")) throw new Error("product issues need the product-issues role");
  const m = configured.trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if (!m) throw new Error("no product repo is configured (setting product_repo)");
  return [m[1]!, m[2]!];
}

/**
 * A product-bug report ready to file upstream: the body with its evidence and where it came from as opaque ids (spec §6.9a,
 * scrub.ts originIds), the whole final text checked by the owner-data scrub. Throws with the matches; nothing is sent.
 */
export function upstreamReport(
  a: { fingerprint: string; title: string; body: string; evidence: { module: string; version: string; reproduction: string; log: string } },
  origin: { instance: string; agent: string },
  terms: string[],
): { fingerprint: string; title: string; body: string } {
  const e = a.evidence;
  const fence = "`".repeat(Math.max(3, ...[...e.log.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const hex = (s: string) => (/^[0-9a-f]{12}$/.test(s) ? s : "unknown");
  const body = `${a.body}\n\n**Module:** ${e.module}@${e.version}\n\n**Reproduction**\n\n${e.reproduction}\n\n**Evidence**\n\n${fence}text\n${e.log}\n${fence}\n\nOrigin: instance=${hex(origin.instance)} agent=${hex(origin.agent)}`;
  // The final text, exactly as it would be posted (fingerprint and title included), is what the scrub reads.
  const hits = scrubProblems([a.fingerprint, a.title, body].join("\n"), terms);
  if (hits.length) throw new Error(`owner data can't go into a public issue; redact these and file again: ${hits.join("; ")}`);
  return { fingerprint: a.fingerprint, title: a.title, body };
}

export class Projects {
  private tokens = new Map<string, { token: string | undefined; expires: number }>();
  private accounts = new Map<string, { user: boolean; projects: boolean }>();
  private slug = "";
  constructor(private readonly codehost: Codehost | undefined, private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  private async api(method: string, url: string, headers: Record<string, string>, body?: unknown) {
    const r = await this.fetchFn(url, { method, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  }

  /**
   * An App token for `target` (owner/name, or owner/* for an org-wide one) and these permissions, from the kernel,
   * reused until 5 minutes before it expires. Where the App doesn't cover it (not installed there, or a permission the
   * installation lacks) or there is no App: undefined (remembered for 15 minutes), or, with `need`, an error that says so.
   */
  private async token(target: string, permissions: Record<string, string>, need?: string): Promise<string | undefined> {
    const key = `${target.toLowerCase()} ${JSON.stringify(permissions)}`;
    const hit = this.tokens.get(key);
    if (hit && hit.expires - Date.now() > 5 * 60_000 && (hit.token || !need)) return hit.token;
    const miss = (why: string) => {
      if (need) throw new Error(`${need}: ${why}`);
      this.tokens.set(key, { token: undefined, expires: Date.now() + 15 * 60_000 });
      return undefined;
    };
    if (!this.codehost) return miss("the GitHub App isn't set up here");
    const r = await this.api("POST", `${this.codehost.url}/v1/codehost/token`, { authorization: `Bearer ${this.codehost.key()}` }, { repo: target, perms: permissions });
    if (r.status === 200) {
      this.slug = String(r.body.app?.slug ?? this.slug);
      this.tokens.set(key, { token: String(r.body.token), expires: Date.parse(r.body.expires_at) });
      return String(r.body.token);
    }
    // 404: not installed there, or no GitHub code host; 422: GitHub refused those permissions or that repo; 503: no App key.
    if ([404, 422, 503].includes(r.status)) return miss(`the GitHub App doesn't cover ${target} with ${Object.entries(permissions).map(([k, v]) => `${k}: ${v}`).join(", ")} (the kernel said ${r.status} ${errorOf(r.body)})`.trim());
    throw new Error(`couldn't get a GitHub App token for ${target} (the kernel said ${r.status} ${errorOf(r.body)})`.trim());
  }

  private async narrowed(owner: string, repo: string, permissions: Record<string, string>, need: string): Promise<{ authorization: string }> {
    if (!NAME.test(owner) || !NAME.test(repo)) throw new Error("the repo isn't owner/repo");
    return { authorization: `Bearer ${await this.token(`${owner}/${repo}`, permissions, need)}` };
  }

  /**
   * A commit status as the App (the design-review check) on an open PR's current head: a one-off token narrowed to that repo,
   * `statuses: write` and `pull_requests: read`. The caller checks the org, the role and the context; this checks that `sha`
   * is the PR's head right now, so a verdict can't land on some other commit a PR's text pointed at.
   */
  async commitStatus(org: string, repo: string, number: number, sha: string, status: { state: string; context: string; description: string; target_url?: string }) {
    if (!NAME.test(org) || !NAME.test(repo) || !Number.isInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("give owner/repo, the PR number and the full 40-character commit SHA");
    const auth = await this.narrowed(org, repo, { statuses: "write", pull_requests: "read" }, `the GitHub App can't write commit statuses on ${org}/${repo} (the operator gives it Commit statuses: Read and write, and accepts that on the installation)`);
    const pr = await this.api("GET", `${API}/repos/${org}/${repo}/pulls/${number}`, auth);
    if (pr.status !== 200) throw new Error(`couldn't read ${org}/${repo}#${number} (GitHub said ${pr.status})`);
    if (pr.body.state !== "open") throw new Error(`${org}/${repo}#${number} isn't open`);
    if (String(pr.body.head?.sha).toLowerCase() !== sha) throw new Error(`${sha.slice(0, 12)} isn't the current head of #${number} (it is ${String(pr.body.head?.sha).slice(0, 12)}): review that head`);
    const r = await this.api("POST", `${API}/repos/${org}/${repo}/statuses/${sha}`, auth, status);
    if (r.status !== 201) throw new Error(`GitHub refused the status (${r.status} ${r.body?.message ?? ""})`.trim());
    return { repo: `${org}/${repo}`, number, sha, context: r.body.context, state: r.body.state };
  }

  /** The App's slug (codehost-github names it with every token), for telling its events from anyone else's. */
  async appSlug(owner: string, repo: string): Promise<string> {
    await this.token(`${owner}/${repo}`, { metadata: "read" }, `the GitHub App doesn't cover ${owner}/${repo}`);
    return this.slug;
  }

  /** A REST call as the App on one repository, with a token narrowed to it and to `permissions`. */
  async appCall(owner: string, repo: string, permissions: Record<string, "read" | "write">, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return this.api(method, `${API}${path}`, await this.narrowed(owner, repo, permissions, `the GitHub App can't act on ${owner}/${repo}`), body);
  }

  /** The repo's issues whose body carries the fingerprint (GitHub search is fuzzy: each hit is checked). */
  private async byFingerprint(owner: string, repo: string, auth: { authorization: string }, fingerprint: string, open: boolean) {
    const q = `repo:${owner}/${repo} is:issue${open ? " is:open" : ""} in:body "${fingerprint}"`;
    const r = await this.api("GET", `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=20`, auth);
    if (r.status !== 200) throw new Error(`GitHub search failed (${r.status} ${r.body?.message ?? ""})`.trim());
    return ((r.body.items ?? []) as { number: number; html_url: string; state: string; state_reason?: string | null; body?: string | null }[]).filter((i) => String(i.body ?? "").includes(fingerprint));
  }

  /** The repo has the agent-fix label (created once, when the product repo doesn't), so an issue can carry it. */
  private async ensureLabel(owner: string, repo: string, auth: { authorization: string }) {
    const path = `${API}/repos/${owner}/${repo}/labels/${encodeURIComponent(AGENT_FIX)}`;
    const found = await this.api("GET", path, auth);
    if (found.status === 200) return;
    if (found.status !== 404) throw new Error(`GitHub couldn't read ${owner}/${repo}'s labels (${found.status})`);
    const made = await this.api("POST", `${API}/repos/${owner}/${repo}/labels`, auth, { name: AGENT_FIX, color: "0e8a16", description: "A product bug an agent found and can fix" });
    if (made.status !== 201 && made.status !== 422) throw new Error(`GitHub couldn't create the ${AGENT_FIX} label on ${owner}/${repo} (${made.status} ${made.body?.message ?? ""})`.trim());
  }

  /**
   * A product-bug report as the App (the fleet's own identity, never the owner's), deduped by its fingerprint: the issue that
   * carries it (an open one first, else the latest closed one: a verification, or a recurrence after a fix) gets the body as a
   * comment; only a fingerprint seen nowhere opens a new issue, the fingerprint on its last line and the agent-fix label.
   */
  async reportIssue(owner: string, repo: string, input: { fingerprint: string; title: string; body: string }) {
    const auth = await this.narrowed(owner, repo, { issues: "write" }, `the GitHub App can't write issues on ${owner}/${repo} yet (the operator gives it Issues: Read and write, and accepts that on the installation)`);
    const all = await this.byFingerprint(owner, repo, auth, input.fingerprint, false);
    const hit = all.find((i) => i.state === "open") ?? all.sort((a, b) => b.number - a.number)[0];
    let r;
    if (hit) {
      r = await this.api("POST", `${API}/repos/${owner}/${repo}/issues/${hit.number}/comments`, auth, { body: input.body });
    } else {
      await this.ensureLabel(owner, repo, auth);
      r = await this.api("POST", `${API}/repos/${owner}/${repo}/issues`, auth, { title: input.title, body: `${input.body}\n\n${input.fingerprint}`, labels: [AGENT_FIX] });
    }
    if (r.status !== 201) throw new Error(`GitHub refused it (${r.status} ${r.body?.message ?? ""})`.trim());
    return { deduplicated: Boolean(hit), number: hit?.number ?? (r.body.number as number), state: hit?.state ?? "open", url: r.body.html_url as string };
  }

  /** Each fingerprint's issues with their state; a closed one names the commit that closed it (`fixed_in`), when a commit did. */
  async issueStatus(owner: string, repo: string, fingerprints: string[]) {
    const auth = await this.narrowed(owner, repo, { issues: "read" }, `the GitHub App can't read issues on ${owner}/${repo}`);
    const out = [];
    for (const fingerprint of fingerprints) {
      for (const i of await this.byFingerprint(owner, repo, auth, fingerprint, false)) {
        let fixed_in: string | undefined;
        if (i.state === "closed") {
          const ev = await this.api("GET", `${API}/repos/${owner}/${repo}/issues/${i.number}/events?per_page=100`, auth);
          fixed_in = ((ev.body ?? []) as { event: string; commit_id?: string | null }[]).filter((e) => e.event === "closed").at(-1)?.commit_id ?? undefined;
        }
        out.push({ fingerprint, number: i.number, url: i.html_url, state: i.state, state_reason: i.state_reason ?? null, ...(fixed_in ? { fixed_in } : {}) });
      }
    }
    return out;
  }

  /**
   * The App on an org or user account, remembered: whether it is a user account (its profile, read with the App's token) and
   * whether the App may read its Projects boards (an org whose installation grants organization_projects).
   */
  async account(org: string): Promise<{ user: boolean; projects: boolean }> {
    if (!NAME.test(org)) throw new Error("invalid org");
    const hit = this.accounts.get(org.toLowerCase());
    if (hit) return hit;
    const token = await this.token(`${org}/*`, ORG_READ, `the AidenHQ GitHub App isn't installed on ${org}`);
    const r = await this.api("GET", `${API}/users/${org}`, { authorization: `Bearer ${token}` });
    if (r.status !== 200) throw new Error(`couldn't read the GitHub account ${org} (GitHub said ${r.status})`);
    const user = r.body.type === "User";
    const out = { user, projects: !user && (await this.token(`${org}/*`, PERMISSIONS)) !== undefined };
    this.accounts.set(org.toLowerCase(), out);
    return out;
  }

  /**
   * A read-only token for one repository (REPO_READ), or undefined when the App doesn't cover it, so the caller keeps using
   * the user's own token.
   */
  async repoToken(owner: string, repo: string): Promise<string | undefined> {
    if (!NAME.test(owner) || !NAME.test(repo)) return undefined;
    return this.token(`${owner}/${repo}`, REPO_READ);
  }

  /**
   * A read-only org-wide token for the org or user account (issues and pull requests), or undefined when the App isn't
   * installed there. Search has no repository in its path, so it uses this instead of the user's token, which can't see the
   * agents org.
   */
  async orgToken(org: string): Promise<string | undefined> {
    return NAME.test(org) ? this.token(`${org}/*`, ORG_READ) : undefined;
  }

  /** The org's token for the sync and boards: with Projects read where the App may read them, else issues and PRs only. */
  private async install(org: string): Promise<{ token: string }> {
    const { projects } = await this.account(org);
    return { token: (await this.token(`${org}/*`, projects ? PERMISSIONS : ORG_READ, `the AidenHQ GitHub App isn't installed on ${org}`))! };
  }

  /**
   * A REST or GraphQL call with the org's App token (the src_github sync, src/sources.ts). Waits out rate limits
   * (429, or 403 with Retry-After / an exhausted quota) and retries; throws on any other failure.
   */
  async request(org: string, method: string, path: string, body?: unknown, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<any> {
    if (!NAME.test(org)) throw new Error("invalid org");
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchFn(`${API}${path}`, { method, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${(await this.install(org)).token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
      const json = (await r.json().catch(() => ({}))) as any;
      const h = (n: string) => r.headers?.get?.(n);
      const limited = r.status === 429 || (r.status === 403 && (h("retry-after") || h("x-ratelimit-remaining") === "0"));
      if (limited && attempt < 5) {
        const reset = Number(h("x-ratelimit-reset"));
        await sleep(h("retry-after") ? Number(h("retry-after")) * 1000 : reset ? Math.max(1000, reset * 1000 - Date.now()) : 60_000);
        continue;
      }
      if (r.status >= 300 || json.errors?.length) throw new Error(`GitHub ${method} ${path.split("?")[0]} failed (${r.status}): ${JSON.stringify(json.errors ?? json.message ?? "").slice(0, 250)}`);
      return json;
    }
  }

  async read(a: { org: string; number: number; query?: string; limit: number; cursor?: string }) {
    if (!NAME.test(a.org)) throw new Error("invalid org");
    const gql = async (after: string | null) => {
      const r = await this.api("POST", `${API}/graphql`, { authorization: `Bearer ${(await this.install(a.org)).token}` }, { query: QUERY, variables: { org: a.org, number: a.number, first: 100, after } });
      if (r.status !== 200 || r.body.errors?.length) throw new Error(`GitHub GraphQL failed (${r.status}): ${JSON.stringify(r.body.errors ?? r.body).slice(0, 250)}`);
      const p = r.body.data?.organization?.projectV2;
      if (!p) throw new Error(`project ${a.number} not found in ${a.org} (or the App can't read it)`);
      return p;
    };
    // GraphQL pages hold at most 100 items: fetch pages until `limit` items are in hand.
    const p = await gql(a.cursor ?? null);
    const nodes: any[] = [...p.items.nodes];
    let page = p;
    while (page.items.pageInfo.hasNextPage && nodes.length < a.limit) {
      page = await gql(page.items.pageInfo.endCursor);
      nodes.push(...page.items.nodes);
    }
    const fields = p.fields.nodes.filter((f: any) => f?.name).map((f: any) => ({
      name: f.name, type: f.dataType, ...(f.options ? { options: f.options.map((o: any) => o.name) } : {}),
      ...(f.configuration ? { iterations: f.configuration.iterations.map((i: any) => `${i.title} (${i.startDate})`) } : {}),
    }));
    let items = nodes.map((n: any) => {
      const c = n.content ?? {};
      const values: Record<string, unknown> = {};
      for (const v of n.fieldValues.nodes) {
        const name = v?.field?.name;
        if (!name) continue;
        values[name] = v.__typename.includes("Iteration") ? { title: v.title, start: v.startDate } : (v.name ?? v.date ?? v.text ?? v.number);
      }
      return {
        type: c.__typename ?? null, title: c.title ?? null, url: c.url ?? null, repo: c.repository?.nameWithOwner ?? null, state: c.state ?? null,
        assignees: c.assignees?.nodes.map((u: any) => u.login) ?? [], labels: c.labels?.nodes.map((l: any) => l.name) ?? [], fields: values,
      };
    });
    // Filters what was fetched; follow `next_cursor` for the rest of the board.
    const q = a.query?.toLowerCase();
    if (q) items = items.filter((i: any) => `${i.title} ${Object.values(i.fields).map((v) => (typeof v === "object" ? JSON.stringify(v) : v)).join(" ")}`.toLowerCase().includes(q));
    return { project: { title: p.title, url: p.url, closed: p.closed, total_items: p.items.totalCount }, fields, items, next_cursor: page.items.pageInfo.hasNextPage ? page.items.pageInfo.endCursor : null };
  }
}
