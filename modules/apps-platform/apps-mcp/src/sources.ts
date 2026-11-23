// Agents' read side of the warehouse (shared sources, docs/design/sources.md):
//   warehouse_query  one read-only SELECT as the `readonly` login (grants are the real control);
//   source_new       rows of a source view newer than the caller's cursor, with a code filter;
//   source_ack       advances that cursor once the caller has handled the rows.
// The cursor is keyed by the caller's Paperclip agent id (the kernel's assertion, never a tool argument), the view and the filter.
// Cursor writes go through the superuser psql path apps-mcp already uses, with values passed as psql variables;
// `readonly` has no write grant.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { WAREHOUSE } from "./database.js";

type View = { time: string; channel?: string; repo?: string; project?: string; tsv?: boolean; skip?: string };
/** One source as its module contributes it to the warehouse's point (modules/warehouse/schemas/sources.json). */
export type Source = { schema: string; about: string; identity?: "users"; module: string; views: ({ name: string; exclude?: { column: string; value: string } } & Omit<View, "skip">)[] };

/** The sources compiled to config/points/warehouse.json (`sources`); none when the warehouse module is off. */
export const SOURCES: Source[] = (() => {
  const file = process.env.WAREHOUSE_POINTS_FILE ?? "/config/points/warehouse.json";
  const list: Source[] = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).sources ?? []) : [];
  for (const s of list) if (s.schema === "src_meta" || list.filter((x) => x.schema === s.schema).length > 1) throw new Error(`warehouse.sources: ${s.schema} is contributed twice or is the warehouse's own: one module per schema`);
  return list;
})();

/**
 * The views source_new serves and which columns its filters use (tsv: full-text `q`). The schema checks every name as an
 * identifier and an exclude value as a plain word, so the SQL built from them carries nothing a module wrote freely.
 */
export const VIEWS: Record<string, View> = Object.fromEntries(SOURCES.flatMap((s) => s.views.map(({ name, exclude, ...v }) => [
  `${s.schema}.${name}`, { ...v, ...(exclude ? { skip: `${exclude.column} IS DISTINCT FROM '${exclude.value}'` } : {}) },
])));

export interface Filter { channels?: string[]; repos?: string[]; projects?: string[]; q?: string; include_baseline?: boolean }

const ROWS = 200; // warehouse_query row cap
const BYTES = 200_000; // warehouse_query result cap, enforced in SQL (capped below)
// source_new may ask for up to 500 rows, so its page gets a larger byte budget that the documented limit can reach. It
// is still a cap: a page ended by it returns fewer rows and says so (`capped`).
export const SOURCE_BYTES = 1_000_000;
const ROW_CHARS = 20_000; // one row's JSON at most (a longer row comes back as {_truncated_row: <its first ROW_CHARS characters>})

/**
 * Wraps a query whose rows are (n, r): r a row's JSON text cut to ROW_CHARS, n its order. Postgres keeps a running byte
 * total and sends r only while it stays within the cap (later rows come back with r null), so no large row or result
 * ever reaches apps-mcp.
 */
const capped = (inner: string, bytes: number) =>
  `SELECT n, CASE WHEN total <= ${bytes} THEN r END AS r FROM (
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
  return { text: capped(`SELECT seq AS n, ${rowText("v")} AS r FROM ${view} v WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${p(limit)}`, SOURCE_BYTES), values };
}

export interface WarehouseDeps {
  pool: Pick<pg.Pool, "connect" | "query">;
  sql: (script: string, vars: Record<string, string>) => Promise<string>; // superuser psql (platform.ts); stdout
}

/**
 * The Fleet Ops detector's two scope lists (`/internal/sources`), from src_meta.ingest_run.
 *   failing: every pass failed for 24 hours, counted from its first failure after its last good pass; recording within 8 days.
 *   short:   its last two passes that reported a total both fetched fewer records than the source held; recording within 8 days.
 * Both apply one condition: a scope whose newest pass carries `status = 'retired'` (its source stopped syncing it, e.g. an
 * org dropped from the source's configured list) is in neither list. Its last failure would otherwise stay "latest" for up
 * to 8 days while nothing syncs it; a re-added scope whose latest pass is normal again returns by itself.
 */
export async function scopeIssues(d: Pick<WarehouseDeps, "pool">): Promise<{ failing: Record<string, unknown>[]; short: Record<string, unknown>[] }> {
  // Each scope's newest pass; a retired newest row drops the scope from both lists below.
  const latest = `latest AS (SELECT DISTINCT ON (source, scope) source, scope, error, status, finished_at FROM src_meta.ingest_run ORDER BY source, scope, finished_at DESC)`;
  const f = await d.pool.query(
    `WITH ok AS (SELECT source, scope, max(finished_at) AS last_ok FROM src_meta.ingest_run WHERE error IS NULL GROUP BY source, scope), ${latest}
     SELECT l.source, l.scope, left(l.error, 500) AS error, ok.last_ok AS since
     FROM latest l LEFT JOIN ok USING (source, scope)
     WHERE l.error IS NOT NULL AND l.finished_at > now() - interval '8 days' AND l.status IS DISTINCT FROM 'retired'
       AND (SELECT min(i.finished_at) FROM src_meta.ingest_run i WHERE i.source = l.source AND i.scope = l.scope AND i.error IS NOT NULL AND i.finished_at > COALESCE(ok.last_ok, '-infinity')) < now() - interval '24 hours'
     ORDER BY l.source, l.scope`,
  );
  const sh = await d.pool.query(
    `WITH ${latest}
     SELECT t.source, t.scope, (array_agg(t.total ORDER BY t.finished_at DESC))[1] AS total, (array_agg(t.fetched ORDER BY t.finished_at DESC))[1] AS fetched
     FROM (SELECT i.source, i.scope, i.total, i.fetched, i.finished_at, row_number() OVER (PARTITION BY i.source, i.scope ORDER BY i.finished_at DESC) AS n
           FROM src_meta.ingest_run i JOIN latest l USING (source, scope)
           WHERE i.error IS NULL AND i.total IS NOT NULL AND l.status IS DISTINCT FROM 'retired') t
     WHERE t.n <= 2
     GROUP BY t.source, t.scope
     HAVING count(*) = 2 AND bool_and(t.fetched < t.total) AND max(t.finished_at) > now() - interval '8 days'
     ORDER BY t.source, t.scope`,
  );
  return { failing: f.rows, short: sh.rows };
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
    const r = await c.query({ text: capped(inner, BYTES), queryMode: "extended" } as pg.QueryConfig);
    const got = parseRows(r.rows.slice(0, ROWS));
    return { rows: got.rows, truncated: got.cut || r.rows.length > ROWS || got.rows.some((x) => "_truncated_row" in x) };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/**
 * The cursor a read keeps: '' unfiltered, else a hash of its scopes and words, so acking a filtered read never moves
 * another read's cursor past rows that filter didn't return. include_baseline only adds rows, so it isn't part of it.
 */
export function filterKey(f: Filter): string {
  const list = (x?: string[]) => [...new Set(x ?? [])].sort();
  const n = { channels: list(f.channels), repos: list(f.repos), projects: list(f.projects), q: f.q?.trim() ?? "" };
  if (!n.channels.length && !n.repos.length && !n.projects.length && !n.q) return "";
  return createHash("sha256").update(JSON.stringify(n)).digest("hex").slice(0, 16);
}
/** A cursor token: the seq, then `.<filter key>` for a filtered read. */
const TOKEN = /^(\d{1,18})(?:\.([0-9a-f]{16}))?$/;

/**
 * Refuses scope values (channels, repos, projects) with no row in the view's source: a guessed name would read nothing
 * and say nothing. A changes view has rows only for changed entities, so every view of the same source counts.
 */
async function checkScopes(d: WarehouseDeps, view: string, f: Filter): Promise<void> {
  const schema = view.slice(0, view.indexOf("."));
  const bad: string[] = [];
  for (const [k, field] of [["channels", "channel"], ["repos", "repo"], ["projects", "project"]] as const) {
    const want = [...new Set(f[k] ?? [])];
    if (!want.length) continue;
    const homes = Object.entries(VIEWS).filter(([n, v]) => n.startsWith(`${schema}.`) && v[field]).map(([n, v]) => [n, v[field]!] as const);
    const missing = await d.pool.query(`SELECT u FROM unnest($1::text[]) u WHERE ${homes.map(([n, c]) => `NOT EXISTS (SELECT 1 FROM ${n} WHERE ${c} = u)`).join(" AND ")}`, [want]);
    const all = homes.map(([n, c]) => `SELECT ${c} AS s FROM ${n}`).join(" UNION ");
    for (const { u } of missing.rows.slice(0, 5) as { u: string }[]) {
      // Suggest values sharing the last part of the name (acme/bridge → bridge/bridge), else a few that exist.
      const like = `%${u.split("/").pop()!.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      const near = await d.pool.query(`SELECT s FROM (${all}) x WHERE s ILIKE $1 ORDER BY s LIMIT 6`, [like]);
      const some = near.rows.length ? near.rows : (await d.pool.query(`SELECT s FROM (${all}) x WHERE s IS NOT NULL ORDER BY s LIMIT 10`)).rows;
      bad.push(`${u} (${near.rows.length ? "did you mean" : "some that exist:"} ${some.map((r: { s: string }) => r.s).join(", ")})`);
    }
    if (missing.rows.length > 5) bad.push(`and ${missing.rows.length - 5} more`);
  }
  if (bad.length) throw new Error(`${view}: nothing ingested for ${bad.join("; ")}. Filter only by values that exist (look them up with warehouse_query); nothing was read.`);
}

export async function sourceNew(d: WarehouseDeps, agentId: string, view: string, f: Filter, limit: number) {
  const key = filterKey(f);
  newRowsSql(view, f, null, limit); // the view and its filters exist, before their values are looked up
  await checkScopes(d, view, f);
  // A filtered read starts after the later of its own cursor and the unfiltered one (whose reads covered every scope), or a
  // day back.
  const cur = await d.pool.query("SELECT filter_key, seq FROM src_meta.cursor WHERE agent_id = $1 AND view = $2 AND filter_key IN ('', $3)", [agentId, view, key]);
  // A view's rows are never deleted, so its seq only grows: a stored cursor past the newest seq cannot be a read position
  // in this view (a cursor from before a seq reset, or from another column), and would keep `seq > cursor` false forever.
  const top = await d.pool.query(`SELECT max(seq) AS seq FROM ${view}`);
  const newest = top.rows[0]?.seq == null ? null : Number(top.rows[0].seq);
  const stored = cur.rows.length ? Math.max(...cur.rows.map((r) => Number(r.seq))) : null;
  const cursor = stored != null && (newest == null || stored > newest) ? null : stored;
  const q = newRowsSql(view, f, cursor, limit);
  const r = await d.pool.query(q.text, q.values);
  const got = parseRows(r.rows);
  const last = got.rows.length ? r.rows[got.rows.length - 1].n : undefined; // n = the row's seq
  const seq = last != null ? String(last) : cursor != null ? String(cursor) : null;
  return {
    rows: got.rows,
    // Ack this once the rows are handled; the next call with the same filter starts after it.
    cursor: seq != null && key ? `${seq}.${key}` : seq,
    // True when the page is smaller than `limit` because the size guard withheld its remaining rows.
    capped: got.cut,
    byte_cap: SOURCE_BYTES,
    more: got.cut || r.rows.length === limit,
  };
}

export async function sourceAck(d: WarehouseDeps, agentId: string, view: string, cursor: string): Promise<{ view: string; cursor: string }> {
  if (!VIEWS[view]) throw new Error(`unknown view ${view}`);
  const m = TOKEN.exec(cursor);
  if (!m) throw new Error("cursor must be the cursor source_new returned");
  // A cursor past the view's newest row is not a position in it (a seq reset, or a timestamp acked as a cursor): refuse it,
  // so a bad ack can't wedge the read again.
  const top = await d.pool.query(`SELECT max(seq) AS seq FROM ${view}`);
  const newest = top.rows[0]?.seq == null ? null : Number(top.rows[0].seq);
  if (newest == null || Number(m[1]) > newest) throw new Error(`cursor is past the newest row in ${view}; pass the cursor source_new returned`);
  await d.sql(
    // Move forward, but never store a position past the view's newest row: a cursor that is already past it (a seq reset
    // or a foreign value) is replaced by this ack, so the next read resumes from real rows instead of staying stuck.
    `INSERT INTO src_meta.cursor (agent_id, view, filter_key, seq) VALUES (:'agent', :'view', :'key', :'seq'::bigint)
     ON CONFLICT (agent_id, view, filter_key) DO UPDATE SET seq = CASE
       WHEN src_meta.cursor.seq > (SELECT COALESCE(max(seq), 0) FROM ${view}) THEN EXCLUDED.seq
       ELSE GREATEST(src_meta.cursor.seq, EXCLUDED.seq) END, updated_at = now();`,
    { agent: agentId, view, key: m[2] ?? "", seq: m[1]! },
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
