#!/usr/bin/env bash
# The host's checkout of a GitHub instance repo pulls with a read-only SSH deploy key from the vault, never with the GitHub
# App's key (codehost-github alone holds it). Run once at setup, from the product checkout:
#   ops/instance-deploy-key.sh
# It makes the key (vault: instance-deploy/key), adds its public half to $AIDENHQ_INSTANCE_REPO as a read-only deploy key with
# the owner's own `gh` login (never the App, which holds no Administration permission), pins GitHub's published SSH host keys
# (api.github.com/meta, over https) in the vault's known_hosts, and points the checkout at both: origin over ssh,
# core.sshCommand with that key and strict host key checking, no credential helper. Pushes to the instance stay codehost
# writes. Without the owner's `gh` here it prints the one command for the owner to run, and stops.
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

title="aidenhq host (read-only)"
if gh repo deploy-key list -R "$repo" 2>/dev/null | grep -qF "$title"; then
  echo "$repo: the read-only deploy key is there already"
elif ! gh repo deploy-key add "$dir/key.pub" -R "$repo" -t "$title" 2>/dev/null; then
  echo "Add the host's read-only deploy key with your own GitHub login, then run this again:"
  echo "  gh repo deploy-key add - -R $repo -t '$title' <<< '$(cat "$dir/key.pub")'"
  exit 1
fi

# GitHub's SSH host keys, from its published list over https: no trust on first use.
node -e '
  fetch("https://api.github.com/meta", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) })
    .then((r) => r.json()).then((m) => {
      const keys = (m.ssh_keys ?? []).filter((k) => /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+\/=]+$/.test(k));
      if (!keys.length) throw new Error("api.github.com/meta listed no SSH host keys");
      process.stdout.write(keys.map((k) => `github.com ${k}\n`).join(""));
    }).catch((e) => { console.error(e.message); process.exit(1); });' > "$dir/known_hosts.tmp"
mv -f "$dir/known_hosts.tmp" "$dir/known_hosts"

git -C "$inst" remote set-url origin "git@github.com:$repo.git"
git -C "$inst" config core.sshCommand "ssh -i '$dir/key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$dir/known_hosts'"
git -C "$inst" config --unset-all credential.helper || true
git -C "$inst" config --unset-all credential.useHttpPath || true
git -C "$inst" fetch --quiet origin main && echo "$inst: pulls $repo with the read-only deploy key"
