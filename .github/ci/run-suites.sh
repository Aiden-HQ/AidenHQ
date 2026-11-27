#!/usr/bin/env bash
# Runs the suites listed in $1 (one per line: name<TAB>dir<TAB>run<TAB>secs) side by side, one per CPU (node's count: `nproc` shows
# the host's CPUs inside a container with a quota). Each gets its own
# timeout, 3x its measured time (`secs` in areas.json) and at least 90 s, so a hang fails with its own log instead of the
# job's. No retries: a flaky test is removed, never re-run (owner). Prints each suite's log in a group, then the failed
# suites, and adds a table of times to the job summary (the numbers that keep `secs` honest).
set -uo pipefail
list="$1"
logs=$(mktemp -d)
one() {
  IFS=$'\t' read -r name dir run secs <<< "$1"
  local n t start rc
  n=$(tr '/#' '__' <<< "$name")
  t=$(( secs * 3 > 90 ? secs * 3 : 90 ))
  start=$(date +%s)
  # The map is read from the base, so a PR that deletes a suite's folder still lists it: nothing is left to test.
  if [ -d "$dir" ]; then (cd "$dir" && timeout -k 10 "$t" bash -eo pipefail -c "$run") > "$logs/$n.log" 2>&1; rc=$?; else echo "gone: $dir" > "$logs/$n.log"; rc=0; fi
  echo "$rc $(( $(date +%s) - start )) $t" > "$logs/$n.rc"
}
export -f one
export logs
grep -v '^$' "$list" | tr '\n' '\0' | xargs -0 -r -P "$(node -p 'require("os").availableParallelism()')" -I{} bash -c 'one "$1"' _ {}
status=0
failed=()
summary="| suite | took (s) | listed secs |"$'\n'"|---|---|---|"
while IFS=$'\t' read -r name dir run secs; do
  [ -n "$name" ] || continue
  n=$(tr '/#' '__' <<< "$name")
  read -r rc took t < "$logs/$n.rc"
  what="exit $rc"
  case "$rc" in 124|137) what="timed out after ${t}s" ;; esac
  echo "::group::$name ($what, ${took}s)"; cat "$logs/$n.log"; echo "::endgroup::"
  [ "$rc" = 0 ] || { echo "::error::$name failed ($what)"; failed+=("$name"); status=1; }
  summary+=$'\n'"| $name | $took | $secs |"
done < "$list"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$summary" >> "$GITHUB_STEP_SUMMARY"
[ "$status" = 0 ] || echo "Failed suites: ${failed[*]}"
exit $status
