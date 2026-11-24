#!/usr/bin/env bash
# Nightly off-host backup (aidenhq-backup.timer, installed by ops/apply-config.sh while the instance sets
# `backup_repository`). Runs scripts/backup.sh --plain into backups/offsite/ (the one local copy), then restic sends it,
# with the vault's ciphertext, .env, compose.override.yaml, config/, the notes vault and transcripts, to the restic
# repository `backup_repository` names, for example a Hetzner Storage Box: sftp://u12345@u12345.your-storagebox.de:23/aidenhq
# (this user's SSH key must be authorised there and its host key known). The repository password is the vault's
# `restic_password`; keep a copy in your password manager too, since a lost host takes the vault with it.
# Keeps 7 daily, 4 weekly and 6 monthly snapshots; on the 1st of the month it also runs `restic check`.
# restic is v0.19.1 (released 2026-07-05), the checksummed release binary, fetched on first use.
#   ops/backup-offsite.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
expand() { local p="$1"; echo "${p/#\~/$HOME}"; }
inst="$(expand "${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env}")"
url="$(sed -n "s/^[[:space:]]\{1,\}backup_repository:[[:space:]]*[\"']\{0,1\}\([^\"' #]*\).*/\1/p" "$inst/instance.yaml" | head -1)"
[ -n "$url" ] || { echo "backup_repository is not set in $inst/instance.yaml" >&2; exit 1; }
secrets="$(expand "${AIDENHQ_SECRETS_DIR:-$HOME/.config/aidenhq}")"
mountpoint -q "$secrets" || [ ! -e "$HOME/.local/share/aidenhq/vault.enc" ] || { echo "the secret vault isn't mounted at $secrets" >&2; exit 1; }
[ -s "$secrets/restic_password" ] || { echo "no restic_password in $secrets" >&2; exit 1; }

# sha256s from the release's SHA256SUMS.
ver=0.19.1
case "$(uname -m)" in
  x86_64) arch=amd64 sum=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c ;;
  aarch64 | arm64) arch=arm64 sum=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465 ;;
  *) echo "restic has no pinned build for $(uname -m)" >&2; exit 1 ;;
esac
restic="$HOME/.local/share/aidenhq/restic-$ver"
if [ ! -x "$restic" ]; then
  mkdir -p "$(dirname "$restic")"
  curl -fsSLo "$restic.bz2" https://github.com/restic/restic/releases/download/v$ver/restic_${ver}_linux_$arch.bz2
  echo "$sum  $restic.bz2" | sha256sum -c - >/dev/null
  bunzip2 -f "$restic.bz2" && chmod 0755 "$restic"
fi
export RESTIC_REPOSITORY="$url" RESTIC_PASSWORD_FILE="$secrets/restic_password"

staging=backups/offsite
mkdir -p "$staging"
old="$(ls -d "$staging"/aidenhq-* 2>/dev/null || true)"
# An incomplete backup (exit 1) stays on disk but is neither uploaded nor allowed to replace the previous local copy
# (the next complete run removes both), so restic's retention only ever counts complete backups.
if ! scripts/backup.sh "$staging" --plain; then echo "error: the backup was incomplete (see above); nothing was uploaded and the previous copy is kept" >&2; exit 1; fi
[ -z "$old" ] || rm -rf $old

"$restic" cat config >/dev/null 2>&1 || "$restic" init
paths=("$staging")
for p in "$HOME/.local/share/aidenhq/vault.enc" .env compose.override.yaml config "${VAULT_DIR:-}" "${TRANSCRIPTS_DIR:-}"; do
  [ -n "$p" ] && [ -e "$(expand "$p")" ] && paths+=("$(expand "$p")")
done
"$restic" backup --tag aidenhq "${paths[@]}"
"$restic" forget --tag aidenhq --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
if [ "$(date -u +%d)" = 01 ]; then "$restic" check; fi
echo "off-host backup done: $url"
