#!/usr/bin/env bash
# Apply the instance on this host. This is the locked entry point: it takes the host's apply lock, then hands the whole
# apply to ops/apply-config-work.sh, which takes no lock of its own.
#
# Only one apply runs on a host at a time, and the lock is data/apply.lock at a fixed path (the data dir is where the
# rest of the host's state lives, and it exists before anything else in the apply is read). It is taken before .env is
# sourced, so nothing the apply reads decides what it locks. A second apply exits at once with `another apply is
# running` rather than queueing: it would otherwise wait through a whole apply, and the caller already knows.
#
# The lock's file descriptor is 9, and it is held across the exec, so apply-config-work.sh inherits the held lock.
# AIDENHQ_APPLY_LOCKED is only the hand-over marker: a process that sets it has not thereby taken anything. With the
# marker set, fd 9 must carry a lock this process holds and be the same file as data/apply.lock, by device and inode
# (ops/lib/apply-lock.sh) -- a descriptor on any other file, however locked, is refused here and again in the work
# script, naming the lock. Without the marker this is the process that takes the lock, at that fixed path.
#
#   ops/apply-config.sh [<instance commit sha>]
set -euo pipefail

main() {
  # The checkout root, as a real path: /proc/self/fd is read for fd 9, and a relative cd would make every later path
  # comparison depend on the caller's working directory.
  cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
  # shellcheck source=ops/lib/apply-lock.sh
  . ops/lib/apply-lock.sh

  if [ -n "${AIDENHQ_APPLY_LOCKED:-}" ]; then
    # A hand-over from an apply already running (ops/apply-config-work.sh execs this script when the product changed it)
    # arrives with the lock held on fd 9. That claim is checked, never taken on the marker's word: fd 9 must carry a lock
    # this process holds and must be data/apply.lock itself. A marker over any other descriptor is a state this apply
    # never produces, so it stops here rather than open the lock itself -- recovering would be exactly the hole, an apply
    # that goes on to compose on the strength of a descriptor that was never the lock.
    if ! { applyFdLocked && applyFdIsLock; }; then
      echo "refusing: $APPLY_LOCK is not held on fd $APPLY_LOCK_FD ($(applyLockId "/proc/self/fd/$APPLY_LOCK_FD" || echo "not an open file"), not $(applyLockId "$APPLY_LOCK" || echo "an existing file"))" >&2
      exit 1
    fi
  else
    mkdir -p data
    exec 9>>data/apply.lock
    if ! flock -n 9; then
      echo "refusing: another apply is running (data/apply.lock is held)" >&2
      exit 1
    fi
    # From here fd 9 is data/apply.lock, held for the life of this process and the one it execs. The marker says so to
    # the work script, which checks the descriptor again before it reads .env.
    export AIDENHQ_APPLY_LOCKED="$APPLY_LOCK_FD"
  fi
  exec ops/apply-config-work.sh "$@"
}

main "$@"
