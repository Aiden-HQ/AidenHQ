#!/usr/bin/env bash
# Back up system-owned state only: Paperclip's data directory, the ops-mcp and board SQLite
# databases, non-secret configuration and the instance repo (a git bundle: on a person's VM it is
# local-only). The Obsidian vault and the secrets directory are NOT included (the vault has its own
# sync/backup; secrets stay where they are, and logins are reconnected after a restore).
#
#   scripts/backup.sh [output-dir]      → <output-dir>/aidenhq-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
data="$(cd "${AIDENHQ_DATA_DIR:-./data}" && pwd)"
config="$(cd "${AIDENHQ_CONFIG_DIR:-./config}" && pwd)"
out_dir="${1:-$repo/backups}"
mkdir -p "$out_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$out_dir/aidenhq-$stamp.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

running="$(docker compose --env-file "$env_file" ps --status running --services 2>/dev/null || true)"

echo "Backing up to $archive"
mkdir -p "$work/ops-mcp" "$work/config" "$work/board"

# ops-mcp: consistent online copy via SQLite's backup API.
if [ -f "$data/ops-mcp/state.sqlite" ]; then
  node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    const src = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(src, process.argv[2]).then(() => src.close());
  ' "$data/ops-mcp/state.sqlite" "$work/ops-mcp/state.sqlite"
fi

# The board (chat places, schedules, approvals): same online copy.
if [ -f "$data/board/board.sqlite" ]; then
  node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    const src = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(src, process.argv[2]).then(() => src.close());
  ' "$data/board/board.sqlite" "$work/board/board.sqlite"
fi

# The instance repo, every branch: the only copy on a VM whose instance repo is local.
if [ -n "${AIDENHQ_INSTANCE_DIR:-}" ] && [ -d "$AIDENHQ_INSTANCE_DIR/.git" ]; then
  git -C "$AIDENHQ_INSTANCE_DIR" bundle create --quiet "$work/instance.bundle" --all
  echo "  includes the instance repo ($(git -C "$AIDENHQ_INSTANCE_DIR" rev-parse --short HEAD))"
fi

# Paperclip: its embedded Postgres must not be copied mid-write. Use Paperclip's own
# hourly DB dumps if the stack is running; copy the whole directory when stopped.
if echo "$running" | grep -qx paperclip; then
  echo "  paperclip is running: archiving its data dir except the live database"
  tar -C "$data" --exclude='paperclip/instances/*/db' -cf "$work/paperclip.tar" paperclip
  latest_dump="$(ls -1t "$data"/paperclip/instances/*/data/backups/* 2>/dev/null | head -1 || true)"
  [ -n "$latest_dump" ] && echo "  includes Paperclip DB dump: $(basename "$latest_dump")" || echo "  WARNING: no Paperclip DB dump yet; stop the stack for a full backup"
else
  tar -C "$data" -cf "$work/paperclip.tar" paperclip
fi

# Config without secrets (secrets live in AIDENHQ_SECRETS_DIR, outside the repo).
for f in system.yaml routing.yaml paperclip.yaml; do
  [ -f "$config/$f" ] && cp "$config/$f" "$work/config/"
done

printf 'created=%s\nhost=%s\npaperclip_running=%s\n' "$stamp" "$(hostname)" "$(echo "$running" | grep -qx paperclip && echo yes || echo no)" > "$work/MANIFEST"
tar -C "$work" -czf "$archive" .
chmod 0600 "$archive"
echo "Done: $archive ($(du -h "$archive" | cut -f1))"
