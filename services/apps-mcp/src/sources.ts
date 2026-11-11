// Agents' read side of the warehouse (shared sources, docs/design/sources.md):
//   warehouse_query  one read-only SELECT as the `readonly` login (grants are the real control);
//   source_new       rows of a source view newer than the caller's cursor, with a code filter;
//   source_ack       advances that cursor once the caller has handled the rows.
// The cursor is keyed by the caller's Paperclip agent id (agent-auth), never a tool argument. Cursor writes go through the
// superuser psql path apps-mcp already uses, with values passed as psql variables; `readonly` has no write grant.
import { readFileSync } from "node:fs";
import pg from "pg";
import { WAREHOUSE } from "./database.js";

/** The views source_new serves and which columns its filters use (tsv: full-text `q`). */
export const VIEWS: Record<string, { time: string; channel?: string; repo?: string; project?: string; tsv?: boolean; skip?: string }> = {
  "src_slack.messages": { time: "ingested_at", channel: "channel_id", tsv: true },
  "src_slack.threads": { time: "ingested_at", channel: "channel_id" },
  "src_slack.changes": { time: "observed_at", channel: "channel_id" },
  "src_github.issues": { time: "ingested_at", repo: "repo", tsv: true },
  "src_github.project_items": { time: "ingested_at", repo: "repo", project: "project", tsv: true },
  "src_github.changes": { time: "observed_at", repo: "scope", project: "scope" },
  "src_jira.issues": { time: "ingested_at", project: "project", tsv: true },
  "src_jira.sprints": { time: "ingested_at" },
  "src_jira.confluence_pages": { time: "ingested_at", project: "space", tsv: true },
  "src_jira.changes": { time: "observed_at", project: "scope" },
  "src_meetings.meetings": { time: "ingested_at", tsv: true },
  "src_meetings.changes": { time: "observed_at" },
  "src_docs.docs": { time: "ingested_at", project: "container", tsv: true },
  "src_docs.changes": { time: "observed_at", project: "scope" },
  // A reviewed false positive (verdict not-affected, current until the finding changes) isn't new work.
  "src_security.findings": { time: "ingested_at", project: "target", tsv: true, skip: "verdict IS DISTINCT FROM 'not-affected'" },
  "src_security.changes": { time: "observed_at", project: "scope" },
};

export interface Filter { channels?: string[]; repos?: string[]; projects?: string[]; q?: string; include_baseline?: boolean }

const ROWS = 200; // warehouse_query row cap
const BYTES = 200_000; // result cap for either tool, enforced in SQL (capped below)
const ROW_CHARS = 20_000; // one row's JSON at most (a longer row comes back as {_truncated_row: <its first ROW_CHARS characters>})

/**
 * Wraps a query whose rows are (n, r): r a row's JSON text cut to ROW_CHARS, n its order. Postgres keeps a running byte
 * total and sends r only while it stays within BYTES (later rows come back with r null), so no large row or result
 * ever reaches apps-mcp.
 */
const capped = (inner: string) =>
  `SELECT n, CASE WHEN total <= ${BYTES} THEN r END AS r FROM (
     SELECT n, r, sum(octet_length(r)) OVER (ORDER BY n ROWS UNBOUNDED PRECEDING) AS total FROM (${inner}) a
   ) b ORDER BY n`;
const rowText = (alias: string) => `left((to_jsonb(${alias}) - 'tsv')::text, ${ROW_CHARS})`;

/** Capped rows back to objects: stops at the first row the byte cap withheld. */
function parseRows(rows: { r: string | null }[]): { rows: Record<string, unknown>[]; cut: boolean } {
  const out: Record<string, unknown>[] = [];
  for (const { r } of rows) {
    if (r == null) return { rows: out, cut: true };
    try {
      out.push(JSON.parse(r));
    } catch {
      out.push({ _truncated_row: r });
    }
  }
  return { rows: out, cut: false };
}

/**
 * source_new's SQL: rows after the cursor (or, with no cursor yet, written in the last day), oldest first, filtered,
 * excluding baseline rows unless asked. Rows younger than 5 seconds wait for the next call, so a writer's transaction
 * that took a lower seq but committed later isn't skipped.
 */
export function newRowsSql(view: string, f: Filter, cursor: number | null, limit: number): { text: string; values: unknown[] } {
  const v = VIEWS[view];
  if (!v) throw new Error(`unknown view ${view} (one of ${Object.keys(VIEWS).join(", ")})`);
  const values: unknown[] = [];
  const p = (x: unknown) => (values.push(x), `$${values.length}`);
  const where = [cursor == null ? `${v.time} > now() - interval '1 day'` : `seq > ${p(cursor)}`, `${v.time} < now() - interval '5 seconds'`];
  if (!f.include_baseline) where.push("NOT baseline");
  if (v.skip) where.push(v.skip);
  for (const [k, col] of [["channels", v.channel], ["repos", v.repo], ["projects", v.project]] as const) {
    const list = f[k];
    if (!list?.length) continue;
    if (!col) throw new Error(`${view} has no ${k} filter`);
    where.push(`${col} = ANY(${p(list)}::text[])`);
  }
  if (f.q) {
    if (!v.tsv) throw new Error(`${view} has no full-text column; q works on ${Object.keys(VIEWS).filter((k) => VIEWS[k]!.tsv).join(", ")}`);
    where.push(`tsv @@ websearch_to_tsquery('simple', ${p(f.q)})`);
  }
  return { text: capped(`SELECT seq AS n, ${rowText("v")} AS r FROM ${view} v WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${p(limit)}`), values };
}

export interface WarehouseDeps {
  pool: Pick<pg.Pool, "connect" | "query">;
  sql: (script: string, vars: Record<string, string>) => Promise<string>; // superuser psql (platform.ts); stdout
}

/** The readonly pool, from the warehouse app's vault dir (apps-mcp's /secrets/apps); undefined while it has no password. */
export function readonlyPool(secretsDir: string): pg.Pool | undefined {
  let password = "";
  try {
    password = readFileSync(`${secretsDir}/warehouse/READONLY_PASSWORD`, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!password) return undefined;
  const pool = new pg.Pool({ host: WAREHOUSE.container, port: WAREHOUSE.port, database: WAREHOUSE.db, user: "readonly", password, max: 4, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  return pool;
}

/** One statement, read-only, 15 s, at most ROWS rows. The extended protocol refuses a second statement. */
export async function warehouseQuery(d: WarehouseDeps, sql: string): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const body = sql.trim().replace(/;\s*$/, "");
  if (!body) throw new Error("empty query");
  const c = await d.pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '15s'");
    const inner = `SELECT row_number() OVER () AS n, ${rowText("_q")} AS r FROM (${body}\n) _q LIMIT ${ROWS + 1}`;
    const r = await c.query({ text: capped(inner), queryMode: "extended" } as pg.QueryConfig);
    const got = parseRows(r.rows.slice(0, ROWS));
    return { rows: got.rows, truncated: got.cut || r.rows.length > ROWS || got.rows.some((x) => "_truncated_row" in x) };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

export async function sourceNew(d: WarehouseDeps, agentId: string, view: string, f: Filter, limit: number) {
  const cur = await d.pool.query("SELECT seq FROM src_meta.cursor WHERE agent_id = $1 AND view = $2", [agentId, view]);
  const cursor = cur.rows[0] ? Number(cur.rows[0].seq) : null;
  const q = newRowsSql(view, f, cursor, limit);
  const r = await d.pool.query(q.text, q.values);
  const got = parseRows(r.rows);
  const last = got.rows.length ? r.rows[got.rows.length - 1].n : undefined; // n = the row's seq
  return {
    rows: got.rows,
    // Ack this once the rows are handled; the next call starts after it.
    cursor: last != null ? String(last) : cursor != null ? String(cursor) : null,
    more: got.cut || r.rows.length === limit,
  };
}

export async function sourceAck(d: WarehouseDeps, agentId: string, view: string, cursor: string): Promise<{ view: string; cursor: string }> {
  if (!VIEWS[view]) throw new Error(`unknown view ${view}`);
  if (!/^\d{1,18}$/.test(cursor)) throw new Error("cursor must be the cursor source_new returned");
  await d.sql(
    `INSERT INTO src_meta.cursor (agent_id, view, seq) VALUES (:'agent', :'view', :'seq'::bigint)
     ON CONFLICT (agent_id, view) DO UPDATE SET seq = GREATEST(src_meta.cursor.seq, EXCLUDED.seq), updated_at = now();`,
    { agent: agentId, view, seq: cursor },
  );
  return { view, cursor };
}

/**
 * Security Watch's verdict on a finding (src_security.verdict, shown on the findings view while the finding is unchanged).
 * The finding's current severity, fix and presence are copied in by the statement itself, so the verdict lapses when they change.
 */
export async function findingVerdict(d: WarehouseDeps, agentName: string, findingId: string, verdict: "not-affected" | "confirmed", reason: string) {
  const r = await d.pool.query("SELECT 1 FROM src_security.findings WHERE finding_id = $1", [findingId]);
  if (!r.rows.length) throw new Error(`no finding ${findingId}`);
  await d.sql(
    `INSERT INTO src_security.verdict (finding_id, verdict, reason, by_agent, at_severity, at_fixed_version, at_fix_state, at_present)
     SELECT finding_id, :'verdict', :'reason', :'agent', severity, fixed_version, fix_state, present FROM src_security.finding WHERE finding_id = :'id'
     ON CONFLICT (finding_id) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, by_agent = EXCLUDED.by_agent, decided_at = now(),
       at_severity = EXCLUDED.at_severity, at_fixed_version = EXCLUDED.at_fixed_version, at_fix_state = EXCLUDED.at_fix_state, at_present = EXCLUDED.at_present;`,
    { id: findingId, verdict, reason, agent: agentName },
  );
  return { finding_id: findingId, verdict };
}
