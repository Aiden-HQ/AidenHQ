#!/usr/bin/env bash
# Keep the CI runner units the config declares running after an apply, and bring back the ones a recorded drain stopped.
# The declared set is the runner instances the host has enabled (ops/setup.sh and the "Scale" step of docs/operations.md):
# an enabled instance systemd reports failed is reset and started whether or not data/fleet-paused.json names it.
# Restart=always with RestartSec=1 reaches systemd's start limit (five starts in ten seconds) on its own -- a runner whose
# container exits quickly, or a host that has just booted -- and the unit then stays failed until reset-failed clears it.
# scripts/fleet-pause.ts pause lists the units it stopped in data/fleet-paused.json and its resume starts them; the apply
# runs this after everything else, so a drain whose resume was skipped or failed never leaves the runners down.
# Each start limit is cleared before the start: a stop races each unit's Restart=always, and `start` then refuses with
# "Start request repeated too quickly". Starting an active unit is a no-op (it keeps the job it is on), and a unit the
# config no longer declares is left as the operator left it unless a drain record names it.
set -uo pipefail
record="${1:-${AIDENHQ_DATA_DIR:-data}}/fleet-paused.json"
recorded=""; [ -f "$record" ] && recorded="$(tr -d '\n' < "$record" | sed -n 's/.*"units"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | grep -oE '"[^"]+"' | tr -d '"')"
for unit in $(printf '%s\n' $recorded $(systemctl --user list-units --all --state=failed --plain --no-legend 'aidenhq-ci-runner@*' 2>/dev/null | awk '{print $1}') | awk 'NF && !seen[$0]++'); do
  printf '%s\n' "$recorded" | grep -qxF -- "$unit" || systemctl --user is-enabled --quiet "$unit" 2>/dev/null || continue
  systemctl --user reset-failed "$unit" 2>/dev/null || true
  systemctl --user start "$unit" && echo "ci runner unit started: $unit" || echo "warn: ci runner unit did not start: $unit" >&2
done
