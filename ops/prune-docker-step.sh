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
# The `build-cache` step is the one whose OUTPUT is kept too: it runs right after the two builder prunes and before the
# image and container prunes, and what it writes (`docker system df`) is the cache as it was once pruning finished. The
# verification judges the build-cache ceiling on that snapshot, not on a later `docker system df` a build started in the
# meantime may have grown past it, which would look like a prune that did not cap anything. Its record holds the invocation, the
# status and the rows in one write (`<run> <rc>` then the rows): each is only current if all of it is.
set -uo pipefail

name="${1:?usage: prune-docker-step.sh <name> <command> [args...]}"; shift
state="${AIDENHQ_STATE_DIR:-${HOME:-/nonexistent}/.local/state/aidenhq}/prune-docker"
mkdir -p "$state" 2>/dev/null || true
run="${INVOCATION_ID:-manual-$$}"
record() { # file, text (one atomic write, ignored when the state dir is unwritable)
  [ -d "$state" ] || return 0
  printf '%s\n' "$2" > "$state/$1.tmp" 2>/dev/null && mv -f "$state/$1.tmp" "$state/$1" 2>/dev/null
}
if [ "$name" = build-cache ]; then
  out="$("$@" 2>/dev/null)"
  rc=$?
  # One record, written once: the invocation, the status and the rows land together, so a failed write can never leave a
  # new status beside an old snapshot (or the reverse) and make the previous run's cache look like this run's.
  record "$name" "$(printf '%s %s\n%s\n' "$run" "$rc" "$out")"
  exit "$rc"
fi
"$@"
rc=$?
record "$name" "$(printf '%s %s\n' "$run" "$rc")"
exit "$rc"
