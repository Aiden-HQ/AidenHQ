# The host's apply lock. ops/apply-config.sh opens data/apply.lock at that fixed path on fd 9, locks it and execs
# ops/apply-config-work.sh, which inherits the descriptor and takes no lock of its own -- so one lock covers the whole
# apply, across the hand-over to a newer script too.
#
# AIDENHQ_APPLY_LOCKED is only the hand-over marker: whoever sets it has taken nothing. What counts is the descriptor,
# and it is never trusted on the marker's word:
#   - fd 9 must be a lock this process holds (flock -n on the inherited description: it is refused while another process
#     holds that file), and
#   - fd 9 must be data/apply.lock itself, by device and inode (stat -L reads through the descriptor, so a path string, a
#     hard link or a file swapped in at the path never passes).
# A descriptor locked on some other file is not accepted as the apply's lock: the apply stops naming data/apply.lock, and
# runs no compose at all. So the only state the apply goes on in is the one where it holds data/apply.lock itself.
#
# Both scripts cd to the checkout root first, so the relative path is the same file for both.
APPLY_LOCK=data/apply.lock
APPLY_LOCK_FD=9

# A file's identity as "<device>:<inode>", or nothing when it can't be read.
applyLockId() { stat -L -c '%d:%i' -- "$1" 2>/dev/null; }

# fd 9 is open and this process holds its lock. An open descriptor is not a held lock, so both halves are needed:
#   - a fresh descriptor on the same file cannot take the lock (nobody else has it free), and
#   - relocking fd 9 succeeds: flock is per open file description, so this only works when fd 9's description already
#     carries the lock. A descriptor that is merely open is refused while another process holds the file, and when
#     nobody holds it the fresh probe above has already said so.
applyFdLocked() {
  [ -e "/proc/self/fd/$APPLY_LOCK_FD" ] || return 1
  # A fresh descriptor on the same file: it takes the lock only when nobody holds it, and it is dropped on subshell exit.
  if ( exec 8>>"/proc/self/fd/$APPLY_LOCK_FD"; flock -n 8 ); then return 1; fi
  flock -n "$APPLY_LOCK_FD" 2>/dev/null
}

# fd 9 and data/apply.lock are the same file, by device and inode.
applyFdIsLock() {
  local want have
  want="$(applyLockId "$APPLY_LOCK")"
  have="$(applyLockId "/proc/self/fd/$APPLY_LOCK_FD")"
  [ -n "$want" ] && [ "$want" = "$have" ]
}
