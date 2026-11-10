#!/usr/bin/env bash
# Build the agent-computer images that config/computers.json names (only those some agent uses, plus their bases), each tagged
# by content hash (scripts/computers.mjs), so an unchanged image is never rebuilt. Run by ops/apply-config.sh after compile.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f config/computers.json ] || { echo "config/computers.json missing: run node scripts/compile.mjs" >&2; exit 1; }
base="$(jq -r '.images["agent-base"] // empty' config/computers.json)"
for name in agent-base engineer; do
  tag="$(jq -r --arg n "$name" '.images[$n] // empty' config/computers.json)"
  [ -n "$tag" ] || continue
  if docker image inspect "$tag" >/dev/null 2>&1; then continue; fi
  echo "building computer image $tag"
  docker build --quiet ${base:+--build-arg BASE="$base"} -t "$tag" "services/computer/images/$name" >/dev/null
done
