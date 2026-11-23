// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  manifests = {},
  sizes = {},
  heldIds = [],
  noDescriptorField = false,
  platformManifests = {},
  platformSizes = {},
  held = null,
  inspectErrors = [],
  saveErrors = {},
  saveGrow = {},
  sizeErrors = [],
  sizeJunk = {},
  seed,
  psFails = false,
  psFailsFrom = 0,
  inspectFails = [],
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
  const sizesFile = join(dir, "sizes");
  const sizeErrorsFile = join(dir, "size-errors");
  const sizeJunkFile = join(dir, "size-junk");
  const platformManifestsFile = join(dir, "platform-manifests");
  const platformSizesFile = join(dir, "platform-sizes");
  // The Docker socket's group for `stat -c %g /var/run/docker.sock`; everything else is the real stat, so a size read on
  // an archive (`stat -c %s`) is the archive's own, as on the host.
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\nif [ \"$1\" = -c ] && [ \"$2\" = %g ]; then echo 0; exit 0; fi\nexec /usr/bin/stat \"$@\"\n");
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
kb=$(( \${FAKE_FREE_KB:-400000000} - \${used:-0} ))
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/md2 481000000 1 %s 1%% /\\n' "$kb"
`);
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
# A fake daemon: containers (id<TAB>.Image<TAB>.Config.Image<TAB>compose image label\`), the tag table (ref<TAB>
# top-level id<TAB>platform manifest) and the image ids it holds. Every syft run and save is logged.
lockstate() { if [ -n "$FAKE_APPLY_LOCK" ] && flock -n "$FAKE_APPLY_LOCK" -c true 2>/dev/null; then echo free; else echo held; fi; }
case "$1" in run|save) printf '%s\\n' "$*" >> "$CALLS" ;; esac
[ "$1" = run ] && printf 'run %s\\n' "$(lockstate)" >> "$LOCKS"
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
  ( exec 9>>"$FAKE_APPLY_LOCK"; flock 9; : > "$marker"
    while [ -f "$marker" ]; do sleep 0.05; done ) >/dev/null 2>&1 </dev/null &
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
    nps=0; [ -f "$DIR/ps-count" ] && read -r nps < "$DIR/ps-count"; nps=$((nps + 1)); printf '%s\\n' "$nps" > "$DIR/ps-count"
    if [ "$PS_FAILS" = 1 ] || { [ -n "\${PS_FAILS_NTH:-}" ] && [ "$nps" -ge "$PS_FAILS_NTH" ]; }; then
      echo "Error response from daemon: cannot list containers" >&2; exit 1
    fi
    printf '%s\\n' ${containers.map((c) => `'${c.id}'`).join(" ")} ;;
  inspect)
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
          # reference's archive exactly that many bytes, as a save's real bytes can exceed the inspect size a little.
          grow="$(awk -F '\t' -v ref="$id" '$1 == ref { print $2; found = 1 }' "$SAVE_GROW" 2>/dev/null)"
          [ -n "$grow" ] && truncate -s "$grow" "$file"
        fi
        : > "$SAVED"; exit 0
      fi
      echo "Error response from daemon: No such image: $id" >&2; exit 1
    fi
    if [ "$1" = inspect ]; then
      shift
      col=2; plat_req=""
      if [ "$1" = --platform ]; then plat_req="$2"; shift 2; fi
      if [ "$1" = -f ] && [ "$2" = '{{.Size}}' ]; then
        # An image's size on disk, for the room its save and unpack need.
        shift 2
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
  save) exit 0 ;;
esac
exit 0
`);
  for (const f of ["stat", "docker", "df", "tar"]) chmodSync(join(dir, "bin", f), 0o755);
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
  writeFileSync(sizesFile, Object.entries(sizes).map(([ref, bytes]) => `${ref}\t${bytes}`).join("\n") + "\n");
  writeFileSync(sizeErrorsFile, sizeErrors.join("\n") + "\n");
  writeFileSync(sizeJunkFile, Object.entries(sizeJunk).map(([ref, out]) => `${ref}\t${out}`).join("\n") + "\n");
  writeFileSync(join(dir, "labelled"), ""); // containers this fake daemon reports as this scanner's own
  const scriptPath_ = scriptPath ?? isolatedCheckout(dir).scriptPath;
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
        SAVE_ERRORS: saveErrorsFile, SAVE_GROW: growFile, SAVED: join(dir, "saved.tar"), CLEAN: join(dir, "clean"), SIZES: sizesFile, LABELLED: join(dir, "labelled"), SIZE_ERRORS: sizeErrorsFile, SIZE_JUNK: sizeJunkFile, PLATFORM_MANIFESTS: platformManifestsFile, PLATFORM_SIZES: platformSizesFile, PS_FAILS: psFails ? "1" : "", NO_DESCRIPTOR_FIELD: noDescriptorField ? "1" : "", PS_FAILS_NTH: psFailsFrom ? String(psFailsFrom) : "", INSPECT_FAILS: inspectFails.join(" "), DRIFT: join(dir, "drift"), DRIFT_COUNT: join(dir, "drift-count"), LOCKS: join(dir, "locks"), FAKE_APPLY_LOCK: join(dirname(dirname(scriptPath_)), "data/apply.lock"),
        DIR: dir, ...env,
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  const batch = join(data, "modules/security/sbom/current/targets.tsv");
  const batchRaw = existsSync(batch) ? readFileSync(batch, "utf8") : null;
  const targets = batchRaw ? batchRaw.split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  return {
    ...r, targets, batchRaw, root: dirname(scriptPath_), dir,
    locks: existsSync(join(dir, "locks")) ? readFileSync(join(dir, "locks"), "utf8").trim().split("\n").filter(Boolean) : [],
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
    workStates: existsSync(join(dir, "clean")) ? readFileSync(join(dir, "clean"), "utf8").trim().split("\n").filter(Boolean) : [],
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

test("security-sbom: a running container whose image is gone is a line naming the id and the error, never a gap", { skip: NOT_LINUX }, async () => {
  // The tag moved to a build the container does not run, the daemon holds neither the container's own id nor that build,
  // and there is no compose label to fall back to: the container's image is gone and the pass must say so.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: [],
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, `no line for the dropped image:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "it was not scanned");
  assert.match(line[2], /No such image/, "the line names the error");
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name image:sha256:1111")), calls.join("\n"));
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

test("security-sbom: a manifest with no image record of its own is exported from the index that holds it", { skip: NOT_LINUX }, async () => {
  // On the containerd store a platform manifest inside a multi-platform index is not an image record: a bare digest
  // names nothing. The index in `held` still contains it, so the pass must resolve through that index rather than drop
  // the container with "No such image".
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999", "sha256:index": "sha256:index" },
    manifests: { "aidenhq/board:local": "sha256:9999", "sha256:index": "sha256:2222" },
    held: ["sha256:index"],
    sizes: { "sha256:2222": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:sha256:index");
  assert.ok(scanned, `the running image was not scanned:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(scanned[1], "-", `the target reached syft: ${scanned[2]}`);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.includes("sha256:index")), `nothing exported the holding index:\n${calls.join("\n")}`);
  assert.match(syft(calls, "image:sha256:index").line, /docker-archive:\/image\.tar/);
  assert.ok(!targets.some((t) => t[0] === "image:sha256:2222"), "the manifest id is not a second key for the same image");
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

test("security-sbom: an inspect that fails for a container still running keeps the previous batch", { skip: NOT_LINUX }, async () => {
  const sentinel = "host\t-\told pass\t\n";
  const { status, out, batchRaw } = await run({}, {
    inspectFails: ["c1"],
    seed: (data) => {
      const dir = join(data, "modules/security/sbom/current");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "targets.tsv"), sentinel);
    },
  });
  assert.equal(status, 0, out);
  assert.match(out, /docker inspect failed for running container c1/);
  assert.equal(batchRaw, sentinel);
});

test("security-sbom: an image that cannot fit is a line, and no save is written for it", { skip: NOT_LINUX }, async () => {
  // 25 GB free, under the 30 GB floor: the target is recorded before `docker save` can fill the disk.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "25000000" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:2222"],
    sizes: { "sha256:2222": 30 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-");
  assert.match(line[2], /does not fit/);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `a save ran below the floor:\n${calls.join("\n")}`);
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

test("security-sbom: with the lock free the same fixture produces the full target list", { skip: NOT_LINUX }, async () => {
  const { status, out, targets } = await run();
  assert.equal(status, 0, out);
  const names = targets.map((t) => t[0]);
  assert.ok(names.includes("host"), names.join(","));
  assert.ok(names.includes("image:aidenhq/board:local"), names.join(","));
  assert.ok(names.some((t) => t.startsWith("repo:product")), names.join(","));
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

test("security-sbom: a container whose own id is exportable is scanned from that id, not dropped", { skip: NOT_LINUX }, async () => {
  // A container started without compose: no label. Its tag moved to another build, but the container's own index is
  // still held and contains the running platform. `pin_of` resolves that index to the platform manifest, so an equality
  // test against the manifest alone would reject the very reference that can export the image.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    manifests: { "aidenhq/board:local": "sha256:9999", "sha256:index": "sha256:2222" },
    held: ["sha256:index"],
    sizes: { "sha256:index": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:sha256:index");
  assert.ok(scanned, `the running image was not scanned:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(scanned[1], "-", `it reached syft: ${scanned[2]}\n${calls.join("\n")}`);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.includes("sha256:index")), `the own id was not exported:\n${calls.join("\n")}`);
  assert.match(syft(calls, "image:sha256:index").line, /docker-archive:\/image\.tar/);
  assert.doesNotMatch(scanned[2], /No such image/, "it is not recorded as a gap");
});

test("security-sbom: a failed follow-up listing keeps the previous batch", { skip: NOT_LINUX }, async () => {
  // The batched inspect fails, one container then inspects fine and another keeps failing, and the re-list that decides
  // "gone or still running" itself fails. Treating that as an empty list would publish a partial batch.
  const sentinel = "host\t-\told pass\t\n";
  const { status, out, batchRaw } = await run({}, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local" },
      { id: "c2", image: "sha256:3333", config: "gate:local" },
    ],
    tags: { "aidenhq/board:local": "sha256:1111", "gate:local": "sha256:3333" },
    inspectFails: ["c2"],
    psFailsFrom: 2,
    seed: (data) => {
      const dir = join(data, "modules/security/sbom/current");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "targets.tsv"), sentinel);
    },
  });
  assert.equal(status, 0, out);
  assert.match(out, /could not re-list containers/);
  assert.equal(batchRaw, sentinel, "the previous batch is the one the scanner still reads");
});

test("security-sbom: a Docker save that stops answering is cut off by the snapshot deadline", { skip: NOT_LINUX }, async () => {
  // The save hangs and the snapshot budget is two seconds. The call must be terminated, the image recorded as a line, and
  // the pass must finish (releasing the apply lock) rather than hold it while an apply waits.
  const started = Date.now();
  const { status, out, targets, locks } = await run({ AIDENHQ_SBOM_SNAPSHOT_SECS: "2", FAKE_SAVE_SLEEP: "20" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:2222"],
    sizes: { "sha256:2222": 1024 },
  });
  const took = (Date.now() - started) / 1000;
  assert.equal(status, 0, out);
  assert.ok(took < 15, `the pass held the lock for ${took}s on a 2s budget`);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, `the image was not recorded:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "it was not scanned");
  assert.ok(locks.every((l) => l.startsWith("save held") || l.startsWith("run free")), locks.join("\n"));
});

test("security-sbom: reading the archive back is bounded by the snapshot deadline too", { skip: NOT_LINUX }, async () => {
  // The plain-save check reads the archive while the apply lock is still held. A multi-GB archive on slow storage must not
  // hold the lock past the budget: the read is cut off, the image is a line, and the pass finishes.
  const started = Date.now();
  const { status, out, targets, locks } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "one", FAKE_SAVE_PIN: "sha256:1111", AIDENHQ_SBOM_SNAPSHOT_SECS: "3", FAKE_ARCHIVE_SLEEP: "30" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  const took = (Date.now() - started) / 1000;
  assert.equal(status, 0, out);
  assert.ok(took < 20, `the pass held the lock for ${took}s on a 3s budget`);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "an archive whose check timed out was scanned");
  assert.match(line[2], /snapshot deadline reached while checking the archive/, line[2]);
  assert.ok(locks.every((l) => l.startsWith("save held") || l.startsWith("run free")), locks.join("\n"));
});

test("security-sbom: a tagged image that cannot fit is a line and saves nothing", { skip: NOT_LINUX }, async () => {
  // 31 GB free, a 30 GB floor: one GB of room above the floor. A tagged image whose archive needs more than that must be
  // a line before any `docker save` writes, not a save that fills the disk and a check afterwards.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "31000000" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    sizes: { "aidenhq/board:local": 4 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "it was not scanned");
  assert.match(line[2], /does not fit/);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `a save ran with one GB above the floor:\n${calls.join("\n")}`);
});

test("security-sbom: an image is sized through any local reference that can export it", { skip: NOT_LINUX }, async () => {
  // The container's own id is gone and its bare platform manifest is not an image record, but another local tag points at
  // an index that holds that manifest. Resolving an export reference before the size check keeps the image scanable
  // rather than recording it as unreadable.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:gone", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999", "other:local": "sha256:index" },
    manifests: { "aidenhq/board:local": "sha256:9999", "other:local": "sha256:2222" },
    held: ["sha256:index"],
    sizes: { "other:local": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:sha256:gone");
  assert.ok(scanned, `the running image was not scanned:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.notEqual(scanned[1], "-", `it reached syft: ${scanned[2]}\n${calls.join("\n")}`);
  assert.doesNotMatch(scanned[2], /no local image exports|No such image/);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.endsWith(" other:local")), `the other tag did not export it:\n${calls.join("\n")}`);
  assert.match(syft(calls, "image:sha256:gone").line, /docker-archive:\/image\.tar/);
});

test("security-sbom: two images whose archives and workspaces fit are both scanned", { skip: NOT_LINUX }, async () => {
  // 60 GB free, a 30 GB floor: 30 GB of room. Both 5 GB archives stay on disk until their scans (10 GB), and the scan of
  // either unpacks its own 5 GB beside them: 15 GB, which fits. Charging every image its own workspace up front, or
  // charging an archive twice, would reject the second for no reason.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "60000000" }, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" },
      { id: "c2", image: "sha256:3333", config: "gate:local", label: "sha256:4444" },
    ],
    tags: { "aidenhq/board:local": "sha256:9999", "gate:local": "sha256:8888" },
    held: ["sha256:2222", "sha256:4444"],
    sizes: { "sha256:2222": 5 * 1024 ** 3, "sha256:4444": 5 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  for (const name of ["image:sha256:1111", "image:sha256:3333"]) {
    const scanned = targets.find((t) => t[0] === name);
    assert.ok(scanned, targets.map((t) => t.join("\t")).join("\n"));
    assert.notEqual(scanned[1], "-", `${name} was not scanned: ${scanned[2]}`);
  }
  assert.equal(calls.filter((c) => c.startsWith("save ")).length, 2);
});

test("security-sbom: an image is sized as the reference that is exported, not another that answers", { skip: NOT_LINUX }, async () => {
  // The running platform is held by `other:local` (an index), and the container's own id resolves to nothing. Sizing must
  // read the index that will be saved, not fall back to a size the pass never proved covers the export.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "35000000" }, {
    containers: [{ id: "c1", image: "sha256:gone", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999", "other:local": "sha256:index" },
    manifests: { "aidenhq/board:local": "sha256:9999", "other:local": "sha256:2222" },
    held: ["sha256:index"],
    // The index the save reads is 40 GB: it cannot fit in the 5 GB above the floor, whatever else might answer.
    sizes: { "other:local": 40 * 1024 ** 3, "sha256:gone": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:gone");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "the oversized export was not scanned");
  assert.match(line[2], /does not fit/);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `a save ran for an image that does not fit:\n${calls.join("\n")}`);
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

test("security-sbom: a moved tag on an emulated container is a line unless the tag names its own platform", { skip: NOT_LINUX }, async () => {
  // The tag moved to a rebuilt image; the container runs the arm64 variant whose manifest no local reference holds. The
  // tag resolves to a different arm64 build, so the pass must say so rather than export the amd64 variant the daemon
  // would otherwise answer.
  const arm = { digest: "sha256:arm64", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local", descriptor: arm }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    manifests: { "aidenhq/board:local": "sha256:9999" },
    platformManifests: { "aidenhq/board:local": { "linux/arm64/v8": "sha256:other-arm" } },
    // The container's own index is gone and no reference holds its arm64 manifest.
    held: ["sha256:some-other-index"],
  });
  assert.equal(status, 0, out);
  // The only variant here runs off the daemon's platform, so its key carries the platform: the plain key belongs to the
  // daemon's own platform alone, and a suffix that appears or goes with other variants would move the target's name.
  const line = targets.find((t) => t[0] === "image:sha256:index@linux/arm64/v8");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "a different arm64 build was not scanned");
  assert.match(line[2], /No such image|did not resolve|moved/, line[2]);
  assert.ok(!calls.some((c) => c.startsWith("save ") && /--platform linux\/amd64 /.test(c)), `the daemon's platform was exported:\n${calls.join("\n")}`);
});

test("security-sbom: a daemon without a platform descriptor keeps the server platform and says so", { skip: NOT_LINUX }, async () => {
  // An older daemon or a single-platform store reports no `ImageManifestDescriptor`. The pass then reads on the server
  // platform, as before, and prints how many containers it did that for, so a platform assumption is never silent.
  const { status, out, targets } = await run();
  assert.equal(status, 0, out);
  assert.match(out, /1 container\(s\) report no platform manifest descriptor; read on the Docker server platform linux\/amd64/);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
});

test("security-sbom: a daemon whose template has no descriptor field still publishes on the server platform", { skip: NOT_LINUX }, async () => {
  // `ImageManifestDescriptor` is a field a daemon either has or does not; asking for it on an older one fails the whole
  // template. The pass must fall back to the older template and read on the server platform, not keep the old batch
  // forever because docker refuses the format.
  const { status, out, targets } = await run({ NO_DESCRIPTOR_FIELD: "1" }, {
    noDescriptorField: true,
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    heldIds: ["sha256:1111"],
  });
  assert.equal(status, 0, out);
  assert.match(out, /1 container\(s\) report no platform manifest descriptor; read on the Docker server platform linux\/amd64/);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
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

test("security-sbom: a target no wave can hold is a line naming the admitted total, its size, the largest and the room", { skip: NOT_LINUX }, async () => {
  // 40 GB free, a 30 GB floor: 10 GB of room. A 6 GB image needs its 6 GB archive held to scan plus 6 GB to unpack it, 12 GB
  // in all, which no wave of 10 GB ever has. The line must state the budget that decided it rather than "6 GB does not fit
  // in 10 GB", which reads as though the image alone were over the room.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "41943040" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:2222"],
    sizes: { "sha256:2222": 6 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-");
  assert.match(line[2], /admitted 0 GB of archives/);
  assert.match(line[2], /this 6 GB image/);
  assert.match(line[2], /largest archive 6 GB/);
  assert.match(line[2], /room 10 GB above the 30 GB floor/);
  assert.match(line[2], /short by 2 GB/);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `a save ran for an image no wave can hold:\n${calls.join("\n")}`);
});

test("security-sbom: an apply that takes the lock between waves leaves those images as lines, not gaps", { skip: NOT_LINUX }, async () => {
  // The first wave exports and scans; an apply starts while the scans run and holds the apply lock, so the second wave
  // cannot export. The images it would have carried must be recorded with the reason, never silently dropped.
  const ids = ["sha256:a1", "sha256:a2", "sha256:a3", "sha256:a4", "sha256:a5"];
  const sizes = [6, 7, 8, 9, 10];
  const { status, out, targets, calls, dir } = await run({ FAKE_FREE_KB: "62914560", FAKE_TAKE_LOCK_ON_HOST_SCAN: "1" }, {
    containers: ids.map((id, i) => ({ id: `c${i + 1}`, image: id, config: `svc${i + 1}:local`, label: id })),
    tags: Object.fromEntries(ids.map((id, i) => [`svc${i + 1}:local`, id])),
    held: ids,
    sizes: Object.fromEntries(ids.map((id, i) => [id, sizes[i] * 1024 ** 3])),
  });
  assert.equal(status, 0, out);
  // The fixture held the lock from the host scan through the pass, past the second wave's save attempt, so that wave
  // could not export. Release the fixture now and wait for it to drop the lock, so a later test never inherits it.
  const checkout = join(dir, "checkout");
  for (let i = 0; i < 100 && !existsSync(join(checkout, "data/late-holder")); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(join(checkout, "data/late-holder")), "the fixture never took the apply lock");
  rmSync(join(checkout, "data/late-holder"), { force: true });
  let released = false;
  for (let i = 0; i < 100 && !released; i++) {
    try { execFileSync("flock", ["-n", join(checkout, "data/apply.lock"), "-c", "true"], { stdio: "ignore" }); released = true; }
    catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  assert.ok(released, "the fixture never released the apply lock");
  const rows = targets.filter((t) => t[0].startsWith("image:"));
  assert.equal(rows.length, ids.length, `every running image has a row:\n${rows.map((t) => t.join("\t")).join("\n")}`);
  const scanned = rows.filter((t) => t[1] !== "-");
  const unreached = rows.filter((t) => /not reached/.test(t[2]));
  assert.ok(scanned.length >= 1, `the first wave was still scanned:\n${rows.map((t) => t.join("\t")).join("\n")}`);
  assert.ok(unreached.length >= 1, `the later wave's images are lines:\n${rows.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(scanned.length + unreached.length, ids.length, rows.map((t) => t.join("\t")).join("\n"));
  assert.match(out, /an apply took the apply lock between waves/);
  // The later wave wrote no bytes, and the pass still swapped its batch in.
  assert.equal(calls.filter((c) => c.startsWith("save ")).length, scanned.length);
});

test("security-sbom: an archive too large for its wave is retried after the others are freed, not skipped", { skip: NOT_LINUX }, async () => {
  // 55 GB free, a 30 GB floor: 25 GB of room. The daemon reports 7 GB and 9 GB, so one wave admits both (16 GB of
  // archives plus a 9 GB workspace = 25 GB). The 9 GB image's archive is really 10 GB. The two archives therefore hold
  // 17 GB, leaving only 8 GB above the floor: unpacking the 10 GB image beside the 7 GB archive needs 17 GB, so the
  // largest scan fails its first check. It must be retried, not dropped: once the 7 GB archive is scanned and removed,
  // its own 10 GB archive plus 10 GB to unpack fits in the 15 GB that are then free above the floor.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: String(55 * 1024 * 1024) }, {
    containers: [
      { id: "c1", image: "sha256:b1", config: "big1:local", label: "sha256:b1" },
      { id: "c2", image: "sha256:b2", config: "big2:local", label: "sha256:b2" },
    ],
    tags: { "big1:local": "sha256:b1", "big2:local": "sha256:b2" },
    held: ["sha256:b1", "sha256:b2"],
    sizes: { "sha256:b1": 9 * 1024 ** 3, "sha256:b2": 7 * 1024 ** 3 },
    saveGrow: { "sha256:b1": 10 * 1024 ** 3, "sha256:b2": 7 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  for (const name of ["image:big1:local", "image:big2:local"]) {
    const row = targets.find((t) => t[0] === name);
    assert.ok(row, targets.map((t) => t.join("\t")).join("\n"));
    assert.notEqual(row[1], "-", `${name} was not scanned: ${row[2]}`);
  }
  const scans = calls.filter((c) => c.startsWith("run ") && c.includes("--source-name image:"));
  assert.equal(scans.length, 2, `both images were scanned:\n${calls.join("\n")}`);
});

test("security-sbom: when a wave's real bytes outgrow its room, the smallest deferred image is the line, not the largest", { skip: NOT_LINUX }, async () => {
  // 60 GB free, a 30 GB floor: 30 GB of room. The daemon reports 9 GB and 8 GB, so one wave admits both (17 GB of
  // archives plus a 9 GB workspace = 26 GB). The archives are really 12 GB and 10 GB: both save, and the two hold 22 GB,
  // leaving only 8 GB above the floor, so neither scan fits beside the other (12 > 8 and 10 > 8). Dropping the smaller
  // 10 GB archive leaves 18 GB of room for the 12 GB archive and its 12 GB workspace. Exactly one image must be a line,
  // and it must be the smaller one.
  const { status, out, targets } = await run({ FAKE_FREE_KB: String(60 * 1024 * 1024) }, {
    containers: [
      { id: "c1", image: "sha256:b1", config: "big1:local", label: "sha256:b1" },
      { id: "c2", image: "sha256:b2", config: "big2:local", label: "sha256:b2" },
    ],
    tags: { "big1:local": "sha256:b1", "big2:local": "sha256:b2" },
    held: ["sha256:b1", "sha256:b2"],
    sizes: { "sha256:b1": 9 * 1024 ** 3, "sha256:b2": 8 * 1024 ** 3 },
    saveGrow: { "sha256:b1": 12 * 1024 ** 3, "sha256:b2": 10 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const small = targets.find((t) => t[0] === "image:big2:local");
  const large = targets.find((t) => t[0] === "image:big1:local");
  assert.ok(small && large, targets.map((t) => t.join("\t")).join("\n"));
  assert.notEqual(large[1], "-", `the larger image must be scanned: ${large[2]}`);
  assert.equal(small[1], "-", "the smaller image is the one dropped");
  assert.match(small[2], /does not fit/);
});

test("security-sbom: an archive no round can scan is dropped before one that still can", { skip: NOT_LINUX }, async () => {
  // 62 GB free, a 30 GB floor: 32 GB of room. The daemon reports 9 GB and 8 GB, so one wave admits both. The archives are
  // really 18 GB and 7 GB (25 GB held, 7 GB above the floor): neither scan fits beside the other. The 7 GB image would
  // scan alone, but the 18 GB one needs 36 GB and can scan in no round. Dropping the 18 GB archive first leaves 25 GB for
  // the 7 GB image (7 GB held plus 7 GB to unpack), so it must be scanned, not crowded out by the unreachable one.
  const { status, out, targets } = await run({ FAKE_FREE_KB: String(62 * 1024 * 1024) }, {
    containers: [
      { id: "c1", image: "sha256:b1", config: "big1:local", label: "sha256:b1" },
      { id: "c2", image: "sha256:b2", config: "big2:local", label: "sha256:b2" },
    ],
    tags: { "big1:local": "sha256:b1", "big2:local": "sha256:b2" },
    held: ["sha256:b1", "sha256:b2"],
    sizes: { "sha256:b1": 9 * 1024 ** 3, "sha256:b2": 8 * 1024 ** 3 },
    saveGrow: { "sha256:b1": 18 * 1024 ** 3, "sha256:b2": 7 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const small = targets.find((t) => t[0] === "image:big2:local");
  const huge = targets.find((t) => t[0] === "image:big1:local");
  assert.ok(small && huge, targets.map((t) => t.join("\t")).join("\n"));
  assert.notEqual(small[1], "-", `the scannable image must be scanned: ${small[2]}`);
  assert.equal(huge[1], "-", "the archive no round can scan is the line");
  assert.match(huge[2], /does not fit/);
});

test("security-sbom: an archive is admitted only when its own scan has workspace left", { skip: NOT_LINUX }, async () => {
  // 40 GB free, a 30 GB floor: 10 GB of room. A 9 GB image's archive fits, but unpacking it beside the archive needs its
  // size again, so the scan would refuse it and the pass would save it every night and never read it. It must be a line
  // and no save may run.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "40000000" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:2222"],
    sizes: { "sha256:2222": 9 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:1111");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "the image whose scan could not fit was not saved");
  assert.match(line[2], /does not fit/);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `an archive was saved for a scan that cannot fit:\n${calls.join("\n")}`);
});

test("security-sbom: a compose label that disagrees with the container's digest does not take the tag's target", { skip: NOT_LINUX }, async () => {
  // The tag was rebuilt with a new arm64 variant only; the stale arm64 container still runs the old one, while the tag's
  // amd64 variant still matches the compose label. The descriptor is the authority, so the tag must not be used as this
  // container's target with a different manifest under it.
  const arm = { digest: "sha256:aaaa", platform: { os: "linux", architecture: "arm64", variant: "v8" } };
  const { status, out, targets } = await run({}, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local", label: "sha256:amd64", descriptor: arm }],
    tags: { "aidenhq/board:local": "sha256:amd64" },
    manifests: { "aidenhq/board:local": "sha256:amd64" },
    platformManifests: { "aidenhq/board:local": { "linux/amd64": "sha256:amd64" } },
    held: ["sha256:index"],
    sizes: { "sha256:index": 1024 },
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
  const fixture = (extra) => ({
    containers: [extra, { id: "c9", image: "sha256:index", config: "board:local", descriptor: arm }].filter(Boolean),
    tags: { "board:local": "sha256:b2b2" },
    manifests: { "board:local": "sha256:b2b2" },
    platformManifests: {
      "board:local": { "linux/amd64": "sha256:b2b2", "linux/arm64/v8": "sha256:a1a1" },
      "sha256:index": { "linux/amd64": "sha256:b2b2", "linux/arm64/v8": "sha256:a1a1" },
    },
    platformSizes: { "sha256:index": { "linux/amd64": 1024, "linux/arm64/v8": 1024 } },
    held: ["sha256:index"],
  });
  const alone = await run({}, fixture(null));
  assert.equal(alone.status, 0, alone.out);
  const aloneKeys = alone.targets.filter((t) => t[0].startsWith("image:")).map((t) => t[0]);
  assert.deepEqual(aloneKeys, ["image:board:local@linux/arm64/v8"], aloneKeys.join("\n"));

  const beside = await run({}, fixture({ id: "c1", image: "sha256:index", config: "board:local", descriptor: amd64 }));
  assert.equal(beside.status, 0, beside.out);
  const besideKeys = beside.targets.filter((t) => t[0].startsWith("image:")).map((t) => t[0]).sort();
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

test("security-sbom: a later scan's space is measured with the archives its predecessors freed", { skip: NOT_LINUX }, async () => {
  // 50 GB free, a 30 GB floor: 19 GB of room (free is in KiB, so 52,000,000). Three 4 GB archives are 12 GB, and scanning the largest first unpacks 4 GB
  // beside all 12 GB once; after that the scanned archive is gone, so later scans need less. Refusing the third because
  // "every archive twice over" would scan fewer images than the disk can hold.
  const { status, out, targets, calls } = await run({ FAKE_FREE_KB: "52000000" }, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:aa11" },
      { id: "c2", image: "sha256:3333", config: "gate:local", label: "sha256:bb22" },
      { id: "c3", image: "sha256:5555", config: "tasks-mcp:local", label: "sha256:cc33" },
    ],
    tags: { "aidenhq/board:local": "sha256:9991", "gate:local": "sha256:9992", "tasks-mcp:local": "sha256:9993" },
    held: ["sha256:aa11", "sha256:bb22", "sha256:cc33"],
    sizes: { "sha256:aa11": 4 * 1024 ** 3, "sha256:bb22": 4 * 1024 ** 3, "sha256:cc33": 4 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.filter((t) => t[0].startsWith("image:") && t[1] !== "-");
  assert.equal(scanned.length, 3, `all three archives fit and scan:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(calls.filter((c) => c.startsWith("save ")).length, 3);
});

test("security-sbom: archives are exported smallest first and scanned largest first", { skip: NOT_LINUX }, async () => {
  // The snapshot deadline is spent on exports, so a large save that runs it out must not take the smaller archives with
  // it: the small images are written first and still land. Scanning wants the opposite order (largest first, so the peak
  // is at the first scan while every archive is still on disk). One order for both would fail one of the two.
  const { status, out, calls } = await run({ FAKE_FREE_KB: "60000000" }, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:aa11" },
      { id: "c2", image: "sha256:3333", config: "gate:local", label: "sha256:bb22" },
      { id: "c3", image: "sha256:5555", config: "tasks-mcp:local", label: "sha256:cc33" },
    ],
    tags: { "aidenhq/board:local": "sha256:9991", "gate:local": "sha256:9992", "tasks-mcp:local": "sha256:9993" },
    held: ["sha256:aa11", "sha256:bb22", "sha256:cc33"],
    sizes: { "sha256:aa11": 2 * 1024 ** 3, "sha256:bb22": 8 * 1024 ** 3, "sha256:cc33": 4 * 1024 ** 3 },
  });
  assert.equal(status, 0, out);
  const saves = calls.filter((c) => c.startsWith("save "));
  assert.deepEqual(saves.map((c) => c.split(" ").pop()), ["sha256:aa11", "sha256:cc33", "sha256:bb22"], `exports were not smallest first:\n${saves.join("\n")}`);
  const scans = calls.filter((c) => c.startsWith("run ") && c.includes("--source-name image:"));
  assert.deepEqual(scans.map((c) => c.match(/--source-name (image:\S+)/)?.[1]), ["image:sha256:3333", "image:sha256:5555", "image:sha256:1111"], `scans were not largest first:\n${scans.join("\n")}`);
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

test("security-sbom: a pre-1.48 daemon does not treat an immutable index id as a single image", { skip: NOT_LINUX }, async () => {
  // On the containerd store a container's `.Image` is the top-level index, and it is an inspectable immutable id, so
  // `resolve_ref` legitimately returns it. Immutability is not one variant: a plain save of that id writes every platform
  // the index holds, which a line must record rather than a scan under the running variant's target.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "nested" }, {
    containers: [{ id: "c1", image: "sha256:index", config: "aidenhq/board:local" }],
    // The tag has moved to another build, so the container is keyed and pinned by its own index id, which is held and
    // immutable: the resolver legitimately returns it as the export reference.
    tags: { "aidenhq/board:local": "sha256:9999" },
    held: ["sha256:index"],
    sizes: { "sha256:index": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:sha256:index");
  assert.ok(line, `no target for the container:\n${targets.map((t) => t.join("\t")).join("\n")}`);
  assert.equal(line[1], "-", "a multi-platform index archive was scanned");
  assert.match(line[2], /names 2 platform manifests/, line[2]);
  assert.ok(calls.some((c) => c.startsWith("save ") && c.endsWith(" sha256:index") && !c.includes("--platform")), calls.join("\n"));
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("--source-name image:")), `a multi-platform archive was scanned:\n${calls.join("\n")}`);
});

test("security-sbom: a pre-1.48 daemon accepts a legacy manifest.json archive of the running image", { skip: NOT_LINUX }, async () => {
  // A pre-containerd store's plain save has no index.json: its manifest.json has one entry per image, naming that image's
  // config. One entry is one image, but it still has to be the running one, so the entry's config digest is matched
  // against the pin.
  const config = `sha256:${"c".repeat(64)}`;
  const { status, out, targets } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "legacy", FAKE_SAVE_PIN: config }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": config },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
});

test("security-sbom: a legacy manifest.json archive of another image is a line", { skip: NOT_LINUX }, async () => {
  // The single entry has to be the running image's config. Another build's config is a line, not a scan under this target.
  const { status, out, targets } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "legacy", FAKE_SAVE_PIN: `sha256:${"d".repeat(64)}` }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": `sha256:${"c".repeat(64)}` },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "another image's archive was scanned");
  assert.match(line[2], /not the running image/, line[2]);
});


test("security-sbom: a classic-store image id is matched as the manifest's config digest", { skip: NOT_LINUX }, async () => {
  // Docker's classic image store reports .Id as the *config* digest, while a plain save's index.json names the manifest
  // digest. Comparing only manifest digests would reject every correct archive on such a host and drop every image from
  // the batch, so the sole manifest's config.digest counts as the running image too.
  const { status, out, targets, calls } = await run({ FAKE_API: "1.47", FAKE_SAVE_SHAPE: "classic", FAKE_SAVE_PIN: "sha256:1111", FAKE_SAVE_MANIFEST_DIGEST: `sha256:${"a".repeat(64)}` }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    held: [],
    sizes: { "aidenhq/board:local": 1024 },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned, targets.map((t) => t.join("\t")).join("\n"));
  assert.notEqual(scanned[1], "-", `a classic-store archive was refused: ${scanned[2]}`);
  assert.ok(calls.some((c) => c.startsWith("save ") && !c.includes("--platform")), calls.join("\n"));
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

