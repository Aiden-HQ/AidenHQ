#!/usr/bin/env bash
# The last step of prune-docker.service, and the only one not prefixed with `-`: it re-reads the host after the prunes and
# fails the unit when they did not do their work. The prune steps themselves stay independent (every one is `-`-prefixed,
# so a failing builder prune never skips the image prune — that is the shape of the 45 h with no drop on 2026-11-20/21),
# and this is what keeps that from hiding a prune that did nothing at all: a daemon that is down, or a build cache still
# far over its 20 GB cap because neither flag form was accepted, is a failed unit (UnitFailed) rather than a clean one.
#
# It checks these, each one a way the reclaim can silently not happen:
#   1. the daemon answers (`docker info`);
#   2. the build cache was under the 20 GB cap (with 1 GB of slack for `docker system df`'s rounded sizes) right after the
#      builder prunes — the snapshot the `build-cache` step took then, not a `docker system df` taken here, which a build
#      started since could have grown past 20 GB (that growth is not a failed prune);
#   3. no labelled one-off container is still there after having been stopped for over a day (ops/prune-docker-containers.sh
#      should have removed it), and every container it lists can be read (an unreadable one is a cleanup it could not do,
#      not a clean run);
#   4. the image step's recorded exit status is 0 (its `-` prefix keeps a failure from skipping the next step, and this is
#      how it still fails the unit), and the `build-cache` step — which took the snapshot the cap is judged on — could run
#      and save it;
set -uo pipefail

DOCKER=${DOCKER:-docker}
CAP_BYTES=$((21 * 1000 * 1000 * 1000)) # 20 GB cap + 1 GB of rounding in `docker system df`
STOPPED_SECS=86400
LABEL=aidenhq.oneoff=1

bad=()
echo "prune-docker: verify"
"$DOCKER" info >/dev/null 2>&1 || bad+=("the Docker daemon does not answer, so no prune above could have run")

# Each prune step runs through ops/prune-docker-step.sh, which records its exit status under this invocation
# ($INVOCATION_ID). The `-` prefix in the unit keeps a failure from skipping the next step, and this is how the failure
# still reaches systemd: the image and container prunes are read here instead of being run a second time (a second 48 h
# image prune on a large host doubles the work and can outlast the unit's timeout). Under systemd a missing record means
# the wrapper ran but could not record its result, which is unknown, not a pass; a run outside systemd (no INVOCATION_ID)
# has no record to expect, and the direct checks below still apply. The two builder forms are alternatives — one is
# expected to fail with `unknown flag` on a CLI that lacks the other — so their status is not read; the cache size is what
# says whether the cap held.
state="${AIDENHQ_STATE_DIR:-${HOME:-/nonexistent}/.local/state/aidenhq}/prune-docker"
step_status() { # name -> the status of this invocation's step, or nothing
  local f="$state/$1.status" run rc
  [ -f "$f" ] || return 0
  read -r run rc < "$f" || return 0
  [ "$run" = "${INVOCATION_ID:-manual-$$}" ] && printf '%s' "$rc"
  return 0
}
for name in images; do
  rc="$(step_status "$name")"
  case "$rc" in
    # Under systemd every -prefixed step above ran, so a missing status means the wrapper could not record its result:
    # that result is unknown, not a success.
    "") [ -z "${INVOCATION_ID:-}" ] || bad+=("the $name prune step left no status, so its result is unknown") ;;
    0) ;;
    *) bad+=("the $name prune step exited $rc (see its journal line above)") ;;
  esac
done

# The cache: the rows the `build-cache` step saved right after the builder prunes (invoked as
# `prune-docker-step.sh build-cache .../docker system df --format '{{json .}}'`), parsed by key (the JSON's field order is
# not a contract). Judging that snapshot instead of running `docker system df` again here is what keeps a build that grew
# the cache after the prune from reading as a prune that capped nothing. Run by hand (no INVOCATION_ID) no step ran and
# there is no snapshot, so it reads the cache now, which is the same result when nothing else is building.
df_file="$state/build-cache.df"
df_out=""
# df_ok says the snapshot (or the read made in its place) is there to judge: a read that failed is reported, and the
# `case "$cache"` below must not then read an empty reading as "nothing cached".
df_ok=1
if [ -n "$(step_status build-cache)" ] || [ -n "${INVOCATION_ID:-}" ]; then
  case "$(step_status build-cache)" in
    "") bad+=("the build-cache step left no status, so the snapshot the cap is judged on is unknown"); df_ok="" ;;
    0) if [ -f "$df_file" ]; then df_out="$(cat "$df_file" 2>/dev/null)"; else
         bad+=("the build-cache step saved no snapshot, so the 20 GB cap cannot be confirmed"); df_ok=""
       fi ;;
    *) bad+=("the build-cache step could not read the cache (exit $(step_status build-cache)), so the 20 GB cap cannot be confirmed"); df_ok="" ;;
  esac
elif ! df_out="$(timeout 30 "$DOCKER" system df --format '{{json .}}' 2>/dev/null)"; then
  bad+=("docker system df failed, so the build-cache cap cannot be confirmed"); df_ok=""; df_out=""
fi
rows="$(
  printf '%s\n' "$df_out" | awk '
    function field(key,  re, s) {
      re = "\"" key "\":\"([^\"]*)\""
      if (!match($0, re)) return ""
      s = substr($0, RSTART, RLENGTH)
      sub("^\"" key "\":\"", "", s); sub("\"$", "", s)
      return s
    }
    field("Type") == "Build Cache" { print field("Size") "\t" field("Reclaimable"); exit }'
)"
cache="${rows%%"	"*}"
# `docker system df` prints a Build Cache row even when the cache is empty ("0B"). Some stores leave the row out entirely
# when there is no build cache at all: with nothing cached the 20 GB cap holds by definition, so the absence is not a
# failure. A read that FAILED is a different thing (above), and so is a row whose size is unreadable. The check is only
# reached with a successful read.
case "$cache" in
  "") [ -n "$df_ok" ] && echo "prune-docker: no Build Cache row: nothing cached, so the 20 GB cap holds" ;;
  *)
    bytes="$(awk -v s="$cache" 'BEGIN {
      sub(/[[:space:]].*$/, "", s)
      if (!match(s, /^[0-9]+(\.[0-9]+)?/)) exit
      n = substr(s, 1, RLENGTH) + 0; u = substr(s, RLENGTH + 1)
      if (u == "TB") n *= 1000000000000; else if (u == "GB") n *= 1000000000; else if (u == "MB") n *= 1000000
      else if (u == "kB") n *= 1000; else if (u != "B" && u != "") exit
      printf "%.0f", n }')"
    [ -n "$bytes" ] || bad+=("the build cache size ($cache) is unreadable, so the 20 GB cap cannot be confirmed")
    if [ -n "$bytes" ] && [ "$bytes" -gt "$CAP_BYTES" ]; then
      # A concurrent build can hold more than the cap in cache that is in use: the prune then did all it could, and
      # `docker system df` still reports the full Size. Reclaimable is the part a prune could still remove; only when it
      # is exactly zero is the cap holding as far as it can. Any nonzero reclaimable means the prune left bytes it could
      # have freed, which fails: no tolerance, since a tolerance would hide a partly failed prune.
      reclaim="${rows#*"	"}"
      reclaim_bytes="$(awk -v s="$reclaim" 'BEGIN {
        sub(/[[:space:]].*$/, "", s)
        if (!match(s, /^[0-9]+(\.[0-9]+)?/)) exit
        n = substr(s, 1, RLENGTH) + 0; u = substr(s, RLENGTH + 1)
        if (u == "TB") n *= 1000000000000; else if (u == "GB") n *= 1000000000; else if (u == "MB") n *= 1000000
        else if (u == "kB") n *= 1000; else if (u != "B" && u != "") exit
        printf "%.0f", n }')"
      if [ -z "$reclaim_bytes" ]; then
        bad+=("the build cache is $cache, over the 20 GB cap, and its reclaimable size ($reclaim) is unreadable: whether the cap held cannot be confirmed")
      elif [ "$reclaim_bytes" -gt 0 ]; then
        # Any reclaimable cache at all is cache a prune could have freed: if one was, the cap did not hold. Only zero (a
        # build holding the whole cache in use) makes an over-cap Size legitimate, so there is no silent tolerance here.
        bad+=("the build cache is $cache with $reclaim still reclaimable after the prune: neither builder flag form capped it")
      else
        echo "prune-docker: build cache is $cache but nothing is reclaimable: a build holds that cache in use, so the cap holds"
      fi
    fi
    ;;
esac

# One-offs: what ops/prune-docker-containers.sh should have removed, and did not. A container that vanished between the
# listing and its inspect is gone, which is the result we wanted, not a failure — but a re-list that *failed* is not a
# vanished container: it is a cleanup this check could not read, so it fails.
now="$(date +%s)"
left="$("$DOCKER" ps -aq --filter "label=$LABEL" 2>/dev/null)" || bad+=("could not list the containers labelled $LABEL")
listed() { # id -> 0 still there, 1 gone, 2 the daemon did not answer
  local out
  out="$("$DOCKER" ps -aq 2>/dev/null)" || return 2
  grep -qxF -- "$1" <<< "$out" && return 0
  return 1
}
# shellcheck disable=SC2086 # container ids, one word each
for id in $left; do
  running="" finished="" service="" computer=""
  IFS='|' read -r running finished service computer <<< "$("$DOCKER" inspect \
    -f '{{.State.Running}}|{{.State.FinishedAt}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "aidenhq.computer"}}' \
    "$id" 2>/dev/null)"
  if [ -z "$running" ]; then
    listed "$id"
    case $? in
      1) continue ;; # removed since the listing: the outcome we wanted
      2) bad+=("could not re-list the containers, so whether $id (labelled $LABEL) went or is unreadable is unknown") ; continue ;;
    esac
    # Still listed after a successful re-list, but its state cannot be read: a cleanup that cannot be checked, so the unit
    # does not read clean. (A re-list that FAILED is the case above, and is reported as itself.)
    bad+=("container $id is labelled $LABEL but cannot be inspected, so the cleanup could not check it")
    continue
  fi
  [ "$running" = false ] && [ -z "$service" ] && [ -z "$computer" ] || continue
  stopped="$(date -u -d "$finished" +%s 2>/dev/null)" || continue
  [ "$stopped" -gt 0 ] || continue
  [ $(( now - stopped )) -lt "$STOPPED_SECS" ] || bad+=("container $id is a one-off stopped over a day ago and still there")
done

if [ "${#bad[@]}" -gt 0 ]; then
  printf 'prune-docker: %s\n' "${bad[@]}" >&2
  exit 1
fi
echo "prune-docker: verified: daemon answers, build cache under 20 GB, no one-off stopped over a day is left"
