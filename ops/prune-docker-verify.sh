#!/usr/bin/env bash
# The last step of prune-docker.service, and the only one not prefixed with `-`: it re-reads the host after the prunes and
# fails the unit when they did not do their work. The prune steps themselves stay independent (every one is `-`-prefixed,
# so a failing builder prune never skips the image prune — that is the shape of the 45 h with no drop on 2026-11-20/21),
# and this is what keeps that from hiding a prune that did nothing at all: a daemon that is down, or a build cache still
# far over any level a working prune leaves because neither flag form was accepted, is a failed unit (UnitFailed) rather
# than a clean one.
#
# It checks these, each one a way the reclaim can silently not happen:
#   1. the daemon answers (`docker info`);
#   2. the build cache was under `CACHE_CEILING_GB` right after the builder prunes — the snapshot the `build-cache` step
#      took then, not a `docker system df` taken here, which a build started since could have grown past it (that growth is
#      not a failed prune). The ceiling is ops/lib/build-cache.sh's: 15% of the disk Docker uses, 20-60 GB, the same
#      number the apply-time prune caps at. It is a backstop for a prune that did nothing at all (an uncapped store held
#      104 GB), not the disk-pressure guard, which is DiskSpaceLow/DiskNearlyFull. A displayed size carries only the precision Docker printed it with, so the size is
#      allowed to be up to half of its last printed digit over the ceiling and no more: `40.0GB` (one decimal) is under,
#      `40.1GB` is over;
#   3. no labelled one-off container is still there after having been stopped for over a day (ops/prune-docker-containers.sh
#      should have removed it), and every container it lists can be read (an unreadable one is a cleanup it could not do,
#      not a clean run);
#   4. the image and container steps' recorded exit status is 0 (their `-` prefix keeps a failure from skipping the next
#      step, and this is how it still fails the unit — a container listing that failed while the daemon was unreachable can
#      recover before the re-listing below, so the fresh listing alone would read as a clean scan), the `build-cache`
#      step — which took the snapshot the ceiling is judged on — could run and save it, and at least one of the two
#      builder forms exited 0 (one is expected to fail with `unknown flag`; both failing is no cap at all, which the size
#      alone would miss under the ceiling);
set -uo pipefail

DOCKER=${DOCKER:-docker}
. "${BASH_SOURCE[0]%/*}/lib/build-cache.sh"
CACHE_CEILING_GB="$(aidenhq_build_cache_ceiling_gb)" # the one ceiling the apply-time prune caps at too (15% of the disk, 20-60 GB)
CACHE_CEILING_BYTES=$((CACHE_CEILING_GB * 1000 * 1000 * 1000)) # the tolerance is the display precision of the size, below
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
# expected to fail with `unknown flag` on a CLI that lacks the other — so one failing is not held against the run. Both
# failing is: no flag form capped the cache, so the prune did nothing whatever the size under the ceiling says.
state="${AIDENHQ_STATE_DIR:-${HOME:-/nonexistent}/.local/state/aidenhq}/prune-docker"
step_status() { # name -> the status of this invocation's step, or nothing (the step's one record: `<run> <rc>`, then rows)
  local f="$state/$1" run rc
  [ -f "$f" ] || return 0
  read -r run rc < "$f" || return 0
  [ "$run" = "${INVOCATION_ID:-manual-$$}" ] && printf '%s' "$rc"
  return 0
}
# Both builder forms failing is a prune that did nothing. One failing is the expected `unknown flag` on a CLI that lacks
# that form, so only the pair is judged: a small cache would otherwise pass a run where neither prune ran.
buildx_rc="$(step_status builder-buildx)"
classic_rc="$(step_status builder-classic)"
for pair in "buildx:$buildx_rc" "classic:$classic_rc"; do
  form="${pair%%:*}"; rc="${pair#*:}"
  [ -n "$rc" ] || [ -z "${INVOCATION_ID:-}" ] || bad+=("the $form builder prune left no status, so its result is unknown")
done
if [ -n "$buildx_rc" ] && [ -n "$classic_rc" ] && [ "$buildx_rc" != 0 ] && [ "$classic_rc" != 0 ]; then
  bad+=("neither builder prune ran (buildx exited $buildx_rc, the classic builder $classic_rc): no flag form capped the cache")
fi

for name in images containers; do
  rc="$(step_status "$name")"
  case "$rc" in
    # Under systemd every -prefixed step above ran, so a missing status means the wrapper could not record its result:
    # that result is unknown, not a success.
    "") [ -z "${INVOCATION_ID:-}" ] || bad+=("the $name prune step left no status, so its result is unknown") ;;
    0) ;;
    *) bad+=("the $name prune step exited $rc (see its journal line above)") ;;
  esac
done

# The cache: the record the `build-cache` step wrote right after the two builder prunes (`<invocation> <status>` on its
# first line, then the `docker system df` rows), parsed by key (the JSON's field order is not a contract). Judging that
# snapshot instead of running `docker system df` again here is what keeps a build that grew the cache after the prune from
# reading as a prune that capped nothing. The three are one record, so a run can only be judged on its own status and its
# own snapshot. Run by hand (no INVOCATION_ID) no step ran and there is no record, so it reads the cache now, which is the
# same result when nothing else is building.
df_file="$state/build-cache"
df_out=""
# df_ok says the snapshot (or the read made in its place) is there to judge: a read that failed is reported, and the
# `case "$cache"` below must not then read an empty reading as "nothing cached".
df_ok=1
if [ -f "$df_file" ] && [ -n "${INVOCATION_ID:-}" ]; then
  # One read of the file, then the header and the rows are split from those same bytes: the step replaces the record with
  # `mv`, so opening it once can never pair this run's status with another run's rows the way a second open could.
  record="$(cat -- "$df_file" 2>/dev/null)"
  run=""; rc=""; df_out=""
  if [ -n "$record" ]; then
    header="${record%%$'\n'*}"
    read -r run rc <<< "$header" || true
    [ "$header" = "$record" ] || df_out="${record#*$'\n'}"
  fi
  if [ "$run" != "$INVOCATION_ID" ]; then
    bad+=("the build-cache record is from another run ($run, not $INVOCATION_ID), so the snapshot the ceiling is judged on is unknown"); df_ok=""
  else
    case "$rc" in
      0) ;;
      "") bad+=("the build-cache record has no status, so the snapshot the ceiling is judged on is unknown"); df_ok="" ;;
      *) bad+=("the build-cache step could not read the cache (exit $rc), so the build-cache ceiling cannot be confirmed"); df_ok="" ;;
    esac
  fi
elif [ -n "${INVOCATION_ID:-}" ]; then
  bad+=("the build-cache step left no record, so the snapshot the ceiling is judged on is unknown"); df_ok=""
elif ! df_out="$(timeout 30 "$DOCKER" system df --format '{{json .}}' 2>/dev/null)"; then
  bad+=("docker system df failed, so the build-cache cap cannot be confirmed"); df_ok=""; df_out=""
fi
# One record per key, so an absent row, a row with no size and a row with a size are told apart instead of collapsing into
# one empty string.
size=""; reclaim=""; have_row=0
while IFS=$'\t' read -r key value; do
  case "$key" in
    none) ;;
    row) have_row=1 ;;
    size) size="$value" ;;
    reclaim) reclaim="$value" ;;
  esac
done < <(printf '%s\n' "$df_out" | awk '
  function field(key,  re, s) {
    re = "\"" key "\":\"([^\"]*)\""
    if (!match($0, re)) return ""
    s = substr($0, RSTART, RLENGTH)
    sub("^\"" key "\":\"", "", s); sub("\"$", "", s)
    return s
  }
  field("Type") == "Build Cache" { print "row"; print "size\t" field("Size"); print "reclaim\t" field("Reclaimable"); found = 1; exit }
  END { if (!found) print "none" }')

# Bytes in a size `docker system df` prints (`20.9GB`, `0B`, `1.2 kB`), and how precise that display is: half the last
# printed digit is as far as the true value can be from what is shown, which is the only tolerance the ceiling may take.
to_bytes() { # size -> bytes
  awk -v s="$1" 'BEGIN {
    sub(/[[:space:]].*$/, "", s)
    if (!match(s, /^[0-9]+(\.[0-9]+)?/)) exit
    n = substr(s, 1, RLENGTH) + 0; u = substr(s, RLENGTH + 1)
    if (u == "TB") n *= 1000000000000; else if (u == "GB") n *= 1000000000; else if (u == "MB") n *= 1000000
    else if (u == "kB") n *= 1000; else if (u != "B" && u != "") exit
    printf "%.0f", n }'
}
display_slack() { # size -> half of its last printed digit, in bytes
  awk -v s="$1" 'BEGIN {
    sub(/[[:space:]].*$/, "", s)
    if (!match(s, /^[0-9]+(\.[0-9]+)?/)) exit
    num = substr(s, 1, RLENGTH); u = substr(s, RLENGTH + 1)
    u = (u == "TB") ? 1000000000000 : (u == "GB") ? 1000000000 : (u == "MB") ? 1000000 : (u == "kB") ? 1000 : 1
    # The last printed digit: the decimal places that were shown, or the units digit when there is no point.
    d = index(num, "."); decimals = (d ? length(num) - d : 0)
    printf "%.0f", u / 2 / (10 ^ decimals) }'
}

# `docker system df` prints a Build Cache row even when the cache is empty ("0B"). Some stores leave the row out entirely
# when there is no build cache at all: with nothing cached the ceiling holds by definition, so the absence is not a
# failure. A read that FAILED is a different thing (above), and so is a row whose size is unreadable: the row is there,
# so something is cached, and what it is cannot be confirmed.
if [ "$have_row" = 0 ]; then
  [ -n "$df_ok" ] && echo "prune-docker: no Build Cache row: nothing cached, so the ceiling holds"
elif [ -z "$size" ]; then
  [ -n "$df_ok" ] && bad+=("docker system df reported a Build Cache row with no readable size, so the build-cache ceiling cannot be confirmed")
else
  bytes="$(to_bytes "$size")"
  slack="$(display_slack "$size")"
  [ -n "$bytes" ] || bad+=("the build cache size ($size) is unreadable, so the build-cache ceiling cannot be confirmed")
  if [ -n "$bytes" ] && [ -n "$slack" ] && [ "$bytes" -gt $((CACHE_CEILING_BYTES + slack)) ]; then
    reclaim_bytes="$(to_bytes "$reclaim")"
    if [ -z "$reclaim_bytes" ]; then
      bad+=("the build cache is $size, over the $CACHE_CEILING_GB GB ceiling, and its reclaimable size ($reclaim) is unreadable: whether the prune capped anything cannot be confirmed")
    elif [ "$reclaim_bytes" -gt 0 ]; then
      # Any reclaimable cache at all is cache a prune could have freed: if one was, the prune did nothing. Only zero (a
      # build holding the whole cache in use) makes an over-ceiling size legitimate, so there is no tolerance on it here.
      bad+=("the build cache is $size with $reclaim still reclaimable after the prune: neither builder flag form capped it")
    else
      echo "prune-docker: build cache is $size but nothing is reclaimable: a build holds that cache in use, so the ceiling holds"
    fi
  fi
fi

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
echo "prune-docker: verified: daemon answers, build cache under $CACHE_CEILING_GB GB, no one-off stopped over a day is left"
