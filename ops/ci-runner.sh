#!/usr/bin/env bash
# One CI job (modules/ci): mint a registration token on the host, then run a fresh runner container that registers
# ephemerally, takes one job, exits and is removed. aidenhq-ci-runner@<n>.service runs this in a loop (Restart=always),
# so <n> units = <n> concurrent runners.   ops/ci-runner.sh <n>
set -euo pipefail
cd "$(dirname "$0")/.."
RUNNER_TOKEN="$(node ops/ci-runner-token.mjs)"
export RUNNER_TOKEN
name="aidenhq-ci-runner-${1:-1}"
docker rm -f "$name" >/dev/null 2>&1 || true # left over from a crash or reboot: run would refuse the name forever
exec docker compose run --rm -T --no-deps --quiet-pull --name "$name" -e RUNNER_TOKEN ci-runner
