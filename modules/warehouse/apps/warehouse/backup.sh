#!/bin/sh
# Nightly logical dump of the warehouse database into /backups (the app-warehouse_backups volume).
# Waits for Postgres, keeps about 7 days, and never exits on a failed dump: it logs and retries later.
set -u

BACKUP_DIR=/backups
RETRY_SECONDS=300
SCHEDULE_HOUR=2 # 02:00 UTC

log() {
  printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

test -f /run/secrets/POSTGRES_PASSWORD && test -s /run/secrets/POSTGRES_PASSWORD || { log "the secret POSTGRES_PASSWORD is missing or empty"; exit 1; }
export PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)"

wait_for_postgres() {
  delay=2
  while ! pg_isready -h postgres -U warehouse -d warehouse >/dev/null 2>&1; do
    log "postgres is not ready; retrying in ${delay}s"
    sleep "$delay"
    if [ "$delay" -lt 60 ]; then
      delay=$((delay * 2))
      [ "$delay" -gt 60 ] && delay=60
    fi
  done
  log "postgres is accepting connections"
}

retain() {
  find "$BACKUP_DIR" -name 'warehouse-*.dump' -mtime +6 -delete
}

dump_today() {
  today="$(date -u +%F)"
  target="$BACKUP_DIR/warehouse-$today.dump"
  # -s: an empty file from a failed run (e.g. the old script) must not block the day's dump.
  if [ -s "$target" ]; then
    log "dump for $today already exists; not overwriting $target"
    return 0
  fi
  tmp="$BACKUP_DIR/.warehouse-$today.dump.tmp"
  rm -f "$tmp"
  pg_dump -h postgres -U warehouse -d warehouse -Fc -f "$tmp"
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$tmp"
    log "pg_dump failed (exit $status); will retry"
    return 1
  fi
  mv "$tmp" "$target"
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$tmp"
    log "could not move $tmp to $target (exit $status); will retry"
    return 1
  fi
  log "wrote $target"
  retain
  return 0
}

sleep_until_next_run() {
  now="$(date -u +%s)"
  day="$(date -u +%F)"
  hour="$(printf '%02d' "$SCHEDULE_HOUR")"
  target="$(date -u -d "$day $hour:00:00" +%s)"
  if [ "$now" -ge "$target" ]; then
    target=$((target + 86400))
  fi
  wait=$((target - now))
  [ "$wait" -lt 1 ] && wait=1
  log "next run at $(date -u -d "@$target" +%Y-%m-%dT%H:%M:%SZ) (sleeping ${wait}s)"
  sleep "$wait"
}

while true; do
  wait_for_postgres
  if dump_today; then
    sleep_until_next_run
  else
    log "retrying in ${RETRY_SECONDS}s"
    sleep "$RETRY_SECONDS"
  fi
done
