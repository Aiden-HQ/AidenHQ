#!/usr/bin/env bash
# Tunes Paperclip's embedded Postgres (stock: shared_buffers 128MB, jit on, random_page_cost 4). Paperclip starts Postgres
# with only -D <data dir>, so the one durable place is the data dir's postgresql.auto.conf, which Postgres reads on every
# start. Idempotent: rewrites only these keys, keeps every other line. Takes effect when Paperclip next restarts (apply
# recreates it), so run it BEFORE compose up. Never touches a running server.
set -euo pipefail
f="${AIDENHQ_DATA_DIR:-$PWD/data}/paperclip/instances/default/db/postgresql.auto.conf"
[ -f "$f" ] || exit 0 # fresh install: Postgres has not initialised its data dir yet; the next apply sets it
want="jit = 'off'
random_page_cost = '1.1'
shared_buffers = '512MB'"
keep="$(grep -vE "^[[:space:]]*(jit|random_page_cost|shared_buffers)[[:space:]]*=" "$f" || true)"
new="$(printf '%s\n%s\n' "$keep" "$want" | sed '/^$/d')"
if [ "$new" = "$(sed '/^$/d' "$f")" ]; then exit 0; fi
tmp="$f.tune.$$"
printf '%s\n' "$new" >"$tmp" # a whole file then a rename, as ALTER SYSTEM does: never a half-written settings file
chmod --reference="$f" "$tmp" 2>/dev/null || chmod 600 "$tmp"
mv "$tmp" "$f"
echo "paperclip postgres: tuned postgresql.auto.conf (jit off, random_page_cost 1.1, shared_buffers 512MB; next Paperclip restart)"
