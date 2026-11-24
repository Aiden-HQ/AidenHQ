#!/usr/bin/env bash
# Back up this host's AidenHQ state into one directory of parts, each streamed straight to its file (no staging copy):
#   data      the whole data dir: Paperclip, the board, the accounts (data/kernel/auth: auth.db and auth.secret), the gateway ledger,
#             apps-mcp, ops-mcp, slack-live, the apps node's state and the rest. While Paperclip runs, its live database
#             folder is left out; its hourly dumps (paperclip/instances/*/data/backups) carry it.
#             Self-hosted Primer's Postgres (data/modules/primer/db) is left out while it runs: primer.sql[.gz] is its dump.
#   runner    the runner's state dir (config/runner.yaml `state_dir`).
#   volumes   every app volume (app-*), with its labels so the app's next deploy adopts it. A Postgres cluster that a
#             running container uses is skipped: its app's dumps carry it (the warehouse dumps nightly into
#             app-warehouse_backups, which is copied).
#   (A running Postgres cluster or Paperclip without a fresh dump is listed as `unrecoverable=` in MANIFEST: the rest is still
#    written, then the script exits 1.)
#   config    system, routing, paperclip and runner YAML, and the instance repo as a git bundle.
# Every SQLite database in data and runner is also copied online (SQLite's backup API); restore puts that copy over the
# file copy. Files are read through a container, so root-owned ones (the apps node's state) are included without sudo.
# Not included: the secret vault and the notes vault (ops/backup-offsite.sh sends the vault's ciphertext off-host).
# The backup holds auth.secret and the apps node's key, so it is 0700.
# It refuses to start unless the output filesystem has 1.2x the sources' size plus 20 GB free: a full disk takes
# Paperclip's Postgres down with it.
#
#   scripts/backup.sh [output-dir] [--plain]   → <output-dir>/aidenhq-YYYYmmdd-HHMMSS/ with <name>.tar.gz parts (.tar with
#                                                --plain, for restic, which compresses and deduplicates itself)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
plain=; args=()
for a in "$@"; do if [ "$a" = --plain ]; then plain=1; else args+=("$a"); fi; done
env_file="${AIDENHQ_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
data="$(cd "${AIDENHQ_DATA_DIR:-./data}" && pwd)"
config="$(cd "${AIDENHQ_CONFIG_DIR:-./config}" && pwd)"
state=; [ ! -f "$config/runner.yaml" ] || state="$(sed -n 's/^state_dir:[[:space:]]*//p' "$config/runner.yaml" | tr -d "\"'" | head -1)"
state="${state:-~/.local/state/aidenhq-runner}"; state="${state/#\~/$HOME}"
out_dir="${args[0]:-$repo/backups}"
mkdir -p "$out_dir"; out_dir="$(cd "$out_dir" && pwd)" # absolute: git -C below resolves paths against the instance checkout
stamp="$(date +%Y%m%d-%H%M%S)"
final="$out_dir/aidenhq-$stamp"
work="$out_dir/.aidenhq-$stamp.part"
ext=.tar.gz; [ -z "$plain" ] || ext=.tar
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM
# Any small image with tar, already pinned: the warehouse's Postgres (scripts/restore.sh uses the same).
IMG=postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f

running="$(docker compose --env-file "$env_file" ps --status running --services 2>/dev/null || true)"
paperclip_running=no; echo "$running" | grep -qx paperclip && paperclip_running=yes

# Volumes to copy. A Postgres cluster (a PG_VERSION file anywhere in the volume) that a running container uses is skipped when
# its app's <project>_backups volume holds a non-empty *.dump from the last two days. Without one it is still copied (best
# effort, not consistent) and recorded in `unrecoverable`: the backup completes, then this script exits 1 so nobody reads it as a success.
unrecoverable=()
vols=()
app_vols="$(docker volume ls -q --filter name='^app-')"
for v in $app_vols; do
  if [ -n "$(docker ps -q --filter volume="$v")" ] && [ -n "$(docker run --rm -v "$v:/v:ro" "$IMG" find /v -name PG_VERSION -print -quit)" ]; then
    bv="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$v")_backups"
    if docker volume inspect "$bv" >/dev/null 2>&1 \
      && docker run --rm -v "$bv:/b:ro" "$IMG" sh -c "find /b -name '*.dump' -size +0 -mtime -2 | grep -q ." 2>/dev/null; then
      echo "  volume $v: a live Postgres cluster, skipped (its app's dumps carry it)"
      continue
    fi
    echo "  WARNING: volume $v is a live Postgres cluster with no fresh dump in $bv; copied as is, not recoverable" >&2
    unrecoverable+=("$v")
  fi
  vols+=("$v")
done

# Refuse to start without room: the sources' size (read in a container, so root-owned files count) x1.2 plus 20 GB.
size_kb() { docker run --rm -v "$1:/d:ro" "$IMG" du -sk "${@:2}" /d 2>/dev/null | cut -f1; }
need_kb=0
if [ "$paperclip_running" = yes ]; then need_kb=$((need_kb + $(size_kb "$data" '--exclude=/d/paperclip/instances/*/db')))
else need_kb=$((need_kb + $(size_kb "$data"))); fi
[ -d "$state" ] && need_kb=$((need_kb + $(size_kb "$state")))
for v in "${vols[@]}"; do need_kb=$((need_kb + $(size_kb "$v")))
done
need_kb=$((need_kb * 12 / 10 + 20 * 1024 * 1024))
free_kb="$(df -Pk "$out_dir" | awk 'NR==2 {print $4}')"
echo "Needs $((need_kb / 1048576)) GB free in $out_dir, has $((free_kb / 1048576)) GB"
[ "$free_kb" -ge "$need_kb" ] || { echo "error: not enough free space in $out_dir; free some or pass another output dir" >&2; exit 1; }

umask 077
mkdir "$work"
echo "Backing up to $final"

# tar in a container, to stdout. A live tree changes while it is read: GNU tar exits 1 for "file changed as we read it",
# which is fine here (SQLite comes from the online copies, Paperclip from its dumps); 2 and up is a real failure.
ctar() { # docker run args... -- tar args...
  local s=0; docker run --rm "$@" || s=$?
  [ "$s" -le 1 ] || { echo "tar failed (exit $s)" >&2; return "$s"; }
}

pack() { if [ -n "$plain" ]; then cat; else gzip; fi; }

# A directory as <name>.tar[.gz] (read in a container, streamed to its file), plus an online copy of each SQLite database in it under <name>.sqlite/.
snapshot() { # name dir [tar --exclude patterns...]
  local name="$1" dir="$2"; shift 2
  [ -d "$dir" ] || { echo "  $name: $dir is missing, skipped"; return 0; }
  ctar -v "$dir:/d:ro" "$IMG" tar -C /d --warning=no-file-changed --exclude='./.pre-restore-*' "${@/#/--exclude=}" -cf - . | pack >"$work/$name$ext"
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

# Self-hosted Primer's Postgres cluster is a bind mount in the data dir: while it runs it is dumped (primer.sql) and its
# raw directory left out of the data snapshot, as Paperclip's is; stopped, the directory is consistent and travels as is.
skip=()
if [ "$paperclip_running" = yes ]; then skip+=('./paperclip/instances/*/db'); fi
primer_db="$(echo "$running" | grep -x 'primer-db' || true)"
if [ -n "$primer_db" ]; then
  docker compose --env-file "$env_file" exec -T "$primer_db" pg_dump -U primer -d primer | pack >"$work/primer.sql$ext"
  skip+=('./modules/primer/db')
  echo "  Primer is running: its database is dumped to primer.sql$ext"
fi
if [ "$paperclip_running" = yes ]; then
  snapshot data "$data" ${skip[@]+"${skip[@]}"}
  latest_dump="$(find "$data"/paperclip/instances/*/data/backups -type f -size +0 -mtime -2 2>/dev/null | head -1 || true)"
  if [ -n "$latest_dump" ]; then echo "  Paperclip is running: its database comes from dump $(basename "$latest_dump")"
  else
    echo "  WARNING: Paperclip is running and has no fresh DB dump (under two days old); its database is not in this backup (stop the stack for a full one)" >&2
    unrecoverable+=("paperclip")
  fi
else
  snapshot data "$data" ${skip[@]+"${skip[@]}"}
fi
snapshot runner "$state"

# App volumes, each with its labels.
mkdir -p "$work/volumes"
for v in "${vols[@]}"; do
  docker volume inspect -f '{{json .Labels}}' "$v" >"$work/volumes/$v.labels.json"
  ctar -v "$v:/v:ro" "$IMG" tar -C /v --warning=no-file-changed -cf - . | pack >"$work/volumes/$v$ext"
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

printf 'format=3\ncreated=%s\nhost=%s\npaperclip_running=%s\nrunner_state=%s\nunrecoverable=%s\n' "$stamp" "$(hostname)" "$paperclip_running" "$state" "${unrecoverable[*]:-}" >"$work/MANIFEST"
mv "$work" "$final"
echo "Done: $final ($(du -sh "$final" | cut -f1))"
if [ "${#unrecoverable[@]}" -gt 0 ]; then
  echo "error: INCOMPLETE backup, no recoverable database for: ${unrecoverable[*]} (listed in MANIFEST as unrecoverable=)" >&2
  exit 1
fi
