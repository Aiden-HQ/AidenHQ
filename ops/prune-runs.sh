#!/usr/bin/env bash
# Weekly: delete Paperclip run logs and heartbeat_run_events older than DAYS (default 30).
# Paperclip has no pruning of its own. heartbeat_runs is left alone (cost_events etc. reference it).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAYS="${PRUNE_DAYS:-30}"
LOGS="${AIDENHQ_DATA_DIR:-$REPO/data}/paperclip/instances/default/data/run-logs"

if [ -d "$LOGS" ]; then
  n=$(find "$LOGS" -name '*.ndjson' -mtime +"$DAYS" -print -delete | wc -l)
else
  n=0
fi
echo "run-logs deleted: $n"

# The container has no psql; use its bundled node `pg` against the embedded Postgres.
# Defaults are the embedded-instance defaults; override via PAPERCLIP_PG_* if they change.
cd "$REPO"
docker compose -p aidenhq exec -T -e DAYS="$DAYS" paperclip sh -c \
  'cd /app/node_modules/.pnpm/pg@*/node_modules/pg && node -e "
const {Client}=require(\"./\");
(async()=>{
  const c=new Client({host:\"127.0.0.1\",port:54329,user:process.env.PAPERCLIP_PG_USER||\"paperclip\",password:process.env.PAPERCLIP_PG_PASSWORD||\"paperclip\",database:process.env.PAPERCLIP_PG_DB||\"paperclip\"});
  await c.connect();
  const r=await c.query(\"delete from heartbeat_run_events where created_at < now() - make_interval(days => \$1)\",[+process.env.DAYS]);
  console.log(\"heartbeat_run_events deleted: \"+r.rowCount);
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)})"'
