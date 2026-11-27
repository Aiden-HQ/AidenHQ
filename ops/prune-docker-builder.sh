#!/usr/bin/env bash
# One builder prune of prune-docker.service: keep the build cache at the shared ceiling (ops/lib/build-cache.sh), least
# recently used first, the same prune the apply runs. Usage: prune-docker-builder.sh <--max-used-space|--keep-storage>
# (buildx and the classic builder each know one of the two flag forms). Run under prune-docker-step.sh, which records the status.
set -uo pipefail
. "${BASH_SOURCE[0]%/*}/lib/build-cache.sh"
flag="${1:?usage: prune-docker-builder.sh <--max-used-space|--keep-storage>}"
exec "${DOCKER:-docker}" builder prune -f "$flag" "$(aidenhq_build_cache_ceiling_gb)GB"
