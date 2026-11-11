#!/usr/bin/env bash
# Give the runner write access to one more repo (e.g. a new app's): a repo-scoped deploy key, an ssh host alias,
# and a pushInsteadOf so the runner's approved pushes use it. Idempotent. Run as the AidenHQ user on the VM:
#   ssh <user>@<host> 'bash -s owner/repo' < ops/vm/add-deploy-key.sh
# Then add the printed key with write access (or let this script do it if the VM's gh may).
set -euo pipefail
repo="${1:?usage: add-deploy-key.sh owner/repo}"
slug="${repo//\//-}"
key="$HOME/.ssh/${slug//-/_}_deploy"
host="github-$slug"

[ -f "$key" ] || ssh-keygen -q -t ed25519 -N "" -C "aidenhq runner: $repo" -f "$key"
grep -q "^Host $host\$" ~/.ssh/config 2>/dev/null || printf '\n# Write deploy key for %s (ops/vm/add-deploy-key.sh).\nHost %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' "$repo" "$host" "$key" >>~/.ssh/config
git config --global --unset-all "url.git@$host:$repo.pushinsteadof" || true
git config --global --add "url.git@$host:$repo.pushinsteadof" "https://github.com/$repo"
git config --global --add "url.git@$host:$repo.pushinsteadof" "git@github.com:$repo"

if gh repo deploy-key list -R "$repo" 2>/dev/null | grep -q "aidenhq runner"; then
  echo "deploy key already on $repo"
elif gh repo deploy-key add "$key.pub" -R "$repo" -w -t "aidenhq runner" 2>/dev/null; then
  echo "deploy key added to $repo (write)"
else
  echo "Add this key to $repo with write access (Settings > Deploy keys), or run on your laptop:"
  echo "  gh repo deploy-key add - -R $repo -w -t 'aidenhq runner' <<< '$(cat "$key.pub")'"
fi
ssh -T "git@$host" 2>&1 | head -1 || true
