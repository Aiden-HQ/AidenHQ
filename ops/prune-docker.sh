#!/usr/bin/env bash
# The host's Docker disk reclaim (prune-docker.service every four hours, and ops/apply-config-work.sh after each apply).
# `/` climbs with Docker: images, the build cache and one-off containers' writable layers grow between prunes, so the
# reclaim runs every four hours and holds the peak between them, not one nightly sweep.
#
# Every step runs whatever the ones before it did, and the run fails (exit 1: systemd marks the oneshot failed, so
# UnitFailed pages) when any of them did not do its work. A buildx flag or plugin problem, or a status timeout, must not
# skip the image prune — that is the shape of the 45 h with no drop (2026-11-20/21) — and must not pass unseen either:
# a unit whose every command failed is a failed unit, not a clean one. (As separate `ExecStart=-` lines each failure was
# swallowed, including a daemon that was down.)
#
# Retention is unchanged: images nothing runs for 48 h (the rollback window), and the build cache capped at 20 GB, least
# recently used first. An `until` filter frees nothing on the containerd image store (104 GB of cache on the EX44,
# 2026-11-18), so the size cap is the thing that has to hold. Both cap forms are tried because which one the CLI knows
# depends on the buildx plugin (2026-11-21: a deploy logged `buildx Docker CLI plugin not found: falling back to the
# classic builder`): `--max-used-space` is buildx's, the classic fallback only knows `--keep-storage`, and each is a no-op
# where the other works (buildx's `--keep-storage` is its deprecated alias).
#
# Containers: only one-offs — no compose service and no computer box — that have been STOPPED for over a day; a container
# an apply's generation snapshot stopped is a compose service and is never a candidate (see the container block below).
# No volume is ever removed: `docker rm` without -v, no volume prune, no `system prune`, app-warehouse_pgdata included.
set -uo pipefail

DOCKER=${DOCKER:-docker}
STOPPED_SECS=86400 # a one-off goes only after this long stopped (a day)

failed=()
say() { printf 'prune-docker: %s\n' "$*"; }
fail() { failed+=("$1"); printf 'prune-docker: %s\n' "$1" >&2; }

# One run at a time: the timer and an apply can overlap, and Docker refuses a second prune ("a prune operation is already
# running") — which would read as a failed step and page. The wait is long enough for the other run's prunes and short
# enough that a stuck one is reported rather than waited on.
if command -v flock >/dev/null 2>&1; then
  exec 9>>"${XDG_RUNTIME_DIR:-/tmp}/aidenhq-prune-docker.${UID}.lock" || { echo "prune-docker: cannot open the run lock" >&2; exit 1; }
  flock -w 120 9 || { echo "prune-docker: another run held the lock for 2 minutes" >&2; exit 1; }
fi

# The build cache, capped by size in whichever form the installed builder accepts; either one working is the cap holding.
cap_ok=0
"$DOCKER" builder prune -f --max-used-space 20GB && cap_ok=1
"$DOCKER" builder prune -f --keep-storage 20GB && cap_ok=1
[ "$cap_ok" = 1 ] || fail "build cache: neither --max-used-space (buildx) nor --keep-storage (classic builder) was accepted, so the 20 GB cap did not run"

# One-off containers: anything Docker still holds that is NOT a compose service and NOT a computer box, and has been
# stopped for over a day. That is the leak WOR-9559 found (79.5 GB + 62.1 GB of writable layers left by two syft
# containers), and the class a `docker run` without --rm leaves behind. It is not `docker container prune --filter until=`,
# which filters on the container's CREATED time (moby daemon/prune.go, `c.Created.After(until)`): an apply's generation
# snapshot (ops/lib/generations.sh genSnapshot) stops a module's compose services and starts them again when an archive
# fails, and those services are excluded here by their compose label, so a snapshot in flight is never touched. Computer
# boxes are excluded by theirs. No volume is ever removed: `docker rm` without -v drops the writable layer and keeps the
# volumes (app-warehouse_pgdata included).
ids="$("$DOCKER" ps -aq)" || { ids=""; fail "containers: could not list the containers"; }
now="$(date +%s)"
# shellcheck disable=SC2086 # container ids, one word each
for id in $ids; do
  running="" finished="" service="" computer=""
  IFS='|' read -r running finished service computer <<< "$("$DOCKER" inspect \
    -f '{{.State.Running}}|{{.State.FinishedAt}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "aidenhq.computer"}}' \
    "$id" 2>/dev/null)"
  case "$running" in
    true) continue ;; # running: in use, whatever started it
    false) ;;
    *) fail "container $id: state unreadable, left alone"; continue ;;
  esac
  [ -z "$service" ] && [ -z "$computer" ] || continue # a compose service or a computer box: not ours to remove
  stopped="$(date -u -d "$finished" +%s 2>/dev/null)" || { fail "container $id: stop time unreadable ($finished), left alone"; continue; }
  age=$(( now - stopped ))
  if [ "$stopped" -le 0 ]; then
    # The zero time: created and never started. No writable layer to reclaim, and nothing runs it.
    say "container $id: never started, removed"
    "$DOCKER" rm "$id" >/dev/null 2>&1 || fail "container $id: never started but could not be removed"
  elif [ "$age" -lt "$STOPPED_SECS" ]; then
    say "container $id: stopped $(( age / 3600 )) h ago, kept (under $(( STOPPED_SECS / 3600 )) h)"
  elif out="$("$DOCKER" rm "$id" 2>&1)"; then
    say "container $id: removed, stopped $(( age / 3600 )) h ago"
  else
    fail "container $id: stopped $(( age / 3600 )) h ago but could not be removed: $out"
  fi
done

# Images last, so an image whose only user was a one-off removed above can go in this same run. Images a running or
# recent container uses are never removed; 48 h is the rollback window.
"$DOCKER" image prune -af --filter until=48h || fail "images: unused for 48 h and still there (docker image prune failed)"

# What is left, in one line per row in the journal (host-metrics.sh publishes the same rows as aidenhq_docker_* gauges).
# Best effort: a slow or failing `docker system df` never fails the reclaim.
timeout 30 "$DOCKER" system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null || true

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'prune-docker: %d step(s) failed\n' "${#failed[@]}" >&2
  exit 1
fi
say "done: build cache under the 20 GB cap, images unused for 48 h and disposable containers stopped over a day removed"
