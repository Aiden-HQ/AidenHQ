// Runs INSIDE the Paperclip container (retention.ts pipes it to `node -`): the container has no psql, but its bundled `pg`
// reaches the embedded Postgres. Prunes what Paperclip never prunes itself: heartbeat runs finished more than RUN_DAYS ago
// with their dependents, and activity_log rows older than ACTIVITY_DAYS. The foreign keys are read from the live catalogue, so
// a Paperclip upgrade that adds a referrer is handled (or fails loudly at the DELETE, never half-way: each batch is one
// transaction).
//   - run-owned rows (OWNED) are deleted with their run;
//   - a nullable reference (activity_log.run_id, cost_events.heartbeat_run_id, ...) is set to NULL: the row outlives its run;
//   - a NOT NULL reference (decisions, native results, ...) keeps its run: a run something still depends on is never deleted;
//   - ON DELETE CASCADE / SET NULL are the database's own.
// Then the execution workspaces nothing references any more, and the run logs on disk of the deleted runs.
import { createRequire } from "node:module";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RUN_DAYS = Number(process.env.RUN_DAYS), ACTIVITY_DAYS = Number(process.env.ACTIVITY_DAYS), BATCH = Number(process.env.BATCH || 500);
if (!(RUN_DAYS > 0) || !(ACTIVITY_DAYS > 0)) throw new Error("RUN_DAYS and ACTIVITY_DAYS are required");
const OWNED = new Set(["heartbeat_run_events", "environment_leases", "workspace_operations"]);
const LOGS = join(process.env.PAPERCLIP_HOME || "/paperclip", "instances/default/data/run-logs");
const pgDir = process.env.PG_MODULE_DIR || "/app/node_modules/.pnpm/" + readdirSync("/app/node_modules/.pnpm").find((d) => d.startsWith("pg@")) + "/node_modules/pg";
const { Client } = createRequire(import.meta.url)(pgDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

const c = new Client({ host: process.env.PAPERCLIP_PG_HOST || "127.0.0.1", port: Number(process.env.PAPERCLIP_PG_PORT || 54329), user: process.env.PAPERCLIP_PG_USER || "paperclip", password: process.env.PAPERCLIP_PG_PASSWORD || "paperclip", database: process.env.PAPERCLIP_PG_DB || "paperclip" });
await c.connect();
await c.query("SET lock_timeout = '5s'");

/** Every foreign key into `parent`.id from another table, for the key columns that point at `id`: [{ table, col, notNull, del }]. */
async function referrers(parent) {
  const { rows } = await c.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, a.attnotnull AS notnull, c.confdeltype AS del
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(ck, fk)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck
    JOIN pg_attribute p ON p.attrelid = c.confrelid AND p.attnum = k.fk AND p.attname = 'id'
    WHERE c.contype = 'f' AND c.confrelid = $1::regclass`, [parent]);
  return rows.map((r) => ({ table: r.tbl, col: r.col, notNull: r.notnull, del: r.del }));
}
const dedupe = (rs) => [...new Map(rs.map((r) => [`${r.table}.${r.col}`, r])).values()];

const stats = { runs: 0, owned: {}, nulled: {}, workspaces: 0, activity: 0, logs: 0 };

// 1. Runs.
const bare = (t) => t.replace(/^public\./, "");
const runRefs = dedupe(await referrers("heartbeat_runs"));
const owned = runRefs.filter((r) => OWNED.has(bare(r.table)));
const nulls = runRefs.filter((r) => !OWNED.has(bare(r.table)) && (r.del === "a" || r.del === "r") && !r.notNull);
const blockers = runRefs.filter((r) => !OWNED.has(bare(r.table)) && (r.del === "a" || r.del === "r") && r.notNull);
const notBlocked = blockers.map((b) => `AND NOT EXISTS (SELECT 1 FROM ${b.table} x WHERE x.${q(b.col)} = r.id)`).join(" ");
for (;;) {
  const { rows } = await c.query(`SELECT r.id, r.log_store, r.log_ref FROM heartbeat_runs r WHERE r.status NOT IN ('queued', 'running') AND r.finished_at < now() - make_interval(days => $1) ${notBlocked} ORDER BY r.finished_at LIMIT $2`, [RUN_DAYS, BATCH]);
  if (!rows.length) break;
  const ids = rows.map((r) => r.id);
  await c.query("BEGIN");
  try {
    for (const o of owned) stats.owned[o.table] = (stats.owned[o.table] ?? 0) + (await c.query(`DELETE FROM ${o.table} WHERE ${q(o.col)} = ANY($1)`, [ids])).rowCount;
    for (const n of nulls) stats.nulled[n.table] = (stats.nulled[n.table] ?? 0) + (await c.query(`UPDATE ${n.table} SET ${q(n.col)} = NULL WHERE ${q(n.col)} = ANY($1)`, [ids])).rowCount;
    stats.runs += (await c.query("DELETE FROM heartbeat_runs WHERE id = ANY($1)", [ids])).rowCount;
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  for (const r of rows) if (r.log_store === "local_file" && r.log_ref && !r.log_ref.includes("..")) { try { unlinkSync(join(LOGS, r.log_ref)); stats.logs++; } catch (e) { if (e.code !== "ENOENT") throw e; } }
  await sleep(200);
}

// 2. Execution workspaces nothing references (an issue, a surviving lease or operation, a derived workspace...). The self reference
// counts, so a workspace someone was derived from stays. Only those older than RUN_DAYS.
const wsRefs = dedupe(await referrers("execution_workspaces")).filter((r) => r.del !== "c");
const unreferenced = wsRefs.map((b) => `NOT EXISTS (SELECT 1 FROM ${b.table} x WHERE x.${q(b.col)} = w.id)`).join(" AND ") || "TRUE";
for (;;) {
  const r = await c.query(`DELETE FROM execution_workspaces WHERE id IN (SELECT w.id FROM execution_workspaces w WHERE w.created_at < now() - make_interval(days => $1) AND ${unreferenced} LIMIT $2)`, [RUN_DAYS, BATCH]);
  stats.workspaces += r.rowCount;
  if (r.rowCount < BATCH) break;
  await sleep(200);
}

// 3. Activity.
for (;;) {
  const r = await c.query("DELETE FROM activity_log WHERE id IN (SELECT id FROM activity_log WHERE created_at < now() - make_interval(days => $1) LIMIT $2)", [ACTIVITY_DAYS, BATCH * 4]);
  stats.activity += r.rowCount;
  if (r.rowCount < BATCH * 4) break;
  await sleep(200);
}
await c.end();
console.log(JSON.stringify(stats));
