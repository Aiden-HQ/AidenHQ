#!/usr/bin/env bash
# The apply's compose step: start the services, then remove compose's leftovers for services this config dropped.
# Not `docker compose up --remove-orphans`: a CI job's runner is a one-off of this same compose project under the
# inactive `ci` profile (`docker compose run --rm` in ops/ci-runner.sh), so compose counted a finished job's
# self-removing container as an orphan and removed it too, and the daemon's "removal of container ... is already in
# progress" failed the whole apply. Cleanup here is leftovers only -- a stopped container whose name is compose's old
# <12hex>_<project>-<service>-1, for a service this config no longer defines -- so a running container, a one-off
# such as a CI runner, or anything of a service still in the config is never stopped or removed. The step is retried
# once, and only when it raced a container something else was already removing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# The apply already exports the project's environment to this script, and compose reads its own configuration itself:
# this script sources and reads no file of its own.
project="${COMPOSE_PROJECT_NAME:-aidenhq}"
race='removal of container .* is already in progress'

# "<id> <service>" for each leftover: compose's old <12hex>_<project>-<service>-1 name, for a service this config no
# longer defines, and not running. A one-off container is never one: it is named (a CI runner is aidenhq-ci-runner-<n>)
# and removes itself when its command ends, and a running container of a dropped service is left for its owner to stop.
leftovers() {
  local desired id name running service
  desired="$(docker compose config --services | sort -u)"
  # An empty list would make every stopped container a leftover: remove nothing rather than guess.
  [ -n "$desired" ] || { echo "compose: docker compose config lists no services: nothing removed" >&2; return 1; }
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || continue
    [[ "$name" =~ ^/[0-9a-f]{12}_${project}-(.+)-1$ ]] || continue
    service="${BASH_REMATCH[1]}"
    grep -qxF -- "$service" <<< "$desired" && continue
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
    [ "$running" = "false" ] || continue
    printf '%s %s\n' "$id" "$service"
  done
}

# One leftover. Failing because it is already going away is the same outcome: it is gone either way.
remove() {
  local id="$1" service="$2" err status=0
  err="$(docker rm "$id" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then echo "compose: removed $service (no longer in the config)"; return 0; fi
  if grep -qE "$race" <<< "$err"; then echo "compose: $service was already being removed"; return 0; fi
  printf '%s\n' "$err" >&2
  return "$status"
}

# One pass: compose up, then its leftovers. The output goes to $1, where the caller looks for the removal race.
step() {
  local list id service status=0
  docker compose up -d --build 2>&1 | tee "$1" || status=$?
  [ "$status" -eq 0 ] || return "$status"
  list="$(leftovers)"
  while read -r id service; do
    [ -n "$id" ] || continue
    remove "$id" "$service"
  done <<< "$list"
}

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
status=0; step "$out" || status=$?
if [ "$status" -ne 0 ]; then
  grep -qE "$race" "$out" || exit "$status"
  echo "compose: raced a container that was already being removed; retrying once"
  step "$out"
fi
