#!/usr/bin/env bash
# One prune step of prune-docker.service, with its exit status recorded for the unit's last (unprefixed) step.
#
# Every prune `ExecStart=` is `-`-prefixed so a failing builder prune never skips the image or container prune. That prefix
# also hides the failure from systemd, so this wrapper records the status under the unit's systemd INVOCATION_ID and
# ops/prune-docker-verify.sh reads it: the prune runs once, and a failed one still makes the unit fail. A step run outside
# systemd (a manual call) records under its own pid, which no other step shares; verify then has no record to read.
#
# Usage: ops/prune-docker-step.sh <name> <command> [args...]
#
# The `build-cache` step is the one whose OUTPUT is kept too: it runs right after the two builder prunes, and what it
# writes (`docker system df`) is the cache as it was once pruning finished. The verification judges the 20 GB cap on that
# snapshot, not on a later `docker system df` a build started in the meantime may have grown past 20 GB, which would look
# like a prune that did not cap anything.
set -uo pipefail

name="${1:?usage: prune-docker-step.sh <name> <command> [args...]}"; shift
state="${AIDENHQ_STATE_DIR:-${HOME:-/nonexistent}/.local/state/aidenhq}/prune-docker"
mkdir -p "$state" 2>/dev/null || true
run="${INVOCATION_ID:-manual-$$}"
record() { # file, text (written atomically, ignored when the state dir is unwritable)
  [ -d "$state" ] || return 0
  printf '%s\n' "$2" > "$state/$1.tmp" 2>/dev/null && mv -f "$state/$1.tmp" "$state/$1" 2>/dev/null
}
if [ "$name" = build-cache ]; then
  out="$("$@" 2>/dev/null)"
  rc=$?
  record "$name.status" "$run $rc"
  # The raw rows; rc is recorded with the status, so an empty snapshot on a failed read is not read as "nothing cached".
  record "$name.df" "$out"
  exit "$rc"
fi
"$@"
rc=$?
record "$name.status" "$run $rc"
exit "$rc"
