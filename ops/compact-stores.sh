#!/usr/bin/env bash
# One-time compaction by hand, AFTER retention's first runs have freed space (kernel/src/retention.ts): clearing rows and pruning
# Paperclip makes pages reusable but never shrinks the files. Nothing here runs from apply or a timer.
#   ops/compact-stores.sh kernel      stop the kernel, VACUUM INTO a compact copy, verify it, swap it in, start the kernel
#   ops/compact-stores.sh paperclip   VACUUM FULL the pruned Paperclip tables, one at a time, with Paperclip running
# The kernel takes a short outage (its model gateway and tool proxy are down while it is stopped: agents' calls fail and retry;
# running jobs run on and the next kernel adopts them). Do it when the fleet shows no important jobs (aidenhq MCP `fleet`).
# The old kernel.db is kept as kernel.db.precompact until you delete it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
what="${1:-}"
# Under the apply lock (docs/operations.md "Host one-offs"): an apply that starts meanwhile waits, so none restarts the kernel
# between the stop and the swap.
if [ -z "${COMPACT_LOCKED:-}" ]; then exec env COMPACT_LOCKED=1 flock data/apply.lock "$0" "$@"; fi
# The data dir as the kernel resolves it (kernel/src/env.ts: the process env over the checkout's .env).
data="$(node --disable-warning=ExperimentalWarning --input-type=module -e 'import("./kernel/src/env.ts").then((m) => console.log(m.dataDir))')"
die() { echo "compact-stores: $*" >&2; exit 1; }
free_kb() { df -Pk "$1" | awk 'NR==2 {print $4}'; }
confirm() { read -r -p "$1 Type 'compact' to continue: " a; [ "$a" = compact ] || die "not confirmed"; }

kernel() {
  local db="$data/kernel/kernel.db" unit=aidenhq-kernel
  [ -f "$db" ] || die "no $db"
  local need_kb=$(( ( $(stat -c %s "$db") + $(stat -c %s "$db-wal" 2>/dev/null || echo 0) ) * 2 / 1024 ))
  [ "$(free_kb "$(dirname "$db")")" -gt "$need_kb" ] || die "less than $(( need_kb / 1024 )) MB free beside $db (the compact copy and the kept original)"
  confirm "This stops $unit (the gateway and tool proxy go down for about a minute) and replaces $db."
  started=0
  trap 'if [ "$started" = 0 ]; then systemctl --user start '"$unit"'; fi' EXIT
  [ -z "$(systemctl --user list-units --no-legend 'aidenhq-apply-*' 2>/dev/null)" ] || die "an apply unit is active"
  systemctl --user stop "$unit"
  # The stopped unit's kernel drains: wait until no kernel process is left, then nothing holds the file.
  for _ in $(seq 1 300); do pgrep -f '[k]ernel/src/main\.ts' >/dev/null || break; sleep 2; done
  pgrep -f '[k]ernel/src/main\.ts' >/dev/null && die "a kernel is still running after 10 minutes; the unit is started again"
  node --disable-warning=ExperimentalWarning --input-type=module - "$db" <<'JS'
import { DatabaseSync } from "node:sqlite";
import { rmSync, statSync } from "node:fs";
const file = process.argv[2], out = `${file}.compact`;
rmSync(out, { force: true });
const src = new DatabaseSync(file);
src.exec("PRAGMA busy_timeout = 5000");
src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const ok = (d, name) => { const r = d.prepare("PRAGMA integrity_check").all(); if (r.length !== 1 || r[0].integrity_check !== "ok") throw new Error(`${name} fails its integrity check: ${JSON.stringify(r).slice(0, 300)}`); };
ok(src, "the kernel database");
const counts = (d) => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => [t.name, d.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n]));
const before = counts(src);
src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
src.close();
const dst = new DatabaseSync(out, { readOnly: true });
ok(dst, "the compact copy");
const after = counts(dst);
for (const t of Object.keys(before)) if (before[t] !== after[t]) throw new Error(`table ${t}: ${before[t]} rows before, ${after[t]} after`);
console.log(`compact copy verified: ${Object.keys(before).length} tables, same row counts; ${Math.round(statSync(file).size / 1e6)} MB -> ${Math.round(statSync(out).size / 1e6)} MB`);
JS
  # kernel.db never goes missing: the original is hard-linked aside, then the verified copy is renamed over it (one atomic step).
  rm -f "$db.precompact"
  ln "$db" "$db.precompact"
  rm -f "$db-wal" "$db-shm"
  mv -f "$db.compact" "$db"
  systemctl --user start "$unit"
  started=1
  echo "kernel restarted on the compact database; the old one is $db.precompact (delete it once the board looks right)"
}

paperclip() {
  local c="${AIDENHQ_PAPERCLIP_CONTAINER:-aidenhq-paperclip-1}" tables="heartbeat_runs heartbeat_run_events activity_log run_usage_receipts environment_leases workspace_operations execution_workspaces cost_events agent_task_sessions"
  local pgdata="$data/paperclip/instances/default/db"
  [ -d "$pgdata" ] || die "no $pgdata"
  confirm "This rewrites the pruned Paperclip tables one at a time, locking each for the seconds it takes (Paperclip keeps running)."
  # One table at a time needs room for its copy and its WAL: twice the biggest table's size is safe, and the whole set is a ceiling.
  docker exec -i -e TABLES="$tables" -e FREE_KB="$(free_kb "$pgdata")" "$c" node --input-type=module - <<'JS'
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
const dir = "/app/node_modules/.pnpm/" + readdirSync("/app/node_modules/.pnpm").find((d) => d.startsWith("pg@")) + "/node_modules/pg";
const { Client } = createRequire(import.meta.url)(dir);
const c = new Client({ host: "127.0.0.1", port: 54329, user: process.env.PAPERCLIP_PG_USER || "paperclip", password: process.env.PAPERCLIP_PG_PASSWORD || "paperclip", database: process.env.PAPERCLIP_PG_DB || "paperclip" });
await c.connect();
await c.query("SET lock_timeout = '30s'");
const size = async (t) => Number((await c.query("SELECT pg_total_relation_size($1::regclass) AS s", [t])).rows[0].s);
const tables = process.env.TABLES.split(" ");
const sizes = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await size(t)])));
const biggest = Math.max(...Object.values(sizes)), freeKb = Number(process.env.FREE_KB);
if (freeKb * 1024 < biggest * 3) throw new Error(`${Math.round(freeKb / 1024)} MB free; the biggest table is ${Math.round(biggest / 1e6)} MB and needs three times that for its copy and WAL`);
for (const t of tables.sort((a, b) => sizes[b] - sizes[a])) {
  const t0 = Date.now();
  await c.query(`VACUUM (FULL, ANALYZE) ${t}`);
  console.log(`${t}: ${Math.round(sizes[t] / 1e6)} MB -> ${Math.round((await size(t)) / 1e6)} MB in ${Math.round((Date.now() - t0) / 1000)} s`);
}
await c.end();
JS
}

case "$what" in
  kernel) kernel ;;
  paperclip) paperclip ;;
  *) die "usage: ops/compact-stores.sh kernel|paperclip" ;;
esac
