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
  root="$("$docker" info -f '{{.DockerRootDir}}' 2>/dev/null)" || root=""
  kb=""
  [ -z "$root" ] || kb="$("$df" -Pk "$root" 2>/dev/null | awk 'NR==2 {print $2}')"
  case "$kb" in
    ''|*[!0-9]*) gb=20 ;;
    *) gb=$((kb * 15 / 100 / 1000 / 1000)) ;;
  esac
  [ "$gb" -ge 20 ] || gb=20
  [ "$gb" -le 60 ] || gb=60
  printf '%s\n' "$gb"
}
