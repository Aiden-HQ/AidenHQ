#!/usr/bin/env bash
# One CI runner's wait before it mints a registration token (ops/units/aidenhq-ci-runner@.service ExecStartPre).
# ops/ci-runner.sh writes the delay when a mint is refused (a sign-in missing admin:org, GitHub unreachable): 1 second,
# doubling to a minute, cleared by the next token that mints. It waits here rather than in ExecStart so the unit is
# `activating`, not `active`, while it waits: a refused token reads as the restart loop it is (CiRunnerRestartLooping,
# modules/monitoring/prometheus/rules.yml) instead of a runner that looks healthy. A clean job exit writes no delay, so
# the next runner still starts at once.   ops/ci-runner-backoff.sh [<org>-]<n>
set -euo pipefail
cd "$(dirname "$0")/.."
id="${1:-1}"
marker="${AIDENHQ_DATA_DIR:-data}/ci-runner/$(printf '%s' "$id" | tr -c 'A-Za-z0-9_.@-' '_' | cut -c1-100).backoff"
delay="$(cat "$marker" 2>/dev/null || true)"
[[ "$delay" =~ ^[0-9]+$ ]] || exit 0
[ "$delay" -ge 1 ] || exit 0
echo "ci runner $id: no registration token last time; retrying after ${delay}s" >&2
exec sleep "$delay"
