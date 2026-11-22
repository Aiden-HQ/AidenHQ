// GitHub as the owner, for what isn't github.ts's own: organization Projects (v2) boards (one fixed GraphQL query), the
// src_github sync, product issues and the design-review commit status. Every call goes through the owner's client (client.ts),
// so its rate limiter and typed needs apply; there is no other identity.
import type { GitHubAccess } from "./client.js";
import { withFooter } from "./aidenhq-sdk/attribution.js";
import { scrubProblems, scrubText } from "./scrub.js";

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** A GraphQL error that refuses one item's content (an issue of an org the sign-in can't read); the client records that need. */
export const isContentRefusal = (e: any): boolean => e?.type === "FORBIDDEN" && Array.isArray(e.path) && e.path.at(-1) === "content";
/** The errors of a GraphQL answer that lose the read: all but a content refusal. */
const fatalErrors = (errors: any): any[] => (Array.isArray(errors) ? errors : []).filter((e) => !isContentRefusal(e));

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


/**
 * Where product issues go: only the configured product repo (no tool input names a repo), and only for a caller holding the
 * product-issues role (the chief of staff, and the Maintainer), whatever its grant says.
 */
export function productTarget(roles: readonly string[] | undefined, configured: string): [string, string] {
  if (!roles?.includes("product-issues")) throw new Error("product issues need the product-issues role");
  return parseProductRepo(configured);
}

/** The configured product repo (setting product_repo) as [owner, name]. */
export function parseProductRepo(configured: string): [string, string] {
  const m = configured.trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if (!m) throw new Error("no product repo is configured (setting product_repo)");
  return [m[1]!, m[2]!];
}

type Report = { fingerprint: string; title: string; body: string; evidence: { module: string; version: string; reproduction: string; log: string } };

/** A report's body with its evidence (what both the filed issue and the owner's prefilled link carry). */
function reportBody(a: Report): string {
  const e = a.evidence;
  const fence = "`".repeat(Math.max(3, ...[...e.log.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${a.body}\n\n**Module:** ${e.module}@${e.version}\n\n**Reproduction**\n\n${e.reproduction}\n\n**Evidence**\n\n${fence}text\n${e.log}\n${fence}`;
}

/** GitHub refuses a "new issue" URL much past 8 KB; this leaves headroom. */
const MAX_LINK = 7000;
const TRIM_NOTE = "\n\n[trimmed to fit a link]";

/**
 * A report for an install where GitHub isn't connected: the owner's one-click "new issue" link on the product repo, title and body
 * prefilled. Owner data is rewritten out of it (scrub.ts scrubText) and the result checked again, as upstreamReport does, and
 * the body is cut (with a note) until the link fits GitHub's URL limit. Nothing is filed: the owner submits it.
 */
export function issueLink(repo: string, a: Report, terms: string[]): { url: string; trimmed: boolean } {
  const title = scrubText(a.title, terms);
  const full = scrubText(`${reportBody(a)}\n\nFingerprint: ${a.fingerprint}`, terms);
  const hits = scrubProblems(`${title}\n${full}`, terms);
  if (hits.length) throw new Error(`owner data can't go into a public issue; redact these and try again: ${hits.join("; ")}`);
  const link = (body: string) => `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  if (link(full).length <= MAX_LINK) return { url: link(full), trimmed: false };
  const cut = (n: number) => full.slice(0, n).replace(/[\ud800-\udbff]$/, "") + TRIM_NOTE;
  let lo = 0;
  for (let hi = full.length; lo < hi; ) {
    const mid = Math.ceil((lo + hi) / 2);
    if (link(cut(mid)).length <= MAX_LINK) lo = mid;
    else hi = mid - 1;
  }
  return { url: link(cut(lo)), trimmed: true };
}

/**
 * A product-bug report ready to file upstream: the body with its evidence and where it came from as opaque ids (spec §6.9a,
 * scrub.ts originIds), the whole final text checked by the owner-data scrub. Throws with the matches; nothing is sent.
 */
export function upstreamReport(
  a: Report,
  origin: { instance: string; agent: string },
  terms: string[],
): { fingerprint: string; title: string; body: string } {
  const hex = (s: string) => (/^[0-9a-f]{12}$/.test(s) ? s : "unknown");
  const body = `${reportBody(a)}\n\nOrigin: instance=${hex(origin.instance)} agent=${hex(origin.agent)}`;
  // The final text, exactly as it would be posted (fingerprint and title included), is what the scrub reads.
  const hits = scrubProblems([a.fingerprint, a.title, body].join("\n"), terms);
  if (hits.length) throw new Error(`owner data can't go into a public issue; redact these and file again: ${hits.join("; ")}`);
  return { fingerprint: a.fingerprint, title: a.title, body };
}

export class Projects {
  private accounts = new Map<string, { user: boolean; projects: boolean }>();
  constructor(private readonly access: Pick<GitHubAccess, "rest" | "graphql">) {}

  /**
   * A commit status (the design-review check) on an open PR's current head. The caller checks the org, the role and the
   * context; this checks that `sha` is the PR's head right now, so a verdict can't land on some other commit a PR's text
   * pointed at.
   */
  async commitStatus(org: string, repo: string, number: number, sha: string, status: { state: string; context: string; description: string; target_url?: string }) {
    if (!NAME.test(org) || !NAME.test(repo) || !Number.isInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("give owner/repo, the PR number and the full 40-character commit SHA");
    const pr = await this.access.rest("GET", `/repos/${org}/${repo}/pulls/${number}`);
    if (pr.status !== 200) throw new Error(`couldn't read ${org}/${repo}#${number} (GitHub said ${pr.status})`);
    if (pr.body.state !== "open") throw new Error(`${org}/${repo}#${number} isn't open`);
    if (String(pr.body.head?.sha).toLowerCase() !== sha) throw new Error(`${sha.slice(0, 12)} isn't the current head of #${number} (it is ${String(pr.body.head?.sha).slice(0, 12)}): review that head`);
    const r = await this.access.rest("POST", `/repos/${org}/${repo}/statuses/${sha}`, status);
    if (r.status !== 201) throw new Error(`GitHub refused the status (${r.status} ${r.body?.message ?? ""})`.trim());
    return { repo: `${org}/${repo}`, number, sha, context: r.body.context, state: r.body.state };
  }

  /** The repo's issues whose body carries the fingerprint (GitHub search is fuzzy: each hit is checked). */
  private async byFingerprint(owner: string, repo: string, fingerprint: string, open: boolean) {
    const q = `repo:${owner}/${repo} is:issue${open ? " is:open" : ""} in:body "${fingerprint}"`;
    const r = await this.access.rest("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=20`);
    if (r.status !== 200) throw new Error(`GitHub search failed (${r.status} ${r.body?.message ?? ""})`.trim());
    return ((r.body.items ?? []) as { number: number; html_url: string; state: string; state_reason?: string | null; body?: string | null }[]).filter((i) => String(i.body ?? "").includes(fingerprint));
  }

  /**
   * A product-bug report as the owner, signed by the agent (the AidenHQ footer), deduped by its fingerprint: the issue that
   * carries it (an open one first, else the latest closed one: a verification, or a recurrence after a fix) gets the body as
   * a comment; only a fingerprint seen nowhere opens a new issue, the fingerprint on its last line. No label: the
   * Maintainer triages it like any issue (an outside reporter may not be allowed to label).
   */
  async reportIssue(owner: string, repo: string, input: { fingerprint: string; title: string; body: string }, agent: string) {
    if (!NAME.test(owner) || !NAME.test(repo)) throw new Error("the repo isn't owner/repo");
    const all = await this.byFingerprint(owner, repo, input.fingerprint, false);
    const hit = all.find((i) => i.state === "open") ?? all.sort((a, b) => b.number - a.number)[0];
    const signed = withFooter(input.body, agent);
    const r = hit
      ? await this.access.rest("POST", `/repos/${owner}/${repo}/issues/${hit.number}/comments`, { body: signed })
      : await this.access.rest("POST", `/repos/${owner}/${repo}/issues`, { title: input.title, body: `${signed}\n\n${input.fingerprint}` });
    if (r.status !== 201) throw new Error(`GitHub refused it (${r.status} ${r.body?.message ?? ""})`.trim());
    return { deduplicated: Boolean(hit), number: hit?.number ?? (r.body.number as number), state: hit?.state ?? "open", url: r.body.html_url as string, ...(hit ? { comment: r.body.id as number } : {}) };
  }

  /** Each fingerprint's issues with their state; a closed one names the commit that closed it (`fixed_in`), when a commit did. */
  async issueStatus(owner: string, repo: string, fingerprints: string[]) {
    if (!NAME.test(owner) || !NAME.test(repo)) throw new Error("the repo isn't owner/repo");
    const out = [];
    for (const fingerprint of fingerprints) {
      for (const i of await this.byFingerprint(owner, repo, fingerprint, false)) {
        let fixed_in: string | undefined;
        if (i.state === "closed") {
          const ev = await this.access.rest("GET", `/repos/${owner}/${repo}/issues/${i.number}/events?per_page=100`);
          fixed_in = ((ev.body ?? []) as { event: string; commit_id?: string | null }[]).filter((e) => e.event === "closed").at(-1)?.commit_id ?? undefined;
        }
        out.push({ fingerprint, number: i.number, url: i.html_url, state: i.state, state_reason: i.state_reason ?? null, ...(fixed_in ? { fixed_in } : {}) });
      }
    }
    return out;
  }

  /** An org or user account, remembered: whether it is a user account, and whether it has Projects boards to read (an org). */
  async account(org: string): Promise<{ user: boolean; projects: boolean }> {
    if (!NAME.test(org)) throw new Error("invalid org");
    const hit = this.accounts.get(org.toLowerCase());
    if (hit) return hit;
    const r = await this.access.rest("GET", `/users/${org}`, undefined, { background: true });
    if (r.status !== 200) throw new Error(`couldn't read the GitHub account ${org} (GitHub said ${r.status})`);
    const user = r.body.type === "User";
    const out = { user, projects: !user };
    this.accounts.set(org.toLowerCase(), out);
    return out;
  }

  /** A REST or GraphQL call for the src_github sync (src/sources.ts), as background work; throws on any failure. */
  async request(org: string, method: string, path: string, body?: unknown): Promise<any> {
    if (!NAME.test(org)) throw new Error("invalid org");
    if (path === "/graphql") {
      const b = body as { query: string; variables?: Record<string, unknown> };
      const json = await this.access.graphql(b.query, b.variables ?? {}, { background: true });
      const bad = fatalErrors(json?.errors);
      if (bad.length) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(bad).slice(0, 500)}`);
      return json;
    }
    const r = await this.access.rest(method, path, body, { background: true });
    if (r.status >= 300) throw new Error(`GitHub ${method} ${path.split("?")[0]} failed (${r.status}): ${JSON.stringify(r.body?.message ?? "").slice(0, 250)}`);
    return r.body;
  }

  async read(a: { org: string; number: number; query?: string; limit: number; cursor?: string }) {
    if (!NAME.test(a.org)) throw new Error("invalid org");
    const gql = async (after: string | null) => {
      const r = await this.access.graphql(QUERY, { org: a.org, number: a.number, first: 100, after });
      const bad = fatalErrors(r?.errors);
      if (bad.length) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(bad).slice(0, 500)}`);
      const p = r?.data?.organization?.projectV2;
      if (!p) throw new Error(`project ${a.number} not found in ${a.org} (or your account can't read it)`);
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
