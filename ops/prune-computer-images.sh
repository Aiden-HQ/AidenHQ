#!/usr/bin/env bash
# Reclaim superseded computer images (ops/apply-config-work.sh, once an apply's generation is good). The image prunes skip every image labelled aidenhq.keep=true (services/computer/images/browser/Dockerfile;
# every computer image inherits it), because an idle install runs no box and would otherwise lose them. So the ones a
# newer apply replaced go here instead: labelled images config/computers.json no longer names. Under the apply lock, after the
# health check passed; a rollback re-applies the old product, whose computer-images.sh rebuilds what it needs. Docker
# refuses to remove an image a running box uses; the next apply retries.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f config/computers.json ] || { echo "config/computers.json missing: run node scripts/compile.ts" >&2; exit 1; }
keep="$(jq -r '.images | to_entries[].value' config/computers.json)"$'\n'aidenhq/computer-browser:current
docker image ls --filter label=aidenhq.keep=true --format '{{.Repository}}:{{.Tag}}' | { grep -vxF "$keep" || true; } | xargs -r -n1 docker image rm >/dev/null 2>&1 || true
