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
# The npm cache (~/.npm: only the job's own copy is mounted, so nothing of a job's survives it). No job writes a cache anyone else reads: the host fills a seed per org and
# ISO week from the lockfiles of this checkout (the deployed main) with `npm ci --ignore-scripts`, and each job gets its own
# throwaway copy of the seed, deleted when the job ends. A PR job can't poison the seed or a later job, and a seed is never
# older than two weeks. The runner is registered to an org, not a repo, so a per-repo cache can't be told apart before its job
# starts. `npm ci` also checks every tarball against the lockfile's integrity hash, and the runner holds no npm credentials.
data="${AIDENHQ_DATA_DIR:-$(sed -n 's/^AIDENHQ_DATA_DIR=//p' .env 2>/dev/null | tail -n 1)}"
cache_root="${data:-$PWD/data}/ci-npm-cache/${org:-agents}"
seed="$cache_root/$(date +%G-W%V)"
mkdir -p "$cache_root"
find "$cache_root" -mindepth 1 -maxdepth 1 -type d -mtime +13 ! -path "$seed" -exec rm -rf {} + 2>/dev/null || true
(
  flock 9 # the units start together: one seeds, the others wait
  if [ ! -e "$seed/.complete" ]; then
    rm -rf "$seed"; mkdir -p "$seed"
    work="$(mktemp -d)"
    while IFS= read -r lock; do
      rm -rf "$work/pkg"; mkdir "$work/pkg"; cp "$lock" "$(dirname "$lock")/package.json" "$work/pkg/" 2>/dev/null || continue
      (cd "$work/pkg" && npm ci --ignore-scripts --no-audit --no-fund --cache "$seed" >/dev/null 2>&1) || true # a failed one only means fewer hits
    done < <(find . -name package-lock.json -not -path '*/node_modules/*')
    rm -rf "$work" "$seed/_logs" "$seed/_npx"; touch "$seed/.complete"
  fi
) 9>"$cache_root/.lock"
job_cache="$cache_root/job-$id-$$"
trap 'rm -rf "$job_cache"' EXIT
find "$cache_root" -mindepth 1 -maxdepth 1 -name 'job-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
cp -a "$seed" "$job_cache" && rm -f "$job_cache/.complete" && chmod -R a+rwX "$job_cache" # the runner user (uid 1001) isn't the host user; this copy is the job's alone
args+=(-v "$job_cache:/home/runner/.npm")
name="aidenhq-ci-runner-$id"
docker rm -f "$name" >/dev/null 2>&1 || true # left over from a crash or reboot: run would refuse the name forever
# --build: the runner image (modules/ci/runner) is rebuilt when its Dockerfile changed; cached, it takes about a second.
docker compose run --build --rm -T --no-deps --quiet-pull --name "$name" "${args[@]}" ci-runner
