#!/usr/bin/env bash
# The security module's inventory (modules/security): daily from aidenhq-security-sbom.timer (a user timer), or by hand.
# Runs pinned syft in a throwaway container (no network, as this user) over:
#   host            the VM's root filesystem, read-only: OS packages (kernel, Docker, Node...), not Docker's own storage,
#                   the homes or this instance's own checkouts (see HOST_EXCLUDES)
#   image:<ref>     every image a running container uses: the reference it was created with while the tag still names what
#                   runs, else the container's own id (findings reconcile by target name). Each is saved from Docker under
#                   the apply lock, from the reference the lock resolved, and read as a docker archive, so the scan follows
#                   what runs rather than whatever a tag names by the time syft opens it. An image nothing local can
#                   export is a line saying so, never a silent gap in the batch
#   repo:product    this checkout (lockfiles; not data/, node_modules or .git)
#   repo:instance   the instance checkout
#   app:<name>      each app's deployed source (data/apps/.platform/<name>/src, what apps-mcp checked out)
# It runs here, not in the scanner, because these need the Docker socket and the host's root filesystem, which the
# long-running scanner never gets. Output: <data>/modules/security/sbom/current/targets.tsv (target, file, error, commit)
# and one syft-json per target; the scanner (read-only mount) matches a new batch within the hour. commit is the checkout's
# git HEAD for repo:product and repo:instance, so a pass says which tree it read. One target failing is a line with its
# error, never the batch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
SYFT="anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060"
out="${AIDENHQ_DATA_DIR:-$PWD/data}/modules/security/sbom"
mkdir -p "$out"
[ -w "$out" ] || { echo "security-sbom: $out isn't writable by $(id -un) (created by Docker?): sudo chown $(id -u):$(id -g) $out" >&2; exit 1; }
# One pass at a time: two passes unpack two images each into their own .work on the same filesystem, and a timer that fires
# while a manual run is going would double the bytes written and race the current/ swap. A skipped pass keeps yesterday's
# batch, which the scanner reads again; it is not a failure.
exec 9>>"$out/.lock"
flock -n 9 || { echo "security-sbom: another pass holds $out/.lock; skipping this one"; exit 0; }
# Names this pass's containers: its own, so a leftover is recognisably this scanner's and never another's.
pass="$(printf '%s' "$out" | sha256sum | cut -c1-12)-$$"
next="$out/next"
work="$out/.work"
archives="$out/.archives"
rm -rf "$next" "$work" "$archives"
mkdir -p "$next" "$work" "$archives"
: > "$next/targets.tsv"
user="$(id -u):$(id -g)"
# The apply lock comes before any Docker probe: while an apply holds it, Docker may be mid-recreate and a probe that
# fails must not abort the pass instead of reporting the normal mid-apply skip.
# fd 9 is this pass's own .lock above, so the apply lock is taken on fd 8.
# shellcheck source=ops/lib/apply-lock.sh
. ops/lib/apply-lock.sh
mkdir -p "$(dirname "$APPLY_LOCK")"
exec 8>>"$APPLY_LOCK"
if ! flock -n 8; then
  echo "security-sbom: an apply holds the apply lock; skipping this pass" >&2
  rm -rf "$next" "$work" "$archives"
  exit 0
fi
sock_gid="$(stat -c %g /var/run/docker.sock)"
platform="$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')"
# The smallest free space a target may start with, in GB: syft writes a `docker save` archive and unpacks every layer under
# $work, so one large image needs roughly twice its size. Below this the pass records the target as failed rather than
# filling the filesystem the rest of the host runs on (2026-11-21: / on md2 hit 81% while two containers wrote ~142 GB).
# The setting may raise the floor on a roomier disk, never lower it: 30 GB is the least this pass runs with, so a typo, an
# empty value or a deliberate 0 can't switch the guard off.
min_free_gb=30
if [[ "${AIDENHQ_SBOM_MIN_FREE_GB:-}" =~ ^[0-9]+$ ]] && [ "$AIDENHQ_SBOM_MIN_FREE_GB" -gt "$min_free_gb" ]; then
  min_free_gb="$AIDENHQ_SBOM_MIN_FREE_GB"
fi
free_gb() { df -Pk "$out" | awk 'NR == 2 { printf "%d", $4 / 1048576 }'; }
# A container is this scanner's own only by its label: a name is not proof of ownership, so nothing else's is ever removed.
scanner_container() { [ "$(docker inspect -f '{{index .Config.Labels "aidenhq.oneoff"}}' "$1" 2>/dev/null || true)" = 1 ]; }
n=0

# scan <target> <commit> [docker mount args...] -- <syft source> [syft args...]
scan() {
  local target="$1" commit="$2"; shift 2
  local mounts=()
  while [ "$1" != "--" ]; do mounts+=("$1"); shift; done
  shift
  n=$((n + 1))
  local f err name avail
  f="$(printf '%03d.json' "$n")"
  avail="$(free_gb)"
  if [ "$avail" -lt "$min_free_gb" ]; then
    # Not started: a scan that runs the disk out takes the host's other services with it, and its own output would be the
    # thing that never landed. A line with the reason is the batch saying it has no room, never a clean pass.
    printf '%s\t-\t%s\t%s\n' "$target" "skipped: ${avail} GB free on $out, under the ${min_free_gb} GB floor" "$commit" >> "$next/targets.tsv"
    return 0
  fi
  # syft's image has no writable /tmp for a non-root user: image layers unpack into $work (on disk, not RAM).
  # `aidenhq.oneoff`: the scan's own container is running for as long as the batch takes, and containers.prom names none.
  # A name and a forced removal: `timeout` ends the docker CLI, and a container that ignores the forwarded signal would
  # otherwise keep unpacking into $work after the next target started, unseen.
  name="aidenhq-sbom-$pass-$n"
  scanner_container "$name" && docker rm -f "$name" >/dev/null 2>&1 || true # a leftover of this pass, before `run`
  if err="$(timeout 1800 docker run --rm --name "$name" --label aidenhq.oneoff=1 --network none --user "$user" --group-add "$sock_gid" -e SYFT_CHECK_FOR_APP_UPDATE=false \
      -e TMPDIR=/work -e XDG_CACHE_HOME=/work -v "$work:/work" -v "$next:/out" "${mounts[@]}" \
      "$SYFT" scan "$@" --source-name "$target" -o "syft-json=/out/$f" 2>&1 >/dev/null)"; then
    printf '%s\t%s\t\t%s\n' "$target" "$f" "$commit" >> "$next/targets.tsv"
  else
    scanner_container "$name" && docker rm -f "$name" >/dev/null 2>&1 || true
    printf '%s\t-\t%s\t%s\n' "$target" "$(printf '%s' "${err:-failed}" | tr '\t\n' '  ' | tail -c 300)" "$commit" >> "$next/targets.tsv"
  fi
  # Everything the target wrote: stereoscope leaves its `stereoscope-*` and `syft-*` temp dirs behind when a scan fails, and
  # `*` alone would keep a dotfile (an XDG cache) for the next target to grow. A cleanup that fails is said out loud: the
  # next target would otherwise start on top of this one's bytes.
  find "$work" -mindepth 1 -delete 2>/dev/null || echo "security-sbom: could not empty $work after $target" >&2
}

inst="${AIDENHQ_INSTANCE_DIR:-}"
# What the host target leaves out. The scan root is /, and syft resolves a directory scan's patterns against it: a
# pattern is relative (`./home/**`), never `/home/**`. The homes hold checkouts, task worktrees and tool caches, whose
# lockfiles and binaries belong to other projects' dependency trees rather than to this host, and no apt upgrade or
# ops/vm/pins.json clears one: the host target is what the operator remediates. /usr, /opt, /etc and /var/lib/dpkg stay
# in it. A checkout that should be watched later gets its own target, not a place back in here.
HOST_EXCLUDES=(
  './home/**' './root/**'
  './proc/**' './sys/**' './dev/**' './run/**' './tmp/**'
  './var/lib/docker/**' './var/lib/containerd/**'
)
host_excludes=("${HOST_EXCLUDES[@]}" "./${PWD#/}/**" "./${out#/}/**" '**/node_modules/**')
[ -n "$inst" ] && host_excludes+=("./${inst#/}/**")
host_args=()
for p in "${host_excludes[@]}"; do host_args+=(--exclude "$p"); done
# Each running container's own image, `.Image`: after a rebuild a container's configured tag (`.Config.Image`) names the new
# build, and once the image is untagged names nothing at all, so a target keyed on it stops covering what runs and the
# running image is never inventoried. A configured name keeps its `image:<ref>` target while it still names what the
# container runs. On the containerd image store that is the tag's platform manifest, the id compose records on the
# container as `com.docker.compose.image` (ops/compose-recreate.sh decides a recreate by the same comparison): the
# top-level id is an image index and every build rewrites it, so comparing that would drop the target after any rebuild.
# Any other container's image is named by its own id, which is stable across passes, and syft reads it from a saved
# archive. A running container's image is a target or a line, never a silent gap: a size inspect or save that fails
# records the id and the error. A name only counts when it isn't an image id itself, because syft can't resolve a bare
# id: it would try to pull it.
fail() { # <target> <error>: a target that never reached syft is a line with its error, like a failed scan
  n=$((n + 1))
  printf '%s\t-\t%s\t\n' "$1" "$(printf '%s' "$2" | tr '\t\n' '  ' | tail -c 300)" >> "$next/targets.tsv"
}
ceil_gb() { echo $(( ($1 + 1073741823) / 1073741824 )); }
# One Docker call with a deadline, so a daemon that stops answering can't hold the apply lock past it, and the whole
# snapshot under one overall deadline so forty slow saves can't add up to an apply waiting for hours. Without a working
# `timeout` the call fails rather than running unbounded.
docker_call() {
  local secs="$1"; shift
  if [ -n "${SNAPSHOT_DEADLINE:-}" ]; then
    local left=$(( SNAPSHOT_DEADLINE - SECONDS ))
    [ "$left" -le 0 ] && { echo "security-sbom: snapshot deadline reached" >&2; return 124; }
    [ "$secs" -gt "$left" ] && secs="$left"
  fi
  timeout "$secs" docker "$@"
}
# A tag's platform manifest as the daemon answers it, or its top-level id on a daemon without platform resolution.
pin_of() { # <tag>
  local id
  id="$(docker_call 5 image inspect --platform "$platform" -f '{{.Id}}' "$1" 2>/dev/null)"
  [ -n "$id" ] || id="$(docker_call 5 image inspect -f '{{.Id}}' "$1" 2>/dev/null)"
  printf '%s' "$id"
}
# Every reference the daemon holds that might export a platform manifest: the manifest itself, the container's index,
# then every local tag. A platform manifest inside a multi-platform index is not an image record of its own, so a bare
# digest names nothing to Docker; the index that holds it does, and `docker save --platform` exports exactly the running
# platform from it. Immutable references are listed before tags, so a save binds to the first that matches.
platform_refs() { # <platform manifest id> <container .Image>
  local want="$1" image="$2" ref
  printf '%s\n' "$want"
  [ -n "$image" ] && printf '%s\n' "$image"
  while IFS= read -r ref; do
    [ -n "$ref" ] && [ "$ref" != "<none>:<none>" ] && printf '%s\n' "$ref"
  done < <(docker_call 10 image ls -a --no-trunc --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)
}
# The first reference that provably holds the platform manifest <pin>: `docker image inspect --platform` on it names <pin>,
# and it is an image record the daemon can hand to `docker save` (a bare platform manifest inside a multi-platform index is
# not one, which `docker image inspect` shows). Falls back to the pin itself for a single-platform store that holds the
# manifest as an image record the inspect doesn't resolve; the save then either works or the next reference runs.
resolve_ref() { # <pin manifest> <container .Image>
  local pin="$1" image="$2" candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    [ "$candidate" = "$pin" ] && continue
    if [ "$(pin_of "$candidate")" = "$pin" ] && docker_call 5 image inspect -f '{{.Id}}' "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"; return 0
    fi
  done < <(platform_refs "$pin" "$image")
  printf '%s' "$pin"
}
# Export the image <pin> to <dest>, trying every reference that could hold it (immutable ids before tags), each accepted
# only when it names <pin>. A save from an immutable id cannot name another image than the one verified; a tag is re-read
# after the save and the archive dropped if it moved, so a rebuilt tag is never published under the running container's
# target. Returns 1 with export_err.
export_err=""
export_image() { # <pin manifest> <container .Image> <dest tar>
  local pin="$1" image="$2" dest="$3" candidate
  export_err=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    # The pin itself may be a saveable image record on a single-platform store, and a reference is accepted only when it
    # names the pin. Anything else would save a different image under this target.
    if [ "$candidate" != "$pin" ] && [ "$(pin_of "$candidate")" != "$pin" ]; then continue; fi
    if ! export_err="$(docker_call 900 image save --platform "$platform" -o "$dest" "$candidate" 2>&1)"; then
      rm -f "$dest"; continue
    fi
    case "$candidate" in
      sha256:*|*@sha256:*) export_err=""; return 0 ;;
    esac
    if [ "$(pin_of "$candidate")" = "$pin" ]; then export_err=""; return 0; fi
    rm -f "$dest"; export_err="the tag moved during this pass; not scanning a different image"
  done < <(platform_refs "$pin" "$image")
  return 1
}
# The batch's images, decided from one snapshot of the containers, taken under the host's apply lock: between an apply's
# `docker compose build` and its recreate every rebuilt tag names the new image while its container still runs the old
# one, and a batch enumerated there is a half-applied snapshot. The lock is released before the scans, so an apply never
# waits on one. Returns 1 when the enumeration itself failed: the caller keeps the previous batch rather than publish a
# short one.
plan_target=(); plan_source=(); plan_pin=(); plan_ref=()
plan_add() { plan_target+=("$1"); plan_source+=("$2"); plan_pin+=("$3"); plan_ref+=("$4"); }
snapshot() {
  local listing rows cid row image config label want key raw size size_gb avail ref saved candidate archive pin
  local -A running=() tags=() manifests=()
  # How long the snapshot may hold the apply lock: generous for forty saves, short enough that a daemon that stopped
  # answering can't keep an apply waiting. AIDENHQ_SBOM_SNAPSHOT_SECS is for the tests; a bad value falls back.
  local budget=1800
  if [[ "${AIDENHQ_SBOM_SNAPSHOT_SECS:-}" =~ ^[0-9]+$ ]] && [ "$AIDENHQ_SBOM_SNAPSHOT_SECS" -gt 0 ]; then
    budget="$AIDENHQ_SBOM_SNAPSHOT_SECS"
  fi
  SNAPSHOT_DEADLINE=$((SECONDS + budget))
  if ! listing="$(docker_call 10 ps -q 2>&1)"; then
    echo "security-sbom: could not enumerate containers (${listing:-docker ps failed}); keeping the previous batch" >&2
    return 1
  fi
  # One batched inspect, re-run per container if it fails so a container that exited between `ps` and the inspect is
  # simply gone, not an enumeration error. A daemon that answers for none of them is an error: a batch with no images
  # while containers run is exactly the silent gap this pass must not publish.
  local -a cids=()
  while IFS= read -r cid; do [ -n "$cid" ] && cids+=("$cid"); done <<< "$listing"
  local -a missing=()
  if ! rows="$(docker_call 15 inspect -f '{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{end}}' "${cids[@]}" 2>/dev/null)"; then
    rows=""
    for cid in "${cids[@]}"; do
      if row="$(docker_call 10 inspect -f '{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{end}}' "$cid" 2>/dev/null)"; then
        rows+="$row"$'\n'
      else
        missing+=("$cid")
      fi
    done
  fi
  # A container that exited between `ps` and the inspect is gone, not an error. One still listed after failing is the
  # daemon not answering for a running container: no batch, so the previous one stays.
  if [ "${#missing[@]}" -gt 0 ]; then
    # Only a listing that succeeded can say a container is gone: a failed re-list (`|| true`'d into nothing) would make
    # every uninspected container look stopped and publish a partial batch.
    local still
    if ! still="$(docker_call 10 ps -q 2>/dev/null)"; then
      echo "security-sbom: could not re-list containers after a failed inspect; keeping the previous batch" >&2
      return 1
    fi
    for cid in "${missing[@]}"; do
      if printf '%s\n' "$still" | grep -qxF -- "$cid"; then
        echo "security-sbom: docker inspect failed for running container $cid; keeping the previous batch" >&2
        return 1
      fi
    done
  fi
  if printf '%s\n' "$listing" | grep -q . && ! printf '%s\n' "$rows" | grep -q .; then
    echo "security-sbom: docker inspect answered for no running container; keeping the previous batch" >&2
    return 1
  fi
  while read -r cid image config label; do
    [ -n "$cid" ] || continue
    case "$config" in *anchore/syft*) continue ;; esac
    running[$image]=1
    if [ -n "$label" ]; then : "${manifests[$image]:=$label}"; fi
    [ "${config#sha256:}" = "$config" ] || continue
    { [ -n "$label" ] && [ "$(docker_call 5 image inspect --platform "$platform" -f '{{.Id}}' "$config" 2>/dev/null)" = "$label" ]; } \
      || [ "$(docker_call 5 image inspect -f '{{.Id}}' "$config" 2>/dev/null)" = "$image" ] || continue
    { [ -z "${tags[$image]:-}" ] || [[ "$config" < "${tags[$image]}" ]]; } || continue
    tags[$image]="$config"
  done <<< "$rows"
  plan_target=(); plan_source=(); plan_pin=(); plan_ref=()
  # Archives wait here, not in $work, which each scan empties. Space is budgeted across the whole plan: every archive
  # stays on disk until its scan, so a later image must still fit beside the earlier ones above the floor.
  avail=$(( $(free_gb) - min_free_gb ))
  for image in $(printf '%s\n' "${!running[@]}" | sort); do
    # The image the container runs: its tag while the tag still names what runs, else the platform manifest compose
    # recorded, else the container's own top-level id. The target stays `image:<container id>` when the tag has moved: the
    # store reconciles findings by target name, so keying the same image by its manifest id would leave the findings
    # already held under its id unverified beside the new ones.
    want="${tags[$image]:-${manifests[$image]:-$image}}"
    key="${tags[$image]:-$image}"
    # The platform manifest this target stands for, pinned here under the lock and the only thing a later save is checked
    # against. `pin_of` resolves an index to the platform manifest inside it, which is what runs.
    pin="$(pin_of "$want")"; [ -n "$pin" ] || pin="$want"
    # The reference the save will read, resolved now, while the lock still holds the store still. Discovering it here, not
    # after the size checks, is what lets an image whose own id is gone but whose index another tag holds still be
    # exported instead of dropped as unreadable.
    if ! ref="$(resolve_ref "$pin" "$image")"; then
      plan_add "image:$key" "fail:docker save: no local image exports $want" "$pin" "$image"; continue
    fi
    raw=""; saved=""
    if raw="$(docker_call 5 image inspect -f '{{.Size}}' "$ref" 2>&1)"; then saved=1
    elif [ "$ref" != "$image" ] && raw="$(docker_call 5 image inspect -f '{{.Size}}' "$image" 2>&1)"; then ref="$image"; saved=1
    fi
    if [ -z "$saved" ]; then
      plan_add "image:$key" "fail:docker image inspect: ${raw:-failed}" "$pin" "$image"; continue
    fi
    # The template prints one number; a warning ahead of it is not the size, so the last line is what is judged. A size
    # nothing answers is unknown, not zero: an unknown demand can't be judged to fit, so the target is recorded.
    size="$(printf '%s\n' "$raw" | tail -1)"
    if [[ ! "$size" =~ ^[0-9]+$ ]]; then
      plan_add "image:$key" "fail:docker image inspect: no size ('$(printf '%s' "$raw" | tr '\t\n' '  ' | tail -c 100)')" "$pin" "$image"; continue
    fi
    size_gb="$(ceil_gb "$size")"
    # One image's archive and its unpack need about twice its size. An image that cannot fit beside the archives already
    # planned is a line and writes no bytes; this is judged for every image, tagged or not.
    if [ "$avail" -lt $(( size_gb * 2 )) ]; then
      plan_add "image:$key" "fail:skipped: ${size_gb} GB image does not fit in the ${avail} GB of room above the ${min_free_gb} GB floor on $out" "$pin" "$ref"; continue
    fi
    # Exported now, under the lock, from the reference resolved above: the archive holds exactly what runs, and nothing
    # that moves after the lock is released can change it. The scan-time path only re-opens archives.
    archive="$archives/${#plan_target[@]}.tar"
    if export_image "$pin" "$image" "$archive"; then
      plan_add "image:$key" "archive:$archive" "$pin" "$ref"
      # The archive stays on disk until its scan, so its own size is what the next image must fit beside.
      saved="$(ceil_gb "$(stat -c %s "$archive")")"
      avail=$(( avail - saved * 2 ))
    else
      plan_add "image:$key" "fail:docker save: ${export_err:-failed}" "$pin" "$ref"
    fi
  done
}
if ! snapshot; then
  exec 8>&-
  rm -rf "$next" "$work" "$archives"
  exit 0
fi
# From here the target list is fixed and every archive holds the image verified under the lock; let an apply run and scan.
# The snapshot deadline bounded the work under the lock, not the scans.
SNAPSHOT_DEADLINE=""
exec 8>&-
scan host "" -v /:/host:ro -- dir:/host "${host_args[@]}"
for i in "${!plan_target[@]}"; do
  target="${plan_target[$i]}"; source="${plan_source[$i]}"
  case "$source" in
    fail:*) fail "$target" "${source#fail:}" ;;
    archive:*)
      # Recheck this image against free space now, with every archive still waiting on disk: the plan's budget judged it
      # beside the archives it knew of, and a scan that has since unpacked images can have left less room than that. An
      # archive that no longer fits is a line, and its bytes go back before the next target.
      archive="${source#archive:}"
      if [ ! -f "$archive" ]; then fail "$target" "docker save: its archive is gone"; continue; fi
      avail="$(free_gb)"; need="$(ceil_gb "$(stat -c %s "$archive")")"
      if [ "$avail" -lt "$min_free_gb" ] || [ "$need" -gt $(( (avail - min_free_gb) / 2 )) ]; then
        fail "$target" "skipped: ${need} GB image does not fit in the ${avail} GB free on $out above the ${min_free_gb} GB floor"
        rm -f "$archive"; continue
      fi
      scan "$target" "" -v "$archive:/image.tar:ro" -- "docker-archive:/image.tar"
      rm -f "$archive" ;;
  esac
done
rm -rf "$archives"
scan repo:product "$(git -C "$PWD" rev-parse HEAD 2>/dev/null || true)" -v "$PWD:/src:ro" -- dir:/src --exclude './data/**' --exclude './.git/**' --exclude '**/node_modules/**'
if [ -n "$inst" ]; then scan repo:instance "$(git -C "$inst" rev-parse HEAD 2>/dev/null || true)" -v "$inst:/src:ro" -- dir:/src --exclude './.git/**' --exclude '**/node_modules/**'; fi
for src in "$PWD"/data/apps/.platform/*/src; do
  [ -d "$src" ] || continue
  scan "app:$(basename "$(dirname "$src")")" "" -v "$src:/src:ro" -- dir:/src --exclude '**/node_modules/**'
done

# Swap the finished batch in (the scanner reads current/; a scan mid-swap skips a target until next time).
rm -rf "$out/prev"
[ -d "$out/current" ] && mv "$out/current" "$out/prev"
mv "$next" "$out/current"
rm -rf "$out/prev" "$work"
echo "security-sbom: $(wc -l < "$out/current/targets.tsv") targets, $(grep -c $'\t-\t' "$out/current/targets.tsv" || true) failed"
