#!/usr/bin/env bash
# One CI job (modules/ci): mint a registration token on the host, then run a fresh runner container that registers
# ephemerally, takes one job, exits and is removed. aidenhq-ci-runner@<n>.service runs this in a loop (Restart=always),
# so <n> units = <n> concurrent runners for the agents org; aidenhq-ci-runner@<org>-<n> serves another org the App is
# installed on (e.g. the product repo's org).   ops/ci-runner.sh [<org>-]<n>
set -euo pipefail
cd "$(dirname "$0")/.."
id="${1:-1}"
org=""
[[ "$id" == *-* ]] && org="${id%-*}" # an org name may hold dashes; the runner number is after the last one
RUNNER_TOKEN="$(node ops/ci-runner-token.mjs ${org:+"$org"})"
export RUNNER_TOKEN
args=(-e RUNNER_TOKEN)
[ -n "$org" ] && args+=(-e "RUNNER_URL=https://github.com/$org") # else compose's default, the agents org
# The npm cache (only _cacache, never _npx or logs), one per org and per ISO week: orgs never share a cache, and a cache is
# never older than two weeks (the previous week's stays for jobs that already mounted it, older ones are deleted). The runner
# is registered to an org, not a repo, so a repo can't be told apart before its job starts. `npm ci` checks every tarball
# against the lockfile's integrity hash, so a poisoned entry fails the install instead of changing it; the runner has no
# npm credentials, so the cache holds public packages only.
data="${AIDENHQ_DATA_DIR:-$(sed -n 's/^AIDENHQ_DATA_DIR=//p' .env 2>/dev/null | tail -n 1)}"
cache_root="${data:-$PWD/data}/ci-npm-cache/${org:-agents}"
week="$(date +%G-W%V)"
mkdir -p "$cache_root/$week" && chmod 0777 "$cache_root/$week" # the runner user (uid 1001) isn't the host user
find "$cache_root" -mindepth 1 -maxdepth 1 -type d -mtime +13 ! -name "$week" -exec rm -rf {} + 2>/dev/null || true
args+=(-v "$cache_root/$week:/home/runner/.npm/_cacache")
name="aidenhq-ci-runner-$id"
docker rm -f "$name" >/dev/null 2>&1 || true # left over from a crash or reboot: run would refuse the name forever
# --build: the runner image (modules/ci/runner) is rebuilt when its Dockerfile changed; cached, it takes about a second.
exec docker compose run --build --rm -T --no-deps --quiet-pull --name "$name" "${args[@]}" ci-runner
