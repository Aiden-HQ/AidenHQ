#!/usr/bin/env bash
# Release updates (docs/design/release-updates.md), run by aidenhq-update.service: hourly from its timer, and at once when the
# owner presses Update now (the kernel starts the unit). Only an instance that follows a release from the official distro
# repo has the unit (apply installs it). The check (kernel/src/updates.ts check) finds and verifies a newer release and says
# whether it installs now; the install holds the host's apply lock on fd 9, as ops/apply-config.sh takes it, from before the
# pin commit until its apply ends, and hands it to that apply (ops/lib/apply-lock.sh), so no other apply runs in between.
#   ops/update.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
set -a; [ -f .env ] && . ./.env; set +a
dir="${AIDENHQ_DATA_DIR:-data}/updates"
node kernel/src/updates.ts check
if [ -f "$dir/next" ]; then
  mkdir -p data
  exec 9>>data/apply.lock
  if flock -n 9; then
    AIDENHQ_APPLY_LOCKED=9 node kernel/src/updates.ts install || true
  else
    rm -f "$dir/next"
    echo "another apply is running: the update waits for the next check"
  fi
  exec 9>&-
fi
# An Update now that arrived while this ran is taken at once (once), not at the next hour.
if [ -f "$dir/now.json" ] && [ -z "${AIDENHQ_UPDATE_AGAIN:-}" ]; then AIDENHQ_UPDATE_AGAIN=1 exec bash "$0"; fi
