#!/usr/bin/env bash
# Bring back the CI runner units a recorded drain stopped. scripts/fleet-pause.mjs pause lists them in
# data/fleet-paused.json and its resume starts them; the apply runs this after everything else, so a drain whose resume was
# skipped or failed never leaves the runners down (or start-limited, which pages the fleet). Each start limit is cleared
# first: a stop races each unit's Restart=always, five starts in ten seconds hit systemd's start limit, and `start` then
# refuses with "Start request repeated too quickly" until reset-failed clears it. Starting an active unit is a no-op (it
# keeps the job it is on), and a unit no drain recorded is left as the operator left it.
set -uo pipefail
record="${1:-${AIDENHQ_DATA_DIR:-data}}/fleet-paused.json"
[ -f "$record" ] || exit 0
units="$(tr -d '\n' < "$record" | sed -n 's/.*"units"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | grep -oE '"[^"]+"' | tr -d '"')"
for unit in $units; do
  systemctl --user reset-failed "$unit" 2>/dev/null || true
  if systemctl --user start "$unit"; then echo "ci runner unit started: $unit"
  else echo "warn: ci runner unit did not start: $unit" >&2; fi
done
