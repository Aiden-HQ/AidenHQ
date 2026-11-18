#!/usr/bin/env bash
# The host's checkout of a GitHub instance repo pulls with a read-only SSH deploy key from the vault, never with the GitHub
# App's key (codehost-github alone holds it). Run once at setup, from the product checkout, with AidenHQ up:
#   ops/instance-deploy-key.sh
# It makes the key (vault: instance-deploy/key), adds its public half to $AIDENHQ_INSTANCE_REPO as a read-only deploy key from
# inside codehost-github (its src/deploy-key.ts; the App needs Administration: Read and write there), and points the checkout at
# it: origin over ssh, core.sshCommand with that key, no credential helper. Pushes to the instance stay codehost writes.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
repo="${AIDENHQ_INSTANCE_REPO:?set AIDENHQ_INSTANCE_REPO (owner/name) in .env}"
inst="${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env}"; inst="${inst/#\~/$HOME}"
dir="${AIDENHQ_SECRETS_DIR:-$HOME/.config/aidenhq}"; dir="${dir/#\~/$HOME}/instance-deploy"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "AIDENHQ_INSTANCE_REPO must be owner/name" >&2; exit 1; }
mkdir -p -m 700 "$dir"
[ -s "$dir/key" ] || ssh-keygen -q -t ed25519 -N "" -C "aidenhq-host-instance-read" -f "$dir/key"
chmod 600 "$dir/key"
ch="$(docker ps -q --filter label=aidenhq.service=codehost-github)"
[ "$(echo "$ch" | grep -c .)" = 1 ] || { echo "codehost-github isn't running (exactly one container)" >&2; exit 1; }
docker exec -i "$ch" node --disable-warning=ExperimentalWarning src/deploy-key.ts "$repo" "aidenhq host (read-only)" < "$dir/key.pub"
git -C "$inst" remote set-url origin "git@github.com:$repo.git"
git -C "$inst" config core.sshCommand "ssh -i $dir/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git -C "$inst" config --unset-all credential.helper || true
git -C "$inst" config --unset-all credential.useHttpPath || true
git -C "$inst" fetch --quiet origin main && echo "$inst: pulls $repo with the read-only deploy key"
