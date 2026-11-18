#!/usr/bin/env bash
# Release updates (docs/design/release-updates.md), run by aidenhq-update.service: hourly from its timer, and at once when the
# owner presses Update now (the kernel starts the unit). Only an instance that follows a release from the official distro
# repo has the unit (apply installs it). One run (kernel/src/updates.ts run) finishes what a dead run left, finds and verifies
# a newer release, and installs it when it should. The whole run holds the host's apply lock on fd 9, as ops/apply-config.sh
# takes it, and hands it to the apply it starts (ops/lib/apply-lock.sh): no other apply runs between its pin commit and its
# apply. An apply in progress is waited for, as a land waits (up to 15 minutes); an Update now is kept until a run takes it.
#   ops/update.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
set -a; [ -f .env ] && . ./.env; set +a
mkdir -p data
exec 9>>data/apply.lock
flock -w 900 9 || { echo "another apply is still running: the update waits for the next run"; exit 0; }
export AIDENHQ_APPLY_LOCKED=9
node kernel/src/updates.ts run
# An Update now that arrived during this run is taken at once (once), not at the next hour.
if [ -f "${AIDENHQ_DATA_DIR:-data}/updates/now.json" ] && [ -z "${AIDENHQ_UPDATE_AGAIN:-}" ]; then exec 9>&-; AIDENHQ_UPDATE_AGAIN=1 exec bash "$0"; fi
