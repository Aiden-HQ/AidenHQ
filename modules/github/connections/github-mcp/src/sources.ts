// src_github writer (shared sources, docs/design/sources.md), as the owner (background work through the one client,
// src/projects.ts), for each configured org. Every 15 minutes, per org:
//   - issues and pull requests updated since the org's cursor (search API, org-scoped, so cost doesn't grow with repos);
//   - every Projects (v2) board, discovered, read in full: items with their field values (status, iteration, dates,
//     assignees); items gone from a board are marked removed.
// A first sync (an org's issues, a newly found board) is a baseline: rows marked baseline, no change log. No LLM.
import type { Logger } from "pino";
import { isContentRefusal, type Projects } from "./projects.js";
import { capText, SourceStore, tableDdl, USERS, type Row, type Table } from "./source-store.js";

export const ISSUE: Table = {
  name: "issue",
  key: ["repo", "number"],
  cols: {
    repo: "text", number: "integer", kind: "text", title: "text", body: "text", body_truncated: "boolean", state: "text", draft: "boolean",
    author: "text", assignees: "text[]", labels: "text[]", milestone: "text", url: "text", created_at_src: "timestamptz", closed_at: "timestamptz",
    merged_at: "timestamptz", source_updated_at: "timestamptz",
  },
  tracked: ["title", "state", "draft", "assignees", "labels", "milestone", "closed_at", "merged_at"],
  scope: "repo",
  url: "url",
  search: ["title", "body"],
};
export const PROJECT: Table = {
  name: "project",
  key: ["project"],
  cols: { project: "text", org: "text", number: "integer", title: "text", url: "text", closed: "boolean", source_updated_at: "timestamptz" },
  tracked: ["title", "closed"],
  scope: "project",
  url: "url",
};
export const ITEM: Table = {
  name: "project_item",
  key: ["project", "item_id"],
  cols: {
    project: "text", item_id: "text", content_type: "text", title: "text", url: "text", repo: "text", number: "integer", state: "text",
    assignees: "text[]", labels: "text[]", fields: "jsonb", archived: "boolean", removed: "boolean", source_updated_at: "timestamptz",
  },
  tracked: ["title", "state", "assignees", "fields", "archived", "removed"],
  scope: "project",
  url: "url",
  search: ["title"],
};

const common = "baseline, first_seen_at, ingested_at, seq";
export const DDL = `${tableDdl("src_github", ISSUE)}
${tableDdl("src_github", PROJECT)}
${tableDdl("src_github", ITEM)}
${tableDdl("src_github", USERS)}
CREATE OR REPLACE VIEW src_github.issues AS
  SELECT repo, number, kind, title, body, body_truncated, state, draft, author, assignees, labels, milestone, url, created_at_src, closed_at,
    merged_at, source_updated_at, ${common}, tsv FROM src_github.issue;
COMMENT ON VIEW src_github.issues IS 'GitHub issues and pull requests (kind) in the configured orgs. source_updated_at is GitHub''s; first_seen_at ours; baseline = from the first sync (not a recent change). body capped at 4 KB (body_truncated; url for the rest). Field changes: src_github.changes.';
CREATE OR REPLACE VIEW src_github.projects AS SELECT project, org, number, title, url, closed, source_updated_at, ${common} FROM src_github.project;
COMMENT ON VIEW src_github.projects IS 'Every Projects (v2) board in the configured orgs (project = org/number), discovered by the sync.';
CREATE OR REPLACE VIEW src_github.project_items AS
  SELECT project, item_id, content_type, title, url, repo, number, state, assignees, labels, fields, archived, removed, source_updated_at, ${common}, tsv
  FROM src_github.project_item;
COMMENT ON VIEW src_github.project_items IS 'Items on the boards: issue, pull request or draft, with every field value in fields (Status, Iteration {title,start}, dates, text, numbers). removed = no longer on the board. A field change is logged in src_github.changes as fields.<name>.';
CREATE OR REPLACE VIEW src_github.changes AS
  SELECT seq, entity, entity_id, scope, field, old_value, new_value, url, observed_at, false AS baseline FROM src_github.change;
COMMENT ON VIEW src_github.changes IS 'Field changes after the baseline: entity issue (scope = repo) or project_item (scope = project, field e.g. fields.Status), with observed_at (when the sync saw it; GitHub''s own time is the row''s source_updated_at).';
COMMENT ON TABLE src_github.users IS 'GitHub people seen in issues and pull requests: user_id (GitHub id), handle (login).';
GRANT SELECT ON src_github.issues, src_github.projects, src_github.project_items, src_github.changes, src_github.users TO agents_open;`;

const DAY = 86_400_000;
const BASELINE_DAYS = 30;
const logins = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map((u: any) => u?.login).filter(Boolean).sort() : []);

/** A search/issues result as an issue row. */
export function issueRow(i: any): Row {
  const repo = String(i.repository_url ?? "").split("/repos/")[1] ?? "";
  const b = capText(i.body ?? null);
  return {
    repo, number: i.number, kind: i.pull_request ? "pr" : "issue", title: capText(i.title).text, body: b.text, body_truncated: b.truncated, state: i.state,
    draft: !!i.draft, author: i.user?.login ?? null, assignees: logins(i.assignees), labels: (i.labels ?? []).map((l: any) => l.name).sort(),
    milestone: i.milestone?.title ?? null, url: i.html_url, created_at_src: i.created_at, closed_at: i.closed_at ?? null,
    merged_at: i.pull_request?.merged_at ?? null, source_updated_at: i.updated_at,
  };
}

const BOARDS = `query($org:String!,$after:String){organization(login:$org){projectsV2(first:50,after:$after){pageInfo{hasNextPage endCursor} nodes{number title url closed updatedAt}}}}`;
// No nested user-field connection (assignees come from the content): GraphQL cost multiplies through nested connections,
// and the owner's 5,000 points an hour are shared with every other GitHub call.
const ITEMS = `query($org:String!,$number:Int!,$after:String){organization(login:$org){projectV2(number:$number){items(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{
  id isArchived updatedAt
  content{__typename ... on Issue{title url state number repository{nameWithOwner} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}}
    ... on PullRequest{title url state number repository{nameWithOwner} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}} ... on DraftIssue{title}}
  fieldValues(first:30){nodes{__typename
    ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
    ... on ProjectV2ItemFieldIterationValue{title startDate field{... on ProjectV2FieldCommon{name}}}
    ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}
    ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
    ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}}
  rateLimit{cost remaining}}`;

/** A board item (GraphQL) as an item row; field values keyed by field name. */
export function itemRow(project: string, n: any, refused = false): Row {
  const c = n.content ?? {};
  const fields: Record<string, unknown> = {};
  for (const v of n.fieldValues?.nodes ?? []) {
    const name = v?.field?.name;
    if (!name) continue;
    fields[name] = v.__typename.includes("Iteration") ? { title: v.title, start: v.startDate } : (v.name ?? v.date ?? capText(v.text).text ?? v.number ?? null);
  }
  // GitHub refused this item's content (an issue of an org the sign-in can't read): only the board's own columns are written, so
  // what was stored for the item stays. An item that simply has no content (a deleted issue) is written as returned.
  if (refused) return { project, item_id: n.id, fields, archived: !!n.isArchived, removed: false, source_updated_at: n.updatedAt ?? null };
  return {
    project, item_id: n.id, content_type: c.__typename ?? null, title: capText(c.title ?? null).text, url: c.url ?? null, repo: c.repository?.nameWithOwner ?? null,
    number: c.number ?? null, state: c.state ?? null, assignees: logins(c.assignees?.nodes), labels: (c.labels?.nodes ?? []).map((l: any) => l.name).sort(),
    fields, archived: !!n.isArchived, removed: false, source_updated_at: n.updatedAt ?? null,
  };
}

type Gh = Pick<Projects, "request" | "account">;

const BOARD_EVERY = 60 * 60_000;
const CLOSED_EVERY = 7 * 24 * BOARD_EVERY;

/** One org: issues and PRs since its cursor, then every board. Returns rows written with a difference. */
export async function syncOrg(store: SourceStore, gh: Gh, org: string, now = Date.now(), log?: Pick<Logger, "info">): Promise<number> {
  let cost = 0; // GraphQL points spent on board items this pass
  await store.migrate(DDL);
  let written = 0;
  const put = async (t: Table, row: Row, baseline: boolean) => void ((await store.upsert(t, row, { baseline })) !== "same" && written++);
  const acct = await gh.account(org);

  // Issues and PRs: search sorted by updated (ascending), at most 1000 per query, so the window moves up to the last one seen.
  for (const kind of ["issue", "pr"]) {
    const scope = `${kind}s:${org}`;
    const st = await store.scope(scope);
    const baseline = !st.baselined;
    let since = st.cursor ?? new Date(now - BASELINE_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
    for (;;) {
      let last = since;
      let got = 0;
      for (let page = 1; page <= 10; page++) {
        const q = encodeURIComponent(`${acct.user ? "user" : "org"}:${org} is:${kind === "pr" ? "pull-request" : "issue"} updated:>=${since}`);
        const r = await gh.request(org, "GET", `/search/issues?q=${q}&sort=updated&order=asc&per_page=100&page=${page}`);
        for (const i of r.items ?? []) {
          await put(ISSUE, issueRow(i), baseline);
          for (const u of [i.user, ...(i.assignees ?? [])].filter((u: any) => u?.id)) await put(USERS, { user_id: String(u.id), handle: u.login, is_bot: u.type === "Bot" }, false);
          if (i.updated_at > last) last = i.updated_at;
          got++;
        }
        if ((r.items ?? []).length < 100) break;
      }
      await store.saveScope(scope, last);
      if (got < 1000 || last === since) break; // a full 1000: query again from the newest seen
      since = last;
    }
    await store.saveScope(scope, null, true);
  }

  // Boards: discovered each pass; each open board is read in full at most every BOARD_EVERY (closed boards once). A new
  // board's first read is its baseline.
  // Without Projects: read (or on a user account) there are no boards to read; issues and PRs above still sync.
  if (!acct.projects) {
    log?.info({ org }, "src_github boards skipped: a user account has no organization Projects");
    return written;
  }
  let after: string | null = null;
  do {
    const r = await gh.request(org, "POST", "/graphql", { query: BOARDS, variables: { org, after } });
    const conn = r.data?.organization?.projectsV2;
    for (const b of conn?.nodes ?? []) {
      const project = `${org}/${b.number}`;
      const scope = `board:${project}`;
      const st = await store.scope(scope);
      await put(PROJECT, { project, org, number: b.number, title: b.title, url: b.url, closed: !!b.closed, source_updated_at: b.updatedAt }, !st.baselined);
      // Open boards are read hourly; a closed one weekly (it rarely changes, and an item whose content was refused is retried then).
      if (st.baselined && now - Date.parse(st.cursor ?? "") < (b.closed ? CLOSED_EVERY : BOARD_EVERY)) continue;
      const seen = new Set<string>();
      const stored = await store.pool.query(`SELECT item_id, content_type FROM src_github.project_item WHERE project = $1 AND NOT removed`, [project]);
      const unread = new Set<string>(stored.rows.filter((x: any) => x.content_type === null).map((x: any) => x.item_id)); // stored without its content: its first read is a backfill, not a change
      let cur: string | null = null;
      do {
        const p = await gh.request(org, "POST", "/graphql", { query: ITEMS, variables: { org, number: b.number, after: cur } });
        const items = p.data?.organization?.projectV2?.items;
        cost += p.data?.rateLimit?.cost ?? 0;
        const refused = new Set<number>((Array.isArray(p.errors) ? p.errors : []).filter(isContentRefusal).map((e: any) => e.path.at(-2)));
        for (const [i, n] of (items?.nodes ?? []).entries()) {
          seen.add(n.id);
          if (st.baselined && unread.has(n.id) && !refused.has(i)) {
            // The board's own columns go the normal way (their changes are logged); only the newly read content is a backfill.
            // The newly read content goes first, as a backfill (url included, so it is no difference below); then the board's own
            // columns the normal way: their changes are logged, with the url the change record links to.
            const full = itemRow(project, n);
            const { fields: _f, archived: _a, removed: _r, source_updated_at: _s, ...content } = full;
            await put(ITEM, content, true);
            await put(ITEM, { ...itemRow(project, n, true), url: full.url }, false);
          } else await put(ITEM, itemRow(project, n, refused.has(i)), !st.baselined);
        }
        cur = items?.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
      } while (cur);
      for (const { item_id } of stored.rows) if (!seen.has(item_id)) await put(ITEM, { project, item_id, removed: true }, false);
      await store.saveScope(scope, new Date(now).toISOString(), true);
    }
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  if (cost) log?.info({ org, graphql_points: cost }, "src_github boards read");
  return written;
}

/** The org a scope row belongs to: `org:<org>` (a pass's own name) or one of the org's sync scopes (`issues:<org>`,
 * `prs:<org>`, `board:<org>/<n>`); undefined for a scope of another shape. */
const scopeOrg = (scope: string): string | undefined =>
  /^(?:org|issues|prs):(.+)$/.exec(scope)?.[1] ?? /^board:([^/]+)\//.exec(scope)?.[1];

/**
 * An org is no longer configured: one `status = 'retired'` ingest_run row for `org:<org>` (the scope its passes ran as; no
 * error, since it is a marker, not a failed pass) so readers drop the scope's stale failure at once, then every scope row
 * that org holds, so a re-added org syncs from a clean baseline. The org's data rows (issue, project, project_item) stay:
 * only the sync and its scope rows go. The writer role holds INSERT, not SELECT, on src_meta.ingest_run (sources.sql), so
 * the row is a direct INSERT, not a read of the pass record.
 */
async function retireOrg(store: SourceStore, org: string, scopes: string[], log: Logger): Promise<void> {
  try {
    await store.pool.query(`INSERT INTO src_meta.ingest_run (source, scope, started_at, rows, error, status) VALUES ($1, $2, now(), 0, NULL, 'retired')`, ["github", `org:${org}`]);
    for (const scope of scopes) await store.pool.query(`DELETE FROM src_github.scope WHERE scope = $1`, [scope]);
  } catch (err) {
    // The next tick sees the scope rows still there and retires the org then; one org never stops the others' passes.
    log.warn({ org, err: String(err).slice(0, 300) }, "src_github scope retirement failed");
  }
}

/**
 * Every 15 minutes, each org in turn, each pass recorded in src_meta.ingest_run (an org the owner can't read records its
 * error). The configured list is authoritative: before the first pass, every org the writer still holds scope rows for that
 * is no longer in it is retired (retireOrg), an org already orphaned when this first runs included.
 */
export function startSync(store: SourceStore, gh: Gh, orgs: string[], log: Logger, everyMs = 15 * 60_000): void {
  const configured = new Set(orgs.map((o) => o.toLowerCase()));
  const retireRemoved = async () => {
    const held = new Map<string, string[]>(); // org (as the scope row spells it) -> its scope rows
    for (const scope of (await store.scopesByPrefix("")).keys()) {
      const org = scopeOrg(scope);
      if (org) held.set(org, [...(held.get(org) ?? []), scope]);
    }
    for (const [org, scopes] of held) if (!configured.has(org.toLowerCase())) await retireOrg(store, org, scopes, log);
  };
  const tick = async () => {
    await retireRemoved().catch((err) => log.warn({ err: String(err).slice(0, 300) }, "src_github scope retirement pass failed"));
    for (const org of orgs) {
      try {
        // The org's own scope row, saved before its first request: an org whose every pass fails never reaches saveScope
        // below, and this row is what retireRemoved finds once the org leaves the config.
        await store.saveScope(`org:${org}`, null);
        const rows = await store.run("github", `org:${org}`, () => syncOrg(store, gh, org, Date.now(), log));
        log.info({ org, rows }, "src_github sync done");
      } catch (err) {
        log.warn({ org, err: String(err).slice(0, 300) }, "src_github sync failed");
      }
    }
    setTimeout(tick, everyMs).unref();
  };
  setTimeout(tick, 30_000).unref();
}
