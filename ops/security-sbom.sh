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
# The same room in bytes: the pruning round decides what fits, and rounding a gigabyte either way there can drop an
# image the disk could hold or keep one it cannot. Only the line's numbers are rounded.
free_bytes() { df -Pk "$out" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }'; }
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
# How long a call may take right now: its own limit, clamped by what is left of the snapshot deadline. A call that starts
# after the deadline is refused rather than run unbounded, so nothing done under the apply lock outlives it.
deadline_secs() { # <secs>: prints the effective seconds, or fails 124
  local secs="$1" left
  if [ -n "${SNAPSHOT_DEADLINE:-}" ]; then
    left=$(( SNAPSHOT_DEADLINE - SECONDS ))
    [ "$left" -le 0 ] && { echo "security-sbom: snapshot deadline reached" >&2; return 124; }
    [ "$secs" -gt "$left" ] && secs="$left"
  fi
  printf '%s' "$secs"
}
docker_call() {
  local secs
  secs="$(deadline_secs "$1")" || return 124
  shift
  timeout "$secs" docker "$@"
}
# A read of the saved archive, under the same deadline: the archive can be tens of GB on slow storage, and it is read
# while the apply lock is still held, so it may not outlive the snapshot budget.
archive_read() { # <tar> <member>
  local secs
  secs="$(deadline_secs 120)" || return 124
  timeout "$secs" tar -xOf "$1" "$2" 2>/dev/null
}
# A reference's platform manifest as the daemon answers it for <platform>, or its top-level id on a daemon without
# platform resolution. <platform> is a container's own (below) when it runs another variant of the image than the daemon's.
pin_of() { # <ref> [platform]
  local id plat="${2:-$platform}"
  id="$(docker_call 5 image inspect --platform "$plat" -f '{{.Id}}' "$1" 2>/dev/null)"
  [ -n "$id" ] || id="$(docker_call 5 image inspect -f '{{.Id}}' "$1" 2>/dev/null)"
  printf '%s' "$id"
}
# The platform a container runs, from its `ImageManifestDescriptor`: on the containerd image store the container's `.Image`
# is the top-level index and the daemon's platform can name another variant of it (an emulated arm64 container on an amd64
# host), so exporting or sizing through the server platform can hand back a variant the container is not running. The
# descriptor names the platform manifest the container was created from, which is also its identity. Empty on a daemon
# that does not report one; the caller then keeps the server platform.
descriptor_platform() { # <ImageManifestDescriptor json>
  local p os arch variant
  [ -n "$1" ] && [ "$1" != null ] || return 1
  p="$(printf '%s' "$1" | sed -n 's/.*"platform":{\([^}]*\)}.*/\1/p')"
  [ -n "$p" ] || return 1
  os="$(printf '%s' "$p" | sed -n 's/.*"os":"\([^"]*\)".*/\1/p')"
  arch="$(printf '%s' "$p" | sed -n 's/.*"architecture":"\([^"]*\)".*/\1/p')"
  variant="$(printf '%s' "$p" | sed -n 's/.*"variant":"\([^"]*\)".*/\1/p')"
  [ -n "$os" ] && [ -n "$arch" ] || return 1
  if [ -n "$variant" ]; then printf '%s/%s/%s' "$os" "$arch" "$variant"; else printf '%s/%s' "$os" "$arch"; fi
}
descriptor_manifest() { # <ImageManifestDescriptor json>: the platform manifest the container runs
  [ -n "$1" ] && [ "$1" != null ] || return 1
  printf '%s' "$1" | sed -n 's/.*"digest":"\(sha256:[0-9a-f]*\)".*/\1/p'
}
sock_gid="$(stat -c %g /var/run/docker.sock)"
# The deadline starts with the lock, not with snapshot(): `docker version` and the inspects below run under the same
# lock, and a daemon that stops answering on any of them must not keep an apply waiting. AIDENHQ_SBOM_SNAPSHOT_SECS is
# for the tests; a bad value falls back to the 1800 s that forty saves need.
budget=1800
if [[ "${AIDENHQ_SBOM_SNAPSHOT_SECS:-}" =~ ^[0-9]+$ ]] && [ "$AIDENHQ_SBOM_SNAPSHOT_SECS" -gt 0 ]; then
  budget="$AIDENHQ_SBOM_SNAPSHOT_SECS"
fi
SNAPSHOT_DEADLINE=$((SECONDS + budget))
if ! platform="$(docker_call 15 version -f '{{.Server.Os}}/{{.Server.Arch}}')" || [ -z "$platform" ]; then
  echo "security-sbom: could not read the Docker server platform; keeping the previous batch" >&2
  exec 8>&-
  rm -rf "$next" "$work" "$archives"
  exit 0
fi
# `docker image save --platform` needs API 1.48. A daemon older than that may still use the containerd image store and hold
# several platforms of one image, so a plain save is only safe for a reference proven to be a single image (an immutable
# id), never for a tag. Read once, and say so: the pass then exports proven-single images and records the rest.
save_platform=1
if api="$(docker_call 15 version -f '{{.Server.APIVersion}}' 2>/dev/null)" && [ -n "$api" ]; then
  api_major="${api%%.*}"; api_rest="${api#*.}"; api_minor="${api_rest%%.*}"
  if [[ "$api_major" =~ ^[0-9]+$ && "$api_minor" =~ ^[0-9]+$ ]] \
     && { [ "$api_major" -lt 1 ] || { [ "$api_major" -eq 1 ] && [ "$api_minor" -lt 48 ]; }; }; then
    save_platform=0
    echo "security-sbom: Docker API $api predates image save --platform; exporting plain images on the server platform $platform" >&2
  fi
fi
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
# The first reference that provably holds the platform manifest <pin>: `docker image inspect --platform <platform>` on it
# names <pin>, and it is an image record the daemon can hand to `docker save` (a bare platform manifest inside a
# multi-platform index is not one, which `docker image inspect` shows). Falls back to the pin itself for a single-platform
# store that holds the manifest as an image record the inspect doesn't resolve; the save then either works or the next
# reference runs.
resolve_ref() { # <pin manifest> <container .Image> [platform]
  local pin="$1" image="$2" plat="${3:-$platform}" candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    # An immutable id (the pin itself, or the container's index) that the daemon holds as an image record is the safest
    # export: it cannot move, and saving from it can't name another image. Only if none is held does a tag come into it.
    case "$candidate" in
      sha256:*)
        if docker_call 5 image inspect -f '{{.Id}}' "$candidate" >/dev/null 2>&1; then
          printf '%s' "$candidate"; return 0
        fi
        continue ;;
    esac
    if [ "$(pin_of "$candidate" "$plat")" = "$pin" ]; then printf '%s' "$candidate"; return 0; fi
  done < <(platform_refs "$pin" "$image")
  printf '%s' "$pin"
}
# A plain `docker save` (a daemon without `image save --platform`) writes every platform a tag or an index id holds, so
# the archive itself has to prove it holds the running variant. An OCI archive's `index.json` is read, and a single
# descriptor that is itself an index (an image id over a multi-platform image) is resolved to the manifests it names: the
# archive counts as one image only when exactly one platform manifest comes out of it and its digest is <pin>, the
# platform manifest the container runs. An archive with no `index.json` is Docker's legacy `manifest.json`, which has one
# entry per image, and a failed read of either is not proof of anything: it is refused. Why is left in archive_err.
archive_err=""
plain_archive_single() { # <tar> <pin>
  local tar="$1" pin="$2" idx mt digest blob nested legacy n cfg config
  if idx="$(archive_read "$tar" index.json)"; then :; else
    case "$?" in 124) archive_err="the snapshot deadline reached while checking the archive"; return 1 ;; esac
    idx=""
  fi
  if [ -n "$idx" ]; then
    n="$(printf '%s' "$idx" | grep -o '"digest": *"sha256:' | wc -l)"
    if [ "$n" -ne 1 ]; then archive_err="the archive's index.json names $n manifests"; return 1; fi
    mt="$(printf '%s' "$idx" | sed -n 's/.*"mediaType": *"\([^"]*\)".*/\1/p' | tail -1)"
    digest="$(printf '%s' "$idx" | sed -n 's/.*"digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' | tail -1)"
    case "$mt" in
      *index*|*list*)
        # The saved reference was an index itself: the platform manifests are one level down, in a blob this archive holds.
        blob="blobs/sha256/${digest#sha256:}"
        if nested="$(archive_read "$tar" "$blob")"; then :; else
          case "$?" in 124) archive_err="the snapshot deadline reached while checking the archive"; return 1 ;; esac
          nested=""
        fi
        if [ -z "$nested" ]; then archive_err="the archive's index $digest cannot be read from it"; return 1; fi
        n="$(printf '%s' "$nested" | grep -o '"digest": *"sha256:' | wc -l)"
        if [ "$n" -ne 1 ]; then archive_err="the archive's index $digest names $n platform manifests"; return 1; fi
        digest="$(printf '%s' "$nested" | sed -n 's/.*"digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' | tail -1)" ;;
    esac
    if [ "$digest" != "$pin" ]; then
      # A pin can be a manifest digest (a container's `ImageManifestDescriptor`) or a classic-store image id, which Docker
      # reports as the *config* digest. The one manifest the archive holds names both, so the config digest is the id the
      # classic store would have reported: the archive is the running image if either matches.
      blob="blobs/sha256/${digest#sha256:}"
      if cfg="$(archive_read "$tar" "$blob")"; then :; else
        case "$?" in 124) archive_err="the snapshot deadline reached while checking the archive"; return 1 ;; esac
        cfg=""
      fi
      config="$(printf '%s' "$cfg" | sed -n 's/.*"config": *{[^}]*"digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' | tail -1)"
      if [ -z "$config" ] || [ "$config" != "$pin" ]; then
        archive_err="the archive holds $digest (config ${config:-unknown}), not the running image $pin"; return 1
      fi
    fi
    return 0
  fi
  # No OCI index: a legacy `docker save` writes manifest.json, one entry per image.
  if legacy="$(archive_read "$tar" manifest.json)"; then :; else
    case "$?" in 124) archive_err="the snapshot deadline reached while checking the archive"; return 1 ;; esac
    legacy=""
  fi
  if [ -z "$legacy" ]; then archive_err="the archive has neither index.json nor manifest.json"; return 1; fi
  n="$(printf '%s' "$legacy" | grep -o '"Config": *"[^"]*"' | wc -l)"
  if [ "$n" -ne 1 ]; then archive_err="the archive's manifest.json holds $n images"; return 1; fi
  # One entry is one image, but not necessarily the running one: the entry names its config, and on a store whose image
  # id is the config digest (the classic store this shape comes from) that is what <pin> is.
  config="$(printf '%s' "$legacy" | sed -n 's/.*"Config": *"[^"]*\/\([0-9a-f]\{64\}\)\(\.json\)\{0,1\}".*/sha256:\1/p' | tail -1)"
  if [ -z "$config" ]; then
    config="$(printf '%s' "$legacy" | sed -n 's/.*"Config": *"\([0-9a-f]\{64\}\)\(\.json\)\{0,1\}".*/sha256:\1/p' | tail -1)"
  fi
  if [ -z "$config" ] || [ "$config" != "$pin" ]; then
    archive_err="the archive's manifest.json holds config ${config:-unknown}, not the running image $pin"; return 1
  fi
  return 0
}
# Export the image <pin> to <dest> from <ref>, the reference resolved and sized under the lock. The ref is re-read first:
# if it no longer names <pin> (a tag another pull moved, an index a prune dropped) nothing is written, so a different image
# is never saved under this target. A save from an immutable id cannot name anything but the id; a tag is checked again
# after the save as well. <platform> is the platform the container runs, so a multi-platform index yields exactly its
# variant. Returns 1 with export_err.
export_err=""
export_image() { # <pin manifest> <ref> <dest tar> [platform]
  local pin="$1" ref="$2" dest="$3" plat="${4:-$platform}"
  export_err=""
  # Re-read the reference on the container's platform before writing: a tag another pull moved, or an index whose
  # platform manifest changed, must not put a different image under this target. A bare platform manifest inside an index
  # is not an image record, so a reference the daemon does not hold plainly is the resolver's pin and the save decides.
  if [ "$ref" != "$pin" ] && docker_call 5 image inspect -f '{{.Id}}' "$ref" >/dev/null 2>&1; then
    if [ "$(pin_of "$ref" "$plat")" != "$pin" ]; then
      export_err="the reference moved during this pass; not scanning a different image"; return 1
    fi
  fi
  if [ "$save_platform" = 1 ]; then
    if ! export_err="$(docker_call 900 image save --platform "$plat" -o "$dest" "$ref" 2>&1)"; then
      rm -f "$dest"; return 1
    fi
  else
    # No platform selection on this daemon, and an id is no proof of one variant either: on the containerd store a
    # container's `.Image` is the top-level index, so a plain save of it writes every platform the index holds. The save
    # runs, and the archive decides: one manifest is the running image, more is a line, never a scan of variants.
    if ! export_err="$(docker_call 900 image save -o "$dest" "$ref" 2>&1)"; then
      rm -f "$dest"; return 1
    fi
    if ! plain_archive_single "$dest" "$pin"; then
      rm -f "$dest"
      export_err="this daemon cannot select a platform to save, and $ref's archive does not hold exactly the running platform ($archive_err); not scanning it"
      return 1
    fi
  fi
  case "$ref" in
    sha256:*|*@sha256:*) export_err=""; return 0 ;;
  esac
  if [ "$(pin_of "$ref" "$plat")" = "$pin" ]; then export_err=""; return 0; fi
  rm -f "$dest"; export_err="the tag moved during this pass; not scanning a different image"; return 1
}
# The batch's images, enumerated and sized from one snapshot of the containers, taken under the host's apply lock: between
# an apply's `docker compose build` and its recreate every rebuilt tag names the new image while its container still runs
# the old one, and a batch enumerated there is a half-applied snapshot. The survey fixes the target list and the waves;
# each wave's saves then happen under a lock hold and its scans after the lock is released (the driver below), so an apply
# waits only for one wave's saves. Returns 1 when the enumeration itself failed: the caller keeps the previous batch
# rather than publish a short one.
plan_target=(); plan_source=(); plan_pin=(); plan_ref=(); plan_size=(); plan_idx=()
plan_add() { plan_target+=("$1"); plan_source+=("$2"); plan_pin+=("$3"); plan_ref+=("$4"); plan_size+=("${5:-0}"); plan_idx+=("${6:-0}"); }
# The units this pass resolved and sized, indexed alike for the wave driver below. The sizes are known before any bytes
# are written; the driver decides each wave from them, so a later wave never needs to look at the daemon again for size.
p_key=(); p_pin=(); p_ref=(); p_plat=(); p_bytes=(); p_size=()
archive_seq=0
# Each wave's index, 0 for a unit that never fits (a line at survey time): the save and scan of a wave select their units.
declare -a wave_of=()
# Past this many waves an image that still does not fit is a line, so a set whose archives can never share the disk cannot
# keep deferring itself. snapshot sets it once the planned waves are known.
wave_limit=0
# Why a target was not admitted, with the numbers that decided it: the archives the wave holds, this image's size, the
# largest archive among them, the room above the floor, and the shortfall. A line that says "17 GB does not fit in 101 GB"
# hides that the other archives are what made it not fit. <short> is passed where the room already has the held archives
# subtracted (a save or a scan after earlier writes), so the held bytes are named but not charged twice.
space_need() { # <admitted GB> <this image GB> <largest archive GB> <room GB> [short GB]
  local admitted="$1" size="$2" largest="$3" room="$4" short="${5:-}"
  [ -n "$short" ] || short=$(( admitted + size + largest - room ))
  printf 'admitted %s GB of archives, this %s GB image, largest archive %s GB, room %s GB above the %s GB floor on %s, short by %s GB' \
    "$admitted" "$size" "$largest" "$room" "$min_free_gb" "$out" "$short"
}
snapshot() {
  local listing rows cid row image config desc label want key raw size ref saved pin now
  local plat man nodesc unit
  local -A variant_count=()
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
  # The platform manifest descriptor is read with the container: on the containerd image store `.Image` is the top-level
  # index, and the descriptor names the platform manifest (os/arch[/variant] and digest) this container was created from.
  # It is the last field, because a label is optional (`-` when absent) and a compact JSON value holds no space.
  local fmt_full='{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{else}}-{{end}} {{json .ImageManifestDescriptor}}'
  # A daemon that predates `ImageManifestDescriptor` fails the template itself, not just one container. Its containers are
  # then read with the older template and an empty descriptor, so the pass keeps publishing on the server platform.
  local fmt_old='{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{else}}-{{end}}'
  if ! rows="$(docker_call 15 inspect -f "$fmt_full" "${cids[@]}" 2>/dev/null)"; then
    rows=""
    for cid in "${cids[@]}"; do
      if row="$(docker_call 10 inspect -f "$fmt_full" "$cid" 2>/dev/null)"; then
        rows+="$row"$'\n'
      elif row="$(docker_call 10 inspect -f "$fmt_old" "$cid" 2>/dev/null)"; then
        rows+="$row null"$'\n'
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
  nodesc=0
  # One entry per image *variant*: two containers can run one multi-platform index on different platforms (an amd64
  # service and an emulated arm64 one), and they are different packages. Keying only by `.Image` would let the second
  # share the first's archive and publish no row for it. A unit is its image plus the platform manifest it runs (its
  # platform when the daemon reports no descriptor), and the plan keeps one per unit in a stable order.
  local -a units=()
  local -A unit_seen=() u_image=() u_plat=() u_man=() u_tag=() u_label=() u_pinned=()
  while read -r cid image config label desc; do
    [ -n "$cid" ] || continue
    [ "$label" = - ] && label=""
    case "$config" in *anchore/syft*) continue ;; esac
    # The platform this container runs, and the manifest it was created from. Without a descriptor (an older daemon, or a
    # single-platform store) the server platform is the only answer there is, and the pass says how many it read that way.
    plat="$(descriptor_platform "$desc" || true)"
    if [ -z "$plat" ]; then plat="$platform"; nodesc=$((nodesc + 1)); fi
    man="$(descriptor_manifest "$desc" || true)"
    unit="$image|$plat|${man:--}"
    if [ -z "${unit_seen[$unit]:-}" ]; then
      unit_seen[$unit]=1; units+=("$unit")
      u_image[$unit]="$image"; u_plat[$unit]="$plat"; u_man[$unit]="$man"
      u_label[$unit]="$label"
      u_tag[$unit]=""; u_pinned[$unit]="$man"
    elif [ -z "${u_label[$unit]:-}" ] && [ -n "$label" ]; then
      u_label[$unit]="$label"
    fi
    # The tag is read once per variant, on that variant's platform: the id the tests below judge, and the identity carried
    # forward as the pin. Reading it again later would pin whatever it names then, not what the container runs.
    [ "${config#sha256:}" = "$config" ] || continue
    [ -n "${u_tag[$unit]:-}" ] && [[ "${u_tag[$unit]}" < "$config" ]] && continue
    now="$(docker_call 5 image inspect --platform "$plat" -f '{{.Id}}' "$config" 2>/dev/null)"
    # The container's own descriptor is the authority when it has one: the tag counts only while it names that manifest.
    # The compose label is a second-best answer for a daemon that reports no descriptor, and the container's own id the
    # last one. A tag that matches neither must not take the running variant's findings under the tag's target.
    if [ -n "$man" ]; then
      [ "$now" = "$man" ] || continue
    elif [ -n "${u_label[$unit]:-}" ] && [ "$now" = "${u_label[$unit]}" ]; then
      :
    elif [ "$(docker_call 5 image inspect -f '{{.Id}}' "$config" 2>/dev/null)" = "$image" ]; then
      :
    else
      continue
    fi
    u_tag[$unit]="$config"
    [ -n "${u_pinned[$unit]:-}" ] || u_pinned[$unit]="$now"
  done <<< "$rows"
  [ "$nodesc" -eq 0 ] || echo "security-sbom: $nodesc container(s) report no platform manifest descriptor; read on the Docker server platform $platform" >&2
  p_key=(); p_pin=(); p_ref=(); p_plat=(); p_bytes=(); p_size=()
  # Every unit is resolved and sized first, before any bytes are written: a save is only worth making for a target whose
  # scan can be planned. The wave driver uses these sizes to decide which images go in this pass at all.
  for unit in "${units[@]}"; do
    image="${u_image[$unit]}"; plat="${u_plat[$unit]}"; man="${u_man[$unit]}"
    # The image the container runs: its tag while the tag still names what runs, else the platform manifest compose
    # recorded, else the container's own top-level id. The target stays `image:<container id>` when the tag has moved: the
    # store reconciles findings by target name, so keying the same image by its manifest id would leave the findings
    # already held under its id unverified beside the new ones.
    # The key is a function of the variant alone, never of which other variants happen to run: the platform the daemon
    # itself runs keeps the plain key (the tag, or the image id), and a variant on any other platform is always suffixed
    # with its platform. Counting the variants first would rename a target the moment a second one appeared (an emulated
    # container running alone is plain, then `@<platform>` once its own platform's container starts), and findings
    # reconcile by exact target name, so the rename alone would leave the old name's findings unverified.
    if [ "$plat" = "$platform" ]; then key="${u_tag[$unit]:-$image}"
    elif [ -n "${u_tag[$unit]:-}" ]; then key="${u_tag[$unit]}@${plat}"
    else key="${man:-$image}@${plat}"; fi
    want="${u_tag[$unit]:-${u_label[$unit]:-$image}}"
    # The platform manifest this target stands for: the container's own descriptor, the identity the tag check proved,
    # else what compose recorded, else `pin_of` resolving the container's index on the container's own platform. Never a
    # fresh read of the tag, which another pull could have moved since the check.
    pin="${u_pinned[$unit]:-${u_man[$unit]:-}}"
    [ -n "$pin" ] || pin="$(pin_of "$want" "$plat")"
    [ -n "$pin" ] || pin="$want"
    # The reference the save will read, resolved now, while the lock still holds the store still. Discovering it here, not
    # after the size checks, is what lets an image whose own id is gone but whose index another tag holds still be
    # exported instead of dropped as unreadable.
    if ! ref="$(resolve_ref "$pin" "$image" "$plat")"; then
      fail "image:$key" "docker save: no local image exports $want"; continue
    fi
    # Size the very variant the save will write, through the very reference it will read: `docker image inspect` on an
    # index reports the index's total, while `docker save --platform` writes one platform manifest. A plain save (no
    # `--platform` on this daemon) writes everything the reference holds, so the whole reference is what must fit; the
    # archive is then checked for one manifest, and one that holds several is a line rather than an unscanned variant.
    raw=""; saved=""
    if [ "$save_platform" = 0 ]; then
      if raw="$(docker_call 5 image inspect -f '{{.Size}}' "$ref" 2>&1)"; then saved=1; fi
    else
      if raw="$(docker_call 5 image inspect --platform "$plat" -f '{{.Size}}' "$ref" 2>&1)"; then saved=1; fi
    fi
    if [ -z "$saved" ] && raw="$(docker_call 5 image inspect -f '{{.Size}}' "$ref" 2>&1)"; then saved=1; fi
    if [ -z "$saved" ]; then
      fail "image:$key" "docker image inspect: ${raw:-failed}"; continue
    fi
    # The template prints one number; a warning ahead of it is not the size, so the last line is what is judged. A size
    # nothing answers is unknown, not zero: an unknown demand can't be judged to fit, so the target is recorded.
    size="$(printf '%s\n' "$raw" | tail -1)"
    if [[ ! "$size" =~ ^[0-9]+$ ]]; then
      fail "image:$key" "docker image inspect: no size ('$(printf '%s' "$raw" | tr '\t\n' '  ' | tail -c 100)')"; continue
    fi
    p_key+=("$key"); p_pin+=("$pin"); p_ref+=("$ref"); p_plat+=("$plat"); p_bytes+=("$size"); p_size+=("$(ceil_gb "$size")")
  done
  # Cut the surveyed set into waves, smallest first, each wave admitted only while its peak fits above the floor. A
  # wave's peak is all of its archives on disk at the first scan plus the largest one's own size again, unpacked beside
  # them; later scans have their predecessors' archives deleted, so those peaks are lower. Every wave is a separate lock
  # hold: its saves happen under the lock, its scans after the lock is released and before the next wave's saves, so the
  # archives of two waves are never resident together. This is what makes a set whose whole archive total plus its
  # largest does not fit (every running image's set at 2026-11-23's sizes) still get every image inventoried instead of
  # dropping its largest on every pass. An image that cannot fit even alone (its archive held for its own scan plus its
  # own size to unpack it, twice over) never fits any wave: that one is a line stating the numbers.
  local room_bytes=$(( $(free_bytes) - min_free_gb * 1073741824 ))
  [ "$room_bytes" -lt 0 ] && room_bytes=0
  local room="$(ceil_gb "$room_bytes")"
  local idx sz szb wave wave_total wave_biggest
  wave_of=(); wave=0; wave_total=0; wave_biggest=0; wave_count=0
  # NB: the loop body runs in this shell only if the loop itself is not at the end of a pipeline; the sizes come from a
  # process substitution so `wave_of` persists for the save pass. Admission is in bytes: a gigabyte rounded up here would
  # reject an image whose archive and workspace do fit above the floor, and the byte-exact save would never be tried.
  while IFS=$'\t' read -r szb idx; do
    [ -n "$idx" ] || continue
    sz="$(ceil_gb "$szb")"
    # An image held only for its own scan still needs its own size again to unpack it, so twice its size must fit above
    # the floor or no wave can ever take it. It is a line now, with the numbers, and no bytes are written for it.
    if [ $(( 2 * szb )) -gt "$room_bytes" ]; then
      fail "image:${p_key[$idx]}" "skipped: ${sz} GB image does not fit: $(space_need 0 "$sz" "$sz" "$room")"
      continue
    fi
    if [ "$wave" -eq 0 ] || [ $(( wave_total + szb + (szb > wave_biggest ? szb : wave_biggest) )) -gt "$room_bytes" ]; then
      # Does not fit where the wave stands. Ascending order means no later (larger) image fits there either, so the wave
      # is closed.
      wave=$((wave + 1)); wave_count="$wave"; wave_total=0; wave_biggest=0
    fi
    wave_of[$idx]="$wave"; wave_total=$(( wave_total + szb )); [ "$szb" -gt "$wave_biggest" ] && wave_biggest="$szb"
  done < <(for i in "${!p_bytes[@]}"; do printf '%s\t%s\n' "${p_bytes[$i]}" "$i"; done | sort -n)
  # A deferral (a save or scan that the pass's own archives crowded out) moves an image to one wave past the last one
  # planned. The cap keeps a pathological set from looping: past it the image is a line instead of a new wave.
  wave_limit=$(( wave_count + ${#p_bytes[@]} + 1 ))
  return 0
}
# Give a surveyed image one more wave, after the last planned one: something the pass itself wrote makes it not fit now,
# and the bytes come back when those archives are scanned and deleted. Returns 1 once the pass has spent its deferral cap:
# then the image is a line instead, so a set that can never fit cannot make the driver loop. <why> is the line's numbers.
defer_to_next_wave() { # <survey idx> <why>
  local idx="$1" why="$2"
  if [ "$wave_count" -ge "$wave_limit" ]; then return 1; fi
  wave_of[$idx]=$((wave_count + 1)); wave_count=$((wave_count + 1))
  echo "security-sbom: image:${p_key[$idx]} deferred to wave ${wave_of[$idx]}: $why" >&2
  return 0
}
# Save one wave's archives, smallest first, with the apply lock held. Exports run smallest first because the snapshot
# deadline is spent on them: a save that runs out the budget must not be the one that takes every smaller archive down
# with it. Every archive is written from the reference the survey resolved, re-checked at save time; each failure is a
# line, never a gap.
save_wave() { # <wave>
  local w="$1" idx sz szb key pin ref plat archive top top_gb avail_now why written=0 written_big=0
  local floor_bytes=$(( min_free_gb * 1073741824 ))
  while IFS=$'\t' read -r szb idx; do
    [ -n "$idx" ] || continue
    [ "${wave_of[$idx]:-0}" = "$w" ] || continue
    key="${p_key[$idx]}"; pin="${p_pin[$idx]}"; ref="${p_ref[$idx]}"; plat="${p_plat[$idx]}"; sz="${p_size[$idx]}"
    # Free space is read again with this wave's archives already written: `free` already has those bytes subtracted, but
    # another writer on the same filesystem can have taken room since. Judge what this save still needs above it: its own
    # archive plus its own workspace, or the wave's largest workspace if that is bigger. Checking only this archive's size
    # would let a save land that the wave's peak could not then unpack; charging the written archives again would reject
    # a save the disk has room for. Below the floor the room is negative and must stay so: clamping it to 0 would let a
    # free image save while the disk is already under the floor.
    avail_now=$(( $(free_bytes) - floor_bytes ))
    top=$(( szb > written_big ? szb : written_big )); top_gb="$(ceil_gb "$top")"
    # Bytes throughout, and only the line's numbers rounded: rounding a size up here could refuse a save that fits, and
    # the request's sizes come from the daemon in bytes anyway.
    if [ $(( szb + top )) -gt "$avail_now" ]; then
      why="$(space_need "$(ceil_gb "$written")" "$sz" "$top_gb" "$(ceil_gb "$avail_now")" $(( (szb + top - avail_now + 1073741823) / 1073741824 )))"
      # This wave's own archives are held in `free` already, so a save that no longer fits may only be waiting on them.
      # Once this wave is scanned those bytes come back: give the image a wave of its own after this one instead of
      # recording a skip that would repeat on every pass. With nothing written yet the disk itself lacks the room (or
      # another writer took it), and the same check would fail again, so that one is a line.
      if [ "$written" -gt 0 ] && defer_to_next_wave "$idx" "$why"; then
        continue
      fi
      fail "image:$key" "skipped: ${sz} GB image does not fit: $why"
      continue
    fi
    # Exported now, under the lock, from the reference resolved by the survey: the archive holds exactly what runs, and
    # nothing that moves after this lock is released can change it. The scan only re-opens archives.
    archive="$archives/$((archive_seq += 1)).tar"
    if export_image "$pin" "$ref" "$archive" "$plat"; then
      plan_add "image:$key" "archive:$archive" "$pin" "$ref" "$sz" "$idx"
      written=$(( written + szb )); [ "$szb" -gt "$written_big" ] && written_big="$szb"
    else
      fail "image:$key" "docker save: ${export_err:-failed}"
    fi
  done < <(for i in "${!p_bytes[@]}"; do [ "${wave_of[$i]:-0}" = "$w" ] && printf '%s\t%s\n' "${p_bytes[$i]}" "$i"; done | sort -n)
  return 0
}
# Scan one wave's archives, largest first, and delete each as its scan ends. At the first scan every archive of the wave
# is on disk and this image is unpacked beside them; each later scan has fewer archives waiting. An archive is scanned
# only when its own size fits the room left above the floor beside the ones still held (the others are named in a line
# but never charged twice). A round that scans nothing means the archives themselves now exceed the room — their real
# bytes can be a little larger than the size the plan saw — so the smallest remaining one is a line and its bytes go back,
# giving the rest its room for the next round. That keeps every image the disk can hold and drops the cheapest one,
# rather than skipping the largest on every pass. An archive that is gone, or that cannot fit even alone, is a line too.
# Its bytes go back before the next target, and the line states the admitted total, its size, the largest archive, the
# room and the shortfall.
scan_wave() { # <first plan index>
  local first="$1" i k target archive avail_bytes size_gb remaining_bytes=0 room_bytes sz_bytes largest_bytes
  local floor_bytes=$(( min_free_gb * 1073741824 ))
  local -A bytes_of=() gb_of=()
  local -a pending=()
  if [ "${#plan_target[@]}" -le "$first" ]; then return 0; fi
  while IFS=$'\t' read -r _ i; do [ -n "$i" ] && pending+=("$i"); done \
    < <(for i in "${!plan_target[@]}"; do [ "$i" -ge "$first" ] && printf '%s\t%s\n' "${plan_size[$i]}" "$i"; done | sort -rn)
  for i in "${pending[@]}"; do
    archive="${plan_source[$i]#archive:}"
    sz_bytes="$(stat -c %s "$archive" 2>/dev/null || echo 0)"
    bytes_of[$i]="$sz_bytes"; gb_of[$i]="$(ceil_gb "$sz_bytes")"; remaining_bytes=$(( remaining_bytes + sz_bytes ))
  done
  while [ "${#pending[@]}" -gt 0 ]; do
    local -a rest=()
    for i in "${pending[@]}"; do
      target="${plan_target[$i]}"; archive="${plan_source[$i]#archive:}"; size_gb="${gb_of[$i]}"
      if [ ! -f "$archive" ]; then remaining_bytes=$(( remaining_bytes - bytes_of[$i] )); fail "$target" "docker save: its archive is gone"; continue; fi
      avail_bytes="$(free_bytes)"; room_bytes=$(( avail_bytes - floor_bytes ))
      if [ "$avail_bytes" -lt "$floor_bytes" ] || [ "${bytes_of[$i]}" -gt "$room_bytes" ]; then rest+=("$i"); continue; fi
      scan "$target" "" -v "$archive:/image.tar:ro" -- "docker-archive:/image.tar"
      rm -f "$archive"; remaining_bytes=$(( remaining_bytes - bytes_of[$i] ))
    done
    # A round that scanned nothing: the archives themselves now exceed the room (their real bytes are the sizes read
    # here, not the plan's). The capacity is the room the wave began with plus everything still held; deleting an archive
    # does not change it, because every byte a deletion frees was already in `remaining_bytes`, so re-reading the free
    # space would count it twice. Bytes throughout: a gigabyte rounded either way here can drop an image the disk can
    # hold, and only the line's numbers are rounded.
    if [ "${#rest[@]}" -eq "${#pending[@]}" ]; then
      local -a keep=()
      local kk drop="" drop_bytes=0 largest_bytes=0 avail_now room_now capacity
      avail_now="$(free_bytes)"; capacity=$(( avail_now - floor_bytes + remaining_bytes ))
      local largest_gb=0
      for k in "${rest[@]}"; do [ "${bytes_of[$k]}" -gt "$largest_bytes" ] && largest_bytes="${bytes_of[$k]}"; done
      largest_gb="$(ceil_gb "$largest_bytes")"
      # First drop every archive no round can scan (its own bytes twice over exceed the capacity): giving it room would
      # only crowd out an image that can. This runs before any viable archive is considered, so a wave that starts below
      # the floor still keeps its scannable images.
      for k in "${rest[@]}"; do
        if [ $(( 2 * bytes_of[$k] )) -gt "$capacity" ]; then
          i="$k"; target="${plan_target[$i]}"; archive="${plan_source[$i]#archive:}"; size_gb="${gb_of[$k]}"
          room_now=$(( $(free_bytes) - floor_bytes )); [ "$room_now" -lt 0 ] && room_now=0
          fail "$target" "skipped: ${size_gb} GB image does not fit: $(space_need "$(ceil_gb $(( remaining_bytes - bytes_of[$i] )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (2 * bytes_of[$i] - capacity + 1073741823) / 1073741824 )))"
          rm -f "$archive"; remaining_bytes=$(( remaining_bytes - bytes_of[$i] )); continue
        fi
        keep+=("$k")
      done
      if [ "${#keep[@]}" -eq "${#rest[@]}" ]; then
        # All could scan alone, so the others still held are what block them: take the smallest out, so the rest get the
        # most room, and retry them. Its bytes come back here and it is saved again in a later wave, after this wave's
        # archives are gone: skipping it for the whole pass would drop the same image on every pass. Once the pass has
        # spent its deferral cap (a set that keeps trading archives for room), it is a line with the numbers.
        for kk in "${rest[@]}"; do
          if [ -z "$drop" ] || [ "${bytes_of[$kk]}" -lt "$drop_bytes" ]; then drop="$kk"; drop_bytes="${bytes_of[$kk]}"; fi
        done
        i="$drop"; target="${plan_target[$i]}"; archive="${plan_source[$i]#archive:}"; size_gb="${gb_of[$i]}"
        room_now=$(( $(free_bytes) - floor_bytes )); [ "$room_now" -lt 0 ] && room_now=0
        # The survey index travels with the archive: two containers on different indexes can share one target name, so
        # looking the name up would defer (and re-export) the other one and leave this unit never retried.
        if [ -z "${plan_idx[$i]:-}" ] || ! defer_to_next_wave "${plan_idx[$i]}" "$(space_need "$(ceil_gb $(( remaining_bytes - drop_bytes )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (drop_bytes - room_now + 1073741823) / 1073741824 )))"; then
          fail "$target" "skipped: ${size_gb} GB image does not fit: $(space_need "$(ceil_gb $(( remaining_bytes - drop_bytes )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (drop_bytes - room_now + 1073741823) / 1073741824 )))"
        fi
        rm -f "$archive"; remaining_bytes=$(( remaining_bytes - drop_bytes ))
        local -a dropped=()
        for k in "${rest[@]}"; do [ "$k" = "$drop" ] || dropped+=("$k"); done
        keep=("${dropped[@]}")
      fi
      rest=("${keep[@]}")
    fi
    pending=("${rest[@]}")
  done
}
if ! snapshot; then
  exec 8>&-
  rm -rf "$next" "$work" "$archives"
  exit 0
fi
# The survey is done under the lock and fixed the target list. Each wave is saved under its own lock hold and scanned
# after the lock is released, before the next wave's saves: an apply waits only for one wave's saves, never for a scan,
# and two waves' archives are never resident together. The host target keeps its place at the head of the batch and runs
# with the apply lock free, as before.
first="${#plan_target[@]}"
save_wave 1
# What is left of the pass's one overall export budget, carried to the later waves so a set that needs many of them cannot
# add up to an apply waiting for hours. A pass whose budget is spent stops exporting and records the rest as lines.
export_left=$(( SNAPSHOT_DEADLINE - SECONDS ))
[ "$export_left" -lt 0 ] && export_left=0
SNAPSHOT_DEADLINE=""
exec 8>&-
scan host "" -v /:/host:ro -- dir:/host "${host_args[@]}"
scan_wave "$first"
wave_no=2
while [ "$wave_no" -le "$wave_count" ]; do
  if [ "$export_left" -le 0 ]; then
    echo "security-sbom: the export budget is spent; the rest of the images are recorded unscanned" >&2
    break
  fi
  # A later wave takes the apply lock again for its saves, so those bytes are written on a consistent store too. A pass
  # that cannot get the lock now keeps what it has, and every image it did not reach is a line rather than a gap.
  exec 8>>"$APPLY_LOCK"
  if ! flock -n 8; then
    echo "security-sbom: an apply took the apply lock between waves; the rest of the images are recorded unscanned" >&2
    exec 8>&-
    break
  fi
  SNAPSHOT_DEADLINE=$((SECONDS + export_left))
  first="${#plan_target[@]}"
  save_wave "$wave_no"
  export_left=$(( SNAPSHOT_DEADLINE - SECONDS ))
  [ "$export_left" -lt 0 ] && export_left=0
  SNAPSHOT_DEADLINE=""
  exec 8>&-
  scan_wave "$first"
  wave_no=$((wave_no + 1))
done
# An image only ever left for a later wave is placed by its index; a wave that did not run (the lock was lost) leaves its
# images without a row. They are lines saying so, never a silent gap in the batch.
for idx in "${!p_size[@]}"; do
  [ "${wave_of[$idx]:-0}" -gt 0 ] || continue
  [ "${wave_of[$idx]}" -lt "$wave_no" ] && continue
  fail "image:${p_key[$idx]}" "skipped: not reached: this wave's export did not start (the pass's export budget was spent or an apply took the apply lock)"
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
