// Shared sources (docs/design/sources.md): the writer side. Each source writer (slack-live,
// github, jira, ops-mcp for meetings, google-workspace for docs) logs in to the warehouse as src_<source>, owns schema src_<source> (ops/warehouse-sources.sh
// creates both) and writes through this: typed upserts that keep first_seen_at, bump src_meta.seq on any difference and
// log tracked-field changes, a baseline flag for first syncs, per-scope sync state, and one src_meta.ingest_run per pass.
// No LLM anywhere: ingest is code.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it); third-party modules import
// @aidenhq/sdk/source-store (pg is theirs: a peer dependency).
import { readFileSync } from "node:fs";
import pg from "pg";

/** Long text is cut to about 4 KB by default; the row keeps a <field>_truncated flag and its url for the rest. */
const TEXT_CAP = 4096;

/** Text cut to `cap` bytes (whole characters), NULs dropped (Postgres text can't hold them). */
export function capText(s: string | null | undefined, cap = TEXT_CAP): { text: string | null; truncated: boolean } {
  if (s == null) return { text: null, truncated: false };
  const clean = s.replace(/\u0000/g, "");
  const buf = Buffer.from(clean, "utf8");
  if (buf.length <= cap) return { text: clean, truncated: false };
  return { text: buf.subarray(0, cap).toString("utf8").replace(/�+$/, ""), truncated: true };
}

/**
 * A source table. `cols` maps every written column to its Postgres type (key columns included). Changes to `tracked`
 * columns of an existing row are logged in <schema>.change (a jsonb column per key, as `<col>.<key>`), unless the write is
 * a baseline. Every table also has baseline, first_seen_at, ingested_at and seq (see tableDdl).
 */
export interface Table {
  name: string;
  key: string[];
  cols: Record<string, string>;
  tracked: string[];
  scope?: string; // column copied into change.scope (repo, project, channel) so consumers can filter changes
  url?: string; // column copied into change.url
  search?: string[]; // text columns behind a generated full-text column `tsv` (GIN-indexed; source_new's `q`)
}

/** People in a source, keyed by the source's own id: consumers resolve people by id, never by a model-read name. */
export const USERS: Table = { name: "users", key: ["user_id"], cols: { user_id: "text", handle: "text", display_name: "text", email: "text", is_bot: "boolean" }, tracked: [] };

export type Row = Record<string, unknown>;
type Upserted = "new" | "changed" | "same";

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

/** CREATE TABLE for a source table: its columns plus the common ones every source row carries. */
export function tableDdl(schema: string, t: Table): string {
  const cols = Object.entries(t.cols).map(([c, type]) => `  ${ident(c)} ${type}${t.key.includes(c) ? " NOT NULL" : ""}`);
  // 'simple': no stemming or stop words, so product names, codes and handles match as written.
  const tsv = t.search?.length ? `  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${t.search.map((c) => `coalesce(${ident(c)}, '')`).join(" || ' ' || ")})) STORED,\n` : "";
  return `CREATE TABLE IF NOT EXISTS ${ident(schema)}.${ident(t.name)} (
${cols.join(",\n")},
${tsv}  baseline boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  seq bigint NOT NULL DEFAULT nextval('src_meta.seq'),
  PRIMARY KEY (${t.key.map(ident).join(", ")})
);
CREATE INDEX IF NOT EXISTS ${t.name}_seq ON ${schema}.${t.name} (seq);${tsv ? `\nCREATE INDEX IF NOT EXISTS ${t.name}_tsv ON ${schema}.${t.name} USING gin (tsv);` : ""}`;
}

/** Per-scope sync state and the change log: in every source schema. */
function commonDdl(schema: string): string {
  const s = ident(schema);
  return `CREATE TABLE IF NOT EXISTS ${s}.scope (
  scope text PRIMARY KEY,
  baselined_at timestamptz,
  cursor text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${s}.change (
  seq bigint PRIMARY KEY DEFAULT nextval('src_meta.seq'),
  entity text NOT NULL,
  entity_id text NOT NULL,
  scope text,
  field text NOT NULL,
  old_value text,
  new_value text,
  url text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_entity ON ${s}.change (entity, entity_id);`;
}

const asText = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v));
const capped = (v: unknown) => capText(asText(v)).text;

/** What a pass reports beyond its row count (SourceStore.run). */
export type Pass = { complete?: { total: number; fetched: number } };

export class SourceStore {
  private migrated = false;
  readonly schema: string;
  readonly pool: pg.Pool;
  // Plain fields (no parameter properties): the kernel runs this file directly with Node's type stripping.
  constructor(schema: string, pool: pg.Pool) {
    this.schema = ident(schema);
    this.pool = pool;
  }

  /**
   * The writer's store, or undefined while it can't be (no password file: the warehouse module or its secret is missing).
   * WAREHOUSE_HOST defaults to the warehouse app's container, reached on the `sources` network (compose.yaml), which no app joins.
   */
  static fromEnv(source: string, env = process.env): SourceStore | undefined {
    const file = env.WAREHOUSE_PASSWORD_FILE;
    let password = "";
    try {
      password = file ? readFileSync(file, "utf8").trim() : "";
    } catch {
      return undefined;
    }
    if (!password) return undefined;
    const role = `src_${source}`;
    const pool = new pg.Pool({ host: env.WAREHOUSE_HOST || "app-warehouse-postgres-1", port: Number(env.WAREHOUSE_PORT || 5432), database: "warehouse", user: role, password, max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 });
    pool.on("error", () => undefined); // idle-client errors surface on the next query
    return new SourceStore(role, pool);
  }

  /** Runs the writer's DDL once per process, serialised across processes by an advisory lock. */
  async migrate(ddl: string): Promise<void> {
    if (this.migrated) return;
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext($1))", [this.schema]);
      try {
        await c.query(`${commonDdl(this.schema)}\n${ddl}`);
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [this.schema]);
      }
      this.migrated = true;
    } finally {
      c.release();
    }
  }

  async scope(scope: string): Promise<{ baselined: boolean; cursor: string | null }> {
    const r = await this.pool.query(`SELECT baselined_at, cursor FROM ${this.schema}.scope WHERE scope = $1`, [scope]);
    return { baselined: !!r.rows[0]?.baselined_at, cursor: r.rows[0]?.cursor ?? null };
  }

  /** Every scope whose name starts with `prefix`, with when it was last saved (epoch ms): lets a pass pick the oldest-synced first. */
  async scopesByPrefix(prefix: string): Promise<Map<string, { baselined: boolean; cursor: string | null; syncedAt: number }>> {
    const r = await this.pool.query(`SELECT scope, baselined_at, cursor, updated_at FROM ${this.schema}.scope WHERE starts_with(scope, $1)`, [prefix]);
    return new Map(r.rows.map((x) => [x.scope, { baselined: !!x.baselined_at, cursor: x.cursor ?? null, syncedAt: new Date(x.updated_at).getTime() }]));
  }

  /** Saves a scope's cursor; `baselined` marks its first full pass done (only after it completed). */
  async saveScope(scope: string, cursor: string | null, baselined = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.scope (scope, cursor, baselined_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
       ON CONFLICT (scope) DO UPDATE SET cursor = COALESCE(EXCLUDED.cursor, ${this.schema}.scope.cursor),
         baselined_at = COALESCE(${this.schema}.scope.baselined_at, EXCLUDED.baselined_at), updated_at = now()`,
      [scope, cursor, baselined],
    );
  }

  /**
   * Insert or update one row by its key. New rows carry `baseline`; an existing row is rewritten only when a written
   * column differs (seq and ingested_at bumped), and its tracked differences go to the change log unless `baseline`.
   */
  async upsert(t: Table, row: Row, o: { baseline: boolean }): Promise<Upserted> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        const r = await this.upsertIn(c, t, row, o.baseline);
        await c.query("COMMIT");
        return r;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        // Two writers inserted the same new row at once: the second retries as an update.
        if ((err as { code?: string }).code === "23505" && attempt === 0) continue;
        throw err;
      } finally {
        c.release();
      }
    }
  }

  private async upsertIn(c: pg.PoolClient, t: Table, row: Row, baseline: boolean): Promise<Upserted> {
    const s = this.schema;
    const cols = Object.keys(t.cols).filter((k) => k in row);
    const vals = cols.map((k) => (t.cols[k] === "jsonb" && row[k] != null ? JSON.stringify(row[k]) : row[k]));
    const typed = cols.map((k, i) => `$${i + 1}::${t.cols[k]} AS ${ident(k)}`).join(", ");
    const on = t.key.map((k) => `o.${ident(k)} = n.${ident(k)}`).join(" AND ");
    const diff = cols.filter((k) => !t.key.includes(k)).map((k) => `(o.${k} IS DISTINCT FROM n.${k}) AS "d_${k}", o.${k} AS "o_${k}"`);
    const q = `WITH n AS (SELECT ${typed}) SELECT true AS found${diff.length ? `, ${diff.join(", ")}` : ""}
      FROM n JOIN ${s}.${t.name} o ON ${on} FOR UPDATE OF o`;
    const cur = (await c.query(q, vals)).rows[0];
    if (!cur) {
      const names = [...cols, "baseline"].map(ident).join(", ");
      await c.query(`INSERT INTO ${s}.${t.name} (${names}) VALUES (${cols.map((k, i) => `$${i + 1}::${t.cols[k]}`).join(", ")}, $${cols.length + 1})`, [...vals, baseline]);
      return "new";
    }
    const changed = cols.filter((k) => cur[`d_${k}`]);
    if (!changed.length) return "same";
    const keyVals = t.key.map((k) => row[k]);
    // Only the parameters this statement uses (Postgres can't type an unused one).
    const used = [...changed, ...t.key];
    const sets = changed.map((k, i) => `${ident(k)} = $${i + 1}::${t.cols[k]}`).join(", ");
    const where = t.key.map((k, i) => `${ident(k)} = $${changed.length + i + 1}::${t.cols[k]}`).join(" AND ");
    // A row that changes after its baseline is no longer baseline: it is a recent change.
    await c.query(`UPDATE ${s}.${t.name} SET ${sets},${baseline ? "" : " baseline = false,"} ingested_at = now(), seq = nextval('src_meta.seq') WHERE ${where}`, used.map((k) => vals[cols.indexOf(k)]));
    if (baseline) return "changed";
    const entityId = keyVals.map(String).join("/");
    const scope = t.scope ? asText(row[t.scope]) : null;
    const url = t.url ? asText(row[t.url]) : null;
    for (const k of changed.filter((f) => t.tracked.includes(f))) {
      const pairs: [string, unknown, unknown][] =
        t.cols[k] === "jsonb"
          ? jsonDiff(cur[`o_${k}`], row[k]).map(([sub, a, b]) => [`${k}.${sub}`, a, b])
          : [[k, cur[`o_${k}`], row[k]]];
      for (const [field, a, b] of pairs)
        await c.query(`INSERT INTO ${s}.change (entity, entity_id, scope, field, old_value, new_value, url) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.name, entityId, scope, field, capped(a), capped(b), url]);
    }
    return "changed";
  }

  /**
   * One ingest pass: records src_meta.ingest_run (rows = rows written with a difference) and rethrows a failure.
   * `commit` is the git HEAD a repo target was read at, when the pass covers a checkout. A pass that read a scope to its end and
   * got a reliable count of what the source holds for it (the API's total) says so on `pass.complete`: `total` (the source's count)
   * and `fetched` (distinct records the pass read). The Fleet Steward flags a scope whose completed passes keep fetching fewer.
   * A pass that stopped early, resumed mid-scope or whose API gives no total leaves it unset.
   */
  async run(source: string, scope: string, fn: (pass: Pass) => Promise<number>, meta: { commit?: string | null } = {}): Promise<number> {
    const started = new Date();
    let rows = 0;
    let error: string | null = null;
    const pass: Pass = {};
    try {
      rows = await fn(pass);
      return rows;
    } catch (err) {
      error = String((err as Error).message ?? err).slice(0, 500);
      throw err;
    } finally {
      await this.pool
        .query(`INSERT INTO src_meta.ingest_run (source, scope, started_at, rows, error, commit, total, fetched) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [source, scope, started, rows, error, meta.commit || null, error ? null : (pass.complete?.total ?? null), error ? null : (pass.complete?.fetched ?? null)])
        .catch(() => undefined);
    }
  }
}

/** Top-level keys of two JSON objects whose values differ: [key, old, new]. */
function jsonDiff(a: unknown, b: unknown): [string, unknown, unknown][] {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const n = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].sort();
  return keys.filter((k) => stable(o[k] ?? null) !== stable(n[k] ?? null)).map((k) => [k, o[k] ?? null, n[k] ?? null]);
}

/** JSON with object keys sorted (jsonb returns keys in its own order). */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
