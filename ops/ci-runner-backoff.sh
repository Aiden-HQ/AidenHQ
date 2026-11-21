#!/usr/bin/env bash
# One CI runner's wait before it mints a registration token (ops/units/aidenhq-ci-runner@.service ExecStartPre).
# ops/ci-runner.sh writes the delay when a mint is refused (a sign-in missing admin:org, GitHub unreachable): 1 second,
# doubling to a minute, cleared by the next token that mints, and dropped when it has gone stale (a drain, a host that was
# down). It waits here rather than in ExecStart so the unit is `activating`, not `active`, while it waits: a refused token
# reads as the restart loop it is (CiRunnerRestartLooping, modules/monitoring/prometheus/rules.yml) instead of a runner that
# looks healthy. A clean job exit writes no delay, so the next runner still starts at once.   ops/ci-runner-backoff.sh [<org>-]<n>
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=ops/lib/ci-runner-backoff.sh
. ops/lib/ci-runner-backoff.sh
id="${1:-1}"
delay="$(ci_runner_backoff_read "$id")"
[ -n "$delay" ] || exit 0
# An older version's marker (300s) is clamped to the cap and the clamp persisted, so a wait that systemd would kill at its
# default 90s ExecStartPre timeout never runs and the next refusal doubles from the cap.
if ci_runner_backoff_over "$id"; then ci_runner_backoff_write "$id" "$delay"; fi
echo "ci runner $id: no registration token last time; retrying after ${delay}s" >&2
exec sleep "$delay"
