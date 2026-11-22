// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  held = null,
  inspectErrors = [],
  saveErrors = {},
  sizeErrors = [],
  sizeJunk = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const containersFile = join(dir, "containers");
  const tagsFile = join(dir, "tags");
  const heldFile = join(dir, "held");
  const brokenFile = join(dir, "broken");
  const saveErrorsFile = join(dir, "save-errors");
  const sizesFile = join(dir, "sizes");
  const sizeErrorsFile = join(dir, "size-errors");
  const sizeJunkFile = join(dir, "size-junk");
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\necho 0\n"); // the Docker socket's group
  // `df -Pk <dir>`: the fake filesystem's free space in 1K blocks, so a test can put the pass near the floor.
  writeFileSync(join(dir, "bin/df"), "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/md2 481000000 1 %s 1%% /\\n' \"${FAKE_FREE_KB:-400000000}\"\n");
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
# A fake daemon: containers (id<TAB>.Image<TAB>.Config.Image<TAB>compose image label\`), the tag table (ref<TAB>
# top-level id<TAB>platform manifest) and the image ids it holds. Every syft run and save is logged.
case "$1" in run|save) printf '%s\\n' "$*" >> "$CALLS" ;; esac
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
  version) printf 'linux/amd64\\n' ;;
  ps) printf '%s\\n' ${containers.map((c) => `'${c.id}'`).join(" ")} ;;
  inspect)
    [ "$2" = -f ] || exit 1
    case "$3" in
      # The label column is empty for a container without one, as the format's with-block renders an absent label.
      *com.docker.compose.image*) cut -f1-4 "$CONTAINERS" ;;
      *) cut -f1-3 "$CONTAINERS" ;;
    esac ;;
  image)
    shift
    if [ "$1" = inspect ]; then
      shift
      col=2
      if [ "$1" = -f ] && [ "$2" = '{{.Size}}' ]; then
        # An image's size on disk, for the room its save and unpack need.
        shift 2
        junk="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $2; found = 1 }' "$SIZE_JUNK")"
        if [ -n "$junk" ]; then printf '%s\\n' "$junk"; exit 0; fi
        if grep -qxF -- "$1" "$SIZE_ERRORS"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        found="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $2; found = 1 }' "$SIZES")"
        if [ -n "$found" ]; then printf '%s\\n' "$found"; exit 0; fi
        if grep -qxF -- "$1" "$HELD"; then printf '0\\n'; exit 0; fi
        if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        echo "Error response from daemon: No such image: $1" >&2; exit 1
      fi
      if [ "$1" = --platform ]; then col=3; shift 2; fi
      [ "$1" = -f ] && shift 2
      if [ "$#" -eq 0 ]; then cut -f"$col" "$TAGS"; exit 0; fi
      found="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $'"$col"'; found = 1 }' "$TAGS")"
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
  save)
    id="$4"
    failed="$(awk -F '\\t' -v ref="$id" '$1 == ref { print $2; found = 1 } END { exit !found }' "$SAVE_ERRORS")" && { echo "$failed" >&2; exit 1; }
    if grep -qxF -- "$id" "$HELD"; then : > "$SAVED"; exit 0; fi
    echo "Error response from daemon: No such image: $id" >&2; exit 1 ;;
esac
exit 0
`);
  for (const f of ["stat", "docker", "df"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(containersFile, containers.map((c) => `${c.id}\t${c.image}\t${c.config}\t${c.label ?? ""}`).join("\n") + "\n");
  writeFileSync(tagsFile, Object.entries(tags).map(([ref, id]) => `${ref}\t${id}\t${manifests[ref] ?? id}\t${sizes[ref] ?? 0}`).join("\n") + "\n");
  writeFileSync(heldFile, (held ?? [...containers.map((c) => c.image), ...Object.values(tags)]).join("\n") + "\n");
  writeFileSync(brokenFile, inspectErrors.join("\n") + "\n");
  writeFileSync(saveErrorsFile, Object.entries(saveErrors).map(([id, err]) => `${id}\t${err}`).join("\n") + "\n");
  writeFileSync(sizesFile, Object.entries(sizes).map(([ref, bytes]) => `${ref}\t${bytes}`).join("\n") + "\n");
  writeFileSync(sizeErrorsFile, sizeErrors.join("\n") + "\n");
  writeFileSync(sizeJunkFile, Object.entries(sizeJunk).map(([ref, out]) => `${ref}\t${out}`).join("\n") + "\n");
  writeFileSync(join(dir, "labelled"), ""); // containers this fake daemon reports as this scanner's own
  const calls = join(dir, "calls");
  const data = join(dir, "data");
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: join(here, "../.."),
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: data,
        AIDENHQ_INSTANCE_DIR: "", CONTAINERS: containersFile, TAGS: tagsFile, HELD: heldFile, BROKEN: brokenFile,
        SAVE_ERRORS: saveErrorsFile, SAVED: join(dir, "saved.tar"), CLEAN: join(dir, "clean"), SIZES: sizesFile, LABELLED: join(dir, "labelled"), SIZE_ERRORS: sizeErrorsFile, SIZE_JUNK: sizeJunkFile, ...env,
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  const batch = join(data, "modules/security/sbom/current/targets.tsv");
  const targets = existsSync(batch) ? readFileSync(batch, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  return {
    ...r, targets,
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
