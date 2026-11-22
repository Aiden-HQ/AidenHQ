#!/usr/bin/env bash
# The last step of prune-docker.service, and the only one not prefixed with `-`: it re-reads the host after the prunes and
# fails the unit when they did not do their work. The prune steps themselves stay independent (every one is `-`-prefixed,
# so a failing builder prune never skips the image prune — that is the shape of the 45 h with no drop on 2026-11-20/21),
# and this is what keeps that from hiding a prune that did nothing at all: a daemon that is down, or a build cache still
# far over its 20 GB cap because neither flag form was accepted, is a failed unit (UnitFailed) rather than a clean one.
#
# It checks three things, each one a way the reclaim can silently not happen:
#   1. the daemon answers (`docker info`);
#   2. the build cache is under the 20 GB cap (with 1 GB of slack for `docker system df`'s rounded sizes);
#   3. no labelled one-off container is still there after having been stopped for over a day (ops/prune-docker-containers.sh
#      should have removed it), and every container it lists can be read (an unreadable one is a cleanup it could not do,
#      not a clean run).
set -uo pipefail

DOCKER=${DOCKER:-docker}
CAP_BYTES=$((21 * 1000 * 1000 * 1000)) # 20 GB cap + 1 GB of rounding in `docker system df`
STOPPED_SECS=86400
LABEL=aidenhq.oneoff=1

bad=()
echo "prune-docker: verify"
"$DOCKER" info >/dev/null 2>&1 || bad+=("the Docker daemon does not answer, so no prune above could have run")

# The cache: the same rows host-metrics.sh publishes as the aidenhq_docker_* gauges, parsed by key (the JSON's field order
# is not a contract).
cache="$(
  timeout 30 "$DOCKER" system df --format '{{json .}}' 2>/dev/null | awk '
    function field(key,  re, s) {
      re = "\"" key "\":\"([^\"]*)\""
      if (!match($0, re)) return ""
      s = substr($0, RSTART, RLENGTH)
      sub("^\"" key "\":\"", "", s); sub("\"$", "", s)
      return s
    }
    field("Type") == "Build Cache" { print field("Size"); exit }'
)"
# `docker system df` prints a Build Cache row even when the cache is empty ("0B"); no row at all is an unfinished or
# truncated read, so the cap cannot be confirmed and this is a failure rather than a pass.
case "$cache" in
  "") bad+=("docker system df gave no Build Cache row, so the 20 GB cap cannot be confirmed") ;;
  *)
    bytes="$(awk -v s="$cache" 'BEGIN {
      sub(/[[:space:]].*$/, "", s)
      if (!match(s, /^[0-9]+(\.[0-9]+)?/)) exit
      n = substr(s, 1, RLENGTH) + 0; u = substr(s, RLENGTH + 1)
      if (u == "TB") n *= 1000000000000; else if (u == "GB") n *= 1000000000; else if (u == "MB") n *= 1000000
      else if (u == "kB") n *= 1000; else if (u != "B" && u != "") exit
      printf "%.0f", n }')"
    [ -n "$bytes" ] || bad+=("the build cache size ($cache) is unreadable, so the 20 GB cap cannot be confirmed")
    [ -z "$bytes" ] || [ "$bytes" -le "$CAP_BYTES" ] || bad+=("the build cache is $cache, over the 20 GB cap: neither builder flag form capped it")
    ;;
esac

# One-offs: what ops/prune-docker-containers.sh should have removed, and did not. A container that vanished between the
# listing and its inspect is gone, which is the result we wanted, not a failure.
now="$(date +%s)"
left="$("$DOCKER" ps -aq --filter "label=$LABEL" 2>/dev/null)" || bad+=("could not list the containers labelled $LABEL")
# shellcheck disable=SC2086 # container ids, one word each
for id in $left; do
  running="" finished="" service="" computer=""
  IFS='|' read -r running finished service computer <<< "$("$DOCKER" inspect \
    -f '{{.State.Running}}|{{.State.FinishedAt}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "aidenhq.computer"}}' \
    "$id" 2>/dev/null)"
  if [ -z "$running" ]; then
    "$DOCKER" ps -aq 2>/dev/null | grep -qx -- "$id" || continue # removed since the listing
    bad+=("container $id is labelled $LABEL but cannot be inspected, so the cleanup could not check it")
    continue
  fi
  [ "$running" = false ] && [ -z "$service" ] && [ -z "$computer" ] || continue
  stopped="$(date -u -d "$finished" +%s 2>/dev/null)" || continue
  [ "$stopped" -gt 0 ] || continue
  [ $(( now - stopped )) -lt "$STOPPED_SECS" ] || bad+=("container $id is a one-off stopped over a day ago and still there")
done

# The image prune is prefixed with `-` in the unit, so its own failure never reached systemd. Run it again here, unprefixed:
# it is idempotent (the second run of a clean host removes nothing), and if the step above could not remove the images
# unused for 48 h, this fails and the unit with it — the reclaim's result is reported, not just attempted.
"$DOCKER" image prune -af --filter until=48h >/dev/null 2>&1 \
  || bad+=("images unused for 48 h could not be pruned (docker image prune failed)")

if [ "${#bad[@]}" -gt 0 ]; then
  printf 'prune-docker: %s\n' "${bad[@]}" >&2
  exit 1
fi
echo "prune-docker: verified: daemon answers, build cache under 20 GB, no one-off stopped over a day is left"
