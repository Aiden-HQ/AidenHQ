#!/usr/bin/env bash
# The security module's inventory (modules/security): daily from aidenhq-security-sbom.timer (a user timer), or by hand.
# Runs pinned syft in a throwaway container (no network, as this user) over:
#   host            the VM's root filesystem, read-only: OS packages (kernel, Docker, Node...), not Docker's own storage,
#                   the homes or this instance's own checkouts (see HOST_EXCLUDES)
#   image:<ref>     every image a running container uses, plus every image config/computers.json names: a job box is
#                   ephemeral, so the fleet's current computer image runs nowhere most passes, and only the config says it
#                   is in scope. A container's image is the reference it was created with while the tag still names what
#                   runs, else the container's own id (findings reconcile by target name); a configured tag that resolves
#                   to an image a container already runs is that container's target, not a second row. Each is saved from
#                   Docker under the apply lock, from the reference the lock resolved, and read as a docker archive, so the
#                   scan follows what runs rather than whatever a tag names by the time syft opens it. An image nothing
#                   local can export is a line saying so, never a silent gap in the batch. A running container whose
#                   image the daemon no longer holds as an image record (untagged and collected while the container kept
#                   running) is inventoried from the container's own filesystem instead: `docker export`, extracted in
#                   this pass's private directory, scanned as a directory under the same image:<id> target. That scan is
#                   the container's root filesystem, not proof about the missing image, so its row has no error and its
#                   commit column names the container it came from. Without a readable config/computers.json the pass
#                   publishes no batch at all: an inventory missing every configured image must not read as a complete
#                   pass
#   repo:product    this checkout (lockfiles; not data/, node_modules or .git)
#   repo:instance   the instance checkout
#   app:<name>      each app's deployed source (data/apps/.platform/<name>/src, what apps-mcp checked out); a checkout
#                   that resolves anywhere else is a line saying so, never a scan of another tree under the app's name
# It runs here, not in the scanner, because these need the Docker socket and the host's root filesystem, which the
# long-running scanner never gets. Output: <data>/modules/security/sbom/current/targets.tsv (target, file, error, commit)
# and one syft-json per target; the scanner (read-only mount) matches a new batch within the hour. commit is the checkout's
# git HEAD for repo:product, repo:instance and an app: checkout that is a repo of its own (empty otherwise, because an app
# checkout sits inside this one and git would answer with the product's HEAD), so a pass says which tree it read. One
# target failing is a line with its error, never the batch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; [ -f .env ] && . ./.env; set +a
SYFT="anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060"
out="${AIDENHQ_DATA_DIR:-$PWD/data}/modules/security/sbom"
# Remove a tree this pass wrote. Tar restores a container's own directory modes, so a read-only dependency tree (a Go
# module cache, say) leaves directories this user cannot unlink inside; a plain `rm -rf` would then fail under `set -e`
# and, worse, the next pass's first cleanup would fail the same way and leave the runtime data on disk. The owner can
# always chmod its own tree, so a failed removal is retried after granting owner write/search.
discard_tree() { # <dir>...
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    rm -rf "$d" 2>/dev/null && continue
    chmod -R u+rwX "$d" 2>/dev/null || true
    rm -rf "$d" 2>/dev/null || echo "security-sbom: could not remove $d" >&2
  done
}
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
# A running container whose image the daemon no longer holds as an image record is inventoried from `docker export`
# instead; its tar and extracted tree live only here. A container export can hold runtime data (a credential a process
# wrote into its own filesystem, say), so it is kept outside the directory the long-running security-scanner mounts at
# /sbom (modules/security/module.yaml), private to this user (mode 700) and removed with the pass: that service reads the
# finished batch only, never a raw export or the tree unpacked from it, and nothing stays in data/ after the swap.
exportdir="$(dirname "$out")/sbom-exports"
discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
mkdir -p "$next" "$work" "$archives"
mkdir -p -m 700 "$exportdir"
chmod 700 "$exportdir"
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
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
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
# Free space above the floor on the filesystem Docker writes its own scratch to (`docker info`'s Docker Root Dir, which the
# classic store stages a save's layers in). A save's bytes and the daemon's staging copy can sit on different volumes from
# `$out`, so the export is watched against both: whichever is closer to its floor stops it. Empty when the daemon does not
# answer, and the archive's own filesystem is all that can be judged then.
free_bytes_at() { # <dir>
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }'
}
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
# The pass's export directory is a sibling of $out, not below it, so excluding $out's own tree does not cover it: when
# AIDENHQ_DATA_DIR sits on another disk (/srv/aidenhq-data, say) the host scan can reach it, and a staged container root
# there would be attributed to the host. Both roots are excluded when they are under /.
host_excludes=("${HOST_EXCLUDES[@]}" "./${PWD#/}/**" "./${out#/}/**" '**/node_modules/**')
case "$exportdir" in "$PWD"/*) : ;; /*) host_excludes+=("./${exportdir#/}/**") ;; esac
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
# Whether a failed `docker image inspect` says the image record is gone, rather than that the daemon could not answer.
# Only a positive "no such image/object" is proof: a deadline (124) or a transport error is a retryable read, and a
# container export under that image's target would inventory something other than the target it names.
image_absent() { # <inspect output>
  case "$1" in
    *"No such image"*|*"No such object"*|*"no such image"*) return 0 ;;
  esac
  return 1
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
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
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
# The fleet's configured computer images (config/computers.json, which compile writes and ops/computer-images.sh builds;
# the apply compiles to the instance's config dir, so the one the services read is named by AIDENHQ_CONFIG_DIR): every tag
# under `.images`, one per line. A job box is ephemeral, so a configured image often runs in no container at
# snapshot time and only this file says it is in scope. Read through jq, which rejects an unreadable file, a document that
# is not JSON and a value that is not a string: any of those leaves the pass without a complete inventory, so it publishes
# no batch rather than a short one. The browser image is always built (ops/computer-images.sh) and always part of the fleet.
# Every entry must be a reference `docker image inspect` can resolve: `<repository>[:<tag>]`, no whitespace, no shell
# metacharacters. An invalid one is refused here rather than skipped, because the inventory would then be missing an image
# it cannot show is out of scope, and an absent target would read as retired.
if ! jq -e '(.images | type) == "object" and ([.images[] | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._/:@-]*$")] | all)' "${AIDENHQ_CONFIG_DIR:-config}/computers.json" >/dev/null 2>"$work/configured.err"; then
  echo "security-sbom: config/computers.json is missing, unreadable or names an image that is not a tag ($(tr '\t\n' '  ' < "$work/configured.err" | tail -c 200)); keeping the previous batch" >&2
  exec 8>&-
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
  exit 0
fi
if ! jq -r '.images | to_entries[] | .value' "${AIDENHQ_CONFIG_DIR:-config}/computers.json" > "$work/configured" 2>"$work/configured.err"; then
  echo "security-sbom: config/computers.json is missing or unreadable ($(tr '\t\n' '  ' < "$work/configured.err" | tail -c 200)); keeping the previous batch" >&2
  exec 8>&-
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
  exit 0
fi
if ! grep -q . "$work/configured"; then
  echo "security-sbom: config/computers.json names no image; keeping the previous batch" >&2
  exec 8>&-
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
  exit 0
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
# reference runs. A caller that gets the pin back for one of these has an unresolvable image when the size read on it also
# fails: see the container fallback in snapshot().
resolve_ref() { # <pin manifest> <container .Image> [platform]
  local pin="$1" image="$2" plat="${3:-$platform}" candidate out unsure=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    # An immutable id (the pin itself, or the container's index) that the daemon holds as an image record is the safest
    # export: it cannot move, and saving from it can't name another image. Only if none is held does a tag come into it.
    case "$candidate" in
      sha256:*)
        if out="$(docker_call 5 image inspect -f '{{.Id}}' "$candidate" 2>&1)"; then
          printf '%s\n' "$candidate"; return 0
        fi
        image_absent "$out" || unsure="$out"
        continue ;;
    esac
    # A tag: the id it names on the container's platform. A tag pin_of cannot read is asked once more keeping its error,
    # so one that did not answer (a timeout, a refused socket) is not mistaken for a tag that has moved off the image.
    if out="$(pin_of "$candidate" "$plat")" && [ -n "$out" ]; then
      [ "$out" = "$pin" ] && { printf '%s\n' "$candidate"; return 0; }
      continue
    fi
    if ! out="$(docker_call 5 image inspect -f '{{.Id}}' "$candidate" 2>&1)"; then image_absent "$out" || unsure="$out"; fi
  done < <(platform_refs "$pin" "$image")
  printf '%s\n' "$pin"
  # A probe that did not answer proves nothing about the image: it may be held, only the read timed out. The caller runs
  # this in a subshell, so the reason travels as the second line (the first is always the reference to try) instead of
  # through a variable.
  [ -n "$unsure" ] && printf '%s\n' "$(printf '%s' "$unsure" | tr '\t\n' '  ')"
  return 0
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
export_space=0
# A Docker call whose own writes may not exceed <bytes> (`ulimit -f`, in 512-byte blocks). The daemon's size estimate is
# not a bound, so an export is capped at the room it was admitted with: the kernel stops the write at the limit instead of
# letting it take the disk's floor, and the caller sees an ordinary failed save to record. `docker save -o` writes the
# archive in this process, so the limit is the archive's.
# Bash's `ulimit -f` counts 1024-byte blocks, so the cap is converted in KiB. A child stopped by the limit exits through
# SIGXFSZ (153 through a shell that reports it, 128+25), which is also how a save that hit the cap is told apart from a
# daemon error. Docker publishes `-o` output from its own temp file, so a capped save may leave no `$dest` at all: the
# signal, a destination at the cap, or the CLI's own file-too-large error all mean the same thing.
save_hit_cap() { # <rc> <dest> <err> <cap>
  local rc="$1" dest="$2" err="$3" cap="$4"
  [ "$rc" = 153 ] && return 0
  [ -n "$cap" ] && [ "$(stat -c %s "$dest" 2>/dev/null || echo 0)" -ge "$cap" ] && return 0
  case "$err" in *"file too large"*|*"File too large"*|*"no space left on device"*) return 0 ;; esac
  return 1
}
save_call() { # <cap bytes, empty for none> <secs> <docker args...>
  local cap="$1" secs="$2" rc floor_bytes pid docker_root; shift 2
  if [ -z "$cap" ]; then docker_call "$secs" "$@"; return; fi
  local limit="$secs"
  deadline_secs "$limit" >/dev/null || return 124
  floor_bytes=$(( min_free_gb * 1073741824 ))
  docker_root="$(docker_call 5 info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$docker_root" ] && [ -d "$docker_root" ] || docker_root=""
  # The budget is read again after that probe: a slow `docker info` must not hand the save time the pass no longer has.
  secs="$(deadline_secs "$limit")" || return 124
  # The file ceiling bounds the CLI's output, not what the daemon stages in its own temp dir while producing it (the
  # classic image store copies the layers first). Both count against a filesystem, so the export is watched too: if free
  # space on the archive's filesystem or the daemon's root falls to the floor while it runs, it is stopped. That protects
  # each reserve even when the estimate and the ceiling did not see the daemon's copy.
  ( ulimit -f "$(( (cap + 1023) / 1024 ))" 2>/dev/null || exit 1
    exec timeout "$secs" docker "$@" ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    if [ "$(free_bytes)" -lt "$floor_bytes" ] || { [ -n "$docker_root" ] && [ "$(free_bytes_at "$docker_root")" -lt "$floor_bytes" ]; }; then
      kill -TERM "$pid" 2>/dev/null; sleep 1; kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 137
    fi
  done
  wait "$pid"; rc=$?
  [ "$rc" -eq 153 ] || [ "$rc" -eq 152 ] && return 153
  [ "$rc" -eq 137 ] && return 137
  return "$rc"
}
export_image() { # <pin manifest> <ref> <dest tar> [platform] [max bytes]
  local pin="$1" ref="$2" dest="$3" plat="${4:-$platform}" cap="${5:-}"
  export_err=""; export_space=0
  # Re-read the reference on the container's platform before writing: a tag another pull moved, or an index whose
  # platform manifest changed, must not put a different image under this target. A bare platform manifest inside an index
  # is not an image record, so a reference the daemon does not hold plainly is the resolver's pin and the save decides.
  if [ "$ref" != "$pin" ] && docker_call 5 image inspect -f '{{.Id}}' "$ref" >/dev/null 2>&1; then
    if [ "$(pin_of "$ref" "$plat")" != "$pin" ]; then
      export_err="the reference moved during this pass; not scanning a different image"; return 1
    fi
  fi
  # Docker publishes `-o` output from a temp file of its own, in or beside the destination: a save killed at the cap may
  # leave that file behind, and nothing this script removes would reclaim it. Each save writes into a private staging
  # directory, removed whole on any failure, and only a complete archive is moved into place.
  local stage rc
  if ! stage="$(mktemp -d "${dest%/*}/.save.XXXXXX")" || [ -z "$stage" ]; then
    export_err="could not create a staging directory beside $dest"; return 1
  fi
  if [ "$save_platform" = 1 ]; then
    export_err="$(save_call "$cap" 900 image save --platform "$plat" -o "$stage/archive.tar" "$ref" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      save_hit_cap "$rc" "$stage/archive.tar" "$export_err" "$cap" && export_space=1
      [ "$rc" -eq 137 ] && export_space=1
      rm -rf "$stage"; return 1
    fi
    mv -f "$stage/archive.tar" "$dest" || { rm -rf "$stage"; export_err="could not move the archive into place"; return 1; }
    rm -rf "$stage"
  else
    # No platform selection on this daemon, and an id is no proof of one variant either: on the containerd store a
    # container's `.Image` is the top-level index, so a plain save of it writes every platform the index holds. The save
    # runs, and the archive decides: one manifest is the running image, more is a line, never a scan of variants.
    export_err="$(save_call "$cap" 900 image save -o "$stage/archive.tar" "$ref" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      save_hit_cap "$rc" "$stage/archive.tar" "$export_err" "$cap" && export_space=1
      [ "$rc" -eq 137 ] && export_space=1
      rm -rf "$stage"; return 1
    fi
    if ! plain_archive_single "$stage/archive.tar" "$pin"; then
      rm -rf "$stage"
      export_err="this daemon cannot select a platform to save, and $ref's archive does not hold exactly the running platform ($archive_err); not scanning it"
      return 1
    fi
    mv -f "$stage/archive.tar" "$dest" || { rm -rf "$stage"; export_err="could not move the archive into place"; return 1; }
    rm -rf "$stage"
  fi
  case "$ref" in
    sha256:*|*@sha256:*) export_err=""; return 0 ;;
  esac
  if [ "$(pin_of "$ref" "$plat")" = "$pin" ]; then export_err=""; return 0; fi
  rm -f "$dest"; export_err="the tag moved during this pass; not scanning a different image"; return 1
}
# A running container whose image record is gone is inventoried from its root filesystem. `docker export` writes an
# uncompressed tar of the container's whole filesystem, so the pass holds two copies of it (the tar and the extracted
# tree) in its private directory; both are removed as soon as the scan ends and with the pass. The write is bounded like
# an image save: under the apply lock, inside the snapshot deadline, capped at the room left above the floor, and stopped
# if free space falls to the floor while it runs. Returns 1 with export_err.
export_container() { # <container id> <dest tar> <cap bytes>
  local cid="$1" dest="$2" cap="$3" stage rc
  export_err=""; export_space=0
  if ! stage="$(mktemp -d "${dest%/*}/.export.XXXXXX")" || [ -z "$stage" ]; then
    export_err="could not create a staging directory beside $dest"; return 1
  fi
  chmod 700 "$stage" 2>/dev/null || true
  export_err="$(save_call "$cap" 900 export -o "$stage/rootfs.tar" "$cid" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    save_hit_cap "$rc" "$stage/rootfs.tar" "$export_err" "$cap" && export_space=1
    [ "$rc" -eq 137 ] && export_space=1
    [ "$rc" -eq 124 ] && export_err="the snapshot deadline reached during the container export"
    rm -rf "$stage"; return 1
  fi
  mv -f "$stage/rootfs.tar" "$dest" || { rm -rf "$stage"; export_err="could not move the container export into place"; return 1; }
  rm -rf "$stage"
  export_err=""
  return 0
}
# Run a command under the snapshot deadline, stopped if free space on the pass's filesystem or Docker's own root falls to
# the floor: extraction writes a second copy of a container's filesystem, which the tar's own cap does not cover.
run_watched() { # <secs> <cmd...>
  local limit="$1" secs rc floor_bytes pid docker_root; shift
  deadline_secs "$limit" >/dev/null || return 124
  floor_bytes=$(( min_free_gb * 1073741824 ))
  docker_root="$(docker_call 5 info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$docker_root" ] && [ -d "$docker_root" ] || docker_root=""
  # The budget is read again after that probe: a slow `docker info` must not hand the extraction time the pass no longer
  # has.
  secs="$(deadline_secs "$limit")" || return 124
  ( exec timeout "$secs" "$@" ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    if [ "$(free_bytes)" -lt "$floor_bytes" ] || { [ -n "$docker_root" ] && [ "$(free_bytes_at "$docker_root")" -lt "$floor_bytes" ]; }; then
      kill -TERM "$pid" 2>/dev/null; sleep 1; kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 137
    fi
  done
  wait "$pid"; rc=$?
  return "$rc"
}
# Fold one replica's extracted tree into the unit's merged root. A path the root does not hold is linked in at the
# container's own path; a path it holds with different content is linked under `<root>/.replicas[-N]/<cid>/<path>`, so one
# scan reads both replicas' files instead of one overwriting the other. A file identical on both sides is linked once.
# Returns 1 with export_err if the merge cannot be made.
# Whether two entries are the same thing: both symlinks with the same target, or both regular files with the same bytes.
same_entry() { # <a> <b>
  if [ -L "$1" ] || [ -L "$2" ]; then
    [ -L "$1" ] && [ -L "$2" ] && [ "$(readlink "$1" 2>/dev/null)" = "$(readlink "$2" 2>/dev/null)" ]
    return
  fi
  [ -f "$1" ] && [ -f "$2" ] && cmp -s "$1" "$2"
}
# Whether placing <rel> under <root> would run through something that is not a directory the merge itself made: a regular
# file one replica has where another has a directory, or a symlink. A symlink in an ancestor is never followed, even when
# it points somewhere inside the root: a container controls its own tree, so `app -> /home/<user>` in one replica and
# `app/.bash_profile` in another would otherwise write that file to the host instead of the staged root, and a link into
# another container's tree would put one target's files under another's. Such an entry is kept aside instead.
ancestor_blocked() { # <root> <rel>
  local root="$1" rel="$2" rest part acc="$1"
  case "$rel" in */*) rest="${rel%/*}" ;; *) return 1 ;; esac
  local oldifs="$IFS"; IFS='/'
  for part in $rest; do
    acc="$acc/$part"
    if [ -L "$acc" ]; then IFS="$oldifs"; return 0; fi
    if [ -e "$acc" ] && [ ! -d "$acc" ]; then IFS="$oldifs"; return 0; fi
  done
  IFS="$oldifs"
  return 1
}
# The directory conflicting entries are kept under. A container controls its own tree, so it can hold a `/.replicas` of its
# own (a link, a file, a directory of its own paths), and that one is the container's, not the pass's: the merged root is
# built fresh for every unit, so a name that already exists there came from a container, and the first free
# `.replicas`, `.replicas-2`, ... is the one this merge creates. Kept per root, so both replicas of one unit agree on it.
declare -A aside_for=()
pick_asideroot() { # <rootfs>: sets `asideroot`
  local rootfs="$1" k=1 cand
  asideroot="${aside_for[$rootfs]:-}"
  [ -n "$asideroot" ] && [ -d "$asideroot" ] && return 0
  while [ "$k" -le 20 ]; do
    if [ "$k" -eq 1 ]; then cand="$rootfs/.replicas"; else cand="$rootfs/.replicas-$k"; fi
    if [ ! -e "$cand" ] && [ ! -L "$cand" ] && mkdir -p -m 755 "$cand" 2>/dev/null; then
      asideroot="$cand"; aside_for[$rootfs]="$cand"; return 0
    fi
    k=$((k + 1))
  done
  return 1
}
# Link one entry into place: a symlink stays a symlink (its target is part of what the scan reads), a regular file is a
# hard link where that works and a copy where it does not (another filesystem, or a file with no link permission).
place_entry() { # <src> <dst>
  if [ -L "$1" ]; then ln -P "$1" "$2" 2>/dev/null || cp -a "$1" "$2" 2>/dev/null; return; fi
  ln "$1" "$2" 2>/dev/null || cp -a "$1" "$2" 2>/dev/null
}
# Fold one replica's extracted tree into the unit's merged root, bounded by the snapshot deadline (the apply lock is held
# while this runs, so it may not outlast the pass's own budget). A path the root does not hold is linked in at the
# container's own path; one it holds with different content goes under `<root>/.replicas[-N]/<cid>/<rel>`; one whose ancestor
# is a file, or a symlink the merge will not follow, goes there too. Symlinks are carried as symlinks, so a distro's
# `/etc/os-release -> ../usr/lib/os-release` and `/bin -> usr/bin` are where syft looks for them. Returns 1 with export_err.
merge_replica_root() { # <replica root> <merged root> <container id>
  local repodir="$1" rootfs="$2" cid="$3" f rel src dst keep n
  export_err=""
  # Sorted, so one replica's files always merge in the same order: a merge that failed halfway must not depend on the
  # order the filesystem happened to list a container's tree in.
  if ! ( cd "$repodir" && find . -mindepth 1 \( -type f -o -type l \) -print0 | LC_ALL=C sort -z ) > "$exportdir/merge-$cid.list" 2>/dev/null; then
    export_err="could not list the extracted root"; return 1
  fi
  while IFS= read -r -d '' f; do
    # The apply lock is held: one slow merge must not keep a deploy waiting past the pass's budget.
    if [ -n "${SNAPSHOT_DEADLINE:-}" ] && [ "$SECONDS" -ge "$SNAPSHOT_DEADLINE" ]; then
      rm -f "$exportdir/merge-$cid.list"
      export_err="the snapshot deadline reached while merging the replica roots"
      return 1
    fi
    rel="${f#./}"; src="$repodir/$rel"; dst="$rootfs/$rel"; keep=""
    if ancestor_blocked "$rootfs" "$rel"; then
      keep=1
    elif [ -e "$dst" ] || [ -L "$dst" ]; then
      same_entry "$src" "$dst" && continue
      keep=1
    fi
    if [ -n "$keep" ]; then
      # Chosen on the first conflict, not up front: a container's own `/.replicas` is merged before this is asked for, so
      # the holding directory never takes a name the merged root already holds.
      pick_asideroot "$rootfs" || { rm -f "$exportdir/merge-$cid.list"; export_err="could not create the replica holding directory"; return 1; }
      # A second conflicting version of the same path (two replicas, one already kept aside) gets its own suffix, and a
      # version whose own ancestors are a file or a link goes to the next suffix until one can hold it.
      n=1
      while :; do
        if [ "$n" -eq 1 ]; then dst="$asideroot/$cid/$rel"; else dst="$asideroot/$cid.$n/$rel"; fi
        if [ "$n" -gt 20 ]; then
          rm -f "$exportdir/merge-$cid.list"; export_err="could not place $rel"; return 1
        fi
        if ancestor_blocked "$rootfs" "${dst#"$rootfs"/}"; then n=$((n + 1)); continue; fi
        if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then break; fi
        same_entry "$src" "$dst" && break
        n=$((n + 1))
      done
      if [ -e "$dst" ] || [ -L "$dst" ]; then continue; fi
    fi
    mkdir -p "$(dirname "$dst")" 2>/dev/null || { rm -f "$exportdir/merge-$cid.list"; export_err="could not create $(dirname "$dst")"; return 1; }
    place_entry "$src" "$dst" || { rm -f "$exportdir/merge-$cid.list"; export_err="could not place $rel"; return 1; }
  done < "$exportdir/merge-$cid.list"
  rm -f "$exportdir/merge-$cid.list"
  # Directories no file lives in (an empty mount point) are not package evidence and are not needed by the scan.
  return 0
}
# Extract a container's exported tar into <dir> (mode 700, beside the tar). Returns 1 with export_err when the tar is
# unreadable, the tree does not fit above the floor, or the snapshot deadline is reached.
extract_container_root() { # <tar> <dir>
  local tar="$1" dir="$2" rc
  export_err=""; export_space=0
  if ! mkdir -p -m 700 "$dir" 2>/dev/null; then export_err="could not create the extracted root $dir"; return 1; fi
  chmod 700 "$dir" 2>/dev/null || true
  # The tree is about the tar's size; the extraction check happens before it starts, so a tar that cannot be unpacked
  # above the floor is a line rather than a full filesystem.
  if [ "$(free_bytes)" -lt $(( min_free_gb * 1073741824 + $(stat -c %s "$tar" 2>/dev/null || echo 0) )) ]; then
    export_space=1; export_err="the extracted root does not fit above the ${min_free_gb} GB floor"; return 1
  fi
  # The export holds the container's device nodes (`dev/null`, `dev/console`). This pass runs as an ordinary user, so it
  # cannot recreate them; they are not package evidence, and tar's walk of the rest of the tree is what the scan needs.
  # The exclusion is anchored: GNU tar matches an unanchored pattern at any depth, so `dev/*` alone would also drop a
  # nested `/opt/app/dev/...` (a dependency tree, say) and the row would claim a complete scan of a partial filesystem.
  # Sockets and fifos it cannot create are tolerated the same way, but a truncated or unreadable archive is not. `--mode`
  # keeps every directory owner-writable, so one the container had read-only (a Go module cache) can still be removed
  # beneath the floor the pass restores.
  local errf="${exportdir}/extract-$(basename "$dir").err"
  run_watched 900 tar --anchored --no-same-owner --mode='u+rwX' --exclude='dev' --exclude='./dev' --exclude='dev/*' --exclude='./dev/*' \
    -C "$dir" -xf "$tar" 2>"$errf"; rc=$?
  if [ "$rc" -eq 124 ]; then export_err="the snapshot deadline reached while extracting the container root"; return 1; fi
  if [ "$rc" -eq 137 ]; then export_space=1; export_err="extraction stopped: free space fell to the ${min_free_gb} GB floor"; return 1; fi
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'Unexpected EOF|truncated|Cannot open|Cannot read|not recoverable|Archive contains' "$errf" 2>/dev/null; then
      export_err="could not extract the container root: $(tr '\t\n' '  ' < "$errf" | tail -c 200)"
      return 1
    fi
    if grep -Eq 'Cannot mknod|Cannot create socket|Cannot create fifo|Cannot utime|Cannot change ownership|Operation not permitted' "$errf" 2>/dev/null; then
      echo "security-sbom: extracted the container root without its device nodes or sockets ($(tr '\t\n' '  ' < "$errf" | tail -c 200))" >&2
    else
      export_err="could not extract the container root (tar exited $rc)"
      return 1
    fi
  fi
  rm -f "$errf"
  return 0
}
# The batch's images, enumerated and sized from one snapshot of the containers, taken under the host's apply lock: between
# an apply's `docker compose build` and its recreate every rebuilt tag names the new image while its container still runs
# the old one, and a batch enumerated there is a half-applied snapshot. The survey fixes the target list and the waves;
# each wave's saves then happen under a lock hold and its scans after the lock is released (the driver below), so an apply
# waits only for one wave's saves. Returns 1 when the enumeration itself failed: the caller keeps the previous batch
# rather than publish a short one.
plan_target=(); plan_source=(); plan_pin=(); plan_ref=(); plan_size=(); plan_space=(); plan_idx=(); plan_cid=()
plan_add() { # <target> <source> <pin> <ref> <size GB> <survey idx> [workspace bytes] [container id]
  plan_target+=("$1"); plan_source+=("$2"); plan_pin+=("$3"); plan_ref+=("$4"); plan_size+=("${5:-0}")
  plan_idx+=("${6:-0}"); plan_space+=("${7:-0}"); plan_cid+=("${8:-}")
}
# The units this pass resolved and sized, indexed alike for the wave driver below. The sizes are known before any bytes
# are written; the driver decides each wave from them, so a later wave never needs to look at the daemon again for size.
p_key=(); p_pin=(); p_ref=(); p_plat=(); p_bytes=(); p_size=(); p_mode=(); p_cid=()
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
  local listing rows cid row image config desc label want key raw size ref resolved saved pin now mode
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
  local -A unit_seen=() u_image=() u_plat=() u_man=() u_tag=() u_label=() u_pinned=() u_cid=()
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
      u_tag[$unit]=""; u_pinned[$unit]="$man"; u_cid[$unit]="$cid"
    else
      if [ -z "${u_label[$unit]:-}" ] && [ -n "$label" ]; then u_label[$unit]="$label"; fi
      # Two containers can run one image variant (two replicas of a service). If the daemon no longer holds the image,
      # both filesystems are in production and each has to be exported: keep every id, not only the first container's.
      [[ " ${u_cid[$unit]:-} " == *" $cid "* ]] || u_cid[$unit]="${u_cid[$unit]:-} $cid"
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
  # Every configured computer image is a unit of its own, so one that no container runs is still inventoried. It is
  # resolved on the server platform (there is no container to say which variant is in play), and its pin is the image id
  # the tag names now, read once here like every other reference under the lock.
  local -A u_configured_tag=()
  # Whether a tag names the one platform manifest a configured image stands for, on the server platform: `pin_of` checks
  # that the tag resolves and that `docker image inspect --platform` reports that manifest for it, which a tag moved to
  # another build (or naming another variant) fails. Read once and kept, so the key decision below and the plan agree.
  local -A u_configured_pin=()
  # A configured tag is planned once, even if the file repeats it.
  local -A u_tag_seen=()
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    [ -z "${u_tag_seen[$tag]:-}" ] || continue
    u_tag_seen[$tag]=1
    pin_now="$(pin_of "$tag" "$platform")"
    u_configured_pin[$tag]="$pin_now"
    unit="$tag|$platform|-"
    [ -z "${unit_seen[$unit]:-}" ] || continue
    unit_seen[$unit]=1; units+=("$unit")
    u_image[$unit]="$pin_now"; u_plat[$unit]="$platform"; u_man[$unit]=""
    u_label[$unit]=""; u_tag[$unit]="$tag"; u_pinned[$unit]="$pin_now"; u_cid[$unit]=""
    u_configured_tag[$unit]=1
  done < "$work/configured"
  p_key=(); p_pin=(); p_ref=(); p_plat=(); p_bytes=(); p_size=(); p_mode=(); p_cid=()
  # Every unit is resolved and sized first, before any bytes are written: a save is only worth making for a target whose
  # scan can be planned. The wave driver uses these sizes to decide which images go in this pass at all. A unit's image
  # is its platform manifest, or the reference when the pin is unknown: two names for one image on one platform are one
  # unit, and container units come first, so a configured tag naming an image a container runs is planned once (the key
  # itself is decided below).
  local -A unit_pin=() unit_done=()
  # Units that get a row this pass: every one admitted to the plan, whether it scans or records its own error line.
  images_planned=0
  # The configured tag that names each image on each platform: the key a container running that image takes, and the key
  # the configured unit itself takes. Configuring is what makes a name stable, so a configured tag is read first and wins
  # over a container's own alias, and a container's tag names the images no configured tag names. A configured tag lands
  # here only when the tag resolving now reports the pin the configured unit recorded (a tag moved off it by another pull
  # names no known image and is not an alias).
  local -A u_alias=()
  for unit in "${units[@]}"; do
    [ -n "${u_configured_tag[$unit]:-}" ] || continue
    tag="${u_tag[$unit]}"; pin="${u_pinned[$unit]:-}"
    [ -n "$pin" ] && [ "${u_configured_pin[$tag]:-}" = "$pin" ] || continue
    [ -n "${u_alias["${u_plat[$unit]}|$pin"]:-}" ] || u_alias["${u_plat[$unit]}|$pin"]="$tag"
  done
  for unit in "${units[@]}"; do
    # A container's own tag is also a name for its image while the tag check above proved it names what runs.
    tag="${u_tag[$unit]:-}"; pin="${u_pinned[$unit]:-}"
    [ -n "$tag" ] && [ -n "$pin" ] || continue
    [ -n "${u_alias["${u_plat[$unit]}|$pin"]:-}" ] || u_alias["${u_plat[$unit]}|$pin"]="$tag"
  done
  for unit in "${units[@]}"; do
    if [ -z "${u_pinned[$unit]:-}" ]; then
      pin_now="$(pin_of "${u_tag[$unit]:-${u_label[$unit]:-${u_image[$unit]}}}" "${u_plat[$unit]}")"
      if [ -n "$pin_now" ]; then u_pinned[$unit]="$pin_now"; fi
    fi
    unit_pin[$unit]="${u_pinned[$unit]:-${u_image[$unit]}}"
  done
  for unit in "${units[@]}"; do
    image="${u_image[$unit]}"; plat="${u_plat[$unit]}"; man="${u_man[$unit]}"
    # The same image on the same platform is inventoried once: a configured tag that names what a container runs is that
    # container's unit, and two configured tags for one image are one unit, whichever of their keys came first.
    if [ -n "${unit_pin[$unit]}" ] && [ -n "${unit_done["$plat|${unit_pin[$unit]}"]:-}" ]; then continue; fi
    if [ -n "${unit_pin[$unit]}" ]; then unit_done["$plat|${unit_pin[$unit]}"]=1; fi
    images_planned=$((images_planned + 1))
    # The image the container runs: a configured tag that names the same image on the same platform (a fleet computer
    # image, whose browser render runs `computer-browser:current` for its hash build while the config names the hash),
    # else its own tag while the tag still names what runs, else the platform manifest compose recorded, else the
    # container's own top-level id. The configured name wins because it does not depend on a render running: keying the
    # same image by the container's own alias would flip the target's name each time a render started or stopped, and the
    # store reconciles findings by exact target name. For the same reason the target stays `image:<container id>` when the
    # tag has moved: keying the image by its manifest id instead would leave the findings already held under its id
    # unverified beside the new ones.
    # The key is a function of the variant alone, never of which other variants happen to run: the platform the daemon
    # itself runs keeps the plain key (the tag, or the image id), and a variant on any other platform is always suffixed
    # with its platform. Counting the variants first would rename a target the moment a second one appeared (an emulated
    # container running alone is plain, then `@<platform>` once its own platform's container starts), and findings
    # reconcile by exact target name, so the rename alone would leave the old name's findings unverified.
    if [ "$plat" = "$platform" ]; then key="${u_alias["$plat|${unit_pin[$unit]}"]:-${u_tag[$unit]:-$image}}"
    elif [ -n "${u_alias["$plat|${unit_pin[$unit]}"]:-}" ]; then key="${u_alias["$plat|${unit_pin[$unit]}"]}@${plat}"
    elif [ -n "${u_tag[$unit]:-}" ]; then key="${u_tag[$unit]}@${plat}"
    else key="${man:-$image}@${plat}"; fi
    want="${u_tag[$unit]:-${u_label[$unit]:-$image}}"
    # The platform manifest this target stands for: the container's own descriptor, the identity the tag check proved,
    # else what compose recorded, else `pin_of` resolving the container's index on the container's own platform. Never a
    # fresh read of the tag, which another pull could have moved since the check.
    pin="${u_pinned[$unit]:-${u_man[$unit]:-}}"
    [ -n "$pin" ] || pin="$(pin_of "$want" "$plat")"
    [ -n "$pin" ] || pin="$want"
    # A configured tag's image is whatever its pin names; it is never the tag itself, so a save can't hand back another
    # image the tag has moved to.
    if [ -n "${u_configured_tag[$unit]:-}" ] && [ -z "${u_pinned[$unit]:-}" ]; then
      fail "image:$key" "docker save: no local image is tagged $want"; continue
    fi
    # The reference the save will read, resolved now, while the lock still holds the store still. Discovering it here,
    # not after the size checks, is what lets an image whose own id is gone but whose index another tag holds still be
    # exported instead of dropped as unreadable.
    resolved="$(resolve_ref "$pin" "$image" "$plat")"
    ref="$(printf '%s\n' "$resolved" | head -1)"
    # A reference probe that timed out or was refused, as resolve_ref's second line reports it: see the fallback below.
    ref_unsure="$(printf '%s\n' "$resolved" | sed -n '2,$p' | tr '\t\n' '  ')"
    mode=image; cid=""
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
      # No reference resolved the image (`resolve_ref` fell back to the bare pin) and the daemon cannot even size it: the
      # image was untagged and collected while the container kept running. Its filesystem is in production and there is
      # nothing else to read, so a running container is inventoried from `docker export` under the same target. The image
      # path above runs unchanged whenever any reference answers, which is every image the daemon still holds.
      # Only the daemon's own "no such image" is that shape: a timeout (docker_call 124), a refused socket or a daemon
      # mid-restart leaves the image in place, and exporting a live container then would publish a filesystem scan under
      # the image's target — an inventory of the wrong thing that the absent-tag guards would read as a clean image. Those
      # stay the size-read error line, so the next pass retries the image.
      if [ -n "${ref_unsure:-}" ]; then
        # One of resolve_ref's probes timed out or was refused. That probe's candidate could be the image's own index still
        # held by the daemon, and the bare pin's "No such image" then says only that the manifest is not an image record of
        # its own. The container is exported only when every probe answered that nothing holds the image, so this stays an
        # error line and the next pass retries it.
        fail "image:$key" "docker image inspect: ${ref_unsure:-failed}"; continue
      fi
      if [ "$ref" = "$pin" ] && [ -n "${u_cid[$unit]:-}" ] && image_absent "$raw"; then
        mode=container
        # Every container on this variant is exported when the image is gone: two replicas are one unit and one target
        # key, so their roots are scanned together under that row. Their root filesystem sizes, where the daemon reports
        # them, are the demand the unit makes; one it cannot size leaves that part to the write's own cap.
        size=0
        for cid in ${u_cid[$unit]}; do
          raw="$(docker_call 15 inspect --size -f '{{.SizeRootFs}}' "$cid" 2>/dev/null || true)"
          raw="$(printf '%s\n' "$raw" | tail -1)"
          if [[ "$raw" =~ ^[0-9]+$ ]]; then size=$(( size + raw )); fi
        done
        p_key+=("$key"); p_pin+=("$pin"); p_ref+=(""); p_plat+=("$plat"); p_bytes+=("$size"); p_size+=("$(ceil_gb "$size")")
        p_mode+=("$mode"); p_cid+=("${u_cid[$unit]}")
        continue
      fi
      fail "image:$key" "docker image inspect: ${raw:-failed}"; continue
    fi
    # The template prints one number; a warning ahead of it is not the size, so the last line is what is judged. A size
    # nothing answers is unknown, not zero: an unknown demand can't be judged to fit, so the target is recorded.
    size="$(printf '%s\n' "$raw" | tail -1)"
    if [[ ! "$size" =~ ^[0-9]+$ ]]; then
      fail "image:$key" "docker image inspect: no size ('$(printf '%s' "$raw" | tr '\t\n' '  ' | tail -c 100)')"; continue
    fi
    p_key+=("$key"); p_pin+=("$pin"); p_ref+=("$ref"); p_plat+=("$plat"); p_bytes+=("$size"); p_size+=("$(ceil_gb "$size")")
    p_mode+=("$mode"); p_cid+=("")
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
  local idx sz szb wave wave_total wave_biggest what
  wave_of=(); wave=0; wave_total=0; wave_biggest=0; wave_count=0
  # NB: the loop body runs in this shell only if the loop itself is not at the end of a pipeline; the sizes come from a
  # process substitution so `wave_of` persists for the save pass. Admission is in bytes: a gigabyte rounded up here would
  # reject an image whose archive and workspace do fit above the floor, and the byte-exact save would never be tried.
  while IFS=$'\t' read -r szb idx; do
    [ -n "$idx" ] || continue
    sz="$(ceil_gb "$szb")"
    # An image held only for its own scan still needs its own size again to unpack it, so twice its size must fit above
    # the floor or no wave can ever take it. It is a line now, with the numbers, and no bytes are written for it: a write
    # spent on an image the pre-write estimate says cannot be scanned would itself take the reserve the pass protects.
    if [ $(( 2 * szb )) -gt "$room_bytes" ]; then
      # The shortfall comes from the bytes, not the rounded figures: 5 GiB against 9.5 GiB of room is short by 0.5 GiB,
      # and subtracting the two rounded numbers would print "short by 0 GB".
      what=image; [ "${p_mode[$idx]}" = container ] && what="container root filesystem"
      fail "image:${p_key[$idx]}" "skipped: ${sz} GB ${what} does not fit: $(space_need 0 "$sz" "$sz" "$room" $(( (2 * szb - room_bytes + 1073741823) / 1073741824 )))"
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
  defer_seen[$idx]=$(( ${defer_seen[$idx]:-0} + 1 ))
  echo "security-sbom: image:${p_key[$idx]} deferred to wave ${wave_of[$idx]}: $why" >&2
  return 0
}
# Whether an image was already deferred for space once: a shortfall seen with nothing of its own wave written may be
# another writer's temporary pressure, so it is retried once, not skipped on the first sight of it.
deferred_before() { [ "${defer_seen[$1]:-0}" -gt 0 ]; }
declare -A defer_seen=()
# Save one wave's archives, smallest first, with the apply lock held. Exports run smallest first because the snapshot
# deadline is spent on them: a save that runs out the budget must not be the one that takes every smaller archive down
# with it. Every archive is written from the reference the survey resolved, re-checked at save time; each failure is a
# line, never a gap.
save_wave() { # <wave>
  local w="$1" idx sz szb key pin ref plat archive root top top_gb avail_now why cap_bytes written=0 written_big=0
  local unitdir tarsdir rootfs replicasdir repodir cont_err cont_space cont_bytes cont_tars cid ctarchive ctbytes
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
      # recording a skip that would repeat on every pass. With nothing written yet it may be another writer's temporary
      # pressure, so that one is retried once too; only a second shortfall with nothing written is the disk's own state,
      # and it is a line.
      if { [ "$written" -gt 0 ] || ! deferred_before "$idx"; } && defer_to_next_wave "$idx" "$why"; then
        continue
      fi
      fail "image:$key" "skipped: ${sz} GB image does not fit: $why"
      continue
    fi
    # Exported now, under the lock, from the reference resolved by the survey: the archive holds exactly what runs, and
    # nothing that moves after this lock is released can change it. The scan only re-opens archives. The write is capped
    # at the room this save was admitted with, so the daemon's estimate being low can overrun the host's reserve by at
    # most nothing: a save that hits the cap is a refused write, and its file is removed below.
    archive_seq=$((archive_seq + 1))
    archive="$archives/$archive_seq.tar"
    cap_bytes=$(( $(free_bytes) - floor_bytes )); [ "$cap_bytes" -lt 0 ] && cap_bytes=0
    if [ "${p_mode[$idx]}" = container ]; then
      # No image record is left, so the containers' own root filesystems are what gets inventoried. One unit can hold
      # two containers running the same gone image (two replicas); each is exported, and their files are extracted into one
      # root, which is then scanned once under the unit's single target key. The root has to be a real container root:
      # syft looks for `/etc/os-release`, `/usr/lib` and the like at fixed paths relative to the scan root, so a root
      # holding one subdirectory per container would find package files by glob but report no distro, and grype would skip
      # that distro's advisory matching. Every write is bounded like a save: capped at the room above the floor, under this
      # wave's apply-lock hold and the snapshot deadline, with the floor watched while it runs. A container that cannot be
      # exported or extracted leaves the unit a line with its daemon error rather than a gap, and no half-built tree is
      # ever scanned.
      unitdir="$exportdir/unit-$archive_seq"; tarsdir="$unitdir.tars"; rootfs="$unitdir"
      replicasdir="$exportdir/unit-$archive_seq.replicas"
      cont_err=""; cont_space=0; cont_bytes=0; cont_tars=0
      # Each tar goes beside the root in `<unit>.tars`, and each replica's own tree in `<unit>.replicas`, so the scan never
      # reads an export's bytes a second time and never sees a replica's tree outside the merged root.
      if ! mkdir -p -m 700 "$rootfs" "$tarsdir" "$replicasdir" 2>/dev/null; then
        cont_err="could not create the private export directory $rootfs"
      else
        chmod 700 "$rootfs" "$tarsdir" "$replicasdir" 2>/dev/null || true
        for cid in ${p_cid[$idx]}; do
          ctarchive="$tarsdir/export-$cid.tar"
          cap_bytes=$(( $(free_bytes) - floor_bytes )); [ "$cap_bytes" -lt 0 ] && cap_bytes=0
          export_space=0
          if ! export_container "$cid" "$ctarchive" "$cap_bytes"; then
            if [ "$export_space" = 1 ]; then
              cont_space=1
              cont_err="container $cid's export outgrew the $(ceil_gb "$cap_bytes") GB above the ${min_free_gb} GB floor"
            else
              cont_err="container $cid: ${export_err:-failed}"
            fi
            break
          fi
          ctbytes="$(stat -c %s "$ctarchive" 2>/dev/null || echo 0)"
          if [ "$ctbytes" -gt "$cap_bytes" ] || [ "$(free_bytes)" -lt "$floor_bytes" ]; then
            cont_space=1
            cont_err="container $cid's export outgrew the $(ceil_gb "$cap_bytes") GB above the ${min_free_gb} GB floor"
            break
          fi
          cont_tars=$(( cont_tars + ctbytes ))
          # Extracted here, under the same apply-lock hold: the tree is a second write of the container's filesystem and
          # must not outlive the lock or the snapshot budget. The scan reads only the extracted root, after the lock is
          # released like every other scan. Each replica is extracted on its own first: two containers of one image can
          # each have modified the same path in their writable layer, and extracting one straight over the other would
          # lose whichever file came first, so the scan would miss that replica's packages while the row claimed both.
          repodir="$replicasdir/$cid"
          export_space=0
          if ! extract_container_root "$ctarchive" "$repodir"; then
            cont_err="container $cid: ${export_err:-failed to extract the container root}"
            [ "$export_space" = 1 ] && cont_space=1
            break
          fi
          # Merged into the one real root: a path the merged root does not hold yet is added there (so /etc, /usr and the
          # package files sit at the container's own paths for the first replica), and a path it already holds with other
          # content is kept under `<root>/.replicas[-N]/<id>/<path>` instead of being dropped, so the one scan still reads both
          # replicas' versions. Hard links keep the second copy from doubling the bytes.
          if ! merge_replica_root "$repodir" "$rootfs" "$cid"; then
            cont_err="container $cid: could not merge its root into the unit root (${export_err:-failed})"
            break
          fi
          discard_tree "$repodir"
          # Every tar written so far plus the merged root and whatever replica tree is still resident are charged: counting
          # only the root would let a later unit's extraction take room an earlier tar already holds, and the second
          # extraction would then hit the floor and be a line on every pass though each unit fits alone. The replica tree is
          # removed as soon as it is merged, so at most one is charged beside the root.
          cont_bytes=$(( cont_tars + $(du -sb "$rootfs" 2>/dev/null | awk '{ print $1 }' || echo 0) + $(du -sb "$replicasdir" 2>/dev/null | awk '{ print $1 }' || echo 0) ))
        done
      fi
      if [ -z "$cont_err" ]; then
        # The tar and the root stay until the scan ends; scan_wave removes the whole unit directory, tars included, so
        # neither outlives its scan.
        plan_add "image:$key" "$rootfs" "$pin" "$ref" "$sz" "$idx" "${p_bytes[$idx]}" "${p_cid[$idx]}"
        # Both copies are resident until the scan ends: every tar and the root unpacked from them (`cont_bytes` is both,
        # accumulated above). Charging only one would let a later save in this wave use room the other already holds.
        written=$(( written + cont_bytes )); [ "$cont_bytes" -gt "$written_big" ] && written_big="$cont_bytes"
      elif [ "$cont_space" = 1 ]; then
        discard_tree "$unitdir" "$tarsdir" "$replicasdir"
        why="skipped: the ${sz} GB container root filesystem does not fit: $cont_err"
        if { [ "$written" -gt 0 ] || ! deferred_before "$idx"; } && defer_to_next_wave "$idx" "$why"; then continue; fi
        fail "image:$key" "$why"
      else
        discard_tree "$unitdir" "$tarsdir" "$replicasdir"
        fail "image:$key" "docker export: $cont_err"
      fi
      continue
    fi
    if export_image "$pin" "$ref" "$archive" "$plat" "$cap_bytes"; then
      # The archive is measured, not estimated: a save can be larger than the image it holds, and the bytes it really
      # took are what the rest of the wave and the pass's end-of-day budget have to live with. The ceiling stops a real
      # write at the room; a save that still measured over it (a store that reserves a sparse file, say) is deleted here
      # so the host's reserve is never held by an archive this pass cannot scan.
      szb="$(stat -c %s "$archive" 2>/dev/null || echo "$szb")"
      if [ "$szb" -gt "$cap_bytes" ] || [ "$(free_bytes)" -lt "$floor_bytes" ]; then
        export_space=1
        rm -f "$archive"
        why="skipped: the ${sz} GB image's archive outgrew the $(ceil_gb "$cap_bytes") GB above the ${min_free_gb} GB floor (admitted $(ceil_gb "$written") GB of archives, largest archive $top_gb GB)"
        # Same policy as the pre-save and in-save checks: a first shortfall with nothing of the wave written may be
        # another writer's temporary pressure and is retried once; a second is the disk's own state.
        if { [ "$written" -gt 0 ] || ! deferred_before "$idx"; } && defer_to_next_wave "$idx" "$why"; then
          continue
        fi
        fail "image:$key" "$why"
        continue
      fi
      plan_add "image:$key" "archive:$archive" "$pin" "$ref" "$sz" "$idx" "${p_bytes[$idx]}"
      # The resident bytes are the archive's measured size; the workspace a scan needs is the image's own size, which an
      # archive of compressed layers can be much smaller than. Both are kept: a scan unpacks layers, not the tar.
      written=$(( written + szb )); [ "${p_bytes[$idx]}" -gt "$written_big" ] && written_big="${p_bytes[$idx]}"
    elif [ "$export_space" = 1 ]; then
      # The write was stopped at the cap: the archive needs more room than was left above the floor. With archives of this
      # wave already written, those bytes come back when the wave is scanned, so a later wave may still hold it: defer it
      # (bounded) rather than skipping it on every pass. With nothing written the disk itself is short, and a later wave
      # sees the same free space, so it is a line now. Either way the line names the numbers that decided it.
      why="skipped: the ${sz} GB image's archive outgrew the $(ceil_gb "$cap_bytes") GB above the ${min_free_gb} GB floor (admitted $(ceil_gb "$written") GB of archives, largest archive $top_gb GB)"
      # A space failure with nothing of this wave written may be another writer's temporary pressure, so it gets the same
      # one retry the pre-save check does; a second one is the disk's own state and a line.
      if { [ "$written" -gt 0 ] || ! deferred_before "$idx"; } && defer_to_next_wave "$idx" "$why"; then
        continue
      fi
      fail "image:$key" "$why"
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
# A planned source is an image archive or a container's extracted root: either is removed when its scan ends or it is
# dropped, so neither outlives the pass.
discard_plan_source() { # <archive file, extracted unit directory, or its tar directory>
  # A container unit's exported tars sit in `<unit>.tars` and each replica's own tree in `<unit>.replicas` beside the merged
  # root: the scan root must hold the merged root only, and all three go together when the scan ends (or the unit is
  # dropped), never at the end of the pass.
  [ -e "$1.tars" ] && discard_tree "$1.tars"
  [ -e "$1.replicas" ] && discard_tree "$1.replicas"
  if [ -d "$1" ]; then discard_tree "$1"; else rm -f "$1"; fi
}
scan_wave() { # <first plan index>
  local first="$1" i k target archive root avail_bytes size_gb remaining_bytes=0 room_bytes sz_bytes largest_bytes workspace
  local floor_bytes=$(( min_free_gb * 1073741824 ))
  local -A bytes_of=() gb_of=() space_of=()
  local -a pending=()
  if [ "${#plan_target[@]}" -le "$first" ]; then return 0; fi
  while IFS=$'\t' read -r _ i; do [ -n "$i" ] && pending+=("$i"); done \
    < <(for i in "${!plan_target[@]}"; do [ "$i" -ge "$first" ] && printf '%s\t%s\n' "${plan_size[$i]}" "$i"; done | sort -rn)
  for i in "${pending[@]}"; do
    archive="${plan_source[$i]#archive:}"
    if [ -n "${plan_cid[$i]:-}" ]; then
      # A container's extracted root is already on disk and syft reads it in place, so its resident bytes are the tree's
      # and there is no layer workspace to unpack beside it.
      sz_bytes="$(du -sb "$archive" 2>/dev/null | awk '{ print $1 }')"; [ -n "$sz_bytes" ] || sz_bytes="${plan_space[$i]}"
      bytes_of[$i]="$sz_bytes"; gb_of[$i]="$(ceil_gb "$sz_bytes")"; space_of[$i]=0
    else
      sz_bytes="$(stat -c %s "$archive" 2>/dev/null || echo 0)"
      # Resident bytes are the archive's; the workspace a scan unpacks is the image's own size, which a compressed archive
      # can be much smaller than. A scan must have room for both the archive and that workspace above the floor.
      bytes_of[$i]="$sz_bytes"; gb_of[$i]="$(ceil_gb "$sz_bytes")"; space_of[$i]="${plan_space[$i]}"
      [ "${space_of[$i]}" -gt 0 ] || space_of[$i]="$sz_bytes"
    fi
    remaining_bytes=$(( remaining_bytes + sz_bytes ))
  done
  while [ "${#pending[@]}" -gt 0 ]; do
    local -a rest=()
    for i in "${pending[@]}"; do
      target="${plan_target[$i]}"; archive="${plan_source[$i]#archive:}"; size_gb="${gb_of[$i]}"
      if [ -n "${plan_cid[$i]:-}" ] && [ ! -d "$archive" ]; then
        remaining_bytes=$(( remaining_bytes - bytes_of[$i] )); fail "$target" "docker export: its extracted root is gone"; continue
      fi
      if [ -z "${plan_cid[$i]:-}" ] && [ ! -f "$archive" ]; then
        remaining_bytes=$(( remaining_bytes - bytes_of[$i] )); fail "$target" "docker save: its archive is gone"; continue
      fi
      avail_bytes="$(free_bytes)"; room_bytes=$(( avail_bytes - floor_bytes ))
      # The archive stays on disk while this image is unpacked beside it: the room must hold every archive still held plus
      # this scan's workspace (the image's size), which is the model the plan admitted waves with. `avail_bytes` already has
      # the archives' written bytes subtracted, so `remaining_bytes` is not added again; it is only the pool a prune frees.
      workspace="${space_of[$i]}"
      if [ "$avail_bytes" -lt "$floor_bytes" ] || [ "$workspace" -gt "$room_bytes" ]; then rest+=("$i"); continue; fi
      if [ "${plan_cid[$i]:-}" ]; then
        # A container export: scan the extracted root(s) as a directory and remove the whole private unit directory, the
        # tars included. The row's commit column carries `container:<id>`, this scan's provenance: the containers'
        # filesystems, not the missing image. Two containers on one gone image are one target, so both ids are named.
        scan "$target" "container:$(printf '%s' "${plan_cid[$i]}" | tr ' ' ',')" -v "$archive:/src:ro" -- dir:/src
        discard_plan_source "$archive"; remaining_bytes=$(( remaining_bytes - bytes_of[$i] ))
        continue
      fi
      scan "$target" "" -v "$archive:/image.tar:ro" -- "docker-archive:/image.tar"
      discard_plan_source "$archive"; remaining_bytes=$(( remaining_bytes - bytes_of[$i] ))
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
      # First drop every archive no round can scan (its own bytes held plus the workspace its scan unpacks exceed the
      # room the whole pool can ever provide, which is the best a solo wave could offer): giving it room would only
      # crowd out an image that can. The workspace is the image's own size, not
      # the archive's, since compressed layers expand. This runs before any viable archive is considered, so a wave that
      # starts below the floor still keeps its scannable images.
      for k in "${rest[@]}"; do
        if [ $(( bytes_of[$k] + space_of[$k] )) -gt "$capacity" ]; then
          i="$k"; target="${plan_target[$i]}"; archive="${plan_source[$i]#archive:}"; size_gb="${gb_of[$k]}"
          room_now=$(( $(free_bytes) - floor_bytes )); [ "$room_now" -lt 0 ] && room_now=0
          fail "$target" "skipped: ${size_gb} GB image does not fit: $(space_need "$(ceil_gb $(( remaining_bytes - bytes_of[$i] )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (bytes_of[$i] + space_of[$i] - capacity + 1073741823) / 1073741824 )))"
          discard_plan_source "$archive"; remaining_bytes=$(( remaining_bytes - bytes_of[$i] )); continue
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
        if [ -z "${plan_idx[$i]:-}" ] || ! defer_to_next_wave "${plan_idx[$i]}" "$(space_need "$(ceil_gb $(( remaining_bytes - drop_bytes )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (space_of[$i] - room_now + 1073741823) / 1073741824 )))"; then
          fail "$target" "skipped: ${size_gb} GB image does not fit: $(space_need "$(ceil_gb $(( remaining_bytes - drop_bytes )))" "$size_gb" "$largest_gb" "$(ceil_gb "$room_now")" $(( (space_of[$i] - room_now + 1073741823) / 1073741824 )))"
        fi
        discard_plan_source "$archive"; remaining_bytes=$(( remaining_bytes - drop_bytes ))
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
  discard_tree "$next"; discard_tree "$work"; discard_tree "$archives"; discard_tree "$exportdir"
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
discard_tree "$archives"; discard_tree "$exportdir"
scan repo:product "$(git -C "$PWD" rev-parse HEAD 2>/dev/null || true)" -v "$PWD:/src:ro" -- dir:/src --exclude './data/**' --exclude './.git/**' --exclude '**/node_modules/**'
if [ -n "$inst" ]; then scan repo:instance "$(git -C "$inst" rev-parse HEAD 2>/dev/null || true)" -v "$inst:/src:ro" -- dir:/src --exclude './.git/**' --exclude '**/node_modules/**'; fi
apps="$PWD/data/apps/.platform"
# The expected checkout is anchored above data/apps, at this checkout: resolving data/apps too would make a redirected
# apps tree compare equal to itself, and its apps would be scanned under their own names exactly as before.
checkout_real="$(realpath -e "$PWD" 2>/dev/null || printf '%s' "$PWD")"
apps_expected="$checkout_real/data/apps/.platform"
for src in "$apps"/*/src; do
  # A checkout that is gone is nothing to report; a link whose target is gone is a checkout this pass cannot scan, and
  # realpath below is what says so.
  [ -e "$src" ] || [ -L "$src" ] || continue
  app="$(basename "$(dirname "$src")")"
  # Docker resolves symlinks in a bind source, so a checkout that is (or holds) a link into another tree would scan that
  # tree while its rows still name this app, and the findings would read as the app's. The scan root has to be the app's
  # own checkout: one that resolves anywhere else is a line naming both paths, and no syft run that could misread it.
  if ! real="$(realpath -e "$src" 2>/dev/null)"; then
    fail "app:$app" "checkout $src does not resolve (a broken link?); it should be the app's own checkout $apps_expected/$app/src"
    continue
  fi
  # The expected path is lexical below this checkout, so a redirected `data/apps` or `.platform` cannot compare equal to
  # itself: its apps are refused, not published under their own names.
  if [ "$real" != "$apps_expected/$app/src" ]; then
    fail "app:$app" "checkout $src resolves to $real; it should be the app's own checkout $apps_expected/$app/src"
    continue
  fi
  # The commit names the tree the rows came from, as for repo: targets. An app checkout that is not a git repo of its
  # own (data/ sits inside the product checkout, so git would otherwise answer with the product's HEAD) records none.
  commit=""
  if [ "$(git -C "$real" rev-parse --show-toplevel 2>/dev/null || true)" = "$real" ]; then
    commit="$(git -C "$real" rev-parse --verify HEAD 2>/dev/null || true)"
  fi
  scan "app:$app" "$commit" -v "$real:/src:ro" -- dir:/src --exclude '**/node_modules/**'
done

# Swap the finished batch in (the scanner reads current/; a scan mid-swap skips a target until next time).
rm -rf "$out/prev"
[ -d "$out/current" ] && mv "$out/current" "$out/prev"
# The marker the scanner needs before it may retire an image target absent from this batch: every image the survey made a
# unit (running or configured) has a row, so nothing was silently dropped. A unit the inventory could not size or export
# still has its own error line. Written into the batch before it is swapped in, so the marker and the targets it describes
# land together; without it the scanner treats the batch as incomplete and keeps absent targets unverified.
# One row per planned unit, so a count is the check: two units that happened to share a key (two containers on one image
# index) leave it short, and the batch then simply claims no completeness rather than the wrong one.
if [ "${images_planned:-0}" -gt 0 ] && [ "$(grep -c $'^image:[^\t]*\t' "$next/targets.tsv" || true)" -eq "$images_planned" ]; then
  : > "$next/images.complete"
fi
mv "$next" "$out/current"
discard_tree "$out/prev"; discard_tree "$work" "$exportdir"
echo "security-sbom: $(wc -l < "$out/current/targets.tsv") targets, $(grep -c $'\t-\t' "$out/current/targets.tsv" || true) failed"
