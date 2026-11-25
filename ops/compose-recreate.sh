#!/usr/bin/env bash
# The apply's compose step, in order:
# The images are built before this step (the apply's validate, or its switch when nothing was validated).
#   1. an empty service list stops it, before it dumps or removes anything: an empty list would make every
#      stopped container a leftover, and nothing here should guess at what the config runs;
#   2. only the services whose image, compose config or mounted secret content moved are recreated; every other container
#      keeps running. When there are any, a fresh dump of the warehouse (when this host runs one) is taken first (see
#      dump); a step that recreates nothing dumps nothing, and neither does one where no recreated service's image moved
#      (a settings-only apply recreates containers on the same code, so no migration runs; the nightly dump is the copy);
#   3. compose's leftovers for services this config dropped are removed, and never a CI job's runner;
#   4. a service still left `created` (never started) is started;
#   5. a container, running or already stopped, of a service this config dropped (a removed or replaced module's, or Caddy
#      once exposure is no longer public) is removed: compose's own service container only (com.docker.compose.oneoff=False), so a CI
#      job's runner (a one-off) is never one.
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
# The inputs every decision reads, each gathered in one call for all services rather than a few calls per service: the
# project's containers (snapshot), each service's config hash (HASHES), each image's platform manifest (IMAGE_IDS) and
# each service's mounted-secret digest (DIGESTS).
CONTAINERS=""
# Set when a recreated service runs another image than before (new code that may migrate), or had no running container.
IMAGE_MOVED=0
declare -A SERVICE_ID=() RUNNING=() STATUS=() IMAGE_OF=() HASH_OF=() HASHES=() SERVICE_IMAGE=() IMAGE_IDS=() DIGESTS=() DESIRED=()
# The warehouse's own Postgres image, as scripts/backup.sh uses it: already pinned, so the dump needs nothing new.
dump_image='postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f'
warehouse_container=app-warehouse-postgres-1
dump_dir="$data/dumps"
dump_base=warehouse

# The warehouse's password comes from the vault (apps-mcp writes it there). Checked before the first docker command, so a
# host that lost it stops here with a clear message instead of after a step it can't protect. A host with no warehouse
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
  local kept="${1:-}" id name running service
  while IFS='|' read -r id name running _ _ _ _ _; do
    [[ "$name" =~ ^/[0-9a-f]{12}_${project}-(.+)-1$ ]] || continue
    service="${BASH_REMATCH[1]}"
    if [ -n "${DESIRED[$service]-}" ]; then [ -n "$kept" ] || continue; else [ -z "$kept" ] || continue; fi
    [ "$running" = "false" ] || continue
    printf '%s %s\n' "$id" "$service"
  done <<< "$CONTAINERS"
}

# Every container of this project, in one `docker ps` and one `docker inspect`: "id|name|running|status|service|oneoff|
# image|config-hash" per line, and per service the container compose runs it in (never a one-off, never a recreate's
# <12hex>_ half-made one). A container that went away between the two calls (a CI runner removing itself) is simply not
# listed. Taken again after anything here starts or removes a container.
snapshot() {
  local ids id name running status service oneoff image hash
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  CONTAINERS=""
  # shellcheck disable=SC2086 # the ids are one word each
  [ -z "$ids" ] || CONTAINERS="$(docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Running}}|{{.State.Status}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.docker.compose.image"}}|{{index .Config.Labels "com.docker.compose.config-hash"}}' $ids 2>/dev/null)" || true
  SERVICE_ID=(); RUNNING=(); STATUS=(); IMAGE_OF=(); HASH_OF=()
  while IFS='|' read -r id name running status service oneoff image hash; do
    [ -n "$id" ] || continue
    RUNNING[$id]="$running"; STATUS[$id]="$status"; IMAGE_OF[$id]="$image"; HASH_OF[$id]="$hash"
    [ "$oneoff" = False ] && [ -n "$service" ] && [ -z "${SERVICE_ID[$service]-}" ] || continue
    [[ "$name" =~ ^/[0-9a-f]{12}_ ]] || SERVICE_ID[$service]="$id"
  done <<< "$CONTAINERS"
}

# Each service's compose config hash, in one call.
configHashes() {
  local service hash hashes
  hashes="$(docker compose config --hash '*')"
  while read -r service hash; do
    [ -z "$service" ] || HASHES[$service]="$hash"
  done <<< "$hashes"
}

# Each service's own image (SERVICE_IMAGE: `config --images <service>` would list its dependencies' images too) and the
# platform manifest of every one of them (IMAGE_IDS), in one `docker image inspect`. It prints one id per image it
# has, in order, and a "No such image: <ref>" error for each it doesn't (an image the up will pull): those are left
# unset, so their services are recreated. Any other error stops the step.
imageIds() {
  local -a refs ids
  local ref err line service image pairs i=0 status=0
  local -A missing=()
  pairs="$(jq -r '.services | to_entries[] | select((.value.image // "") != "") | "\(.key)\t\(.value.image)"' <<< "$model")"
  while IFS=$'\t' read -r service image; do
    [ -z "$service" ] || SERVICE_IMAGE[$service]="$image"
  done <<< "$pairs"
  [ "${#SERVICE_IMAGE[@]}" -gt 0 ] || return 0
  mapfile -t refs < <(printf '%s\n' "${SERVICE_IMAGE[@]}" | sort -u)
  err="$(docker image inspect --platform "$platform" -f '{{.Id}}' "${refs[@]}" 2>&1 >"$tmp/image-ids")" || status=$?
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [[ "$line" =~ No\ such\ image:\ (.+)$ ]]; then missing["${BASH_REMATCH[1]}"]=1
    else echo "refusing: docker image inspect failed (exit $status): $line" >&2; return 1; fi
  done <<< "$err"
  mapfile -t ids < "$tmp/image-ids"
  for ref in "${refs[@]}"; do
    [ -z "${missing[$ref]-}" ] || continue
    IMAGE_IDS[$ref]="${ids[$i]-}"
    i=$((i + 1))
  done
  [ "$i" -eq "${#ids[@]}" ] || { echo "refusing: docker image inspect printed ${#ids[@]} ids for $i images" >&2; return 1; }
}

# One leftover. Failing because it is already going away is the same outcome: it is gone either way.
remove() {
  local id="$1" service="$2" what="${3:-leftover}" err status=0
  err="$(docker rm "$id" 2>&1)" || status=$?
  if [ "$status" -eq 0 ] || grep -qE "$race" <<< "$err"; then
    stale=1
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

# A logical dump of the warehouse before anything is recreated, once per run (a retry reuses it). The file is created
# under umask 077 in a 0700 directory, so it is 0600 from the first byte and no other user can read it. A dump an earlier
# run left is never rewritten, only has its mode tightened; the newest two are kept and the rest removed, so a host
# applying often doesn't fill its disk with full copies. A dump that can't be written fails the apply: it is the copy the
# recreate stands behind. Called where errexit is off (step), so every failure returns explicitly. The password was
# checked before the first docker call.
dump() {
  [ "$dumped" = 0 ] || return 0
  dumped=1
  [ -d "$secrets/apps/warehouse" ] || { echo "compose: no warehouse on this host: nothing dumped"; return 0; }
  [ "$(docker inspect -f '{{.State.Running}}' "$warehouse_container" 2>/dev/null || true)" = "true" ] || {
    echo "compose: $warehouse_container is not running: nothing dumped"
    return 0
  }
  local was file status=0
  was="$(umask)"; umask 077
  { mkdir -p -m 0700 "$dump_dir" && chmod 0700 "$dump_dir"; } || { umask "$was"; return 1; }
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
  chmod 0600 "$file" || return 1
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
#
# Every service's digest (DIGESTS) at once: one jq over the model and one sha256sum over every file that exists.
secretDigests() {
  local pairs service file sum digest
  local -a files=()
  local -A sums=() lines=()
  DIGESTS=()
  pairs="$(jq -r '. as $model | $model.services | to_entries[] | .key as $service | .value.secrets[]?.source as $source | ($model.secrets[$source].file // empty) | "\($service)\t\(.)"' <<< "$model")" || return 1
  while IFS=$'\t' read -r service file; do
    [ -n "$file" ] && [ -f "$file" ] && [ -z "${sums[$file]-}" ] || continue
    sums[$file]=unread; files+=("$file")
  done <<< "$pairs"
  if [ "${#files[@]}" -gt 0 ]; then
    while read -r sum file; do sums[$file]="$sum"; done <<< "$(sha256sum -- "${files[@]}" 2>/dev/null)"
  fi
  while IFS=$'\t' read -r service file; do
    [ -n "$file" ] || continue
    sum="${sums[$file]-missing}"
    [ "$sum" != unread ] || { echo "refusing: cannot read the secret file $file for $service" >&2; return 1; }
    lines[$service]+="$file $sum"$'\n'
  done <<< "$pairs"
  for service in "${!lines[@]}"; do
    digest="$(printf '%s' "${lines[$service]}" | sha256sum)"
    DIGESTS[$service]="${digest%% *}"
  done
}

# Record what a running container read from its mounted secrets when it started: the container, and the digest of the
# files it mounted. Only a container other than the one the pass began with is recorded (the pass started this one).
# A service with no mounted file secret has nothing to compare, so its old record is dropped. Reads the snapshot taken
# after the up.
recordSecretState() {
  local service="$1" digest="$2" was="${3-}" id
  id="${SERVICE_ID[$service]-}"
  [ -n "$id" ] && [ "$id" != "$was" ] || return 0
  [ "${RUNNING[$id]-}" = true ] || return 0
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
#
# The image is compared by its platform manifest, as compose records it on the container (com.docker.compose.image), not
# by the image's top-level id: on the containerd image store that id is the image index, and every build, cached or not,
# writes a new index (a fresh provenance attestation), so comparing it recreated every built service on every apply. The
# service's own image comes from the model: `config --images <service>` lists its dependencies' images too.
moved() {
  local service="$1" id digest image want have now then
  id="${SERVICE_ID[$service]-}"
  WAS_IDS[$service]="$id"
  # Read before any early return: a service recreated because it was missing or stopped (a snapshot stopped it) gets its
  # record after the up too, or the next apply finds the old container's record and recreates it once more.
  digest="${DIGESTS[$service]-}"
  BEFORE_DIGESTS[$service]="$digest"
  [ -n "$id" ] || { IMAGE_MOVED=1; return 0; }
  [ "${RUNNING[$id]-}" = true ] || { IMAGE_MOVED=1; return 0; }
  image="${SERVICE_IMAGE[$service]-}"
  if [ -n "$image" ]; then
    want="${IMAGE_IDS[$image]-}"
    have="${IMAGE_OF[$id]-}"
    [ -n "$want" ] && [ "$want" = "$have" ] || { IMAGE_MOVED=1; return 0; }
  fi
  now="${HASHES[$service]-}"
  then="${HASH_OF[$id]-}"
  [ -n "$now" ] && [ "$now" = "$then" ] || return 0
  # This container, started with what is on disk now, is what its record says. Another container or another digest is a
  # rotation this one missed; no record at all means its start is unknown, so it is recreated once and recorded after
  # the step.
  [ -z "$digest" ] || [ "$(cat "$secret_state/$service" 2>/dev/null)" = "$id $digest" ] || return 0
  return 1
}

# The snapshot again, only when something here started or removed a container since it was taken.
refresh() {
  [ "$stale" = 1 ] || return 0
  stale=0
  snapshot
}

# One pass: recreate what moved, then clean up the leftovers. Output goes to $1, where the caller looks for a race.
step() {
  local out="$1" status=0 recorded=0 id service
  local -a recreate=()
  stale=1; refresh
  while read -r id service; do
    [ -n "$id" ] || continue
    remove "$id" "$service" "half-made container"
  done <<< "$(leftovers kept)"
  refresh
  secretDigests || exit 1
  IMAGE_MOVED=0
  for service in $desired; do moved "$service" && recreate+=("$service"); done
  if [ "${#recreate[@]}" -gt 0 ]; then
    if [ "$IMAGE_MOVED" = 1 ]; then dump || return 1; else echo "compose: no image moved: the warehouse is not dumped"; fi
    stale=1
    docker compose up -d --no-deps --force-recreate "${recreate[@]}" 2>&1 | tee "$out" || status=$?
    RECREATED+=("${recreate[@]}")
    # Record the digest the pass read before the up, against the container it started, whether or not the up went on to
    # fail, so a retry keeps it instead of starting it twice. Only when the files are still that digest: a secret that
    # changed while the container started may have been read either way, so what it holds is unknown, and its record is
    # left alone to recreate it again on the next apply. A service the pass never started keeps its old record too.
    refresh
    if secretDigests; then
      for service in "${recreate[@]}"; do
        [ "${DIGESTS[$service]-}" = "${BEFORE_DIGESTS[$service]-}" ] || continue
        recordSecretState "$service" "${DIGESTS[$service]-}" "${WAS_IDS[$service]-}" || recorded=$?
      done
    else
      recorded=1
    fi
  else
    : > "$out"
  fi
  [ "$status" -eq 0 ] || return "$status"
  [ "$recorded" -eq 0 ] || return 1
  while read -r id service; do
    [ -n "$id" ] || continue
    remove "$id" "$service"
  done <<< "$(leftovers)"
}

# A service container (never a one-off) of this project, running or stopped, of a service this config no longer defines:
# "<id> <service>". Stopped ones count: a module's data move stops the old container before this step, and a stopped
# container is still one monitoring sees as a core service that is down.
dropped() {
  local id service oneoff
  while IFS='|' read -r id _ _ _ service oneoff _ _; do
    [ "$oneoff" = False ] && [ -n "$service" ] && [ -z "${DESIRED[$service]-}" ] || continue
    printf '%s %s\n' "$id" "$service"
  done <<< "$CONTAINERS"
}

# A service's container state as `docker compose ps` names it (running, exited, created...), from the snapshot.
state() {
  local id="${SERVICE_ID[$1]-}"
  [ -z "$id" ] || printf '%s' "${STATUS[$id]-}"
}

# One line per service in this config: recreated, or kept (and when a kept one is not up, that too), so every apply's
# log shows the stack it left. A cleaned leftover printed its own line as it was removed.
summary() {
  local service state
  for service in $desired; do
    case " ${RECREATED[*]:-} " in
      *" $service "*) echo "compose: $service recreated"; continue ;;
    esac
    state="$(state "$service")"
    if [ "$state" = running ]; then echo "compose: $service kept"
    else echo "compose: $service kept (not running: ${state:-unknown})"; fi
  done
}

# Before the first docker call of any kind: a host that can't dump its warehouse stops here.
requireDumpPassword
desired="$(docker compose config --services | sort -u)"
# Before anything is dumped or removed.
[ -n "$desired" ] || { echo "compose: docker compose config lists no services: nothing dumped or removed" >&2; exit 1; }
for service in $desired; do DESIRED[$service]=1; done
model="$(docker compose config --format json)"
platform="$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
out="$tmp/out"
# The config and the images don't change during the step: read once, for every pass.
configHashes
imageIds

RECREATED=()
dumped=0
stale=1

status=0; step "$out" || status=$?
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
  step "$out"
fi
refresh
# A container compose created but never started (its up was cut short) is started, so the stack ends up running.
for service in $desired; do
  [ "$(state "$service")" = created ] || continue
  stale=1
  docker compose start "$service" && echo "compose: $service was left created: started"
done
refresh
# What this config dropped stops running: a removed module's container would otherwise keep running (and serving) forever.
while read -r id service; do
  [ -n "$id" ] || continue
  stale=1
  err="$(docker rm -f "$id" 2>&1)" || grep -qE "$race" <<< "$err" || { printf '%s\n' "$err" >&2; exit 1; }
  echo "compose: $service removed (no longer in the config)"
done <<< "$(dropped)"
refresh
summary
