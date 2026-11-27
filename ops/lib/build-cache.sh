#!/usr/bin/env bash
# The Docker build-cache ceiling, computed once for every place that prunes the cache or verifies its size (the apply-time
# prune in ops/apply-config-work.sh, ops/prune-docker-verify.sh): 15% of the filesystem Docker's root directory lives on,
# clamped to [20, 60] GB. A fixed 20 GB evicted the shared base layers on a roomy disk (24 GB cache on 267 GB free), so every
# deploy rebuilt the module images from scratch. Sourced, never run.
#
# `aidenhq_build_cache_ceiling_gb` prints whole decimal GB (Docker's own unit). When the disk cannot be read it prints the
# 20 GB floor. `DOCKER` and `DF` name the binaries (tests stub them).
aidenhq_build_cache_ceiling_gb() {
  local docker="${DOCKER:-docker}" df="${DF:-df}" root kb gb
  # Bounded like the prunes after it: a daemon that stops answering must not hold the apply here.
  local bound=""; ! command -v timeout >/dev/null 2>&1 || bound="timeout -k 5s 15s"
  root="$($bound "$docker" info -f '{{.DockerRootDir}}' 2>/dev/null)" || root=""
  kb=""
  [ -z "$root" ] || kb="$("$df" -Pk "$root" 2>/dev/null | awk 'NR==2 {print $2}')"
  case "$kb" in
    ''|*[!0-9]*) gb=20 ;;
    *) gb=$((kb * 1024 * 15 / 100 / 1000000000)) ;; # df -k blocks are 1024 bytes; Docker's GB are 10^9
  esac
  [ "$gb" -ge 20 ] || gb=20
  [ "$gb" -le 60 ] || gb=60
  printf '%s\n' "$gb"
}

# What the verification judges the cache against, above the prune's own target: `--max-used-space` budgets only unshared
# records while `docker system df` counts shared ones too (BuildKit skips `Shared` records in its total and returns early
# when that total is under the budget), so a working prune can leave the cache above its target. A soft target also lands
# where it rounds, so the verification keeps a fixed 20 GB of headroom: 20 -> 40 GB at the floor (the fleet's ordinary
# post-prune level peaked at 29.9 GB against a 20 GB target), 60 -> 80 GB at the cap, still under the 104 GB an uncapped
# store held. Additive, not a multiplier: the overshoot is a rough fixed amount, not a share of the disk.
aidenhq_build_cache_verify_ceiling_gb() {
  printf '%s\n' "$(( $(aidenhq_build_cache_ceiling_gb) + 20 ))"
}
