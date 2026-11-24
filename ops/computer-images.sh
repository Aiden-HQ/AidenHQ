#!/usr/bin/env bash
# Build the images config/computers.json names: always the browser image (agent-browser and its pinned Chrome; apps-mcp renders
# its views in it), and the computer images some agent uses, each FROM its parent's tag. Each is tagged by content hash
# (scripts/computers.ts), so an unchanged image is never rebuilt. Run by ops/apply-config.sh after compile.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f config/computers.json ] || { echo "config/computers.json missing: run node scripts/compile.ts" >&2; exit 1; }
declare -A parent=([agent-base]=browser [engineer]=agent-base [session]=engineer)
# A release's prebuilt images (computers.json `pull`: tag -> digest) are pulled all at once and tagged as the build would be.
pulled=()
for name in browser agent-base engineer session; do
  tag="$(jq -r --arg n "$name" '.images[$n] // empty' config/computers.json)"
  ref="$(jq -r --arg t "$tag" '.pull[$t] // empty' config/computers.json)"
  [ -n "$tag" ] && [ -n "$ref" ] || continue
  docker image inspect "$tag" >/dev/null 2>&1 && continue
  echo "pulling computer image $tag"
  { docker pull --quiet "$ref" >/dev/null && docker tag "$ref" "$tag"; } & pulled+=($!)
done
for pid in ${pulled[@]+"${pulled[@]}"}; do wait "$pid" || { echo "a computer image failed to pull" >&2; exit 1; }; done
for name in browser agent-base engineer session; do
  tag="$(jq -r --arg n "$name" '.images[$n] // empty' config/computers.json)"
  [ -n "$tag" ] || continue
  if docker image inspect "$tag" >/dev/null 2>&1; then continue; fi
  base=""
  if [ -n "${parent[$name]:-}" ]; then base="$(jq -r --arg n "${parent[$name]}" '.images[$n]' config/computers.json)"; fi
  echo "building computer image $tag"
  docker build --quiet ${base:+--build-arg BASE="$base"} -t "$tag" "services/computer/images/$name" >/dev/null
done
# apps-mcp's renderer runs the browser image by this name (modules/apps-platform/apps-mcp/src/main.ts): it always names the current build.
docker tag "$(jq -r '.images.browser' config/computers.json)" aidenhq/computer-browser:current
