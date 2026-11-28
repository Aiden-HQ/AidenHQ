// src_jira writer (shared sources, docs/design/sources.md). Runs inside jira-mcp so it
// shares the one OAuth token pair and its refresh. It reads through Atlassian's MCP server (searchJiraIssuesUsingJql, pinned
// to the configured site): the sign-in's scopes are the MCP "agent-interface" ones, which Jira's REST and Agile APIs don't
// accept, so issue sprints come from the issues' sprint field (board id, name, state, dates, goal); the full boards list and
// board-to-sprint mapping come hourly from the same MCP's board tools (listJiraBoards, getJiraBoardConfig, listJiraBoardSprints,
// same read scope). Every 15 minutes:
// issues updated since the cursor (the first pass, the last BASELINE_DAYS days, is the baseline). Weekly, issues updated in
// the last 30 days that Jira no longer returns are marked deleted (Jira sends no delete signal). No LLM.
// Optional one-time history backfill per listed project (history_projects, 365 days; syncHistory).
// Confluence pages (src_jira.confluence_page) share this schema, DDL and sign-in; their passes are in src/confluence.ts.
import type { Logger } from "pino";
import { capText, SourceStore, tableDdl, USERS, type Row, type Table } from "./source-store.js";

const ISSUE: Table = {
  name: "issue",
  key: ["key"],
  cols: {
    key: "text", project: "text", issue_type: "text", summary: "text", description: "text", description_truncated: "boolean", status: "text",
    status_category: "text", assignee_id: "text", assignee: "text", reporter_id: "text", priority: "text", labels: "text[]", fix_versions: "text[]",
    parent_key: "text", sprint: "text", sprint_ids: "integer[]", due_date: "date", resolution: "text", resolved_at: "timestamptz",
    created_at_src: "timestamptz", source_updated_at: "timestamptz", url: "text", deleted: "boolean",
  },
  tracked: ["summary", "status", "assignee_id", "priority", "labels", "fix_versions", "parent_key", "sprint", "due_date", "resolution", "deleted"],
  scope: "project",
  url: "url",
  search: ["summary", "description"],
};
const SPRINT: Table = {
  name: "sprint",
  key: ["sprint_id"],
  cols: { sprint_id: "integer", board_id: "integer", name: "text", state: "text", start_date: "timestamptz", end_date: "timestamptz", complete_date: "timestamptz", goal: "text" },
  tracked: ["name", "state", "start_date", "end_date", "goal"],
  scope: "board_id",
};

const BOARD: Table = {
  name: "board",
  key: ["board_id"],
  cols: { board_id: "integer", name: "text", type: "text", project_keys: "text[]", filter_id: "text", filter_jql: "text" },
  tracked: ["name", "type", "project_keys", "filter_jql"],
  scope: "board_id",
};
const BOARD_SPRINT: Table = {
  name: "board_sprint",
  key: ["board_id", "sprint_id"],
  cols: { board_id: "integer", sprint_id: "integer", state: "text", start_date: "timestamptz", end_date: "timestamptz", complete_date: "timestamptz" },
  tracked: ["state", "start_date", "end_date", "complete_date"],
  scope: "board_id",
};

export const PAGE_T: Table = {
  name: "confluence_page",
  key: ["page_id"],
  cols: {
    page_id: "text", space: "text", title: "text", url: "text", owner_id: "text", owner_name: "text", last_modified_by: "text",
    created_at_src: "timestamptz", source_updated_at: "timestamptz", version: "text", body_excerpt: "text",
    summary: "text", summary_rev: "text", summary_model: "text", summary_prompt: "text", summarized_at: "timestamptz", summary_error: "text",
  },
  tracked: ["title", "version", "space", "owner_id"],
  scope: "space",
  url: "url",
  search: ["title", "summary", "body_excerpt"],
};

const common = "baseline, first_seen_at, ingested_at, seq";
export const DDL = `${tableDdl("src_jira", ISSUE)}
${tableDdl("src_jira", PAGE_T)}
${tableDdl("src_jira", SPRINT)}
${tableDdl("src_jira", USERS)}
${tableDdl("src_jira", BOARD)}
${tableDdl("src_jira", BOARD_SPRINT)}
CREATE OR REPLACE VIEW src_jira.issues AS
  SELECT key, project, issue_type, summary, description, description_truncated, status, status_category, assignee_id, assignee, reporter_id, priority,
    labels, fix_versions, parent_key, sprint, sprint_ids, due_date, resolution, resolved_at, created_at_src, source_updated_at, url, deleted, ${common}, tsv
  FROM src_jira.issue;
COMMENT ON VIEW src_jira.issues IS 'Jira issues on the configured site. source_updated_at is Jira''s; first_seen_at ours; baseline = from the first sync (not a recent change). sprint = the active (else latest) sprint''s name; sprint_ids join src_jira.sprints. description is plain text capped at 4 KB (description_truncated; url for the rest). deleted = gone from Jira (weekly check). People: assignee_id/reporter_id join src_jira.users. Field changes: src_jira.changes.';
CREATE OR REPLACE VIEW src_jira.sprints AS SELECT sprint_id, board_id, name, state, start_date, end_date, complete_date, goal, ${common} FROM src_jira.sprint;
COMMENT ON VIEW src_jira.sprints IS 'Jira sprints seen on issues (board_id = the Jira board); the full list is src_jira.board_sprints.';
CREATE OR REPLACE VIEW src_jira.boards AS SELECT board_id, name, type, project_keys, filter_id, filter_jql, ${common} FROM src_jira.board;
COMMENT ON VIEW src_jira.boards IS 'Every Jira board the signed-in owner can see (type scrum or kanban; project_keys and filter_jql = what the board shows). Hourly.';
CREATE OR REPLACE VIEW src_jira.board_sprints AS SELECT board_id, sprint_id, state, start_date, end_date, complete_date, ${common} FROM src_jira.board_sprint;
COMMENT ON VIEW src_jira.board_sprints IS 'Board to sprint mapping from the board''s own sprint list (a sprint can be on several boards); join src_jira.sprints on sprint_id for name and goal. Hourly.';
CREATE OR REPLACE VIEW src_jira.changes AS
  SELECT seq, entity, entity_id, scope, field, old_value, new_value, url, observed_at, false AS baseline FROM src_jira.change;
COMMENT ON VIEW src_jira.changes IS 'Field changes after the baseline: entity issue (scope = project key), confluence_page (scope = space key), sprint, board or board_sprint (scope = board id), with observed_at (when the sync saw it; Jira''s own time is the row''s source_updated_at).';
CREATE OR REPLACE VIEW src_jira.confluence_pages AS
  SELECT page_id, space, title, url, owner_id, owner_name, last_modified_by, created_at_src, source_updated_at, version, body_excerpt,
    summary, summary_rev, summary_model, summary_prompt, summarized_at, ${common}, tsv
  FROM src_jira.confluence_page;
COMMENT ON VIEW src_jira.confluence_pages IS 'Confluence pages on the configured site (pages modified in the last 30 days, then every change; Confluence is not in src_docs). Metadata, the link, a search excerpt, and a short summary by a cheap model (summary_model, summary_prompt) of version summary_rev, made once the page was quiet 3 hours: a pointer for finding pages, never evidence. Read the page live (getConfluenceContent, or Glean) before quoting, claiming or acting on it. space = space key. owner_id = the page creator''s account id (join src_jira.users). baseline = from the first sync. Changes (title, version = an edit, space = moved, owner_id): src_jira.changes, entity confluence_page, scope = space.';
COMMENT ON TABLE src_jira.users IS 'Jira people by account id: display name, email when Jira shows it.';
GRANT SELECT ON src_jira.confluence_pages, src_jira.issues, src_jira.sprints, src_jira.changes, src_jira.users, src_jira.boards, src_jira.board_sprints TO agents_open;`;

/** The text blocks of a tool result. */
export const textsOf = (r: Awaited<ReturnType<CallJira>>): string[] => (Array.isArray(r.content) ? r.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text));

/** searchJiraIssuesUsingJql through the proxy (args without cloudId; the proxy pins the site). */
export type CallJira = (tool: string, args: Record<string, unknown>) => Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>;

export const BASELINE_DAYS = 30;
export const DAY = 86_400_000;
const PAGE = 50;

/** The search result as {issues, next}: JSON in a text block or structured content (shapes Atlassian has used). */
function searchPage(r: Awaited<ReturnType<CallJira>>): { issues: any[]; next?: string } {
  const texts = textsOf(r);
  if (r.isError) throw new Error(`Jira search failed: ${String(texts.join(" ")).slice(0, 300)}`);
  for (const cand of [r.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return undefined; } })]) {
    const o = (cand as any)?.data ?? cand;
    if (Array.isArray(o?.issues)) return { issues: o.issues, ...(o.nextPageToken && !o.isLast ? { next: o.nextPageToken } : {}) };
  }
  throw new Error(`unexpected Jira search response: ${String(texts.join(" ")).slice(0, 200)}`);
}

/** Atlassian Document Format (or plain text) as plain text. */
function plain(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n?.text === "string") out.push(n.text);
    for (const c of Array.isArray(n?.content) ? n.content : []) walk(c);
    if (["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(n?.type)) out.push("\n");
  };
  walk(v);
  return out.join("").trim();
}

/** The sprint field: whichever field holds sprint objects (its custom field id differs per site). */
function sprintsOf(fields: Record<string, any>): any[] {
  for (const v of Object.values(fields ?? {})) if (Array.isArray(v) && v.length && v.every((s) => s && typeof s === "object" && "boardId" in s && "state" in s)) return v;
  return [];
}

function issueRow(i: any, site: string): Row {
  const f = i.fields ?? {};
  const sprints = sprintsOf(f);
  const current = sprints.find((s) => s.state === "active") ?? sprints.at(-1);
  const d = capText(plain(f.description));
  return {
    key: i.key, project: f.project?.key ?? String(i.key).split("-")[0], issue_type: f.issuetype?.name ?? null, summary: capText(f.summary ?? null).text,
    description: d.text, description_truncated: d.truncated, status: f.status?.name ?? null, status_category: f.status?.statusCategory?.name ?? null,
    assignee_id: f.assignee?.accountId ?? null, assignee: f.assignee?.displayName ?? null, reporter_id: f.reporter?.accountId ?? null, priority: f.priority?.name ?? null,
    labels: [...(f.labels ?? [])].sort(), fix_versions: (f.fixVersions ?? []).map((v: any) => v.name).sort(), parent_key: f.parent?.key ?? null,
    sprint: current?.name ?? null, sprint_ids: sprints.map((s) => Number(s.id)).filter(Number.isFinite), due_date: f.duedate ?? null,
    resolution: f.resolution?.name ?? null, resolved_at: f.resolutiondate ?? null, created_at_src: f.created ?? null, source_updated_at: f.updated ?? null,
    url: `${site.replace(/\/$/, "")}/browse/${i.key}`, deleted: false,
  };
}

async function* search(call: CallJira, jql: string, fields: string[]): AsyncGenerator<any> {
  let next: string | undefined;
  do {
    const p = searchPage(await call("searchJiraIssuesUsingJql", { jql, fields, maxResults: PAGE, ...(next ? { nextPageToken: next } : {}) }));
    for (const i of p.issues) yield i;
    next = p.next;
  } while (next);
}

/** One issue with its sprints and people. */
async function putIssue(put: (t: Table, row: Row, baseline: boolean) => Promise<void>, i: any, site: string, baseline: boolean): Promise<void> {
  const f = i.fields ?? {};
  await put(ISSUE, issueRow(i, site), baseline);
  for (const s of sprintsOf(f))
    await put(SPRINT, { sprint_id: Number(s.id), board_id: Number(s.boardId) || null, name: s.name ?? null, state: s.state ?? null, start_date: s.startDate ?? null, end_date: s.endDate ?? null, complete_date: s.completeDate ?? null, goal: s.goal || null }, baseline);
  for (const u of [f.assignee, f.reporter, f.creator].filter((u: any) => u?.accountId))
    await put(USERS, { user_id: u.accountId, display_name: u.displayName ?? null, ...(u.emailAddress ? { email: u.emailAddress } : {}), is_bot: u.accountType === "app" }, false);
}

/** The weekly delete check refused an answer too short to trust. */
class Refused extends Error {}

/** One pass: issues updated since the cursor (minute-relative JQL, so Jira's timezone never matters), and the weekly delete check. */
export async function syncJira(store: SourceStore, call: CallJira, site: string, now = Date.now()): Promise<number> {
  await store.migrate(DDL);
  let written = 0;
  const put = async (t: Table, row: Row, baseline: boolean) => void ((await store.upsert(t, row, { baseline })) !== "same" && written++);
  const st = await store.scope("issues");
  const baseline = !st.baselined;
  const since = st.cursor ? Date.parse(st.cursor) : now - BASELINE_DAYS * DAY;
  const minutes = Math.ceil((now - since) / 60_000) + 5; // overlap: unchanged rows are no-ops
  let newest = st.cursor ?? new Date(since).toISOString();
  for await (const i of search(call, `updated >= -${minutes}m ORDER BY updated ASC`, ["*navigable"])) {
    await putIssue(put, i, site, baseline);
    const u = i.fields?.updated;
    if (u && Date.parse(u) > Date.parse(newest)) newest = new Date(Date.parse(u)).toISOString();
  }
  await store.saveScope("issues", newest, true);

  const rec = await store.scope("reconcile");
  if (rec.baselined && now - Date.parse(rec.cursor ?? "") < 7 * DAY) return written;
  let checkedAt = now;
  if (rec.baselined) {
    // Its own ingest_run: a refused check is visible there and doesn't fail the issue sync; a failed search is retried tomorrow, a refusal waits the week.
    await store
      .run("jira", "reconcile", async () => {
        const live = new Set<string>();
        for await (const i of search(call, "updated >= -30d ORDER BY updated ASC", ["updated"])) live.add(i.key);
        const ours = await store.pool.query(`SELECT key FROM src_jira.issue WHERE NOT deleted AND source_updated_at > now() - interval '28 days'`);
        const gone = ours.rows.map((r: { key: string }) => r.key).filter((k: string) => !live.has(k));
        // Deletes are rare: an empty or short answer (paging not followed, a permission change) must not tombstone the site.
        if (ours.rows.length && (!live.size || gone.length > Math.max(5, ours.rows.length * 0.1))) throw new Refused(`delete check refused: ${gone.length} of ${ours.rows.length} recent issues missing from Jira's answer (${live.size} returned)`);
        for (const key of gone) await put(ISSUE, { key, deleted: true }, false);
        return gone.length;
      })
      .catch((err) => void (err instanceof Refused || (checkedAt = now - 6 * DAY)));
  }
  await store.saveScope("reconcile", new Date(checkedAt).toISOString(), true);
  return written;
}

/** A history pass stops starting new work after this long; the next pass resumes from the project's cursor. */
export const HISTORY_BUDGET_MS = 5 * 60_000;

/**
 * One-time backfill of quiet projects' history (the live pass only goes back BASELINE_DAYS site-wide): per listed project,
 * its issues updated in the last `days`, oldest first, stored as baseline rows. Resumable and time-bounded: the project's
 * cursor (newest updated seen) is saved as it goes and the project is marked done (scope baselined) only when its search
 * ended; a project that errors is logged and skipped, the others go on. Finished projects are never re-read, so a newly
 * listed project is picked up on the next pass. Returns rows written with a difference.
 */
export async function syncHistory(store: SourceStore, call: CallJira, site: string, projects: string[], days: number, now = Date.now(), budgetMs = HISTORY_BUDGET_MS, log?: Pick<Logger, "warn">): Promise<number> {
  await store.migrate(DDL);
  let written = 0;
  const started = Date.now();
  const put = async (t: Table, row: Row, baseline: boolean) => void ((await store.upsert(t, row, { baseline })) !== "same" && written++);
  for (const project of projects) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(project)) {
      log?.warn({ project }, "src_jira history: not a project key, skipped");
      continue;
    }
    const scope = `history:${project}`;
    const st = await store.scope(scope);
    if (st.baselined) continue;
    if (Date.now() - started >= budgetMs) break;
    let newest = st.cursor ?? new Date(now - days * DAY).toISOString();
    let done = false;
    try {
      const minutes = Math.ceil((now - Date.parse(newest)) / 60_000) + 5; // overlap: unchanged rows are no-ops
      done = true;
      for await (const i of search(call, `project = "${project}" AND updated >= -${minutes}m ORDER BY updated ASC`, ["*navigable"])) {
        await putIssue(put, i, site, true);
        const u = Date.parse(i.fields?.updated);
        if (u > Date.parse(newest)) newest = new Date(u).toISOString();
        if (Date.now() - started >= budgetMs) {
          done = false;
          break;
        }
      }
    } catch (err) {
      done = false;
      log?.warn({ project, err: String(err).slice(0, 200) }, "src_jira history: project failed, will resume");
    }
    await store.saveScope(scope, newest, done);
  }
  return written;
}

/** A tool result's JSON (structured content, or JSON in a text block); an error result throws its text. */
export function toolJson(r: Awaited<ReturnType<CallJira>>, tool: string): any {
  const texts = textsOf(r);
  if (r.isError) throw new Error(`${tool} failed: ${texts.join(" ").slice(0, 300)}`);
  for (const cand of [r.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return undefined; } })]) if (cand != null) return (cand as any).data ?? cand;
  throw new Error(`unexpected ${tool} response: ${texts.join(" ").slice(0, 200)}`);
}

/** The list inside a board-tool answer (the Agile API calls it values; the MCP wrappers may name it for what it holds). */
const listOf = (o: any, name: string): any[] => (Array.isArray(o) ? o : Array.isArray(o?.[name]) ? o[name] : Array.isArray(o?.values) ? o.values : []);

/** Every page of a board tool: pages on only when the answer says there is more (isLast false, or total above what we hold). */
async function pages(call: CallJira, tool: string, args: Record<string, unknown>, name: string): Promise<any[]> {
  const out: any[] = [];
  for (;;) {
    const o = toolJson(await call(tool, { ...args, ...(out.length ? { startAt: out.length } : {}) }), tool);
    const got = listOf(o, name);
    out.push(...got);
    if (!got.length || (o?.isLast !== false && !(Number(o?.total) > out.length))) return out;
  }
}

/** The hourly boards pass: every board, its project keys and filter, and its sprints. Baseline semantics as for issues. */
export async function syncBoards(store: SourceStore, call: CallJira, now = Date.now(), log?: Pick<Logger, "warn">): Promise<number> {
  await store.migrate(DDL);
  let written = 0;
  const failed: string[] = [];
  const put = async (t: Table, row: Row, baseline: boolean) => void ((await store.upsert(t, row, { baseline })) !== "same" && written++);
  const baseline = !(await store.scope("boards")).baselined;
  const boards = await pages(call, "listJiraBoards", {}, "boards");
  // An empty list means the tool is gated or the account sees no boards: say so rather than record an empty pass.
  if (!boards.length) throw new Error("listJiraBoards returned no boards (does the signed-in account have Jira Software access?)");
  for (const b of boards) {
    const id = Number(b.id ?? b.boardId);
    if (!Number.isFinite(id)) continue;
    const cfg = toolJson(await call("getJiraBoardConfig", { boardId: id }), "getJiraBoardConfig");
    const keys = new Set<string>();
    for (const p of [...listOf(b.projects, "projects"), b.location, ...listOf(cfg.projects, "projects"), cfg.location]) {
      const k = p?.projectKey ?? p?.key;
      if (typeof k === "string") keys.add(k);
    }
    const f = cfg.filter ?? b.filter ?? {};
    await put(BOARD, { board_id: id, name: b.name ?? cfg.name ?? null, type: b.type ?? cfg.type ?? null, project_keys: [...keys].sort(), filter_id: f.id != null ? String(f.id) : null, filter_jql: capText(f.query ?? f.jql ?? null).text }, baseline);
    // Only scrum boards have sprints; one board's sprint error (e.g. sprints switched off) doesn't fail the pass.
    if (String(b.type ?? cfg.type ?? "").toLowerCase() !== "scrum") continue;
    const sprints = await pages(call, "listJiraBoardSprints", { boardId: id }, "sprints").catch((err) => (failed.push(`${id}: ${String(err).slice(0, 120)}`), []));
    for (const s of sprints)
      if (Number.isFinite(Number(s.id))) await put(BOARD_SPRINT, { board_id: id, sprint_id: Number(s.id), state: s.state ?? null, start_date: s.startDate ?? null, end_date: s.endDate ?? null, complete_date: s.completeDate ?? null }, baseline);
  }
  if (failed.length) log?.warn({ boards: failed }, "src_jira: some boards' sprints couldn't be read");
  await store.saveScope("boards", new Date(now).toISOString(), true);
  return written;
}

/** Every 15 minutes, each pass recorded in src_meta.ingest_run (not signed in: the run records that error). */
export function startSync(store: SourceStore, call: CallJira, site: string, log: Logger, history: { projects: string[]; days: number } = { projects: [], days: 365 }, everyMs = 15 * 60_000, boardsEveryMs = 60 * 60_000): void {
  const tick = async () => {
    try {
      const rows = await store.run("jira", "issues", () => syncJira(store, call, site));
      log.info({ rows }, "src_jira sync done");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 300) }, "src_jira sync failed");
    }
    // The listed projects' history, once each (resumes across passes); its own ingest_run, and never fails the live pass.
    if (history.projects.length)
      await store.run("jira", "history", () => syncHistory(store, call, site, history.projects, history.days, Date.now(), HISTORY_BUDGET_MS, log)).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "src_jira history failed"));
    setTimeout(tick, everyMs).unref();
  };
  setTimeout(tick, 60_000).unref();
  // Boards hourly, in this process (one token refresher serves both).
  const boardTick = async () => {
    try {
      log.info({ rows: await store.run("jira", "boards", () => syncBoards(store, call, Date.now(), log)) }, "src_jira boards sync done");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 300) }, "src_jira boards sync failed");
    }
    setTimeout(boardTick, boardsEveryMs).unref();
  };
  setTimeout(boardTick, 120_000).unref();
}
