#!/usr/bin/env bash
# One builder prune of prune-docker.service: keep the build cache at the shared ceiling (ops/lib/build-cache.sh), least
# recently used first (`-a`: shared and internal records count in `docker system df`, so they may go too), the same prune the apply runs. Usage: prune-docker-builder.sh <--max-used-space|--keep-storage>
# (buildx and the classic builder each know one of the two flag forms). Run under prune-docker-step.sh, which records the status.
# The target is a soft one: `--max-used-space` budgets only unshared records while `docker system df` counts shared ones
# too, so a working prune can leave the cache above it. That is why the verification judges a ceiling with headroom
# (aidenhq_build_cache_verify_ceiling_gb), not this number.
set -uo pipefail
. "${BASH_SOURCE[0]%/*}/lib/build-cache.sh"
flag="${1:?usage: prune-docker-builder.sh <--max-used-space|--keep-storage>}"
exec "${DOCKER:-docker}" builder prune -af "$flag" "$(aidenhq_build_cache_ceiling_gb)GB"
