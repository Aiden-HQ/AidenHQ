#!/usr/bin/env bash
# Back up this host's AidenHQ state into one archive:
#   data      the whole data dir: Paperclip, the board (with its accounts, auth.db, and auth.secret), the gateway ledger,
#             apps-mcp, ops-mcp, slack-live, the apps node's state and the rest. While Paperclip runs, its live database
#             folder is left out; its hourly dumps (paperclip/instances/*/data/backups) carry it.
#   runner    the runner's state dir (config/runner.yaml `state_dir`).
#   volumes   every app volume (app-*), with its labels so the app's next deploy adopts it. A Postgres cluster that a
#             running container uses is skipped: its app's dumps carry it (the warehouse dumps nightly into
#             app-warehouse_backups, which is copied).
#   config    system, routing, paperclip and runner YAML, and the instance repo as a git bundle.
# Every SQLite database in data and runner is also copied online (SQLite's backup API); restore puts that copy over the
# file copy. Files are read through a container, so root-owned ones (the apps node's state) are included without sudo.
# Not included: the secret vault and the notes vault (ops/backup-offsite.sh sends the vault's ciphertext off-host).
# The archive holds auth.secret and the apps node's key, so it is 0600.
#
#   scripts/backup.sh [output-dir] [--plain]   → <output-dir>/aidenhq-YYYYmmdd-HHMMSS.tar.gz (.tar with --plain, for
#                                                restic, which compresses and deduplicates itself)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
plain=; args=()
for a in "$@"; do if [ "$a" = --plain ]; then plain=1; else args+=("$a"); fi; done
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
data="$(cd "${AIDENHQ_DATA_DIR:-./data}" && pwd)"
config="$(cd "${AIDENHQ_CONFIG_DIR:-./config}" && pwd)"
state="$(sed -n 's/^state_dir:[[:space:]]*//p' "$config/runner.yaml" 2>/dev/null | tr -d "\"'" | head -1)"
state="${state:-~/.local/state/aidenhq-runner}"; state="${state/#\~/$HOME}"
out_dir="${args[0]:-$repo/backups}"
mkdir -p "$out_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$out_dir/aidenhq-$stamp.tar$([ -n "$plain" ] || echo .gz)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Any small image with tar, already pinned: the warehouse's Postgres (scripts/restore.sh uses the same).
IMG=postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f

running="$(docker compose --env-file "$env_file" ps --status running --services 2>/dev/null || true)"
paperclip_running=no; echo "$running" | grep -qx paperclip && paperclip_running=yes

echo "Backing up to $archive"

# tar in a container, to stdout. A live tree changes while it is read: GNU tar exits 1 for "file changed as we read it",
# which is fine here (SQLite comes from the online copies, Paperclip from its dumps); 2 and up is a real failure.
ctar() { # docker run args... -- tar args...
  local s=0; docker run --rm "$@" || s=$?
  [ "$s" -le 1 ] || { echo "tar failed (exit $s)" >&2; return "$s"; }
}

# A directory as <name>.tar (read in a container), plus an online copy of each SQLite database in it under <name>.sqlite/.
snapshot() { # name dir [tar --exclude patterns...]
  local name="$1" dir="$2"; shift 2
  [ -d "$dir" ] || { echo "  $name: $dir is missing, skipped"; return 0; }
  ctar -v "$dir:/d:ro" "$IMG" tar -C /d --warning=no-file-changed --exclude='./.pre-restore-*' "${@/#/--exclude=}" -cf - . >"$work/$name.tar"
  node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    const fs = require("node:fs"), path = require("node:path");
    const [root, out] = process.argv.slice(1);
    const skip = new Set(["node_modules", ".git"]);
    function* walk(d) {
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } // unreadable: the tar has it
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith(".pre-restore-")) yield* walk(p);
        else if (e.isFile() && /\.(sqlite3?|db)$/.test(e.name)) yield p;
      }
    }
    const isSqlite = (p) => { try { const b = Buffer.alloc(16); const fd = fs.openSync(p, "r"); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.toString("latin1") === "SQLite format 3\0"; } catch { return false; } };
    (async () => {
      for (const p of walk(root)) {
        if (!isSqlite(p)) continue;
        const dest = path.join(out, path.relative(root, p));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // One database that cannot be copied online (a workspace file mid-write, another owner) keeps its file copy.
        try {
          const db = new DatabaseSync(p, { readOnly: true });
          try { await backup(db, dest); } finally { db.close(); }
        } catch (e) { fs.rmSync(dest, { force: true }); console.error(`  WARNING: ${p}: ${e.message}; only its file copy is in the backup`); }
      }
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$dir" "$work/$name.sqlite"
  echo "  $name: $dir ($(find "$work/$name.sqlite" -type f 2>/dev/null | wc -l | tr -d ' ') SQLite databases copied online)"
}

if [ "$paperclip_running" = yes ]; then
  snapshot data "$data" './paperclip/instances/*/db'
  latest_dump="$(ls -1t "$data"/paperclip/instances/*/data/backups/* 2>/dev/null | head -1 || true)"
  [ -n "$latest_dump" ] && echo "  Paperclip is running: its database comes from dump $(basename "$latest_dump")" \
    || echo "  WARNING: Paperclip is running and has no DB dump yet; stop the stack for a full backup"
else
  snapshot data "$data"
fi
snapshot runner "$state"

# App volumes, each with its labels.
mkdir -p "$work/volumes"
for v in $(docker volume ls -q --filter name='^app-'); do
  if [ -n "$(docker ps -q --filter volume="$v")" ] && docker run --rm -v "$v:/v:ro" "$IMG" test -f /v/PG_VERSION; then
    echo "  volume $v: a live Postgres cluster, skipped (its app's dumps carry it)"; continue
  fi
  docker volume inspect -f '{{json .Labels}}' "$v" >"$work/volumes/$v.labels.json"
  ctar -v "$v:/v:ro" "$IMG" tar -C /v --warning=no-file-changed -cf - . >"$work/volumes/$v.tar"
  echo "  volume $v"
done

# The instance repo, every branch: the only copy on a VM whose instance repo is local.
if [ -n "${AIDENHQ_INSTANCE_DIR:-}" ] && [ -d "$AIDENHQ_INSTANCE_DIR/.git" ]; then
  git -C "$AIDENHQ_INSTANCE_DIR" bundle create --quiet "$work/instance.bundle" --all
  echo "  instance repo ($(git -C "$AIDENHQ_INSTANCE_DIR" rev-parse --short HEAD))"
fi

# Config without secrets (secrets live in AIDENHQ_SECRETS_DIR, outside the repo).
mkdir -p "$work/config"
for f in system.yaml routing.yaml paperclip.yaml runner.yaml; do
  [ -f "$config/$f" ] && cp "$config/$f" "$work/config/"
done

printf 'format=2\ncreated=%s\nhost=%s\npaperclip_running=%s\nrunner_state=%s\n' "$stamp" "$(hostname)" "$paperclip_running" "$state" >"$work/MANIFEST"
umask 077
if [ -n "$plain" ]; then tar -C "$work" -cf "$archive.part" .; else tar -C "$work" -cf - . | gzip >"$archive.part"; fi
mv "$archive.part" "$archive"
echo "Done: $archive ($(du -h "$archive" | cut -f1))"
