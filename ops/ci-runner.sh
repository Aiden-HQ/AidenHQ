#!/usr/bin/env bash
# One CI job (modules/ci): mint a registration token on the host, then run a fresh runner container that registers
# ephemerally, takes one job, exits and is removed. aidenhq-ci-runner@<n>.service runs this in a loop (Restart=always),
# so <n> units = <n> concurrent runners for the fleet org; aidenhq-ci-runner@<org>-<n> serves another org (e.g. the product
# repo's org).   ops/ci-runner.sh [<org>-]<n>
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=ops/lib/ci-runner-backoff.sh
. ops/lib/ci-runner-backoff.sh
id="${1:-1}"
org=""
[[ "$id" == *-* ]] && org="${id%-*}" # an org name may hold dashes; the runner number is after the last one
# A refused registration token (the owner's sign-in missing admin:org, GitHub unreachable) must not spin at the unit's
# RestartSec=1: note a delay here, where a refused mint is told apart from a finished job, and keep RestartSec=1 for the
# job-to-job exit, which has to start the next runner at once. The delay doubles per refusal up to a minute, and the next
# token that mints forgets it. The wait itself is ops/ci-runner-backoff.sh in ExecStartPre, so the unit is activating (not
# active) while it waits and the loop stays visible to CiRunnerRestartLooping. Both scripts keep the file in one helper.
if ! RUNNER_TOKEN="$(node ops/ci-runner-token.ts ${org:+"$org"})"; then
  delay="$(ci_runner_backoff_read "$id")"
  # No delay yet: the first refused token waits a second. Else the wait just served doubles; a minute is the cap.
  if [ -n "$delay" ]; then delay=$(( delay * 2 )); else delay=1; fi
  ci_runner_backoff_write "$id" "$delay"
  echo "ci runner $id: no registration token; the next attempt waits ${delay}s" >&2
  exit 1
fi
ci_runner_backoff_clear "$id"
export RUNNER_TOKEN
args=(-e RUNNER_TOKEN)
[ -n "$org" ] && args+=(-e "RUNNER_URL=https://github.com/$org") # else compose's default, the fleet org
name="aidenhq-ci-runner-$id"
docker rm -f "$name" >/dev/null 2>&1 || true # left over from a crash or reboot: run would refuse the name forever
# --build: the runner image (modules/ci/runner) is rebuilt when its Dockerfile changed; cached, it takes about a second.
exec docker compose run --build --rm -T --no-deps --quiet-pull --name "$name" "${args[@]}" ci-runner
