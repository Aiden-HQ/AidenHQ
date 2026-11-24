// Runs INSIDE the Paperclip container (retention.ts pipes it to `node --input-type=module -`): the container has no psql, but its
// bundled `pg` reaches the embedded Postgres. Prunes what Paperclip never prunes itself: heartbeat runs finished more than
// RUN_DAYS ago with their dependents, and activity_log rows older than ACTIVITY_DAYS. The foreign keys are read from the live
// catalogue, so a Paperclip upgrade that adds a referrer is handled (or fails loudly at the DELETE, never half-way: each batch is
// one transaction). For a run:
//   - run-owned rows (OWNED) are deleted with it, and its run log on disk;
//   - a nullable NO ACTION reference (activity_log.run_id, cost_events.heartbeat_run_id, ...) is set to NULL: the row outlives its run;
//   - a NOT NULL reference (decisions, native results, ...) keeps its run: a run something still depends on is never deleted;
//   - ON DELETE CASCADE / SET NULL are the database's own;
//   - a run still owed its cost accounting, or holding a lease that is not released or expired (teardown or recovery pending), stays.
// Then the execution workspaces nothing references any more. One pass at a time (an advisory lock), bounded in time (DEADLINE_MIN)
// and per statement.
import { createRequire } from "node:module";
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RUN_DAYS = Number(process.env.RUN_DAYS), ACTIVITY_DAYS = Number(process.env.ACTIVITY_DAYS), BATCH = Number(process.env.BATCH || 200);
const deadline = Date.now() + Number(process.env.DEADLINE_MIN || 45) * 60_000;
if (!(RUN_DAYS > 0) || !(ACTIVITY_DAYS > 0)) throw new Error("RUN_DAYS and ACTIVITY_DAYS are required");
// Run-owned tables and what of them goes with the run: a lease only when ephemeral (a reusable one still owns its sandbox: the
// database detaches it from the run), an operation with its log file.
const OWNED = new Map([["heartbeat_run_events", ""], ["environment_leases", "AND lease_policy = 'ephemeral'"], ["workspace_operations", ""]]);
const DATA = join(process.env.PAPERCLIP_HOME || "/paperclip", "instances/default/data");
const LOGS = join(DATA, "run-logs"), OP_LOGS = join(DATA, "workspace-operation-logs");
// The kernel's drain touches this pass's own file (retention.ts names it per pass): the pass stops at its next check.
const STOP = process.env.STOP_FILE || "";
const pgDir = process.env.PG_MODULE_DIR || "/app/node_modules/.pnpm/" + readdirSync("/app/node_modules/.pnpm").find((d) => d.startsWith("pg@")) + "/node_modules/pg";
// import.meta.url of a module read from stdin is not a file URL: resolve `pg` from its own directory instead.
const { Client } = createRequire(join(pgDir, "x.js"))(pgDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const bare = (t) => t.replace(/^public\./, "");

const c = new Client({ host: process.env.PAPERCLIP_PG_HOST || "127.0.0.1", port: Number(process.env.PAPERCLIP_PG_PORT || 54329), user: process.env.PAPERCLIP_PG_USER || "paperclip", password: process.env.PAPERCLIP_PG_PASSWORD || "paperclip", database: process.env.PAPERCLIP_PG_DB || "paperclip" });
await c.connect();
if (!(await c.query("SELECT pg_try_advisory_lock(727274101) AS got")).rows[0].got) { console.log(JSON.stringify({ skipped: "another prune is running" })); await c.end(); process.exit(0); }
await c.query("SET lock_timeout = '5s'");
await c.query("SET statement_timeout = '120s'");

/** Every foreign key into `parent`.id from another table, for the key columns that point at `id`: [{ table, col, notNull, del }]. */
async function referrers(parent) {
  const { rows } = await c.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, a.attnotnull AS notnull, c.confdeltype AS del
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(ck, fk)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck
    JOIN pg_attribute p ON p.attrelid = c.confrelid AND p.attnum = k.fk AND p.attname = 'id'
    WHERE c.contype = 'f' AND c.confrelid = $1::regclass`, [parent]);
  return [...new Map(rows.map((r) => [`${r.tbl}.${r.col}`, { table: r.tbl, col: r.col, notNull: r.notnull, del: r.del }])).values()];
}

const stats = { runs: 0, owned: {}, nulled: {}, workspaces: 0, activity: 0, logs: 0, stopped: null };
const out = () => (stats.stopped = stats.stopped ?? (STOP && existsSync(STOP) ? "drain" : Date.now() > deadline ? "deadline" : null));

// 1. Runs.
const runRefs = await referrers("heartbeat_runs");
const owned = runRefs.filter((r) => OWNED.has(bare(r.table)));
const unlinkLog = (root, store, ref) => { if (store === "local_file" && ref && !ref.includes("..")) { try { unlinkSync(join(root, ref)); stats.logs++; } catch (e) { if (e.code !== "ENOENT") console.error(`log ${ref}: ${e.message}`); } } };
const strict = (r) => !OWNED.has(bare(r.table)) && (r.del === "a" || r.del === "r");
const nulls = runRefs.filter((r) => strict(r) && !r.notNull);
const kept = [
  ...runRefs.filter((r) => strict(r) && r.notNull).map((b) => `NOT EXISTS (SELECT 1 FROM ${b.table} x WHERE x.${q(b.col)} = r.id)`),
  "r.cost_accounting_pending IS NOT TRUE",
  "NOT EXISTS (SELECT 1 FROM environment_leases l WHERE l.heartbeat_run_id = r.id AND l.status NOT IN ('released', 'expired'))",
].join(" AND ");
const runWhere = `r.status NOT IN ('queued', 'running') AND r.finished_at < now() - make_interval(days => $1) AND ${kept}`;
const wsRefs = await referrers("execution_workspaces");
const unreferenced = wsRefs.map((b) => `NOT EXISTS (SELECT 1 FROM ${b.table} x WHERE x.${q(b.col)} = w.id)`).join(" AND ") || "TRUE";
const wsWhere = `w.created_at < now() - make_interval(days => $1) AND ${unreferenced}`;
// DRY=1 counts what a pass would delete and writes nothing.
if (process.env.DRY) {
  const n = async (sql, d) => Number((await c.query(sql, [d])).rows[0].n);
  console.log(JSON.stringify({ dry: {
    runs: await n(`SELECT count(*) AS n FROM heartbeat_runs r WHERE ${runWhere}`, RUN_DAYS),
    workspacesAlreadyUnreferenced: await n(`SELECT count(*) AS n FROM execution_workspaces w WHERE ${wsWhere}`, RUN_DAYS),
    activity: await n("SELECT count(*) AS n FROM activity_log WHERE created_at < now() - make_interval(days => $1)", ACTIVITY_DAYS),
    runsKept: { owned: owned.map((o) => o.table), nulled: nulls.map((o) => `${o.table}.${o.col}`) },
  } }));
  await c.end();
  process.exit(0);
}
while (!out()) {
  const { rows } = await c.query(`SELECT r.id, r.log_store, r.log_ref FROM heartbeat_runs r WHERE ${runWhere} ORDER BY r.finished_at LIMIT $2`, [RUN_DAYS, BATCH]);
  if (!rows.length) break;
  const ids = rows.map((r) => r.id);
  await c.query("BEGIN");
  const opLogs = [];
  try {
    for (const o of owned) {
      const hasLog = bare(o.table) === "workspace_operations";
      const r = await c.query(`DELETE FROM ${o.table} WHERE ${q(o.col)} = ANY($1) ${OWNED.get(bare(o.table))}${hasLog ? " RETURNING log_store, log_ref" : ""}`, [ids]);
      stats.owned[o.table] = (stats.owned[o.table] ?? 0) + r.rowCount;
      if (hasLog) opLogs.push(...r.rows);
    }
    for (const n of nulls) stats.nulled[n.table] = (stats.nulled[n.table] ?? 0) + (await c.query(`UPDATE ${n.table} SET ${q(n.col)} = NULL WHERE ${q(n.col)} = ANY($1)`, [ids])).rowCount;
    stats.runs += (await c.query("DELETE FROM heartbeat_runs WHERE id = ANY($1)", [ids])).rowCount;
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  // Their logs only once the rows are gone; one a crash leaves behind is found by the orphan sweep below.
  for (const r of rows) unlinkLog(LOGS, r.log_store, r.log_ref);
  for (const r of opLogs) unlinkLog(OP_LOGS, r.log_store, r.log_ref);
  await sleep(200);
}

// Log files no row names any more (a crash between a commit and its unlinks), a day old at least.
for (const [root, table] of [[LOGS, "heartbeat_runs"], [OP_LOGS, "workspace_operations"]]) {
  if (out()) break;
  const named = new Set((await c.query(`SELECT log_ref FROM ${table} WHERE log_ref IS NOT NULL`)).rows.map((r) => r.log_ref));
  // One folder at a time, the stop checked between files; a file that vanished or can't be read is skipped.
  const dirs = [""];
  while (dirs.length && !out()) {
    const rel = dirs.pop();
    let entries = [];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    for (const e of entries) {
      const f = join(rel, e.name);
      if (e.isDirectory()) { dirs.push(f); continue; }
      if (out()) break;
      try { if (!named.has(f) && Date.now() - statSync(join(root, f)).mtimeMs > 864e5) { unlinkSync(join(root, f)); stats.logs++; } } catch (err) { if (err.code !== "ENOENT") console.error(`log ${f}: ${err.message}`); }
    }
  }
}

// 2. Execution workspaces nothing references: any foreign key into one counts (an issue, a lease, a derived workspace...). Only
// those older than RUN_DAYS.
while (!out()) {
  const r = await c.query(`DELETE FROM execution_workspaces WHERE id IN (SELECT w.id FROM execution_workspaces w WHERE ${wsWhere} LIMIT $2)`, [RUN_DAYS, BATCH]);
  stats.workspaces += r.rowCount;
  if (r.rowCount < BATCH) break;
  await sleep(200);
}

// 3. Activity.
while (!out()) {
  const r = await c.query("DELETE FROM activity_log WHERE id IN (SELECT id FROM activity_log WHERE created_at < now() - make_interval(days => $1) LIMIT $2)", [ACTIVITY_DAYS, BATCH * 4]);
  stats.activity += r.rowCount;
  if (r.rowCount < BATCH * 4) break;
  await sleep(200);
}
await c.end();
if (STOP) rmSync(STOP, { force: true });
console.log(JSON.stringify(stats));
