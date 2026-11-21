#!/usr/bin/env bash
# A CI runner's persisted backoff, shared by ops/ci-runner.sh (which writes it when a registration mint is refused) and
# ops/ci-runner-backoff.sh (which sleeps it out in the unit's ExecStartPre). Sourced, never run. The cap is a minute: systemd's
# default ExecStartPre timeout is 90s, so a longer wait would be killed before ci-runner.sh could retry. A marker is also
# dropped when it is stale: a unit stopped for a drain or a host that was down has not refused anything since, and the owner
# may have fixed the sign-in meanwhile.

CI_RUNNER_BACKOFF_MAX=60
# A marker older than this was not written by a refusal loop still running: start at once rather than serve it.
CI_RUNNER_BACKOFF_STALE=900

# <data>/ci-runner/<id>.backoff, the id reduced to the characters a filename takes (an org id may hold more).
ci_runner_backoff_marker() {
  printf '%s/ci-runner/%s.backoff' "${AIDENHQ_DATA_DIR:-data}" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.@-' '_' | cut -c1-100)"
}

# The wait the last refusal left; nothing when there is no marker, it is unreadable or stale, or it is not a delay at all.
ci_runner_backoff_read() {
  local marker delay stamp age
  marker="$(ci_runner_backoff_marker "$1")"
  delay="$(cat "$marker" 2>/dev/null || true)"
  [[ "$delay" =~ ^[0-9]+$ ]] || return 0
  [ "$delay" -ge 1 ] || return 0
  stamp="$(stat -c %Y "$marker" 2>/dev/null || true)"
  [[ "$stamp" =~ ^[0-9]+$ ]] || return 0
  age=$(( $(date +%s) - stamp ))
  [ "$age" -le "$CI_RUNNER_BACKOFF_STALE" ] || return 0
  # A marker past the cap is not a delay this version wrote: serve nothing rather than outlast systemd's ExecStartPre timeout.
  [ "$delay" -le "$CI_RUNNER_BACKOFF_MAX" ] || return 0
  printf '%s\n' "$delay"
}

# Persist this refusal's wait, clamped to the cap. A data dir that can't take it is said, not fatal: the unit still exits and
# restarts (at RestartSec=1), and that oscillation is what CiRunnerRestartLooping alerts on.
ci_runner_backoff_write() {
  local marker delay="$2"
  marker="$(ci_runner_backoff_marker "$1")"
  [ "$delay" -ge 1 ] || delay=1
  [ "$delay" -le "$CI_RUNNER_BACKOFF_MAX" ] || delay=$CI_RUNNER_BACKOFF_MAX
  if ! mkdir -p "$(dirname "$marker")" 2>/dev/null || ! printf '%s\n' "$delay" > "$marker" 2>/dev/null; then
    echo "ci runner $1: could not record the ${delay}s backoff at $marker" >&2
  fi
}

# Forget the delay (a token minted): the next refusal starts again at a second. Best effort: a data dir that cannot be
# written (a file where the dir should be, ENOTDIR) must not stop the job now that GitHub mints again -- the marker is only
# a wait, and a stale one is dropped by ci_runner_backoff_read's staleness check anyway.
ci_runner_backoff_clear() {
  rm -f "$(ci_runner_backoff_marker "$1")" 2>/dev/null || true
}
