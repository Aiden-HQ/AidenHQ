#!/usr/bin/env bash
# The security module's inventory (modules/security): daily from aidenhq-security-sbom.timer (a user timer), or by hand.
# Runs pinned syft in a throwaway container (no network, as this user) over:
#   host            the VM's root filesystem, read-only: OS packages (kernel, Docker, Node...), not Docker's own storage,
#                   the homes or this instance's own checkouts (see HOST_EXCLUDES)
#   image:<ref>     every image a running container uses, by the reference it was created with while that still resolves to
#                   its running image (the Docker socket, read-only mount): the tag's platform manifest, which compose
#                   records on the container, or on a daemon whose image id is the content id the top-level id
#   image:sha256:<id> an image whose container's tag has moved since creation: the running image itself, saved from Docker and
#                   scanned offline, so the scan follows what runs rather than whatever the tag names today. The platform
#                   manifest compose records on the container is used when the container's top-level id is gone; an id the
#                   daemon no longer holds is a line saying so, never a silent gap in the batch
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
mkdir -p "$next" "$work"
: > "$next/targets.tsv"
user="$(id -u):$(id -g)"
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
# Containers without the label, and daemons where the top-level id is the content id, are compared by that id. Any other
# container's image is named by its own id, which is stable across passes, and syft reads it from a `docker save` archive.
# A container whose tag has moved but which carries `com.docker.compose.image` is scanned from that platform manifest:
# it is the image the container actually runs, and the top-level id `.Image` may already be gone. An image nothing can
# read -- the store collected the id, the save failed, a daemon that won't answer -- is a line naming the id and the
# error, so a short batch never looks like a complete one. A name only counts when it isn't an image id itself: syft
# can't resolve a bare id, it would try to pull it. The enumeration and the inspect/save calls run under the host's
# apply lock: between `docker compose build` and the recreate an apply leaves every rebuilt tag naming the new image
# while its container still runs the old one, and a batch enumerated there is a half-applied snapshot.
fail() { # <target> <error>: a target that never reached syft is a line with its error, like a failed scan
  n=$((n + 1))
  printf '%s\t-\t%s\t\n' "$1" "$(printf '%s' "$2" | tr '\t\n' '  ' | tail -c 300)" >> "$next/targets.tsv"
}
# The apply lock is data/apply.lock at a fixed path from this checkout root (ops/lib/apply-lock.sh); it is not the
# data dir's .lock above, and not AIDENHQ_DATA_DIR, because ops/apply-config.sh opens exactly this file. Non-blocking:
# while an apply holds it a batch would be a mid-apply snapshot, so it leaves current/ alone and skips, and the scanner
# re-reads the previous complete batch. Only the container enumeration and the target list it decides run under it;
# the scans do not, so an apply never waits on a forty-minute pass.
# fd 9 is this pass's own .lock above, so the apply lock is taken on fd 8.
# shellcheck source=ops/lib/apply-lock.sh
. ops/lib/apply-lock.sh
mkdir -p "$(dirname "$APPLY_LOCK")"
exec 8>>"$APPLY_LOCK"
if ! flock -n 8; then
  echo "security-sbom: an apply holds the apply lock; skipping this pass" >&2
  rm -rf "$next" "$work"
  exit 0
fi
declare -A running=() tags=() manifests=()
while read -r cid image config label; do
  [ -n "$cid" ] || continue
  case "$config" in *anchore/syft*) continue ;; esac
  running[$image]=1
  if [ -n "$label" ]; then : "${manifests[$image]:=$label}"; fi
  [ "${config#sha256:}" = "$config" ] || continue
  { [ -n "$label" ] && [ "$(docker image inspect --platform "$platform" -f '{{.Id}}' "$config" 2>/dev/null)" = "$label" ]; } \
    || [ "$(docker image inspect -f '{{.Id}}' "$config" 2>/dev/null)" = "$image" ] || continue
  { [ -z "${tags[$image]:-}" ] || [[ "$config" < "${tags[$image]}" ]]; } || continue
  tags[$image]="$config"
done <<< "$(docker ps -q | xargs -r docker inspect -f '{{.Id}} {{.Image}} {{.Config.Image}} {{with index .Config.Labels "com.docker.compose.image"}}{{.}}{{end}}' 2>/dev/null)"
# The image targets, decided from that one enumeration while the apply lock is still held: the tag while it still names
# what the container runs, else the platform manifest compose recorded on it, else the container's own top-level id. The
# size inspect and the `docker save` run here too, so the image the batch will scan is the one the containers were
# running. Only the syft scans run after the lock is released: an apply never waits on a forty-minute pass. Every image
# is a target in the plan or a line saying why it can't be.
mkdir -p "$archives"
plan_kind=(); plan_target=(); plan_arg=()
plan_add() { plan_kind+=("$1"); plan_target+=("$2"); plan_arg+=("$3"); }
archives_n=0
for image in $(printf '%s\n' "${!running[@]}" | sort); do
  # The images to try, in the order the container's image is known best: the configured tag while it still names what
  # the container runs, then the platform manifest compose recorded on it, then the container's own top-level id. A tag
  # that moved names a different image; the manifest is what the container actually runs even when that top-level id is
  # already collected. Only a candidate the daemon answers a size for is scanned, so the target is an image it holds.
  tag="${tags[$image]:-}"
  cands=()
  if [ -n "$tag" ]; then cands+=("$tag"); fi
  if [ -n "${manifests[$image]:-}" ] && [ "${manifests[$image]:-}" != "$tag" ]; then cands+=("${manifests[$image]}"); fi
  if [ "$image" != "$tag" ] && [ "$image" != "${manifests[$image]:-}" ]; then cands+=("$image"); fi
  # A tag that doesn't resolve has moved since the container was created, so the image is read from the platform
  # manifest or the container's own id. A daemon that fails any other way is a line with its error, not a fallback:
  # "No such image" is the only answer that means the image is not there to read.
  ref=""; raw=""; err=""; have=""
  for cand in "${cands[@]}"; do
    ref="$cand"
    if raw="$(docker image inspect -f '{{.Size}}' "$cand" 2>&1)"; then have=1; break; fi
    err="$raw"
    [[ "$raw" == *"No such image"* ]] || break
  done
  if [ -z "$have" ]; then
    plan_add fail "image:$ref" "docker image inspect: ${err:-failed}"
    continue
  fi
  # What one image costs: syft's daemon source runs its own `docker save` and unpacks every layer into $work, and the
  # archive source does the same over the tar this script saved. Either way the target needs about twice the image's size,
  # so an image that doesn't fit in half the room above the floor is refused up front rather than as a full disk mid-scan.
  # A size the daemon won't give is unknown, not zero: an unknown demand can't be judged to fit. A target that can't be
  # read or can't fit is a line naming it and the reason, never a silent gap in the batch. The template prints one
  # number; a warning ahead of it is not the size, so the last line is what is judged.
  size="$(printf '%s\n' "$raw" | tail -1)"
  if [[ ! "$size" =~ ^[0-9]+$ ]]; then
    plan_add fail "image:$ref" "docker image inspect: no size ('$(printf '%s' "$raw" | tr '\t\n' '  ' | tail -c 100)')"
    continue
  fi
  size_gb=$(( (size + 1073741823) / 1073741824 ))
  room_gb=$(( $(free_gb) - min_free_gb ))
  if [ "$room_gb" -ge 0 ] && [ "$size_gb" -gt $(( room_gb / 2 )) ]; then
    plan_add fail "image:$ref" "skipped: ${size_gb} GB image needs more than half the ${room_gb} GB of room above the ${min_free_gb} GB floor on $out"
  elif [ -n "$tag" ]; then
    plan_add tag "image:$ref" "$ref"
  elif err="$(docker save -o "$archives/$archives_n.tar" "$ref" 2>&1)"; then
    # The archive lands under $out, not $work, which each scan empties; it is removed once its scan finishes.
    plan_add archive "image:$ref" "$archives/$archives_n.tar"
    archives_n=$((archives_n + 1))
  else
    # The store can collect an image between the size inspect and the save. That is still a running container's image,
    # so it is a line naming the id and the error, never a silent gap; the pass carries on with the other targets.
    plan_add fail "image:$ref" "docker save: ${err:-failed}"
  fi
done
# From here the target list is fixed; let an apply run and scan. The archives are the images enumerated under the lock.
exec 8>&-
scan host "" -v /:/host:ro -- dir:/host "${host_args[@]}"
for i in "${!plan_kind[@]}"; do
  case "${plan_kind[$i]}" in
    tag) scan "${plan_target[$i]}" "" -v /var/run/docker.sock:/var/run/docker.sock:ro -- "docker:${plan_arg[$i]}" ;;
    archive) scan "${plan_target[$i]}" "" -v "${plan_arg[$i]}:/image.tar:ro" -- "docker-archive:/image.tar"; rm -f "${plan_arg[$i]}" ;;
    fail) fail "${plan_target[$i]}" "${plan_arg[$i]}" ;;
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
