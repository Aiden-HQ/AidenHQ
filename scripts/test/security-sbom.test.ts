// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

// Every test has its own temp dir, fake PATH and lock file, so they run side by side (this suite is the slowest one): the
// tests are collected here and registered in one concurrent suite at the end, after the helpers below are defined.
const tests = [];
const test = (...args) => { tests.push(args); };

const NOT_LINUX = process.platform !== "linux" && "ops/security-sbom.sh needs bash 4 (declare -A); macOS ships bash 3.2";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../ops/security-sbom.sh");

/**
 * The script against the given running containers, a throwaway data dir and a logging `docker`. Each container is
 * `{ id, image, config, label }`: its id, the image it runs (`.Image`, an id), the reference it was created with
 * (`.Config.Image`) and the `com.docker.compose.image` label. `tags` maps each configured reference to the image's
 * top-level id now and `manifests` to its platform manifest (what `docker image inspect --platform` reports). The two
 * differ on the containerd image store, where every build writes a new top-level id over stable content. `held` lists
 * the ids the daemon still has: `docker save` reads those and fails on any other. `inspectErrors` names ids its
 * `docker image inspect` fails on for a reason other than the image being gone, as a daemon that can't answer does.
 * `saveErrors` maps an id the daemon still holds to the error its `docker save` fails with, as a store that collects the
 * image between the inspect and the save does.
 */
async function run(env = {}, {
  containers = [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
  tags = { "aidenhq/board:local": "sha256:1111" },
  // config/computers.json's `images`: undefined names the reference the fixture's first container was created with (so
  // the file is there, as on the host, and a running image is also a configured one), null leaves the file out, and an
  // object is written as given.
  computers = undefined,
  manifests = {},
  sizes = {},
  heldIds = [],
  noDescriptorField = false,
  platformManifests = {},
  platformSizes = {},
  // A container's root filesystem size (bytes) for `docker inspect --size`; an id it does not name has no answer.
  containerSizes = {},
  // id<TAB>error for a container `docker export` fails on.
  exportErrors = {},
  // id<TAB>bytes a container export writes regardless of the size the daemon reported.
  exportGrow = {},
  held = null,
  inspectErrors = [],
  saveErrors = {},
  saveGrow = {},
  takeAfterSave = {},
  freeTaken = 0,
  sizeErrors = [],
  sizeJunk = {},
  seed,
  psFails = false,
  psFailsFrom = 0,
  inspectFails = [],
  inspectSilent = "@@none@@",
  // References the daemon refuses to parse at all: `docker image inspect` answers "invalid reference format" for them,
  // as it does for a bare container id where a reference is expected (and for an id whose `sha256:` prefix was stripped).
  invalidRefs = [],
  drift = {},
  scriptPath,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const containersFile = join(dir, "containers");
  const tagsFile = join(dir, "tags");
  const heldFile = join(dir, "held");
  const heldIdsFile = join(dir, "held-ids");
  const brokenFile = join(dir, "broken");
  const saveErrorsFile = join(dir, "save-errors");
  const growFile = join(dir, "save-grow");
  const takeFile = join(dir, "take-after-save");
  const freeTakenFile = join(dir, "free-taken");
  const sizesFile = join(dir, "sizes");
  const sizeErrorsFile = join(dir, "size-errors");
  const invalidRefsFile = join(dir, "invalid-refs");
  const sizeJunkFile = join(dir, "size-junk");
  const platformManifestsFile = join(dir, "platform-manifests");
  const platformSizesFile = join(dir, "platform-sizes");
  const containerSizesFile = join(dir, "container-sizes");
  const exportErrorsFile = join(dir, "export-errors");
  const exportGrowFile = join(dir, "export-grow");
  const modesFile = join(dir, "modes");
  // The Docker socket's group for `stat -c %g /var/run/docker.sock`; everything else is the real stat, so a size read on
  // an archive (`stat -c %s`) is the archive's own, as on the host.
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\nif [ \"$1\" = -c ] && [ \"$2\" = %g ]; then echo 0; exit 0; fi\nexec /usr/bin/stat \"$@\"\n");
  // `find` for the merge's walk of a replica root: FAKE_FIND_SLEEP holds it open, as a tree with millions of entries
  // does, so a test can prove the walk is bounded by the snapshot deadline.
  writeFileSync(join(dir, "bin/find"), "#!/usr/bin/env bash\nif [ -n \"\\${FAKE_FIND_SLEEP:-}\" ] && [[ \"$*\" == *-print0* ]]; then read -r -t \"$FAKE_FIND_SLEEP\" _ < <(exec perl -e \"select undef, undef, undef, $FAKE_FIND_SLEEP\"); fi\nexec /usr/bin/find \"$@\"\n");
  // `tar -xOf <archive> <member>` for the archive check: with FAKE_ARCHIVE_SLEEP it stops answering, as a multi-GB archive
  // on slow storage does, so a test can prove the read is bounded by the snapshot deadline. Otherwise the real tar runs.
  writeFileSync(join(dir, "bin/tar"), `#!/usr/bin/env bash
if [ "$1" = -xOf ] && [ -n "\${FAKE_ARCHIVE_SLEEP:-}" ]; then
  read -r -t "$FAKE_ARCHIVE_SLEEP" _ < <(exec perl -e "select undef, undef, undef, $FAKE_ARCHIVE_SLEEP")
fi
exec /usr/bin/tar "$@"
`);
  // `df -Pk <dir>`: the fake filesystem's free space in 1K blocks, so a test can put the pass near the floor. FAKE_FREE_KB
  // is the free space with no archives; the archives directory's bytes are subtracted, as a real filesystem would, so a
  // test can model free space falling as archives are written and rising again as scans free them.
  writeFileSync(join(dir, "bin/df"), `#!/usr/bin/env bash
used="$(find "\${AIDENHQ_DATA_DIR:-.}/modules/security/sbom/.archives" -type f -printf '%s\\n' 2>/dev/null | awk '{ s += $1 } END { printf "%d", s / 1024 }')"
# FAKE_FREE_TAKEN_KB: bytes another writer on the filesystem took, so a test can model room vanishing between a save and
# its scan.
taken="$(awk '{ s += $1 } END { printf "%d", s / 1024 }' "\${FAKE_FREE_TAKEN:-$FREE_TAKEN}" 2>/dev/null)"
# FAKE_TAKE_AFTER_DF <n> <bytes>: another writer's bytes appear only after <n> free-space reads, so a test can put the
# pressure after the survey's own read and before every save.
n=""; [ -f "$DIR/df-count" ] && read -r n < "$DIR/df-count"; n=$(( \${n:-0} + 1 )); printf '%s\n' "$n" > "$DIR/df-count"
if [ -n "\${FAKE_TAKE_AFTER_DF:-}" ] && [ "$n" -gt "\${FAKE_TAKE_AFTER_DF}" ] && [ -n "\${FAKE_TAKE_BYTES:-}" ]; then
  taken=$(( taken + FAKE_TAKE_BYTES / 1024 ))
fi
kb=$(( \${FAKE_FREE_KB:-400000000} - \${used:-0} - \${taken:-0} ))
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/md2 481000000 1 %s 1%% /\\n' "$kb"
`);
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
# A fake daemon: containers (id<TAB>.Image<TAB>.Config.Image<TAB>compose image label\`), the tag table (ref<TAB>
# top-level id<TAB>platform manifest) and the image ids it holds. Every syft run and save is logged.
lockstate() { if [ -n "$FAKE_APPLY_LOCK" ] && flock -n "$FAKE_APPLY_LOCK" -c true 2>/dev/null; then echo free; else echo held; fi; }
case "$1" in run|save|export) printf '%s\\n' "$*" >> "$CALLS" ;; esac
[ "$1" = run ] && printf 'run %s\\n' "$(lockstate)" >> "$LOCKS"
[ "$1" = export ] && printf 'export %s\\n' "$(lockstate)" >> "$LOCKS"
# The host scan is the twenty-minute one on a real box: FAKE_HOST_SCAN_SLEEP holds it open that long (seconds), so a test
# can put the snapshot deadline inside it and prove the deadline ends with the snapshot.
if [ "$1" = run ] && [ -n "$FAKE_HOST_SCAN_SLEEP" ] && [[ "$*" == *"--source-name host"* ]]; then
  read -r -t "$FAKE_HOST_SCAN_SLEEP" _ < <(exec perl -e "select undef, undef, undef, $FAKE_HOST_SCAN_SLEEP")
fi
# An apply that starts while the scans run: FAKE_TAKE_LOCK_ON_HOST_SCAN has a background process hold the apply lock as the
# host scan begins, so a later wave cannot export and must record its images rather than leave a gap. It writes a marker
# once it holds the lock and keeps holding it until the test removes the marker, so nothing races a timeout. The host scan
# waits for the marker, so the lock is held before any scan runs. The holder's stdout is closed so the host scan's command
# substitution does not wait on it.
if [ "$1" = run ] && [ -n "\${FAKE_TAKE_LOCK_ON_HOST_SCAN:-}" ] && [[ "$*" == *"--source-name host"* ]]; then
  marker="\${FAKE_APPLY_LOCK%/*}/late-holder"
  # Bounded (60s) so an interrupted test cannot leave a holder polling for ever; the test's cleanup removes the marker
  # as soon as the pass returns.
  ( exec 9>>"$FAKE_APPLY_LOCK"; flock 9; : > "$marker"
    for _ in $(seq 1 1200); do [ -f "$marker" ] || break; sleep 0.05; done ) >/dev/null 2>&1 </dev/null &
  for _ in $(seq 1 200); do [ -f "$marker" ] && break; sleep 0.05; done
fi
# rm -f clears a container the script named before a run; a name nothing holds is a normal answer, not a failure.
[ "$1" = rm ] && exit 0
# Only a container carrying this scanner's own label may be removed: inspect prints the label, or fails as Docker does.
if [ "$1" = inspect ] && [ "$2" = -f ] && [[ "$3" == *aidenhq.oneoff* ]]; then
  grep -qxF -- "$4" "$LABELLED" && printf '1\n' && exit 0
  echo "Error: No such object: $4" >&2; exit 1
fi
if [ "$1" = run ]; then
  # syft's output file (-o syft-json=/out/NNN.json) under the /out mount: a scan that succeeded leaves a real file, so
  # a test can check a row's file is on disk rather than only its name in targets.tsv.
  outm=""
  for a in "$@"; do case "$a" in *:/out) outm="\${a%:/out}" ;; esac; done
  for a in "$@"; do case "$a" in syft-json=/out/*) [ -n "$outm" ] && : > "$outm/\${a#syft-json=/out/}" ;; esac; done
  # A container scan reads the extracted root from the pass's private export directory (a sibling of the /sbom mount, so a
  # raw export is never visible to the scanner). Its mode, the tar beside it and its contents are recorded as the scan
  # starts: that is the only moment both exist.
  for a in "$@"; do
    case "$a" in */sbom-exports/*:/src:ro)
      d="\${a%:/src:ro}"
      sb="\${AIDENHQ_DATA_DIR}/modules/security/sbom"
      printf 'tree %s %s\n' "\${d#\${sb%/*}/}" "$(stat -c %a "$d")" >> "$MODES"
      printf 'exportdir %s\n' "$(stat -c %a "$(dirname "$d")")" >> "$MODES"
      for r in "$d.tars"/*.tar; do [ -f "$r" ] && printf 'tar %s %s\n' "\${r#\${sb%/*}/}" "$(stat -c %a "$r")" >> "$MODES"; done
      for f in "$d"/etc/os-release "$d"/usr/lib/libfix.so "$d"/opt/app/dev/node_modules/pkg.json; do
        [ -e "$f" ] && printf 'file %s\n' "\${f#\${sb%/*}/}" >> "$MODES"
      done
      # Every version of the replica paths a test plants, wherever the merge put them: the root's own path and the
      # .replicas/<id>/ copies a conflicting path is kept under.
      cd "$d"
      for f in usr/lib/libdup.so usr/lib/replica-only.so .replicas/c1/usr/lib/libdup.so .replicas/c2/usr/lib/libdup.so; do
        [ -f "$f" ] && printf 'content %s %s\n' "$f" "$(tr -d '\n' < "$f")" >> "$MODES"
      done
      for f in etc/os-release bin opt/app/plugins .replicas/c2/opt/app/plugins/installed.txt \
               app 'd*' .replicas/probe .replicas-2/c2/app/.bash_profile .replicas/c2/d*/app/.bash_profile; do
        if [ -L "$f" ]; then printf 'link %s %s\n' "$f" "$(readlink "$f")" >> "$MODES"
        elif [ -f "$f" ]; then printf 'regular %s\n' "$f" >> "$MODES"; fi
      done
      cd - >/dev/null
      # A file the export dropped must not be in the scanned root: record those the test asks about.
      for f in "$d"/dev/null "$d"/opt/app/dev/node_modules/pkg.json; do [ -e "$f" ] && printf 'present %s\n' "\${f#\${sb%/*}/}" >> "$MODES"; done
      ;;
    esac
  done
  # The work dir the script mounted as /work: what a target leaves must be gone before the next one starts. Junk is made
  # here, as stereoscope and an XDG cache would (a dotfile included), so the script's own cleanup is what the test reads.
  w=""
  for a in "$@"; do case "$a" in *:/work) w="\${a%:/work}" ;; esac; done
  if [ -n "$w" ] && [ -d "$w" ]; then
    if [ -n "$(ls -A "$w" 2>/dev/null)" ]; then printf 'dirty\n' >> "$CLEAN"; else printf 'clean\n' >> "$CLEAN"; fi
    mkdir -p "$w/stereoscope-$$" "$w/.cache/syft"
    printf 'x' > "$w/stereoscope-$$/layer"
  fi
fi
case "$1" in
  version)
    if [[ "$*" == *APIVersion* ]]; then printf '%s\\n' "\${FAKE_API:-1.48}"; exit 0; fi
    printf 'linux/amd64\\n' ;;
  ps)
    # FAKE_TAKE_ON_PS: another writer takes room once the survey has listed the containers, so the survey's room is whole
    # but every save sees less. This models pressure that begins between the survey and the saves.
    [ -n "\${FAKE_TAKE_ON_PS:-}" ] && printf '%s\n' "$FAKE_TAKE_ON_PS" >> "$FREE_TAKEN"
    nps=0; [ -f "$DIR/ps-count" ] && read -r nps < "$DIR/ps-count"; nps=$((nps + 1)); printf '%s\\n' "$nps" > "$DIR/ps-count"
    if [ "$PS_FAILS" = 1 ] || { [ -n "\${PS_FAILS_NTH:-}" ] && [ "$nps" -ge "$PS_FAILS_NTH" ]; }; then
      echo "Error response from daemon: cannot list containers" >&2; exit 1
    fi
    printf '%s\\n' ${containers.map((c) => `'${c.id}'`).join(" ")} ;;
  inspect)
    # A container's root filesystem size (inspect --size -f SizeRootFs): CONTAINER_SIZES is id<TAB>bytes, and an id
    # it does not name has no answer, as a daemon that cannot size a container does.
    if [ "$2" = --size ]; then
      for a in "$@"; do cid="$a"; done; found="$(awk -F '\\t' -v id="$cid" '$1 == id { print $2; found = 1 } END { exit !found }' "$CONTAINER_SIZES")" && { printf '%s\\n' "$found"; exit 0; }
      echo "Error: No such container: $cid" >&2; exit 1
    fi
    [ "$2" = -f ] || exit 1
    # A container the fake daemon cannot answer for, as a daemon that stops mid-enumeration does.
    for bad in \${INSPECT_FAILS:-}; do
      if [ "$bad" = "$4" ] && [ "$PS_FAILS" != 1 ]; then echo "Error response from daemon: cannot inspect $4: EOF" >&2; exit 1; fi
    done
    # A batched inspect (more than one container id) that names a container the daemon cannot answer for fails whole,
    # as the daemon's would; the script then re-inspects one by one.
    if [ "$#" -gt 1 ]; then
      for bad in \${INSPECT_FAILS:-}; do
        for arg in "$@"; do
          if [ "$bad" = "$arg" ]; then echo "Error response from daemon: cannot inspect $arg: EOF" >&2; exit 1; fi
        done
      done
    fi
    case "$3" in
      # The format is id, .Image, .Config.Image, label (a dash when absent, the with-block's else) and the platform
      # manifest descriptor (the last field, compact JSON or null). A daemon without the field rejects the template, as
      # docker does for an unknown property.
      *ImageManifestDescriptor*) if [ -n "$NO_DESCRIPTOR_FIELD" ]; then echo "template: :1:6: executing \"template\" at <.ImageManifestDescriptor>: can't evaluate field ImageManifestDescriptor" >&2; exit 1; fi; cut -f1,2,3,4,5 "$CONTAINERS" ;;
      # The label column is empty for a container without one, as the format's with-block renders an absent label.
      *com.docker.compose.image*) cut -f1,2,3,4 "$CONTAINERS" ;;
      *) cut -f1-3 "$CONTAINERS" ;;
    esac ;;
  image)
    shift
    if [ "$1" = ls ] || [ "$1" = list ]; then
      # docker image ls --format '{{.Repository}}:{{.Tag}}': the references, one per line, as the daemon lists them.
      awk -F '\\t' '$3 != "" { print $1 }' "$TAGS"
      exit 0
    fi
    if [ "$1" = save ]; then
      printf 'save %s\n' "$*" >> "$CALLS"; printf 'save %s\n' "$(lockstate)" >> "$LOCKS"
      # A daemon that stops answering mid-save: FAKE_SAVE_SLEEP holds the call open, so a test can prove the snapshot
      # deadline terminates it instead of holding the apply lock.
      [ -n "$FAKE_SAVE_SLEEP" ] && read -r -t "$FAKE_SAVE_SLEEP" _ < <(exec perl -e "select undef, undef, undef, $FAKE_SAVE_SLEEP")
      shift
      file=""; id=""; plat_save=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          -o) file="$2"; shift 2 ;;
          --platform) plat_save="$2"; shift 2 ;;
          -*) shift ;;
          *) id="$1"; shift ;;
        esac
      done
      failed="$(awk -F '\\t' -v ref="$id" '$1 == ref { print $2; found = 1 } END { exit !found }' "$SAVE_ERRORS")" && { echo "$failed" >&2; exit 1; }
      # A platform save of an index writes only when some local reference holds that platform's manifest; when the
      # fixture records no per-platform manifests for the ref at all, the plain reference rule below decides.
      if [ -n "$plat_save" ] && grep -qF -- "$id" "$PLATFORM_MANIFESTS"; then
        awk -F '\\t' -v ref="$id" -v p="$plat_save" '$1 == ref && $2 == p { found = 1 } END { exit !found }' "$PLATFORM_MANIFESTS" \
          || { echo "Error response from daemon: No such image: $id" >&2; exit 1; }
      fi
      if grep -qxF -- "$id" "$HELD" || awk -F '\\t' -v ref="$id" '$1 == ref { found = 1 } END { exit !found }' "$TAGS"; then
        if [ -n "$file" ]; then
          # The archive a plain save writes, shaped by FAKE_SAVE_SHAPE and FAKE_SAVE_PIN:
          #   one     index.json naming one manifest (that manifest is FAKE_SAVE_PIN when set, else the saved ref's id)
          #   multi   index.json naming two platform manifests (a multi-platform reference)
          #   nested  index.json naming one descriptor that is itself an index of two platform manifests, as a saved
          #           image id over a multi-platform image looks on the containerd store
          #   legacy  manifest.json with one image and no index.json
          #   none    an archive with neither index nor manifest, which is not proof of anything
          # Unset keeps the old fixture: the leftover empty file, no index and no manifest.
          : > "$file"
          shape="\${FAKE_SAVE_SHAPE:-none}"
          pin="\${FAKE_SAVE_PIN:-$id}"
          if [ "$shape" != none ]; then
            d="$(mktemp -d)"; mkdir -p "$d/blobs/sha256"
            case "$shape" in
              one|classic)
                # one names a manifest whose digest is the pin; classic names a manifest whose config digest is the pin
                # (a classic-store image id), with the manifest digest different, as docker image inspect .Id reports.
                md="\${FAKE_SAVE_MANIFEST_DIGEST:-$pin}"
                printf '{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"manifests\":[{\"digest\":\"%s\",\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}}]}\n' "$md" > "$d/index.json"
                printf '{\"schemaVersion\":2,\"config\":{\"digest\":\"%s\"},\"layers\":[]}\n' "$pin" > "$d/blobs/sha256/\${md#sha256:}" ;;
              multi) printf '{\"schemaVersion\":2,\"manifests\":[{\"digest\":\"sha256:%064d\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}},{\"digest\":\"sha256:%064d\",\"platform\":{\"os\":\"linux\",\"architecture\":\"arm64\",\"variant\":\"v8\"}}]}\n' 1 2 > "$d/index.json" ;;
              nested)
                printf '{\"schemaVersion\":2,\"manifests\":[{\"digest\":\"sha256:%064d\",\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}}]}\n' 7 > "$d/index.json"
                { printf '{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"manifests\":['; i=1
                  while [ "$i" -le 2 ]; do [ "$i" -gt 1 ] && printf ','; printf '{\"digest\":\"sha256:%064d\"}' "$i"; i=$((i + 1)); done
                  printf ']}\n'; } > "$d/blobs/sha256/0000000000000000000000000000000000000000000000000000000000000007" ;;
              legacy)
                # A legacy save: one manifest.json entry naming selftest.json whose digest is the pin (the config id).
                printf '[{\"Config\":\"%s.json\",\"RepoTags\":[\"x:local\"]}]\n' "\${pin#sha256:}" > "$d/manifest.json"
                printf '{\"architecture\":\"amd64\",\"os\":\"linux\"}\n' > "$d/\${pin#sha256:}.json" ;;
            esac
            # Members at the archive root, as docker writes them (index.json, manifest.json, blobs/...).
            ( cd "$d" && tar -cf "$file" $(find . -type f | sed 's|^\./||') )
            rm -rf "$d"
          fi
          # An archive whose bytes differ from the size the daemon reported: FAKE_SAVE_GROW ref<TAB>bytes makes that
          # reference's archive exactly that many bytes, as a save's real bytes can exceed the inspect size a little. A
          # write with a ulimit -f ceiling (1024-byte blocks, 0 = none) stops at that ceiling and fails, as a real write
          # running out of room does, rather than shrinking to fit.
          grow="$(awk -F '\t' -v ref="$id" '$1 == ref { print $2; found = 1 }' "$SAVE_GROW" 2>/dev/null)"
          lim="$(ulimit -f)"
          if [ -n "$grow" ]; then
            if [ "$lim" != 0 ] && [ "$grow" -gt $(( lim * 1024 )) ]; then
              truncate -s $(( lim * 1024 )) "$file"
              echo "Error response from daemon: write $file: no space left on device" >&2
              echo "Error response from daemon: write $file: file too large" >&2
              kill -XFSZ $$
            fi
            truncate -s "$grow" "$file"
          fi
        fi
        # A concurrent writer takes bytes as the save finishes: FAKE_TAKE_AFTER_SAVE ref<TAB>bytes.
        take="$(awk -F '\t' -v ref="$id" '$1 == ref { print $2; found = 1 }' "$TAKE_AFTER_SAVE" 2>/dev/null)"
        [ -n "$take" ] && printf '%s\n' "$take" >> "$FREE_TAKEN"
        : > "$SAVED"; exit 0
      fi
      echo "Error response from daemon: No such image: $id" >&2; exit 1
    fi
    if [ "$1" = inspect ]; then
      shift
      col=2; plat_req=""
      if [ "$1" = --platform ]; then plat_req="$2"; shift 2; fi
      # A probe the kernel killed prints nothing at all: a timeout or a connection dropped mid-read. Only the id probe
      # (-f .Id, what resolve_ref reads to find a reference) is silenced, so the size read on the bare pin still
      # answers the daemon's "No such image" — the exact shape the guard has to tell apart.
      case "$*" in
        *'{{.Id}}'*"\${INSPECT_SILENT:-@@none@@}"*) exit 1 ;;
      esac
      if [ "$1" = -f ] && [ "$2" = '{{.Size}}' ]; then
        # An image's size on disk, for the room its save and unpack need.
        shift 2
        # A reference the daemon cannot parse at all: it refuses before it looks anything up, as it does for a bare
        # container id where a reference is expected.
        if grep -qxF -- "$1" "$INVALID_REFS"; then echo "Error response from daemon: invalid reference format" >&2; exit 1; fi
        # A per-platform size (ref<TAB>platform<TAB>bytes) wins: one index's variants have different sizes.
        if [ -n "$plat_req" ]; then
          plat_size="$(awk -F '\\t' -v ref="$1" -v plat="$plat_req" '$1 == ref && $2 == plat { print $3; found = 1 } END { exit !found }' "$PLATFORM_SIZES")" && { printf '%s\\n' "$plat_size"; exit 0; }
        fi
        junk="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $2; found = 1 }' "$SIZE_JUNK")"
        if [ -n "$junk" ]; then printf '%s\\n' "$junk"; exit 0; fi
        # The reference is what a save will read: an id that is held, or a tag in the table. A bare platform manifest
        # inside an index is not an image record, so it does not answer a size.
        if [ -n "$plat_req" ]; then
          if ! grep -qxF -- "$1" "$HELD" && [ -z "$(awk -F '\\t' -v ref="$1" '$1 == ref && $3 != "" { print $1 }' "$TAGS")" ]; then
            echo "Error response from daemon: No such image: $1" >&2; exit 1
          fi
        fi
        if grep -qxF -- "$1" "$SIZE_ERRORS"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        found="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $2; found = 1 }' "$SIZES")"
        if [ -n "$found" ]; then printf '%s\\n' "$found"; exit 0; fi
        if grep -qxF -- "$1" "$HELD_IDS"; then printf '0\\n'; exit 0; fi
        # A configured tag resolves to the image it names, as the daemon does; the table holds ref<TAB>id<TAB>manifest.
        # An image id in the table's first column is that image, not a tag naming another one.
        by_tag="$(awk -F '\\t' -v ref="$1" '$1 == ref && $3 != "" { print $2; found = 1 }' "$TAGS")"
        if [ -n "$by_tag" ] && ! grep -qxF -- "$1" "$HELD"; then set -- "$by_tag"; fi
        if grep -qxF -- "$1" "$HELD"; then printf '0\\n'; exit 0; fi
        if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        echo "Error response from daemon: No such image: $1" >&2; exit 1
      fi
      plat="$plat_req"
      if [ -n "$plat" ]; then col=3; fi
      tmpl=""
      if [ "$1" = -f ]; then tmpl="$2"; shift 2; fi
      if [ "$#" -eq 0 ]; then cut -f"$col" "$TAGS"; exit 0; fi
      # A reference the daemon cannot parse at all: refused before any lookup, as a bare container id is.
      if grep -qxF -- "$1" "$INVALID_REFS"; then echo "Error response from daemon: invalid reference format" >&2; exit 1; fi
      # FAKE_TAG_NOISE <ref>: the daemon prints a warning ahead of the id, as a daemon that logs to stdout does.
      if [ -n "\${FAKE_TAG_NOISE:-}" ] && [ "$1" = "\${FAKE_TAG_NOISE}" ] && [ "$tmpl" = '{{.Id}}' ]; then
        printf 'WARNING: deprecated image store\n'
        awk -F '\\t' -v ref="$1" '$1 == ref { print $'"$col"'; found = 1 } END { exit !found }' "$TAGS"; exit 0
      fi
      # A reference the fixture says the daemon cannot answer for (a timeout, a refused socket) fails even when the tag
      # table names it: the table is what the daemon holds, not a promise it will answer this read.
      if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
      # A per-platform manifest (ref<TAB>platform<TAB>manifest) wins over the tag table's single manifest: a platform read
      # resolves a tag or an index id to the manifest for that platform.
      if [ -n "$plat" ]; then
        per_plat="$(awk -F '\\t' -v ref="$1" -v p="$plat" '$1 == ref && $2 == p { print $3; found = 1 } END { exit !found }' "$PLATFORM_MANIFESTS")" && found="$per_plat"
      fi
      # A plain id read (no --platform) answers for an image id the daemon holds, never from the tag table's manifest
      # column: on the containerd store the platform manifest inside an index is not an image record.
      if [ -z "$plat" ] && [ "$tmpl" = '{{.Id}}' ] && grep -qxF -- "$1" "$HELD"; then printf '%s\\n' "$1"; exit 0; fi
      if [ -z "$found" ]; then found="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $'"$col"'; found = 1 }' "$TAGS")"; fi
      # A tag that moves mid-pass: after N reads of its platform manifest it names another image build.
      if [ -n "$plat" ]; then
        n=0; [ -f "$DRIFT_COUNT/$(printf '%s' "$1" | sha256sum | cut -c1-16)" ] && read -r n < "$DRIFT_COUNT/$(printf '%s' "$1" | sha256sum | cut -c1-16)"
        n=$((n + 1)); printf '%s\n' "$n" > "$DRIFT_COUNT/$(printf '%s' "$1" | sha256sum | cut -c1-16)"
        drift="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $3; after = $2; found = 1 } END { if (found) print after }' "$DRIFT")"
        drift_then="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $3 }' "$DRIFT")"
        drift_after="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $2 }' "$DRIFT")"
        if [ -n "$drift_then" ] && [ "$n" -gt "$drift_after" ]; then found="$drift_then"; fi
      fi
      if [ -z "$found" ]; then
        if grep -qxF -- "$1" "$HELD"; then printf '%s\\n' "$1"; exit 0; fi
        if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        echo "Error response from daemon: No such image: $1" >&2; exit 1
      fi
      printf '%s\\n' "$found"; exit 0
    fi
    if [ -n "$1" ]; then
      if grep -qxF -- "$1" "$HELD"; then printf '%s\\n' "$1"; exit 0; fi
      if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
      echo "Error response from daemon: No such image: $1" >&2; exit 1
    fi ;;
  export)
    # docker export -o <file> <container id>: a tar of the container's filesystem, or the daemon's error.
    # EXPORT_ERRORS is id<TAB>error; FAKE_EXPORT_SLEEP holds the call open so a test can prove the deadline ends it.
    shift
    file=""; cid=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) file="$2"; shift 2 ;;
        -*) shift ;;
        *) cid="$1"; shift ;;
      esac
    done
    [ -n "$FAKE_EXPORT_SLEEP" ] && read -r -t "$FAKE_EXPORT_SLEEP" _ < <(exec perl -e "select undef, undef, undef, $FAKE_EXPORT_SLEEP")
    failed="$(awk -F '\\t' -v id="$cid" '$1 == id { print $2; found = 1 } END { exit !found }' "$EXPORT_ERRORS" 2>/dev/null)" && { echo "$failed" >&2; exit 1; }
    d="$(mktemp -d)"; mkdir -p "$d/etc" "$d/usr/lib" "$d/dev" "$d/opt/app/dev/node_modules"
    printf 'fixture' > "$d/etc/os-release"
    printf 'x' > "$d/usr/lib/libfix.so"
    # The container root's own device directory (a real export holds device nodes; the pass leaves them out), and a
    # nested dev inside a deployed app's dependency tree, which must survive the exclusion.
    printf '' > "$d/dev/null"
    printf '{}' > "$d/opt/app/dev/node_modules/pkg.json"
    # EXPORT_EXTRAS "id:path=content;id:path=content": files a container has in its writable layer, so two replicas of one
    # image can differ on one path (or one can hold a file the other lacks).
    if [ -n "\${EXPORT_EXTRAS:-}" ]; then
      oldifs="$IFS"; IFS=';'
      for e in $EXPORT_EXTRAS; do
        IFS="$oldifs"
        [ "\${e%%:*}" = "$cid" ] || continue
        epath="\${e#*:}"; econtent="\${epath#*=}"; epath="\${epath%%=*}"
        mkdir -p "$d/$(dirname "$epath")"; printf '%s' "$econtent" > "$d/$epath"
      done
      IFS="$oldifs"
    fi
    # EXPORT_SYMLINKS "id:link=target;...": symlinks the container has, as a distro keeps /etc/os-release ->
    # ../usr/lib/os-release and /bin -> usr/bin.
    if [ -n "\${EXPORT_SYMLINKS:-}" ]; then
      oldifs="$IFS"; IFS=';'; set -f
      for e in $EXPORT_SYMLINKS; do
        IFS="$oldifs"
        [ "\${e%%:*}" = "$cid" ] || continue
        elink="\${e#*:}"; etarget="\${elink#*=}"; elink="\${elink%%=*}"
        mkdir -p "$d/$(dirname "$elink")"; rm -f "$d/$elink"; ln -s "$etarget" "$d/$elink"
      done
      IFS="$oldifs"; set +f
    fi
    # EXPORT_DIR_MODE <mode>: a directory the container left read-only (a Go module cache), as tar would restore it.
    [ -n "\${EXPORT_DIR_MODE:-}" ] && { mkdir -p "$d/root/.cache/go-mod" && printf 'bin' > "$d/root/.cache/go-mod/mod.zip" && chmod "$EXPORT_DIR_MODE" "$d/root/.cache/go-mod"; }
    ( cd "$d" && set -f && tar -cf "$file" $(find . -type f -o -type l | sed 's|^\./||') )
    rm -rf "$d"
    # EXPORT_GROW id<TAB>bytes: a container root filesystem much larger than the daemon's size said, as a real container
    # whose runtime data has grown since it was sized. The ulimit -f ceiling stops the write, as a real one would.
    grow="$(awk -F '\t' -v id="$cid" '$1 == id { print $2; found = 1 } END { exit !found }' "$EXPORT_GROW" 2>/dev/null)"
    if [ -n "$grow" ]; then
      lim="$(ulimit -f)"
      if [ "$lim" != 0 ] && [ "$grow" -gt $(( lim * 1024 )) ]; then
        truncate -s $(( lim * 1024 )) "$file"
        echo "Error response from daemon: write $file: no space left on device" >&2
        echo "Error response from daemon: write $file: file too large" >&2
        kill -XFSZ $$
      fi
      truncate -s "$grow" "$file"
    fi
    exit 0 ;;
  save)
    # docker save <ref> (no "image" subcommand): the same answer docker image save gives, so a save of an image the
    # daemon does not hold is refused here too rather than answering success for anything.
    shift; file=""; id=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) file="$2"; shift 2 ;;
        -*) shift ;;
        *) id="$1"; shift ;;
      esac
    done
    failed="\$(awk -F '\\t' -v ref="\$id" '\$1 == ref { print \$2; found = 1 } END { exit !found }' "\$SAVE_ERRORS")" && { echo "\$failed" >&2; exit 1; }
    if grep -qxF -- "\$id" "\$HELD" || awk -F '\\t' -v ref="\$id" '\$1 == ref { found = 1 } END { exit !found }' "\$TAGS"; then
      if [ -n "\$file" ]; then : > "\$file"; fi
      : > "\$SAVED"; exit 0
    fi
    echo "Error response from daemon: No such image: \$id" >&2; exit 1 ;;
esac
exit 0
`);
  for (const f of ["stat", "docker", "df", "tar", "find"]) chmodSync(join(dir, "bin", f), 0o755);
  // The label column is a dash when absent, as the script's with-block else renders it: an empty field would collapse
  // when the script splits the inspect output on whitespace.
  writeFileSync(containersFile, containers.map((c) => `${c.id}\t${c.image}\t${c.config}\t${c.label ?? "-"}\t${c.descriptor === undefined ? "null" : JSON.stringify(c.descriptor)}`).join("\n") + "\n");
  writeFileSync(platformManifestsFile, Object.entries(platformManifests).map(([ref, m]) => Object.entries(m).map(([p, v]) => `${ref}\t${p}\t${v}`).join("\n")).filter(Boolean).join("\n") + "\n");
  writeFileSync(platformSizesFile, Object.entries(platformSizes).map(([ref, m]) => Object.entries(m).map(([p, v]) => `${ref}\t${p}\t${v}`).join("\n")).filter(Boolean).join("\n") + "\n");
  writeFileSync(tagsFile, Object.entries(tags).map(([ref, id]) => `${ref}\t${id}\t${manifests[ref] ?? id}\t${sizes[ref] ?? 0}`).join("\n") + "\n");
  writeFileSync(heldFile, (held ?? [...containers.map((c) => c.image), ...Object.values(tags)]).join("\n") + "\n");
  writeFileSync(heldIdsFile, heldIds.join("\n") + "\n");
  writeFileSync(brokenFile, inspectErrors.join("\n") + "\n");
  writeFileSync(saveErrorsFile, Object.entries(saveErrors).map(([id, err]) => `${id}\t${err}`).join("\n") + "\n");
  writeFileSync(growFile, Object.entries(saveGrow).map(([id, bytes]) => `${id}\t${bytes}`).join("\n") + "\n");
  writeFileSync(takeFile, Object.entries(takeAfterSave).map(([id, bytes]) => `${id}\t${bytes}`).join("\n") + "\n");
  if (freeTaken) writeFileSync(freeTakenFile, `${freeTaken}\n`);
  writeFileSync(sizesFile, Object.entries(sizes).map(([ref, bytes]) => `${ref}\t${bytes}`).join("\n") + "\n");
  writeFileSync(sizeErrorsFile, sizeErrors.join("\n") + "\n");
  writeFileSync(invalidRefsFile, invalidRefs.join("\n") + "\n");
  writeFileSync(sizeJunkFile, Object.entries(sizeJunk).map(([ref, out]) => `${ref}\t${out}`).join("\n") + "\n");
  writeFileSync(containerSizesFile, Object.entries(containerSizes).map(([id, bytes]) => `${id}\t${bytes}`).join("\n") + "\n");
  writeFileSync(exportErrorsFile, Object.entries(exportErrors).map(([id, err]) => `${id}\t${err}`).join("\n") + "\n");
  writeFileSync(exportGrowFile, Object.entries(exportGrow).map(([id, bytes]) => `${id}\t${bytes}`).join("\n") + "\n");
  writeFileSync(join(dir, "labelled"), ""); // containers this fake daemon reports as this scanner's own
  const scriptPath_ = scriptPath ?? isolatedCheckout(dir).scriptPath;
  // The writer reads the fleet's configured computer images (config/computers.json), which is what keeps an image that
  // runs in no container in the inventory.
  const checkout = dirname(dirname(scriptPath_));
  mkdirSync(join(checkout, "config"), { recursive: true });
  const computersFile = join(checkout, "config/computers.json");
  if (computers === null) rmSync(computersFile, { force: true });
  else writeFileSync(computersFile, JSON.stringify(computers ?? { images: containers.length ? { image: containers[0]!.config } : {} }));
  writeFileSync(join(dir, "drift"), Object.entries(drift).map(([ref, d]) => `${ref}\t${d.after}\t${d.then}`).join("\n") + "\n");
  mkdirSync(join(dir, "drift-count"), { recursive: true });
  const calls = join(dir, "calls");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  if (seed) seed(data);
  const r = await new Promise((resolve) => {
    execFile("bash", [scriptPath_], {
      cwd: dirname(scriptPath_),
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: data,
        AIDENHQ_INSTANCE_DIR: "", CONTAINERS: containersFile, TAGS: tagsFile, HELD: heldFile, HELD_IDS: heldIdsFile, BROKEN: brokenFile,
        INSPECT_SILENT: inspectSilent,
        SAVE_ERRORS: saveErrorsFile, SAVE_GROW: growFile, TAKE_AFTER_SAVE: takeFile, FREE_TAKEN: freeTakenFile, SAVED: join(dir, "saved.tar"), CLEAN: join(dir, "clean"), SIZES: sizesFile, LABELLED: join(dir, "labelled"), SIZE_ERRORS: sizeErrorsFile, SIZE_JUNK: sizeJunkFile, INVALID_REFS: invalidRefsFile, CONTAINER_SIZES: containerSizesFile, EXPORT_ERRORS: exportErrorsFile, EXPORT_GROW: exportGrowFile, MODES: modesFile, PLATFORM_MANIFESTS: platformManifestsFile, PLATFORM_SIZES: platformSizesFile, PS_FAILS: psFails ? "1" : "", NO_DESCRIPTOR_FIELD: noDescriptorField ? "1" : "", PS_FAILS_NTH: psFailsFrom ? String(psFailsFrom) : "", INSPECT_FAILS: inspectFails.join(" "), DRIFT: join(dir, "drift"), DRIFT_COUNT: join(dir, "drift-count"), LOCKS: join(dir, "locks"), FAKE_APPLY_LOCK: join(dirname(dirname(scriptPath_)), "data/apply.lock"),
        DIR: dir, AIDENHQ_SBOM_POLL_S: "0.05", ...env,
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  // A fixture that held the apply lock is released here, whatever the pass returned: a failing assertion must not leave
  // a background holder behind for the next test. `lateHeld` says whether it ever took the lock.
  const lockDir = join(dirname(dirname(scriptPath_)), "data");
  const lateMarker = join(lockDir, "late-holder");
  const lateHeld = existsSync(lateMarker);
  if (lateHeld) {
    rmSync(lateMarker, { force: true });
    for (let i = 0; i < 100; i++) {
      try { execFileSync("flock", ["-n", join(lockDir, "apply.lock"), "-c", "true"], { stdio: "ignore" }); break; }
      catch { await new Promise((r) => setTimeout(r, 20)); }
    }
  }
  const batch = join(data, "modules/security/sbom/current/targets.tsv");
  const batchRaw = existsSync(batch) ? readFileSync(batch, "utf8") : null;
  const targets = batchRaw ? batchRaw.split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  return {
    ...r, targets, batchRaw, root: dirname(scriptPath_), dir, lateHeld,
    locks: existsSync(join(dir, "locks")) ? readFileSync(join(dir, "locks"), "utf8").trim().split("\n").filter(Boolean) : [],
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
    workStates: existsSync(join(dir, "clean")) ? readFileSync(join(dir, "clean"), "utf8").trim().split("\n").filter(Boolean) : [],
    modes: existsSync(modesFile) ? readFileSync(modesFile, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

/** One target's syft run: the source it scanned and its `--exclude` patterns. */
function syft(calls, target) {
  const found = calls.find((c) => c.startsWith("run ") && c.includes(`--source-name ${target}`));
  assert.ok(found, `no syft run for ${target}:\n${calls.join("\n")}`);
  return { line: found, excludes: [...found.matchAll(/--exclude (\S+)/g)].map((m) => m[1]) };
}

test("security-sbom: the host target scans / with /home and /root excluded, and /usr, /opt, /etc and dpkg still in it", { skip: NOT_LINUX }, async () => {
  const { status, out, calls } = await run();
  assert.equal(status, 0, out);
  const host = syft(calls, "host");
  assert.match(host.line, /-v \/:\/host:ro .* dir:\/host /, "the root filesystem, read-only");
  // A checkout, task worktree or tool cache in a home belongs to another project's dependency tree, and no apt upgrade
  // or ops/vm/pins.json clears a lockfile in a clone: the host target is only what the operator remediates.
  assert.ok(host.excludes.includes("./home/**"), JSON.stringify(host.excludes));
  assert.ok(host.excludes.includes("./root/**"), JSON.stringify(host.excludes));
  // Every exclusion is anchored at a top-level path, so none can cover the system package set, which stays scanned.
  assert.deepEqual(host.excludes.filter((p) => !p.startsWith("./") && p !== "**/node_modules/**"), [], "each excluded path is top-level");
  const top = host.excludes.map((p) => p.replace(/^\.\//, "").replace(/\/\*\*$/, ""));
  for (const dir of ["usr", "opt", "etc", "var/lib/dpkg"]) {
    assert.ok(!top.some((p) => p === dir || dir.startsWith(`${p}/`) || p.startsWith(`${dir}/`)), `${dir} is outside every exclusion: ${JSON.stringify(host.excludes)}`);
  }
});

test("security-sbom: a container with a matching name but no scanner label is never removed", { skip: NOT_LINUX }, async () => {
  // The name is this pass's own (hash and pid), but a name is not proof of ownership: only a container the scanner
  // labelled aidenhq.oneoff is removed before a run.
  const { status, out, calls } = await run();
  assert.equal(status, 0, out);
  const removed = calls.filter((c) => c.startsWith("rm "));
  assert.deepEqual(removed, [], `nothing was removed:\n${calls.join("\n")}`);
  // Every run it started carries the label, so the next pass would recognise its own leftover.
  const runs = calls.filter((c) => c.startsWith("run "));
  assert.ok(runs.length > 0, calls.join("\n"));
  for (const r of runs) assert.match(r, /--label aidenhq\.oneoff=1/, r);
});

/**
 * A throwaway checkout holding a copy of the script and ops/lib/apply-lock.sh: the lock it takes is this tree's
 * data/apply.lock, never the real checkout's, so a suite run during an apply (or an apply during a suite) can't contend
 * with the host's own lock.
 */
function isolatedCheckout(parent) {
  const root = join(parent ?? mkdtempSync(join(tmpdir(), "security-sbom-checkout-")), "checkout");
  mkdirSync(join(root, "ops/lib"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  copyFileSync(script, join(root, "ops/security-sbom.sh"));
  copyFileSync(join(here, "../../ops/lib/apply-lock.sh"), join(root, "ops/lib/apply-lock.sh"));
  return { root, scriptPath: join(root, "ops/security-sbom.sh") };
}

/** Holds a checkout's data/apply.lock on fd 9, as ops/apply-config.sh does, for the length of `fn`. */
async function withApplyLock(root, fn) {
  // Blocked on stdin, not `sleep`: the holder must stay alive until the test's script has run.
  const child = spawn("bash", ["-c", "exec 9>>data/apply.lock; flock -n 9 || { echo busy >&2; exit 3; }; echo locked; read -r _"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("locked")) resolve(); });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the lock holder exited (${code}) before taking the lock`)));
  });
  try {
    return await fn();
  } finally {
    child.kill("SIGKILL");
  }
}

test("security-sbom: a running container whose image record is gone is inventoried from its root filesystem", { skip: NOT_LINUX }, async () => {
  // The tag moved to a build the container does not run, the daemon holds neither the container's own id nor that build,
  // and there is no compose label to fall back to: the image record is gone but the container is in production. Its
  // root filesystem is exported and scanned as a directory under the target the unit already had, with a syft-json file,
  // an empty error, and the container id as provenance in the commit column.
  const { status, out, targets, calls, modes, dir } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096 },
  });
  assert.equal(status, 0, out);
  const row = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(row, `no row for the dropped image:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(row[1], "-", `it was not scanned: ${row[2]}`);
  assert.equal(row[2], "", "a container scan has no error");
  assert.equal(row[3], "container:c1", "the row names the container whose filesystem it read");
  assert.ok(existsSync(join(dir, "data/modules/security/sbom/current", row[1]!)), `the row has no syft-json file on disk: ${row[1]}`);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `nothing was saved:\n${calls.join("\n")}`);
  // This case only means what it claims when the daemon is out of both ways to the image: the inspect the survey runs, and
  // a save. Ask the very fixture the pass just ran against for that save, so a fake that would have answered one of them
  // cannot make the test pass.
  const refused = spawnSync(join(dir, "bin/docker"), ["image", "save", "-o", join(dir, "probe.tar"), "sha256:1111"], {
    env: {
      ...process.env, DIR: dir, CALLS: join(dir, "calls"), HELD: join(dir, "held"), TAGS: join(dir, "tags"),
      SAVE_ERRORS: join(dir, "save-errors"), SAVE_GROW: join(dir, "save-grow"), TAKE_AFTER_SAVE: join(dir, "take-after-save"),
      FREE_TAKEN: join(dir, "free-taken"), SAVED: join(dir, "saved.tar"), PLATFORM_MANIFESTS: join(dir, "platform-manifests"),
    },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0, `the daemon answered a save for an image it does not hold: ${refused.stdout}${refused.stderr}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /No such image: sha256:1111/, "the save refused for a reason other than the image being gone");
  // Criteria 1-3: the export names the unresolvable container, and syft reads the extracted root as a directory with the
  // same target name.
  assert.ok(calls.some((c) => /^export .* -o \S+ c1$/.test(c) || /^export .* c1$/.test(c)), `no export of c1:\n${calls.join("\n")}`);
  const call = calls.find((c) => c.startsWith("run ") && c.includes("--source-name image:sha256:1111"));
  assert.ok(call, `no syft run for the target:\n${calls.join("\n")}`);
  assert.match(call, / dir:\/src /, "the extracted root was scanned as a directory");
  assert.doesNotMatch(call, /docker-archive:/, "the image path was not used for a container with no image");
  // Criterion 7: the extracted root and its tar sit at mode 700 while scanned, outside the scanner's /sbom mount, and the
  // root is a real container root (os-release at ./etc), not a wrapper directory.
  const tree = modes.find((m) => m.startsWith("tree "));
  const dirMode = modes.find((m) => m.startsWith("exportdir "));
  assert.ok(tree, `the extracted root's mode was not read:\n${modes.join("\n")}`);
  assert.match(tree, / 700$/, tree);
  assert.doesNotMatch(tree, /modules\/security\/sbom\//, `the export sits inside the scanner's mount: ${tree}`);
  assert.match(tree, /sbom-exports\//, tree);
  assert.match(dirMode ?? "", / 700$/, `the pass's private directory is not mode 700: ${dirMode}`);
  assert.ok(modes.some((m) => m.startsWith("file ") && m.endsWith("/etc/os-release")), `the root is not a container root: ${modes.join("\n")}`);
  assert.ok(modes.some((m) => /^tar \S+\.tar/.test(m)), `no tar beside the extracted root: ${modes.join("\n")}`);
  // The export never appears under the /sbom mount at any moment of the pass.
  assert.ok(!modes.some((m) => /modules\/security\/sbom\/\.export/.test(m)), `an export sits inside the scanner mount: ${modes.join("\n")}`);
});

test("security-sbom: an image inspect that fails with invalid reference format is inventoried from the container root", { skip: NOT_LINUX }, async () => {
  // A running container's image is an id, and the daemon can be handed a reference it cannot parse at all: "invalid
  // reference format" is the daemon saying it has no image record for that reference, exactly as "No such image" is. The
  // container is then the only copy of the filesystem, so it is inventoried from its root under its own key — a scan row
  // with a real SBOM, not an error line that the scanner's failedAt() guard would read as an unverified image.
  const { status, out, targets, calls, dir } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1576dd87", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    invalidRefs: ["sha256:1576dd87"],
    containerSizes: { c1: 4096 },
  });
  assert.equal(status, 0, out);
  const row = targets.find((t) => t[0] === "image:sha256:1576dd87");
  assert.ok(row, `no row for the invalid-reference container image:
${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(row[1], "-", `it was not scanned: ${row[2]}`);
  assert.equal(row[2], "", "the invalid-reference container scan has no error");
  assert.equal(row[3], "container:c1", "the row names the container whose filesystem it read");
  assert.ok(existsSync(join(dir, "data/modules/security/sbom/current", row[1]!)), `the row has no syft-json file on disk: ${row[1]}`);
  assert.ok(calls.some((c) => /^export .* -o \S+ c1$/.test(c) || /^export .* c1$/.test(c)), `no export of c1:\n${calls.join("\n")}`);
  const call = calls.find((c) => c.startsWith("run ") && c.includes("--source-name image:sha256:1576dd87"));
  assert.ok(call, `no syft run for the target:\n${calls.join("\n")}`);
  assert.match(call, / dir:\/src /, "the extracted root was scanned as a directory");
  assert.ok(!calls.some((c) => c.startsWith("save ")), `nothing was saved:\n${calls.join("\n")}`);
});

test("security-sbom: a container path with a glob character is still checked for a symlink ancestor", { skip: NOT_LINUX }, async () => {
  // A container names its own paths, so one can be `d*` or `lib[1]`. The pass runs from the checkout root, where `d*`
  // expands to `data`. A walk that let the shell expand the ancestor would test the merged root's `data` (an ordinary
  // directory), not the container's own `d*` entry, so the link would go unnoticed and c2's `d*/app/.bash_profile` would
  // be written through it, outside the staged root.
  const { status, out, targets, modes } = await run({
    EXPORT_SYMLINKS: "c1:d*=../../../../../../home/service",
    EXPORT_EXTRAS: "c2:d*/app/.bash_profile=evil",
  }, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local" },
      { id: "c2", image: "sha256:1111", config: "aidenhq/board:local" },
    ],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096, c2: 4096 },
  });
  assert.equal(status, 0, out);
  const row = targets.find((t) => t[0] === "image:sha256:1111");
  assert.equal(row?.[2], "", `the unit errored: ${row?.[2]}\n${modes.join("\n")}`);
  assert.ok(!modes.some((m) => m === "regular d*/app/.bash_profile"), `the merge wrote through a glob-named link: ${modes.join("\n")}`);
  assert.ok(modes.some((m) => m === "link d* ../../../../../../home/service"), `c1's link was dropped: ${modes.join("\n")}`);
  assert.ok(modes.some((m) => m === "regular .replicas/c2/d*/app/.bash_profile"), `c2's file was not kept beside the link: ${modes.join("\n")}`);
});

test("security-sbom: a replica's symlink is never followed, so no file is written outside the staged root", { skip: NOT_LINUX }, async () => {
  // A container controls its own tree. One replica holds `app -> /home/service` (the service user's home on the host) and
  // the other has `app/.bash_profile`: a merge that followed the link through `-d` would write that file to the host as the
  // pass's own user, from container-controlled content. The entry whose ancestor is a symlink is kept beside it instead,
  // and the link itself goes nowhere near the host's /home.
  const { status, out, targets, modes } = await run({
    EXPORT_SYMLINKS: "c1:app=../../../../../../home/service",
    EXPORT_EXTRAS: "c2:app/.bash_profile=evil;c2:.replicas/probe=inside",
  }, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local" },
      { id: "c2", image: "sha256:1111", config: "aidenhq/board:local" },
    ],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096, c2: 4096 },
  });
  assert.equal(status, 0, out);
  const row = targets.find((t) => t[0] === "image:sha256:1111");
  assert.equal(row?.[2], "", `the unit errored: ${row?.[2]}\n${modes.join("\n")}`);
  assert.ok(modes.some((m) => m === "link app ../../../../../../home/service"), `c1's link was dropped: ${modes.join("\n")}`);
  assert.ok(modes.some((m) => m === "regular .replicas-2/c2/app/.bash_profile"), `c2's file was not kept beside the link: ${modes.join("\n")}`);
  assert.ok(!modes.some((m) => m === "regular app/.bash_profile"), `the merge wrote through the container's link: ${modes.join("\n")}`);
  // A container's own `/.replicas` (here a directory with its own file) is the container's, not the pass's: the holding
  // directory takes the next free name instead of putting another replica's files inside the container's tree.
  assert.ok(modes.some((m) => m === "regular .replicas/probe"), `c2's own .replicas was moved: ${modes.join("\n")}`);
});

test("security-sbom: an inspect that fails for another reason is an error line, not a container export", { skip: NOT_LINUX }, async () => {
  // The image still exists, but the daemon's size read fails for a reason other than the image being gone (a timeout, a
  // refused socket, a daemon mid-restart). Exporting the live container then would publish a filesystem scan under the
  // image's target: an inventory of the wrong thing that the absent-tag guards would read as a clean image. Only the
  // daemon's own "No such image" takes the export path.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    sizeErrors: ["sha256:1111"],
    containerSizes: { c1: 4096 },
  });
  assert.equal(status, 0, out);
  assert.deepEqual(calls.filter((c) => c.startsWith("export ")), [], `a live container was exported for a failed inspect:\n${calls.join("\n")}`);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "the target was recorded as scanned");
  assert.match(line[2], /docker image inspect/, line[2]);
});

test("security-sbom: a container export that fails records its image id and the docker error, and the batch still lands", { skip: NOT_LINUX }, async () => {
  // The image record is gone and the container cannot be exported either (a daemon that will not), so the pass records
  // the per-target error naming the target and the daemon's text, and still publishes its batch.
  const { status, out, targets, batchRaw } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096 },
    exportErrors: { c1: "Error response from daemon: cannot export container c1: EOF" },
  });
  assert.equal(status, 0, out);
  assert.ok(batchRaw, "the pass published no batch");
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, `no row for the failed export:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "a failed export was scanned");
  assert.match(line[2], /docker export: .*cannot export container c1/, line[2]);
  assert.ok(!targets.some((t) => t[0] === "image:sha256:1111" && t[1] !== "-"), "the failed target was also scanned");
});

test("security-sbom: a container export that outgrows the room is stopped, recorded, and never extracted", { skip: NOT_LINUX }, async () => {
  // The daemon sized the container at 4 KB, but its export is 8 GB and only 1 GB sits above the floor: the write's cap
  // stops it, and the target is a line rather than a tree that would fill the disk. This is the real shape, where a
  // container's runtime data grows after it was sized.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "32500000" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096 },
    exportGrow: { c1: 8 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "a container whose export outgrew the room was scanned");
  assert.match(line[2], /outgrew the .* GB above the .* GB floor/, line[2]);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name image:sha256:1111")), `an outgrown export was scanned:\n${calls.join("\n")}`);
});

test("security-sbom: the pass removes its private export directory, so no container tar or rootfs is left in data/", { skip: NOT_LINUX }, async () => {
  // Criterion 5: after the swap the batch sits in current/, and the exported tar and extracted tree are gone with the
  // pass's private directory.
  const { status, out, targets, dir } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
    containerSizes: { c1: 4096 },
  });
  assert.equal(status, 0, out);
  assert.ok(targets.some((t) => t[0] === "image:sha256:1111" && t[2] === ""), targets.map((t) => t.join("\t")).join("\n"));
  const sbom = join(dir, "data/modules/security/sbom");
  assert.ok(existsSync(join(sbom, "current/targets.tsv")), "the batch sits in current/");
  assert.ok(!existsSync(join(sbom, ".export")), "the pass's private export directory was left behind");
  assert.ok(!existsSync(join(sbom, ".work")), "the pass's work directory was left behind");
  const leftovers = execFileSync("find", [sbom, "-name", "*.tar"], { encoding: "utf8" }).trim();
  assert.equal(leftovers, "", `a container tar stayed behind:\n${leftovers}`);
});

test("security-sbom: a moved tag with the compose platform manifest is scanned from that manifest's archive", { skip: NOT_LINUX }, async () => {
  // The tag now names sha256:9999, the container runs sha256:1111 whose top-level id the store collected, and compose
  // recorded sha256:2222 as the platform manifest the container actually runs. The target stays the container's id
  // (findings reconcile by target name); the manifest only selects the archive.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    manifests: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:2222"],
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(scanned, `the running image was not scanned:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(scanned[1], "-", `the target reached syft: ${scanned[2]}`);
  assert.ok(!targets.some((t) => t[0] === "image:sha256:2222"), "the manifest id is not a second key for the same image");
  assert.ok(calls.some((c) => c.startsWith("save ") && c.endsWith(" sha256:2222")), `no save of the manifest id:\n${calls.join("\n")}`);
  const call = syft(calls, "image:sha256:1111");
  assert.match(call.line, /docker-archive:\/image\.tar/, "scanned from the saved tar");
  assert.ok(!calls.some((c) => c.startsWith("run ") && / docker:sha256:/.test(c)), `never the daemon source for a bare id:\n${calls.join("\n")}`);
});

test("security-sbom: an apply holding the lock skips the pass and leaves current/ untouched", { skip: NOT_LINUX }, async () => {
  const sentinel = "host\t-\told pass\t\n";
  const { root, scriptPath } = isolatedCheckout();
  const { status, out, batchRaw, calls } = await withApplyLock(root, () => run({}, {
    scriptPath,
    seed: (data) => {
      const dir = join(data, "modules/security/sbom/current");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "targets.tsv"), sentinel);
    },
  }));
  assert.equal(status, 0, out);
  assert.match(out, /security-sbom: an apply holds the apply lock; skipping this pass/);
  assert.equal(batchRaw, sentinel, "the previous batch is left exactly as it was");
  assert.ok(!calls.some((c) => c.startsWith("run ") || c.startsWith("save ")), `nothing was scanned or saved:\n${calls.join("\n")}`);
});

test("security-sbom: a container enumeration that fails keeps the previous batch", { skip: NOT_LINUX }, async () => {
  // A daemon that answers `version` but fails `ps` must not publish a batch with no images: that is the silent gap.
  const sentinel = "host\t-\told pass\t\n";
  const { status, out, batchRaw } = await run({}, {
    psFails: true,
    seed: (data) => {
      const dir = join(data, "modules/security/sbom/current");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "targets.tsv"), sentinel);
    },
  });
  assert.equal(status, 0, out);
  assert.match(out, /could not enumerate containers/);
  assert.equal(batchRaw, sentinel, "the previous batch is the one the scanner still reads");
});

test("security-sbom: a tag that moves mid-pass is read from the image the lock verified", { skip: NOT_LINUX }, async () => {
  // The tag matches the container during the snapshot and is pinned there; after two reads it names a rebuilt image,
  // by the time the pass would scan it. The image must be read from an immutable reference (the container's own id)
  // rather than through the tag, so a rebuild in between can't put the replacement's packages under this target.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    drift: { "aidenhq/board:local": { after: 2, then: "sha256:8888" } },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned, targets.map((t) => t.join("\t")).join("\n"));
  assert.notEqual(scanned[1], "-", `the running image was scanned:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  const call = syft(calls, "image:aidenhq/board:local");
  assert.match(call.line, /docker-archive:\/image\.tar/, "read from the saved archive, not the mutable tag");
  assert.ok(!calls.some((c) => c.includes("docker:aidenhq/board:local")), `never the daemon source for a tag:\n${calls.join("\n")}`);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.endsWith(" sha256:1111")), `the save was not from the pinned id:\n${calls.join("\n")}`);
});

test("security-sbom: a tag that stays put is scanned from its own archive", { skip: NOT_LINUX }, async () => {
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
  assert.match(syft(calls, "image:aidenhq/board:local").line, /docker-archive:\/image\.tar/);
  assert.ok(!calls.some((c) => c.includes("docker:aidenhq/board:local")), calls.join("\n"));
});

test("security-sbom: the apply lock is held through the saves and free during every scan", { skip: NOT_LINUX }, async () => {
  // Two images read from archives: the saves must stay inside the lock, the syft runs outside it, or an apply could
  // rebuild a tag under a scan or wait on one.
  const { status, out, locks } = await run({}, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" },
      { id: "c2", image: "sha256:3333", config: "gate:local", label: "sha256:4444" },
    ],
    tags: { "aidenhq/board:local": "sha256:9999", "gate:local": "sha256:8888" },
    held: ["sha256:2222", "sha256:4444"],
    sizes: { "sha256:2222": 1024, "sha256:4444": 1024 },
  });
  assert.equal(status, 0, out);
  const saves = locks.filter((l) => l.startsWith("save "));
  const runs = locks.filter((l) => l.startsWith("run "));
  assert.ok(saves.length >= 2, locks.join("\n"));
  assert.deepEqual(saves, saves.map(() => "save held"), `every save is under the apply lock:\n${locks.join("\n")}`);
  assert.ok(runs.length > 0, locks.join("\n"));
  assert.deepEqual(runs, runs.map(() => "run free"), `no scan holds the apply lock:\n${locks.join("\n")}`);
});

test("security-sbom: a configured computer image no container runs is inventoried, and a running one is a single target", { skip: NOT_LINUX }, async () => {
  // A job box is ephemeral, so the fleet's current computer images often run in no container at snapshot time. Only
  // config/computers.json says they are in scope: without it the pass would carry their findings unverified for ever.
  const { status, out, targets, calls } = await run({}, {
    computers: { images: { browser: "aidenhq/computer-browser:h1", engineer: "aidenhq/computer-engineer:h2" } },
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb", "aidenhq/computer-engineer:h2": "sha256:eeee" },
    manifests: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb", "aidenhq/computer-engineer:h2": "sha256:eeee" },
    sizes: { "sha256:bbbb": 1024, "sha256:eeee": 1024 },
  });
  assert.equal(status, 0, out);
  const browser = targets.find((t) => t[0] === "image:aidenhq/computer-browser:h1");
  const engineer = targets.find((t) => t[0] === "image:aidenhq/computer-engineer:h2");
  assert.ok(browser, `the configured image no container runs is a target:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.ok(engineer, `the second configured image is a target:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(browser[1], "-", `it reached syft: ${browser[2]}`);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.endsWith(" sha256:bbbb")), `nothing exported the configured image:\n${calls.join("\n")}`);
  assert.match(syft(calls, "image:aidenhq/computer-browser:h1").line, /docker-archive:\/image\.tar/, "it is scanned from its saved archive, not from a tag that may move");
  // The running container's image is not configured, so its own target stays as before.
  assert.ok(targets.some((t) => t[0] === "image:aidenhq/board:local"), targets.map((t) => t.join("\t")).join("\n"));

  // A configured tag naming an image a running container runs is that container's target: the image is inventoried once,
  // under the name its container produces, so its findings keep reconciling by that name.
  const both = await run({}, {
    computers: { images: { browser: "aidenhq/computer-browser:h1" } },
    containers: [{ id: "c1", image: "sha256:bbbb", config: "aidenhq/computer-browser:h1", label: "sha256:bbbb" }],
    tags: { "aidenhq/computer-browser:h1": "sha256:bbbb" },
    manifests: { "aidenhq/computer-browser:h1": "sha256:bbbb" },
    sizes: { "sha256:bbbb": 1024 },
  });
  assert.equal(both.status, 0, both.out);
  const images = both.targets.filter((t) => t[0].startsWith("image:"));
  assert.deepEqual(images.map((t) => t[0]), ["image:aidenhq/computer-browser:h1"], `one target per image, not one per container plus one per tag:\n${images.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(both.calls.filter((c) => c.startsWith("save ")).length, 1, both.calls.join("\n"));
});

test("security-sbom: the batch marks a complete image inventory, and a batch short of its units does not", { skip: NOT_LINUX }, async () => {
  // The scanner only retires an absent image target from a batch that says it listed every running and configured image.
  // A batch missing one of its own units must not carry the marker, or absence would settle findings for an image the
  // inventory simply failed to list.
  const full = await run({}, {
    computers: { images: { browser: "aidenhq/computer-browser:h1" } },
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    manifests: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    sizes: { "sha256:bbbb": 1024 },
  });
  assert.equal(full.status, 0, full.out);
  assert.ok(existsSync(join(full.dir, "data/modules/security/sbom/current/images.complete")), `a complete batch carries the marker:\n${full.targets.map((t) => t.join("\t")).join("\n")}`);

  // 25 GB free, under the 30 GB floor: the configured image cannot be exported, but it still has a line, so the batch is
  // complete (the scanner sees a target with its error, not a target missing from the inventory).
  const short = await run({ FAKE_FREE_KB: "25000000" }, {
    computers: { images: { browser: "aidenhq/computer-browser:h1" } },
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    manifests: { "aidenhq/board:local": "sha256:1111", "aidenhq/computer-browser:h1": "sha256:bbbb" },
  });
  assert.equal(short.status, 0, short.out);
  const line = short.targets.find((t) => t[0] === "image:aidenhq/computer-browser:h1");
  assert.ok(line && line[1] === "-" && /does not fit/.test(line[2]!), `the configured image is a line, not a gap:\n${short.targets.map((t) => t.join("\t")).join("\n")}`);
  assert.ok(existsSync(join(short.dir, "data/modules/security/sbom/current/images.complete")), "an error line is still a row");
});

test("security-sbom: without config/computers.json the previous batch stays, so an incomplete inventory never reads as a pass", { skip: NOT_LINUX }, async () => {
  // The file names the fleet's computer images. Missing, the pass cannot know the image an idle engineer box would run,
  // so publishing what it saw would carry those findings as unverified with nothing telling them apart from a real pass.
  const sentinel = "host\t-\told pass\t\n";
  const seed = (data: string) => {
    const dir = join(data, "modules/security/sbom/current");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "targets.tsv"), sentinel);
  };
  const missing = await run({}, { computers: null, seed });
  assert.equal(missing.status, 0, missing.out);
  assert.match(missing.out, /config\/computers\.json is missing, unreadable or names an image that is not a tag/);
  assert.equal(missing.batchRaw, sentinel, "the previous batch is left exactly as it was");
  assert.ok(!missing.calls.some((c) => c.startsWith("run ") || c.startsWith("save ")), `nothing was scanned or saved:\n${missing.calls.join("\n")}`);

  // A file that names no image, or names one entry that is not a tag, is the same incomplete inventory: the entries must
  // not be silently skipped, since the image a skipped one names would then look retired.
  // A value that is not a reference `docker image inspect` can resolve (whitespace, a shell metacharacter) is refused the
  // same way, rather than becoming a target key nothing scans and every pass then retries.
  for (const config of [
    { images: {} },
    { images: { browser: "aidenhq/computer-browser:h1", engineer: null } },
    { images: { session: "" } },
    { images: { browser: "aidenhq/computer-browser h1" } },
    { images: { browser: "$(touch /tmp/x)" } },
  ]) {
    const bad = await run({}, { computers: config, seed });
    assert.equal(bad.status, 0, bad.out);
    assert.match(bad.out, /names no image|names an image that is not a tag/, bad.out);
    assert.equal(bad.batchRaw, sentinel, `the previous batch is left exactly as it was:\n${JSON.stringify(config)}`);
    assert.ok(!bad.calls.some((c) => c.startsWith("run ") || c.startsWith("save ")), `nothing was scanned or saved:\n${bad.calls.join("\n")}`);
  }
});

test("security-sbom: a container's own platform is what is inspected and exported", { skip: NOT_LINUX }, async () => {
  // An amd64 host running the arm64 variant of a multi-platform image, with no compose label: the daemon resolves the
  // index to its amd64 manifest, but the container's `ImageManifestDescriptor` names the arm64 one it runs. Exporting or
  // sizing through the server platform would publish packages for a variant the container is not running.
  const arm = { digest: "sha256:arm64", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local", descriptor: arm }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    manifests: { "aidenhq/board:local": "sha256:9999", "sha256:index": "sha256:amd64" },
    platformManifests: { "sha256:index": { "linux/arm64/v8": "sha256:arm64" } },
    platformSizes: { "sha256:index": { "linux/arm64/v8": 1024 } },
    held: ["sha256:index"],
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:sha256:index@linux/arm64/v8");
  assert.ok(scanned, targets.map((t) => t.join("\t")).join("\n"));
  assert.notEqual(scanned[1], "-", `the running image was scanned: ${scanned[2]}`);
  const save = calls.find((c) => c.startsWith("save "));
  assert.ok(save, `nothing was exported:\n${calls.join("\n")}`);
  assert.match(save, /--platform linux\/arm64\/v8 /, `the container's platform was not used:\n${save}`);
  assert.ok(!calls.some((c) => c.startsWith("save ") && /--platform linux\/amd64 /.test(c)), `the daemon's platform was exported:\n${calls.join("\n")}`);
  // The compose label is the arm64 manifest the container runs, so the target stays the tag.
  assert.ok(!targets.some((t) => t[0] === "image:sha256:arm64"), "the manifest id is not a second key for the same image");
});

test("security-sbom: two containers running one index on different platforms are two targets", { skip: NOT_LINUX }, async () => {
  // One amd64 service and one emulated arm64 service run the same multi-platform index. Keying only by `.Image` would let
  // the second variant share the first's archive and publish nothing for it; each variant must be its own target.
  const amd64 = { digest: "sha256:amd64", platform: { os: "linux", architecture: "amd64" } };
  const arm64 = { digest: "sha256:arm64", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const { status, out, targets, calls } = await run({}, {
    containers: [
      { id: "c1", image: "sha256:index", config: "board:local", label: "sha256:amd64", descriptor: amd64 },
      { id: "c2", image: "sha256:index", config: "board:local", label: "sha256:arm64", descriptor: arm64 },
    ],
    tags: { "board:local": "sha256:amd64" },
    manifests: { "board:local": "sha256:amd64" },
    platformManifests: {
      "board:local": { "linux/amd64": "sha256:amd64", "linux/arm64/v8": "sha256:arm64" },
      "sha256:index": { "linux/amd64": "sha256:amd64", "linux/arm64/v8": "sha256:arm64" },
    },
    platformSizes: { "sha256:index": { "linux/amd64": 1024, "linux/arm64/v8": 1024 } },
    held: ["sha256:index"],
  });
  assert.equal(status, 0, out);
  const images = targets.filter((t) => t[0].startsWith("image:"));
  assert.equal(images.length, 2, `one target per running variant:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  // The variant on the daemon's own platform keeps the plain tag key, so target names do not move when a variant comes or
  // goes; only the other variant is suffixed.
  assert.ok(images.some((t) => t[0] === "image:board:local"), `the native variant kept the plain key:\n${images.map((t) => t.join("\t")).join("\n")}`);
  assert.ok(images.some((t) => t[0] === "image:board:local@linux/arm64/v8"), `the emulated variant got its own key:\n${images.map((t) => t.join("\t")).join("\n")}`);
  const saves = calls.filter((c) => c.startsWith("save "));
  assert.equal(saves.length, 2, `one archive per variant:\n${calls.join("\n")}\ntargets:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.ok(saves.some((c) => /--platform linux\/amd64 /.test(c)), saves.join("\n"));
  assert.ok(saves.some((c) => /--platform linux\/arm64\/v8 /.test(c)), saves.join("\n"));
});

test("security-sbom: a set whose archives plus the largest exceed the room is scanned in waves, every image scanned", { skip: NOT_LINUX }, async () => {
  // 60 GB free, a 30 GB floor: 30 GB of room. The five archives total 40 GB and the largest is 10 GB, so the whole set at
  // once needs 50 GB and cannot fit. Scanned in waves, each wave's archives plus its largest fit: 6+7+8 GB with 8 GB
  // unpacked is 29 GB, and 9+10 GB with 10 GB unpacked is 29 GB. Every image must be inventoried, with no skip line, and
  // the second wave's saves must run only after the first wave's scans have freed their archives.
  const ids = ["sha256:a1", "sha256:a2", "sha256:a3", "sha256:a4", "sha256:a5"];
  const sizes = [6, 7, 8, 9, 10];
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "62914560" }, {
    containers: ids.map((id, i) => ({ id: `c${i + 1}`, image: id, config: `svc${i + 1}:local`, label: id })),
    tags: Object.fromEntries(ids.map((id, i) => [`svc${i + 1}:local`, id])),
    held: ids,
    sizes: Object.fromEntries(ids.map((id, i) => [id, sizes[i] * 1024 ** 3])),
  });
  assert.equal(status, 0, out);
  const rows = targets.filter((t) => t[0].startsWith("image:"));
  assert.equal(rows.length, ids.length, rows.map((t) => t.join("\t")).join("\n"));
  for (const row of rows) assert.notEqual(row[1], "-", `${row[0]} was skipped: ${row[2]}`);
  assert.ok(!rows.some((t) => /does not fit|skipped/.test(t[2])), `a target was space-skipped:\n${rows.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(calls.filter((c) => c.startsWith("save ")).length, ids.length);
  const firstScan = calls.findIndex((c) => c.startsWith("run ") && c.includes("--source-name image:"));
  const lastSave = calls.map((c, i) => (c.startsWith("save ") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const secondWaveSave = calls.findIndex((c, i) => i > firstScan && c.startsWith("save "));
  assert.ok(secondWaveSave > firstScan, `a later wave was saved before the first wave's scans freed its archives:\n${calls.join("\n")}`);
  assert.ok(lastSave > firstScan, "every save must be accounted for");
});

test("security-sbom: a save that overshoots its estimate is deleted rather than left under the floor", { skip: NOT_LINUX }, async () => {
  // 40 GB free, a 30 GB floor: 10 GB of room. The daemon reports a 5 GB image, but the save would write 15 GB and take
  // the disk under the floor. The write is capped at the room above the floor, so the kernel stops it before the host's
  // reserve is spent, the partial archive is removed, and the image is a line naming the room it outgrew.
  const { status, out, targets } = await run({ FAKE_FREE_KB: String(40 * 1024 * 1024) }, {
    containers: [{ id: "c1", image: "sha256:b1", config: "big1:local", label: "sha256:b1" }],
    tags: { "big1:local": "sha256:b1" },
    held: ["sha256:b1"],
    sizes: { "sha256:b1": 5 * 1024 ** 3 },
    saveGrow: { "sha256:b1": 15 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const row = targets.find((t) => t[0] === "image:big1:local");
  assert.ok(row, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(row[1], "-", "the overshooting save is not scanned");
  assert.match(row[2], /archive outgrew the 10 GB above the 30 GB floor/);
  assert.doesNotMatch(row[2], /^15 GB/);
});

test("security-sbom: a compose label that disagrees with the container's digest does not take the tag's target", { skip: NOT_LINUX }, async () => {
  // The tag was rebuilt with a new arm64 variant only; the stale arm64 container still runs the old one, while the tag's
  // amd64 variant still matches the compose label. The descriptor is the authority, so the tag must not be used as this
  // container's target with a different manifest under it.
  const arm = { digest: "sha256:aaaa", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  // The configured fleet tag is some other image, so this fixture is only about the container's own target.
  const { status, out, targets } = await run({}, {
    computers: { images: { browser: "aidenhq/computer-browser:h1" } },
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local", label: "sha256:amd64", descriptor: arm }],
    tags: { "aidenhq/board:local": "sha256:amd64", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    manifests: { "aidenhq/board:local": "sha256:amd64", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    platformManifests: { "aidenhq/board:local": { "linux/amd64": "sha256:amd64" } },
    held: ["sha256:index", "sha256:bbbb"],
    sizes: { "sha256:index": 1024, "sha256:bbbb": 1024 },
  });
  assert.equal(status, 0, out);
  // The tag names a different manifest than the one this container runs, so the target stays the container's own id and
  // the tag never appears as a target key for it.
  assert.equal(targets.find((t) => t[0] === "image:aidenhq/board:local"), undefined, `the tag took another manifest's target:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  const own = targets.find((t) => t[0] === "image:sha256:aaaa@linux/arm64/v8");
  assert.ok(own, `the running variant keeps its own target:\n${targets.map((t) => t.join("\t")).join("\n")}`);
});

test("security-sbom: a variant's key does not move when another variant appears", { skip: NOT_LINUX }, async () => {
  // The same emulated arm64 container, alone and then beside an amd64 one. Its target name must be the same in both
  // passes: the scanner reconciles findings by exact target name, so a name that depended on how many variants run would
  // leave the first pass's findings unverified the moment a second variant started.
  const arm = { digest: "sha256:a1a1", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const amd64 = { digest: "sha256:b2b2", platform: { os: "linux", architecture: "amd64" } };
  // The configured fleet tag is some other image, so the keys below are only the container variants'.
  const fixture = (extra) => ({
    computers: { images: { browser: "aidenhq/computer-browser:h1" } },
    containers: [extra, { id: "c9", image: "sha256:index", config: "board:local", descriptor: arm }].filter(Boolean),
    tags: { "board:local": "sha256:b2b2", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    manifests: { "board:local": "sha256:b2b2", "aidenhq/computer-browser:h1": "sha256:bbbb" },
    platformManifests: {
      "board:local": { "linux/amd64": "sha256:b2b2", "linux/arm64/v8": "sha256:a1a1" },
      "sha256:index": { "linux/amd64": "sha256:b2b2", "linux/arm64/v8": "sha256:a1a1" },
    },
    platformSizes: { "sha256:index": { "linux/amd64": 1024, "linux/arm64/v8": 1024 } },
    held: ["sha256:index", "sha256:bbbb"],
    sizes: { "sha256:bbbb": 1024 },
  });
  const alone = await run({}, fixture(null));
  assert.equal(alone.status, 0, alone.out);
  const aloneKeys = alone.targets.filter((t) => t[0].startsWith("image:board:local")).map((t) => t[0]);
  assert.deepEqual(aloneKeys, ["image:board:local@linux/arm64/v8"], aloneKeys.join("\n"));

  const beside = await run({}, fixture({ id: "c1", image: "sha256:index", config: "board:local", descriptor: amd64 }));
  assert.equal(beside.status, 0, beside.out);
  const besideKeys = beside.targets.filter((t) => t[0].startsWith("image:board:local")).map((t) => t[0]).sort();
  assert.deepEqual(besideKeys, ["image:board:local", "image:board:local@linux/arm64/v8"], besideKeys.join("\n"));
});

test("security-sbom: a daemon older than API 1.48 exports without --platform instead of failing every image", { skip: NOT_LINUX }, async () => {
  // `docker image save --platform` needs API 1.48; on a 27.x daemon (API 1.47) asking for it fails every export and the
  // pass would turn a usable batch into error rows. The pass must fall back to a plain save and say so, and the archive
  // that save writes has to prove the running image.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "one", FAKE_SAVE_PIN: "sha256:1111" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    heldIds: ["sha256:1111"],
  });
  assert.equal(status, 0, out);
  assert.match(out, /Docker API 1\.47 predates image save --platform/);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
  const save = calls.find((c) => c.startsWith("save "));
  assert.ok(save, calls.join("\n"));
  assert.doesNotMatch(save, /--platform/, `a plain save was not used:\n${save}`);
});

test("security-sbom: a pre-1.48 daemon does not plain-save a tag whose archive holds several platforms", { skip: NOT_LINUX }, async () => {
  // On a containerd store an old daemon's plain save of a tag writes every platform it holds; the archive would contain
  // variants the container does not run and the size check would not cover it. The save runs, and its archive has to
  // prove one image: two manifests is a line, never a scan under the running variant's target.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "multi" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    // The container's own id is gone, so the only reference that can export is the tag itself.
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, `no tag target:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "a multi-platform archive was scanned");
  assert.match(line[2], /names 2 manifests/, line[2]);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name image:")), `a multi-platform archive was scanned:\n${calls.join("\n")}`);
});

test("security-sbom: a pre-1.48 daemon refuses an archive it cannot verify", { skip: NOT_LINUX }, async () => {
  // Neither index.json nor manifest.json is not proof of one image: a truncated or unexpected archive is a line, never a
  // scan attributed to a variant nothing confirmed.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "none" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "an unverifiable archive was scanned");
  assert.match(line[2], /neither index\.json nor manifest\.json/, line[2]);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name image:")), calls.join("\n"));
});

test("security-sbom: a pre-1.48 daemon refuses an archive of another image than the one running", { skip: NOT_LINUX }, async () => {
  // A single descriptor is not enough either: it has to be the platform manifest the container runs, or the pass would
  // file another build's packages under this target.
  const { status, out, targets } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "one", FAKE_SAVE_PIN: "sha256:9999" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "another image's archive was scanned");
  assert.match(line[2], /not the running image/, line[2]);
});

test("security-sbom: a pre-1.48 daemon scans a plain save whose archive holds one image", { skip: NOT_LINUX }, async () => {
  // The same fallback, with an archive that proves one manifest: the running image is scanned instead of the pass
  // publishing a line for every image on an older daemon.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "one", FAKE_SAVE_PIN: "sha256:1111" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
  assert.ok(calls.some((c) => c.startsWith("save ") && !c.includes("--platform")), calls.join("\n"));
});


test("security-sbom: an app checkout that is a symlink to another tree is a line naming where it resolved, and is not scanned", { skip: NOT_LINUX }, async () => {
  // Docker resolves symlinks in a bind source, so a link into the product tree scanned that tree while the rows still
  // named the app: every finding read as the app's. The scan root must be the app's own checkout, and one that resolves
  // elsewhere is a line naming both paths rather than a scan of whatever the link points at.
  const { root, scriptPath } = isolatedCheckout();
  const elsewhere = join(root, "shared/product-checkout");
  const platform = join(root, "data/apps/.platform");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "package-lock.json"), "{}\n");
  mkdirSync(join(platform, "roadmap-keeper"), { recursive: true });
  symlinkSync(elsewhere, join(platform, "roadmap-keeper/src"));
  const { status, out, targets, calls } = await run({}, { scriptPath });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "app:roadmap-keeper");
  assert.ok(line, `no line for the linked app checkout:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "the linked checkout was not scanned");
  assert.ok(line[2].includes(elsewhere), `the line names what the link resolved to: ${line[2]}`);
  assert.ok(line[2].includes(join(platform, "roadmap-keeper/src")), `and the path it should have been: ${line[2]}`);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name app:roadmap-keeper")),
    `a symlinked checkout was handed to syft:\n${calls.join("\n")}`);
});

test("security-sbom: an ordinary app checkout is scanned and its row carries the checkout's HEAD", { skip: NOT_LINUX }, async () => {
  // An app's own checkout still scans, and its row names the tree those rows came from the way repo: targets do, so a
  // batch says which app commit it read.
  const { root, scriptPath } = isolatedCheckout();
  const src = join(root, "data/apps/.platform/roadmap-keeper/src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "package-lock.json"), "{}\n");
  execFileSync("git", ["-C", src, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", src, "add", "-A"]);
  execFileSync("git", ["-C", src, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "app tree"]);
  const head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const { status, out, targets, calls } = await run({}, { scriptPath });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "app:roadmap-keeper");
  assert.ok(line, `no row for the app checkout:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(line[1], "-", `the checkout reached syft: ${line[2]}`);
  assert.equal(line[3], head, "the row names the checkout's HEAD");
  assert.match(syft(calls, "app:roadmap-keeper").line, new RegExp(`-v ${src}:/src:ro`), "scanned from the app's own checkout");
});

test("security-sbom: an app checkout with no git of its own still scans and records an empty commit", { skip: NOT_LINUX }, async () => {
  // apps-mcp writes a deployed app's files into src from its bare repo under data/apps-mcp/git, so the checkout is not a
  // git repo of its own (and git run in it would answer with the product checkout it sits inside). It scans; the commit
  // column is empty rather than the product's HEAD, which would name a tree the rows did not come from.
  const { root, scriptPath } = isolatedCheckout();
  const src = join(root, "data/apps/.platform/roadmap-keeper/src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "package-lock.json"), "{}\\n");
  // The product checkout the app's data sits inside, committed: without the guard, git run in src would answer with its
  // HEAD, and the row would name a tree these rows did not come from.
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "tree"]);
  const { status, out, targets, calls } = await run({}, { scriptPath });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "app:roadmap-keeper");
  assert.ok(line, `no row for the app checkout:\\n${targets.map((t) => t.join("\\t")).join("\\n")}`);
  assert.notEqual(line[1], "-", `the checkout reached syft: ${line[2]}`);
  assert.equal(line[3], "", "no tree is named for a checkout that is not its own repo");
  assert.match(syft(calls, "app:roadmap-keeper").line, new RegExp(`-v ${src}:/src:ro`));
});

describe("security-sbom", { concurrency: Math.max(4, availableParallelism()) }, () => {
  for (const args of tests) nodeTest(...args);
});
