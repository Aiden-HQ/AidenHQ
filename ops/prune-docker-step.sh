#!/usr/bin/env bash
# One prune step of prune-docker.service, with its exit status recorded for the unit's last (unprefixed) step.
#
# Every prune `ExecStart=` is `-`-prefixed so a failing builder prune never skips the image or container prune. That prefix
# also hides the failure from systemd, so this wrapper records the status under the unit's systemd INVOCATION_ID and
# ops/prune-docker-verify.sh reads it: the prune runs once, and a failed one still makes the unit fail. A step run outside
# systemd (a manual call) records under its own pid, which no other step shares; verify then has no record to read.
#
# Usage: ops/prune-docker-step.sh <name> <command> [args...]
set -uo pipefail

name="${1:?usage: prune-docker-step.sh <name> <command> [args...]}"; shift
state="${AIDENHQ_STATE_DIR:-${HOME:-/nonexistent}/.local/state/aidenhq}/prune-docker"
mkdir -p "$state" 2>/dev/null || true
run="${INVOCATION_ID:-manual-$$}"
"$@"
rc=$?
if [ -d "$state" ]; then
  printf '%s %s\n' "$run" "$rc" > "$state/$name.status.tmp" 2>/dev/null \
    && mv -f "$state/$name.status.tmp" "$state/$name.status" 2>/dev/null
fi
exit "$rc"
