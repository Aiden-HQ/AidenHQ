#!/usr/bin/env bash
# Reclaim superseded computer images (prune-docker.service's step after the image prune, and ops/apply-config-work.sh after
# each apply). The image prunes skip every image labelled aidenhq.keep=true (services/computer/images/browser/Dockerfile;
# every computer image inherits it), because an idle install runs no box and would otherwise lose them. So the ones a
# newer apply replaced go here instead: labelled images over 48 h old that config/computers.json no longer names (the
# previous generation stays for the rollback window). Docker refuses to remove an image a running box uses; the next run retries.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f config/computers.json ] || { echo "config/computers.json missing: run node scripts/compile.ts" >&2; exit 1; }
keep="$(jq -r '.images | to_entries[].value' config/computers.json)"$'\n'aidenhq/computer-browser:current
docker image ls --filter label=aidenhq.keep=true --filter until=48h --format '{{.Repository}}:{{.Tag}}' | { grep -vxF "$keep" || true; } | xargs -r -n1 docker image rm >/dev/null 2>&1 || true
