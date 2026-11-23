#!/usr/bin/env bash
# Shared sources: writer roles, schemas and src_meta on the warehouse (modules/warehouse/apps/warehouse/sources.sql).
# Idempotent; ops/apply-config.sh runs it after compose up, and it is safe to run by hand. Skips quietly while the warehouse
# app isn't running (apps-mcp deploys it; run this again once it is).
#
# Each source writer's password is a generated secret of its module (warehouse_src_<source>_password, made by compile).
# Passwords reach psql on stdin, never argv, and psql's output (which echoes them) is discarded.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
secrets="${AIDENHQ_SECRETS_DIR:?set AIDENHQ_SECRETS_DIR in .env}"
container=app-warehouse-postgres-1

if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
  echo "warehouse-sources: $container isn't running; shared sources not set up yet (run ops/warehouse-sources.sh once it is)"
  exit 0
fi

pw() { if [ -s "$secrets/$1" ]; then tr -d '\n' < "$secrets/$1"; fi; }
{
  for s in slack github jira hubspot meetings docs security tasks; do printf '\\set pw_src_%s %s\n' "$s" "$(pw "warehouse_src_${s}_password")"; done
  cat modules/warehouse/apps/warehouse/sources.sql
} | docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U warehouse -d warehouse >/dev/null
echo "warehouse-sources: writer roles, schemas and src_meta are in place"
