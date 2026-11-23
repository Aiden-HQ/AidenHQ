#!/usr/bin/env bash
# Reclaim superseded and dangling computer images (ops/apply-config-work.sh, once an apply's generation is good). The image prunes skip every image labelled aidenhq.keep=true (services/computer/images/browser/Dockerfile;
# every computer image inherits it), because an idle install runs no box and would otherwise lose them. So the ones a
# newer apply replaced go here instead: labelled images config/computers.json no longer names. Under the apply lock, after the
# health check passed; a rollback re-applies the old product, whose computer-images.sh rebuilds what it needs. Docker
# refuses to remove an image a running box uses; the next apply retries.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f config/computers.json ] || { echo "config/computers.json missing: run node scripts/compile.ts" >&2; exit 1; }
# By image ID, so a superseded image goes whatever references it (its local tag, a release's registry digest, none at all once
# a child image dropped its tag). `rm -f` removes every reference; it still refuses an image a running box uses. Three passes:
# a parent only goes once the child that held it is gone.
# Any configured image that cannot be resolved aborts the sweep: nothing is removed against an incomplete keep list.
tags="$(jq -r '.images | to_entries[].value' config/computers.json)"
[ -n "$tags" ] || { echo "config/computers.json names no images" >&2; exit 1; }
keep=""
for tag in $tags aidenhq/computer-browser:current; do
  keep+="$(docker image inspect --format '{{.Id}}' "$tag")"$'\n'
done

for _ in 1 2 3; do
  docker image ls --no-trunc --filter label=aidenhq.keep=true --format '{{.ID}}' | sort -u | { grep -vxF "$keep" || true; } | xargs -r -n1 docker image rm -f >/dev/null 2>&1 || true
done
