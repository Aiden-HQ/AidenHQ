#!/usr/bin/env bash
# The one-off container reclaim (prune-docker.service's fourth step, every four hours, and ops/apply-config-work.sh after
# each rebuild). A container started with `docker run` and no `--rm` keeps its whole writable layer forever; nothing else
# on the host prunes one. That is the leak WOR-9559 found: 79.5 GB + 62.1 GB of writable layers left by two syft scans.
#
# Only one-offs go — a container with no compose service and no computer box — and only once it has been STOPPED for over a
# day. It is not `docker container prune --filter until=`: that filters on the container's CREATED time (moby
# daemon/prune.go, `c.Created.After(until)`), so an apply's generation snapshot (ops/lib/generations.sh genSnapshot stops a
# module's compose services and starts them again when an archive fails) would have a service removed from under it. A
# container with no stop time (created and never started) is kept: the day cannot be measured against it.
#
# No volume is ever removed: `docker rm` without -v drops the writable layer and keeps the volumes (app-warehouse_pgdata
# included). The unit prefixes this step with `-`, so its exit code never skips a later step; ops/prune-docker-verify.sh
# re-reads the host afterwards and fails the unit when anything this should have removed is still there.
set -uo pipefail

DOCKER=${DOCKER:-docker}
STOPPED_SECS=86400 # a one-off goes only after this long stopped (a day)

failed=0
say() { printf 'prune-docker: %s\n' "$*"; }
fail() { failed=1; printf 'prune-docker: %s\n' "$*" >&2; }

ids="$("$DOCKER" ps -aq)" || { ids=""; fail "could not list the containers"; }
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
  if [ "$stopped" -le 0 ]; then
    # The zero time: created and never started. It has no stop time to measure the day against, so the rule gives no
    # reason to remove it.
    say "container $id: never started, kept (no stopped time to measure $(( STOPPED_SECS / 3600 )) h against)"
    continue
  fi
  age=$(( now - stopped ))
  if [ "$age" -lt "$STOPPED_SECS" ]; then
    say "container $id: stopped $(( age / 3600 )) h ago, kept (under $(( STOPPED_SECS / 3600 )) h)"
  elif out="$("$DOCKER" rm "$id" 2>&1)"; then
    say "container $id: removed, stopped $(( age / 3600 )) h ago"
  else
    fail "container $id: stopped $(( age / 3600 )) h ago but could not be removed: $out"
  fi
done

[ "$failed" -eq 0 ] || exit 1
