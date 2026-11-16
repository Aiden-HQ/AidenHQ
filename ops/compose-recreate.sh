#!/usr/bin/env bash
# The apply's compose step, in order:
#   1. an empty service list stops it, before it builds, dumps or removes anything: an empty list would make every
#      stopped container a leftover, and nothing here should guess at what the config runs;
#   2. a fresh dump of the warehouse, when this host runs one, taken before anything is recreated (see dump);
#   3. every image this config builds (cached unless its context changed);
#   4. only the services whose image, compose config or mounted secret content moved are recreated; every other container
#      keeps running;
#   5. compose's leftovers for services this config dropped are removed, and never a CI job's runner;
#   6. a service still left `created` (never started) is started.
#
# Not `docker compose up --remove-orphans`: a CI job's runner is a one-off of this same compose project under the
# inactive `ci` profile (`docker compose run --rm` in ops/ci-runner.sh), so compose counted a finished job's
# self-removing container as an orphan and removed it too, and the daemon's "removal of container ... is already in
# progress" failed the whole apply. Cleanup here is leftovers only -- a stopped container whose name is compose's old
# <12hex>_<project>-<service>-1, for a service this config no longer defines -- so a running container, a one-off
# such as a CI runner, or anything of a service still in the config is never stopped or removed.
#
# A recreate that was killed (an apply that died) leaves its replacement behind: compose creates the new container as
# <12hex>_<project>-<service>-1, stops and removes the old one, then renames and starts the new one. That half-made
# container, never running, would make the next `up` recreate it under the old one's name and trip on "name already in
# use", so each pass removes those of the services this config runs first. A running container is never one of them.
#
# The step is retried once, and only for the two ways the daemon races this script: a container it is still removing,
# and a container name another removal has not released yet. Every service gets one summary line saying what became of
# it: recreated, kept, or cleaned as a leftover.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# The apply already exports the project's environment to this script, and compose reads its own configuration itself:
# this script sources and reads no file of its own.
project="${COMPOSE_PROJECT_NAME:-aidenhq}"
race='removal of container .* is already in progress'
conflict='Conflict\. The container name .* is already in use'
data="${AIDENHQ_DATA_DIR:-data}"
secrets="${AIDENHQ_SECRETS_DIR:-}"
# What each running container's mounted secrets looked like when it started. The resolved compose model is read once,
# before any service is recreated.
secret_state="$data/compose-secret-digests"
model=""
declare -A WAS_IDS=()
declare -A BEFORE_DIGESTS=()
# The warehouse's own Postgres image, as scripts/backup.sh uses it: already pinned, so the dump needs nothing new.
dump_image='postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f'
warehouse_container=app-warehouse-postgres-1
dump_dir="$data/dumps"
dump_base=warehouse

# The warehouse's password comes from the vault (apps-mcp writes it there). Checked before the first docker command, so a
# host that lost it stops here with a clear message instead of after a build it can't protect. A host with no warehouse
# deployment has nothing to dump and carries on.
requireDumpPassword() {
  [ -d "$secrets/apps/warehouse" ] || return 0
  [ -s "$secrets/apps/warehouse/POSTGRES_PASSWORD" ] && return 0
  echo "refusing: no warehouse password to dump with ($secrets/apps/warehouse/POSTGRES_PASSWORD is missing)" >&2
  return 1
}

# "<id> <service>" for each leftover: compose's old <12hex>_<project>-<service>-1 name, for a service this config no
# longer defines, and not running. A one-off container is never one: it is named (a CI runner is aidenhq-ci-runner-<n>)
# and removes itself when its command ends, and a running container of a dropped service is left for its owner to stop.
# With `kept` (the services this config runs), the remains of a killed recreate instead: the same names, not running, of a
# service still in the config.
leftovers() {
  local desired id name running service kept="${2:-}"
  desired="$1"
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)" || continue
    [[ "$name" =~ ^/[0-9a-f]{12}_${project}-(.+)-1$ ]] || continue
    service="${BASH_REMATCH[1]}"
    if grep -qxF -- "$service" <<< "$desired"; then [ -n "$kept" ] || continue; else [ -z "$kept" ] || continue; fi
    running="$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)"
    [ "$running" = "false" ] || continue
    printf '%s %s\n' "$id" "$service"
  done
}

# One leftover. Failing because it is already going away is the same outcome: it is gone either way.
remove() {
  local id="$1" service="$2" what="${3:-leftover}" err status=0
  err="$(docker rm "$id" 2>&1)" || status=$?
  if [ "$status" -eq 0 ] || grep -qE "$race" <<< "$err"; then
    echo "compose: $service $what cleaned"
    return 0
  fi
  printf '%s\n' "$err" >&2
  return "$status"
}

# One fresh dump file, or nothing when every name is taken. `set -C` makes the redirect exclusive, so an existing name is
# skipped rather than truncated, and the suffixes run on until one is free.
dumpTo() {
  local base="$1" n=0 file
  while [ "$n" -lt 100 ]; do
    file="$dump_dir/$base$([ "$n" -eq 0 ] || printf -- '-%d' "$n").dump"
    if ( set -C; : > "$file" ) 2>/dev/null; then printf '%s\n' "$file"; return 0; fi
    n=$((n + 1))
  done
  return 1
}

# A logical dump of the warehouse before anything is recreated. The file is created under umask 077 in a 0700 directory,
# so it is 0600 from the first byte and no other user can read it. A dump an earlier run left is never rewritten, only
# have its mode tightened; the newest two are kept and the rest removed, so a host applying often doesn't fill its disk
# with full copies. A dump that can't be written fails the apply: it is the copy the recreate stands behind.
dump() {
  requireDumpPassword
  [ -d "$secrets/apps/warehouse" ] || { echo "compose: no warehouse on this host: nothing dumped"; return 0; }
  [ "$(docker inspect -f '{{.State.Running}}' "$warehouse_container" 2>/dev/null || true)" = "true" ] || {
    echo "compose: $warehouse_container is not running: nothing dumped"
    return 0
  }
  local was file status=0
  was="$(umask)"; umask 077
  mkdir -p -m 0700 "$dump_dir"; chmod 0700 "$dump_dir"
  file="$(dumpTo "$dump_base")" || { umask "$was"; echo "refusing: no free dump name in $dump_dir" >&2; return 1; }
  # The warehouse publishes 127.0.0.1:5433 (apps/warehouse/compose.yaml), so the host's own pinned client reaches it.
  docker run --rm -i --network host -e PGPASSWORD="$(cat "$secrets/apps/warehouse/POSTGRES_PASSWORD")" "$dump_image" \
      pg_dump -h 127.0.0.1 -p 5433 -U warehouse -d warehouse -Fc >"$file" || status=$?
  umask "$was"
  if [ "$status" -ne 0 ]; then
    rm -f -- "$file"
    echo "refusing: the warehouse dump failed (exit $status); nothing was recreated" >&2
    return 1
  fi
  chmod 0600 "$file"
  # Older dumps in the same place, without reading or rewriting them.
  find "$dump_dir" -maxdepth 1 -type f -name "$dump_base*.dump" ! -path "$file" -exec chmod 0600 {} + 2>/dev/null || true
  # Only the newest two dumps are kept: the one just taken and the one before it. A cleanup that fails is reported, never
  # fails an apply that already has its dump.
  find "$dump_dir" -maxdepth 1 -name "$dump_base*.dump" -printf '%T@ %p\n' | sort -rn | tail -n +3 | cut -d' ' -f2- | xargs -r rm -f \
    || echo "compose: could not remove the older dumps in $dump_dir" >&2
  echo "compose: dumped the warehouse to $file"
}

# One digest over the file names and contents of the secrets a service mounts: a service's secret entries name a
# top-level secret, which names its file (external secrets have none). A missing file counts as missing. Empty when the
# service mounts no file secret. Compose's config hash covers the path, not the content, so a rotation changes this only.
secretDigest() {
  local files file sum lines=""
  files="$(jq -r --arg service "$1" '. as $model | $model.services[$service].secrets[]?.source as $source | $model.secrets[$source].file // empty' <<< "$model")" || return 1
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    sum=missing
    [ ! -f "$file" ] || sum="$(sha256sum -- "$file" 2>/dev/null | awk '{print $1}')"
    [ -n "$sum" ] || { echo "refusing: cannot read the secret file $file for $1" >&2; return 1; }
    lines+="$file $sum"$'\n'
  done <<< "$files"
  [ -z "$lines" ] || printf '%s' "$lines" | sha256sum | awk '{print $1}'
}

# Record what a running container read from its mounted secrets when it started: the container, and the digest of the
# files it mounted. Only a container other than the one the pass began with is recorded (the pass started this one).
# A service with no mounted file secret has nothing to compare, so its old record is dropped.
recordSecretState() {
  local service="$1" digest="$2" was="${3-}" id
  id="$(docker compose ps -a -q "$service" 2>/dev/null | head -1)"
  [ -n "$id" ] && [ "$id" != "$was" ] || return 0
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = true ] || return 0
  if [ -z "$digest" ]; then
    rm -f -- "$secret_state/$service"
    return 0
  fi
  mkdir -p -m 0700 "$secret_state"
  chmod 0700 "$secret_state"
  printf '%s %s\n' "$id" "$digest" > "$secret_state/$service"
}

# Whether one service has to be recreated: not running, or its container was built from another image, or its resolved
# compose config differs from the one it was started with (compose records that hash on the container itself), or a
# mounted secret's content changed since this container started.
moved() {
  local service="$1" id
  id="$(docker compose ps -a -q "$service" 2>/dev/null | head -1)"
  WAS_IDS[$service]="$id"
  [ -n "$id" ] || return 0
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = "true" ] || return 0
  local digest
  digest="$(secretDigest "$service")" || exit 1
  BEFORE_DIGESTS[$service]="$digest"
  local image want have
  image="$(docker compose config --images "$service" 2>/dev/null | head -1)"
  if [ -n "$image" ]; then
    want="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
    have="$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null || true)"
    [ -n "$want" ] && [ "$want" = "$have" ] || return 0
  fi
  local now then
  now="$(docker compose config --hash "$service" 2>/dev/null | awk '{print $2}')"
  then="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id" 2>/dev/null || true)"
  [ -n "$now" ] && [ "$now" = "$then" ] || return 0
  # This container, started with what is on disk now, is what its record says. Another container or another digest is a
  # rotation this one missed; no record at all means its start is unknown, so it is recreated once and recorded after
  # the step.
  [ -z "$digest" ] || [ "$(cat "$secret_state/$service" 2>/dev/null)" = "$id $digest" ] || return 0
  return 1
}

# One pass: recreate what moved, then clean up the leftovers. Output goes to $1, where the caller looks for a race.
step() {
  local out="$1" desired="$2" status=0 recorded=0 id service after
  local -a recreate=()
  while read -r id service; do
    [ -n "$id" ] || continue
    remove "$id" "$service" "half-made container"
  done <<< "$(leftovers "$desired" kept)"
  for service in $desired; do moved "$service" && recreate+=("$service"); done
  if [ "${#recreate[@]}" -gt 0 ]; then
    docker compose up -d --no-deps --force-recreate "${recreate[@]}" 2>&1 | tee "$out" || status=$?
    RECREATED+=("${recreate[@]}")
  else
    : > "$out"
  fi
  # Record the digest the pass read before the up, against the container it started, whether or not the up went on to
  # fail, so a retry keeps it instead of starting it twice. Only when the files are still that digest: a secret that
  # changed while the container started may have been read either way, so what it holds is unknown, and its record is
  # left alone to recreate it again on the next apply. A service the pass never started keeps its old record too.
  for service in "${recreate[@]}"; do
    after="$(secretDigest "$service")" || recorded=$?
    [ "$after" = "${BEFORE_DIGESTS[$service]-}" ] || continue
    recordSecretState "$service" "$after" "${WAS_IDS[$service]-}" || recorded=$?
  done
  [ "$status" -eq 0 ] || return "$status"
  [ "$recorded" -eq 0 ] || return 1
  while read -r id service; do
    [ -n "$id" ] || continue
    remove "$id" "$service"
  done <<< "$(leftovers "$desired")"
}

# One line per service in this config: recreated, or kept (and when a kept one is not up, that too), so every apply's
# log shows the stack it left. A cleaned leftover printed its own line as it was removed.
summary() {
  local desired="$1" service state
  for service in $desired; do
    case " ${RECREATED[*]:-} " in
      *" $service "*) echo "compose: $service recreated"; continue ;;
    esac
    state="$(docker compose ps -a --format '{{.State}}' "$service" 2>/dev/null | head -1)"
    if [ "$state" = running ]; then echo "compose: $service kept"
    else echo "compose: $service kept (not running: ${state:-unknown})"; fi
  done
}

# Before the first docker call of any kind: a host that can't dump its warehouse stops here, not after a build.
requireDumpPassword
desired="$(docker compose config --services | sort -u)"
# Before anything is built, dumped or removed.
[ -n "$desired" ] || { echo "compose: docker compose config lists no services: nothing built, dumped or removed" >&2; exit 1; }
model="$(docker compose config --format json)"

RECREATED=()
dump
docker compose build

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
status=0; step "$out" "$desired" || status=$?
if [ "$status" -ne 0 ]; then
  # Each of the two known races is tolerated once; anything else, or a second failure, ends the apply as it is.
  if grep -qE "$race" "$out"; then
    echo "compose: raced a container that was already being removed; retrying once"
  elif grep -qE "$conflict" "$out"; then
    echo "compose: a container name was still in use; retrying once"
  else
    exit "$status"
  fi
  # The retry re-derives what moved, so a service the first pass already recreated is reported as kept, not twice.
  RECREATED=()
  step "$out" "$desired"
fi
# A container compose created but never started (its up was cut short) is started, so the stack ends up running.
for service in $desired; do
  [ "$(docker compose ps -a --format '{{.State}}' "$service" 2>/dev/null | head -1)" = created ] || continue
  docker compose start "$service" && echo "compose: $service was left created: started"
done
summary "$desired"
