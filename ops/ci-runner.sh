#!/usr/bin/env bash
# One CI job (modules/ci): mint a registration token on the host, then run a fresh runner container that registers
# ephemerally, takes one job, exits and is removed. aidenhq-ci-runner@<n>.service runs this in a loop (Restart=always),
# so <n> units = <n> concurrent runners for the fleet org; aidenhq-ci-runner@<org>-<n> serves another org (e.g. the product
# repo's org).   ops/ci-runner.sh [<org>-]<n>
set -euo pipefail
cd "$(dirname "$0")/.."
id="${1:-1}"
org=""
[[ "$id" == *-* ]] && org="${id%-*}" # an org name may hold dashes; the runner number is after the last one
# A refused registration token (the owner's sign-in missing admin:org, GitHub unreachable) must not spin at the unit's
# RestartSec=1: back off here, where a refused mint is told apart from a finished job, and keep RestartSec=1 for the
# job-to-job exit, which has to start the next runner at once. The delay doubles per refusal up to 5 minutes, and the next
# token that mints forgets it.
backoff="${AIDENHQ_DATA_DIR:-$PWD/data}/ci-runner/$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.@-' '_' | cut -c1-100).backoff"
if ! RUNNER_TOKEN="$(node ops/ci-runner-token.ts ${org:+"$org"})"; then
  delay="$(cat "$backoff" 2>/dev/null || true)"
  [[ "$delay" =~ ^[0-9]+$ ]] && [ "$delay" -ge 1 ] || delay=1
  mkdir -p "$(dirname "$backoff")"
  echo "$(( delay * 2 > 300 ? 300 : delay * 2 ))" > "$backoff"
  echo "ci runner $id: no registration token; retrying in ${delay}s" >&2
  sleep "$delay"
  exit 1
fi
rm -f "$backoff"
export RUNNER_TOKEN
args=(-e RUNNER_TOKEN)
[ -n "$org" ] && args+=(-e "RUNNER_URL=https://github.com/$org") # else compose's default, the fleet org
name="aidenhq-ci-runner-$id"
docker rm -f "$name" >/dev/null 2>&1 || true # left over from a crash or reboot: run would refuse the name forever
# --build: the runner image (modules/ci/runner) is rebuilt when its Dockerfile changed; cached, it takes about a second.
exec docker compose run --build --rm -T --no-deps --quiet-pull --name "$name" "${args[@]}" ci-runner
