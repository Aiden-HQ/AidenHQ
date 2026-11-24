#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh. Refuses to run while any AidenHQ container or the kernel is running.
# Existing state is moved aside, never deleted: each top-level entry the backup replaces goes to
# <dir>/.pre-restore-<stamp>/ (in the data dir and in the runner's state dir). App volumes that already exist are left
# alone (remove one with `docker volume rm` first to restore it). Files are written through a container, so their
# owners come back as they were.
#
#   scripts/restore.sh backups/aidenhq-YYYYmmdd-HHMMSS   (the directory scripts/backup.sh wrote)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
work="${1:?usage: scripts/restore.sh <backup-dir>}"
[ -d "$work" ] || { echo "error: $work is not a backup directory (an older .tar archive needs the restore.sh that made it)" >&2; exit 1; }
work="$(cd "$work" && pwd)"
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
IMG=postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f # as scripts/backup.sh

# By project label, since compose files may not exist yet on a fresh host. A failing docker stops the restore: it must not read as "nothing running".
running="$(docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-aidenhq}" --format '{{.Names}}')"
if [ -n "$running" ]; then
  echo "error: refusing to restore while containers are running: $(echo $running)" >&2
  echo "       stop them first: docker compose down" >&2
  exit 1
fi
if systemctl --user is-active --quiet aidenhq-kernel 2>/dev/null; then
  echo "error: refusing to restore while the kernel is running: systemctl --user stop aidenhq-kernel" >&2
  exit 1
fi

data="${AIDENHQ_DATA_DIR:-./data}"
config="${AIDENHQ_CONFIG_DIR:-./config}"
mkdir -p "$data"
data="$(cd "$data" && pwd)"
[ -f "$work/MANIFEST" ] || { echo "error: not an AidenHQ backup" >&2; exit 1; }
grep -q '^format=3$' "$work/MANIFEST" || {
  echo "error: this backup was made by an older scripts/backup.sh; restore it with that version's restore.sh" >&2; exit 1; }
cat "$work/MANIFEST"
# An incomplete backup (scripts/backup.sh exit 1) holds a live copy of these databases, which may not start or may be inconsistent.
lost="$(sed -n 's/^unrecoverable=//p' "$work/MANIFEST")"
if [ -n "$lost" ] && [ "${AIDENHQ_RESTORE_INCOMPLETE:-}" != "yes" ]; then
  echo "error: this backup is INCOMPLETE: no recoverable dump for: $lost" >&2
  echo "       pick a complete backup, or salvage this one with AIDENHQ_RESTORE_INCOMPLETE=yes scripts/restore.sh $work" >&2
  exit 1
fi
stamp="$(date +%Y%m%d-%H%M%S)"

# <name>.tar into dir: move aside what it replaces, extract, then put each online SQLite copy over its file copy (with
# the file copy's owner) and drop the file copy's -wal/-shm, which belong to the torn copy.
restore_tree() { # name dir
  local name="$1" dir="$2"
  local parts=("$work/$name".tar*) part
  [ -e "${parts[0]}" ] || return 0
  part="${parts[0]}"
  mkdir -p "$dir"
  docker run --rm -v "$dir:/d" -v "$work:/b:ro" -e PART="/b/$(basename "$part")" -e NAME="$name" -e ASIDE="/d/.pre-restore-$stamp" "$IMG" sh -euc '
    for top in $(tar -tf "$PART" | sed -n "s|^\./\([^/][^/]*\).*|\1|p" | sort -u); do
      [ -e "/d/$top" ] || continue
      mkdir -p "$ASIDE"; mv "/d/$top" "$ASIDE/"
    done
    tar -C /d -xpf "$PART"
    [ -d "/b/$NAME.sqlite" ] || exit 0
    cd "/b/$NAME.sqlite"
    find . -type f | while read -r f; do
      cp "$f" "/d/$f.restore"
      [ -e "/d/$f" ] && chown --reference="/d/$f" "/d/$f.restore"
      mv "/d/$f.restore" "/d/$f"
      rm -f "/d/$f-wal" "/d/$f-shm"
    done'
  echo "Restored $name into $dir (anything it replaced is in $dir/.pre-restore-$stamp)"
}

restore_tree data "$data"
state="$(sed -n 's/^runner_state=//p' "$work/MANIFEST")"
[ -n "$state" ] && restore_tree runner "$state"

for t in "$work"/volumes/*.tar*; do
  [ -f "$t" ] || continue
  v="$(basename "$t")"; v="${v%.tar.gz}"; v="${v%.tar}"
  if docker volume inspect "$v" >/dev/null 2>&1; then
    echo "Volume $v exists, left alone (docker volume rm $v, then restore again, to replace it)"; continue
  fi
  labels=()
  while IFS= read -r l; do labels+=(--label "$l"); done < <(jq -r 'to_entries[]? | "\(.key)=\(.value)"' "$work/volumes/$v.labels.json")
  docker volume create "${labels[@]}" "$v" >/dev/null
  docker run --rm -v "$v:/v" -v "$work/volumes:/b:ro" "$IMG" tar -C /v -xpf "/b/$(basename "$t")"
  echo "Volume $v restored"
done

# The instance repo: recreated from the bundle only where there is none (a fresh VM). An existing one is left alone.
aside="$data/.pre-restore-$stamp"
if [ -f "$work/instance.bundle" ]; then
  inst="${AIDENHQ_INSTANCE_DIR:-}"
  if [ -n "$inst" ] && [ ! -e "$inst" ]; then
    remote="${AIDENHQ_INSTANCE_REMOTE:-}"
    if [ -n "$remote" ] && [ ! -e "$remote" ]; then
      git clone --quiet --bare "$work/instance.bundle" "$remote"
      git clone --quiet "$remote" "$inst"
      git -C "$remote" config receive.denyNonFastForwards true
    else
      git clone --quiet "$work/instance.bundle" "$inst"
      git -C "$inst" remote remove origin
    fi
    echo "Instance repo restored at $inst"
  else
    mkdir -p "$aside" && cp "$work/instance.bundle" "$aside/instance.bundle"
    echo "Instance repo exists; the backup's copy is at $aside/instance.bundle"
  fi
fi
for f in "$work"/config/*.yaml; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ -f "$config/$name" ] && ! cmp -s "$f" "$config/$name"; then
    mkdir -p "$aside" && cp "$config/$name" "$aside/$name"
  fi
  cp "$f" "$config/$name"
done

if grep -q '^paperclip_running=yes' "$work/MANIFEST"; then
  echo "NOTE: this backup was taken while Paperclip was running, so its live database was excluded."
  echo "      Restore Paperclip's DB from its dump under $data/paperclip/instances/*/data/backups/"
  echo "      (see Paperclip docs: database backups), or use a backup taken with the stack stopped."
fi
if compgen -G "$work/primer.sql*" >/dev/null; then
  # Primer's database directory is a bind mount: made here as this user (a missing one is created by Docker as root, and the
  # database, running as this user, can't initialise in it).
  mkdir -p "$data/modules/primer/db"
  echo "NOTE: Self-hosted Primer was running, so its database came as a dump, not a data directory. After the stack is up (an installer-driven"
  echo "      restore has already started Primer on an empty database, which this replaces), import it:"
  echo "      zcat -f \"$work\"/primer.sql* >/dev/null && docker compose stop primer-server && docker compose up -d --wait primer-db && docker compose exec -T primer-db psql -U primer -d postgres -c 'DROP DATABASE IF EXISTS primer WITH (FORCE)' -c 'CREATE DATABASE primer' && zcat -f \"$work\"/primer.sql* | docker compose exec -T primer-db psql -v ON_ERROR_STOP=1 -U primer -d primer && docker compose up -d primer-server"
fi
echo "Restored. Start with: docker compose up -d (then systemctl --user start aidenhq-kernel)"
echo "A live Postgres cluster skipped by the backup (the warehouse) comes back from its app's dumps: see its AGENTS.md."
