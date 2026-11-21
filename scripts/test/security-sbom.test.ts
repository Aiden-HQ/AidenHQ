// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

/** The batch's line for one target (target, file, error, commit), `undefined` when the target is not in it. */
function batchLine(targets, target) {
  return targets.find((t) => t[0] === target);
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

test("security-sbom: the image, repo and app targets keep their own scope", { skip: NOT_LINUX }, async () => {
  const { status, out, calls } = await run();
  assert.equal(status, 0, out);
  assert.deepEqual(syft(calls, "image:aidenhq/board:local").excludes, []);
  const repo = syft(calls, "repo:product");
  assert.deepEqual(repo.excludes, ["./data/**", "./.git/**", "**/node_modules/**"], "the checkout keeps its own scope");
  assert.ok(!repo.excludes.includes("./home/**"), "the homes are a host scope, not a checkout's");
});

test("security-sbom: an instance checkout elsewhere on the host is excluded where the host scan would otherwise read it", { skip: NOT_LINUX }, async () => {
  const { status, out, calls } = await run({ AIDENHQ_INSTANCE_DIR: "/home/mudit/aidenhq-instance" });
  assert.equal(status, 0, out);
  assert.ok(syft(calls, "host").excludes.includes("./home/mudit/aidenhq-instance/**"));
  assert.deepEqual(syft(calls, "repo:instance").excludes, ["./.git/**", "**/node_modules/**"]);
});

test("security-sbom: a rebuilt tag keeps its reference target while the container's platform manifest is what the tag names", { skip: NOT_LINUX }, async () => {
  // The containerd image store: every build writes a new top-level image index (a fresh attestation) over unchanged
  // content, so the tag's id moved while the platform manifest the container records is still the one it resolves to.
  // Comparing the top-level id alone would drop the tag and name the running image by an id the store has collected.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:2222" }],
    tags: { "aidenhq/board:local": "sha256:3333" },
    manifests: { "aidenhq/board:local": "sha256:2222" },
  });
  assert.equal(status, 0, out);
  assert.ok(batchLine(targets, "image:aidenhq/board:local"), `the tag is the target:\n${targets.join("\n")}`);
  assert.match(syft(calls, "image:aidenhq/board:local").line, / docker:aidenhq\/board:local( |$)/);
  assert.equal(batchLine(targets, "image:sha256:1111"), undefined, "the running image id is not a target of its own");
  assert.ok(!calls.some((c) => c.startsWith("save ")), `nothing is saved:\n${calls.join("\n")}`);
});

test("security-sbom: a container whose platform manifest differs from its tag is scanned from its saved archive", { skip: NOT_LINUX }, async () => {
  // A real rebuild: the tag names another build, so neither the top-level id nor the platform manifest is the running
  // image's. The image that runs is what gets inventoried, under its own id.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c2", image: "sha256:4444", config: "aidenhq/whisper:local", label: "sha256:5555" }],
    tags: { "aidenhq/whisper:local": "sha256:6666" },
    manifests: { "aidenhq/whisper:local": "sha256:7777" },
  });
  assert.equal(status, 0, out);
  assert.equal(batchLine(targets, "image:aidenhq/whisper:local"), undefined, "a moved tag gets no target of its own");
  const scan = syft(calls, "image:sha256:4444");
  assert.match(scan.line, / docker-archive:\/work\/image\.tar( |$)/);
  // The scan's own container is labelled, so the host metrics leave it out of the container inventory.
  assert.ok(scan.line.includes("--label aidenhq.oneoff=1"), scan.line);
  const save = calls.find((c) => c.startsWith("save "));
  assert.ok(save && save.includes("-o ") && save.includes("sha256:4444"), `docker save of the running image:\n${calls.join("\n")}`);
});

test("security-sbom: an image id the daemon no longer holds is left out of the batch, with no docker save failure", { skip: NOT_LINUX }, async () => {
  // The store collected the image the container still names: there is nothing to scan, and a line for it would only be
  // an error the pass reports as a coverage gap it cannot close.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c3", image: "sha256:aaaa", config: "aidenhq/gone:local", label: "sha256:8888" }],
    tags: { "aidenhq/gone:local": "sha256:9999" },
    manifests: { "aidenhq/gone:local": "sha256:bbbb" },
    held: [],
  });
  assert.equal(status, 0, out);
  const vanished = targets.find((t) => t[0] === "image:sha256:aaaa" || t[0] === "sha256:aaaa");
  assert.equal(vanished, undefined, `no line for a vanished image:\n${targets.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `the vanished image is not saved:\n${calls.join("\n")}`);
  assert.ok(!targets.some((t) => t[2]), `no target failed:\n${targets.join("\n")}`);
  assert.ok(!out.includes("docker save"), out);
});

test("security-sbom: an image the daemon cannot inspect is recorded, not dropped as if it were gone", { skip: NOT_LINUX }, async () => {
  // Only "No such image" is the store having collected it. A daemon that can't answer says nothing about coverage, so
  // the target keeps a line with the error rather than the pass claiming to have listed every running image.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c7", image: "sha256:cccc", config: "aidenhq/broken:local", label: "sha256:dddd" }],
    tags: {},
    held: [],
    inspectErrors: ["sha256:cccc"],
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:cccc");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /docker image inspect: .*cannot inspect/, JSON.stringify(line));
  assert.equal(line[1], "-", "no syft ran for it");
  assert.ok(!calls.some((c) => c.startsWith("save ")), calls.join("\n"));
});

test("security-sbom: an image the store collects between the inspect and the save records no line either", { skip: NOT_LINUX }, async () => {
  // The daemon answered the inspect, so the id is not one it already calls gone; by the time `docker save` runs the store
  // has collected it. That is the same vanished image as the case above, not a target that went missing, so the batch
  // keeps no line for it instead of a `docker save` failure the pass could never close.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c8", image: "sha256:eeee", config: "aidenhq/racing:local", label: "sha256:ffff" }],
    tags: {},
    held: ["sha256:eeee"],
    saveErrors: { "sha256:eeee": "Error response from daemon: No such image: sha256:eeee" },
  });
  assert.equal(status, 0, out);
  assert.equal(batchLine(targets, "image:sha256:eeee"), undefined, `no line for a collected image:\n${targets.join("\n")}`);
  assert.ok(calls.some((c) => c.startsWith("save ")), `the save is attempted:\n${calls.join("\n")}`);
  assert.ok(!targets.some((t) => t[2]), `no target failed:\n${targets.join("\n")}`);
});

test("security-sbom: a save that fails for another reason keeps its line with the error", { skip: NOT_LINUX }, async () => {
  // Not every failed save is a collected image: a disk full or a broken daemon says the target was not inventoried, so it
  // keeps a line rather than the pass reading as if it had listed it.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c9", image: "sha256:dddd", config: "aidenhq/diskfull:local", label: "sha256:cccc" }],
    tags: {},
    held: ["sha256:dddd"],
    saveErrors: { "sha256:dddd": "Error response from daemon: write /var/lib/docker/tmp/x.tar: no space left on device" },
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:dddd");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /docker save: .*no space left/, JSON.stringify(line));
  assert.equal(line[1], "-", "no syft ran for it");
  assert.ok(calls.some((c) => c.startsWith("save ")), calls.join("\n"));
});

test("security-sbom: a container whose configured reference no longer exists is scanned too, and the syft image is not", { skip: NOT_LINUX }, async () => {
  const { status, out, calls } = await run({}, {
    containers: [
      { id: "c4", image: "sha256:4444", config: "aidenhq/whisper@sha256:0000" },
      { id: "c5", image: "sha256:5555", config: "anchore/syft:v1.57.1" },
    ],
    tags: {},
  });
  assert.equal(status, 0, out);
  assert.match(syft(calls, "image:sha256:4444").line, / docker-archive:\/work\/image\.tar( |$)/);
  assert.ok(!calls.some((c) => c.includes("sha256:5555") || c.includes("--source-name image:anchore/syft")), "the throwaway syft container is not a target");
});

test("security-sbom: a container configured with an image id is still scanned from the saved image, never as a docker: source", { skip: NOT_LINUX }, async () => {
  // Docker reports `Config.Image` as the id when the container was started from one: it resolves to the running image, but
  // syft can't read a bare id as a source (it would try to pull it), so the archive path is the only one that works.
  const { status, out, calls } = await run({}, {
    containers: [{ id: "c6", image: "sha256:6666", config: "sha256:6666" }],
    tags: { "sha256:6666": "sha256:6666" },
  });
  assert.equal(status, 0, out);
  assert.match(syft(calls, "image:sha256:6666").line, / docker-archive:\/work\/image\.tar( |$)/);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("docker:sha256:")), calls.join("\n"));
});

test("security-sbom: a target starts with the work dir emptied of everything the last one left, dotfiles included", { skip: NOT_LINUX }, async () => {
  // stereoscope leaves `stereoscope-*` and `syft-*` dirs behind when a scan fails, and an XDG cache under $work is a
  // dotfile: `rm -rf $work/*` kept both, so each target's bytes stayed on the disk the host runs from.
  const { status, out, workStates } = await run({}, {
    containers: [
      { id: "c1", image: "sha256:1111", config: "aidenhq/board:local" },
      { id: "c2", image: "sha256:2222", config: "aidenhq/other:local" },
    ],
    tags: { "aidenhq/board:local": "sha256:1111", "aidenhq/other:local": "sha256:2222" },
  });
  assert.equal(status, 0, out);
  // The first target finds the empty dir the pass made; every one after it finds what the one before wrote already gone.
  assert.ok(workStates.length > 3, `several targets ran:\n${workStates.join(",")}`);
  assert.deepEqual(workStates.slice(1).filter((s) => s !== "clean"), [], `every target after the first starts clean:\n${workStates.join(",")}`);
});

test("security-sbom: an image too large for the room above the floor is refused before its save, with the reason", { skip: NOT_LINUX }, async () => {
  // A 40 GB image needs its archive and its unpacked layers: about twice its size. With 35 GB free and a 30 GB floor the
  // pass has no room, and discovering that as a full disk mid-save is what took the host down.
  const { status, out, calls, targets } = await run({ FAKE_FREE_KB: String(35 * 1024 * 1024) }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/huge:local", label: "sha256:aaaa" }],
    tags: {},
    sizes: { "sha256:1111": String(40 * 1024 ** 3) },
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:1111");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /skipped: 40 GB image/, JSON.stringify(line));
  assert.equal(line[1], "-", "no syft ran for it");
  assert.ok(!calls.some((c) => c.startsWith("save ")), `nothing was saved:\n${calls.join("\n")}`);
});

test("security-sbom: with the disk under the floor no scan starts and the batch says why", { skip: NOT_LINUX }, async () => {
  const { status, out, calls, targets } = await run({ FAKE_FREE_KB: String(5 * 1024 * 1024) }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
  });
  assert.equal(status, 0, out);
  assert.ok(!calls.some((c) => c.startsWith("run ")), `no syft run started:\n${calls.join("\n")}`);
  for (const target of ["host", "image:aidenhq/board:local", "repo:product"]) {
    const line = batchLine(targets, target);
    assert.ok(line, `${target} keeps a line:\n${targets.join("\n")}`);
    assert.match(line[2], /skipped: 5 GB free/, JSON.stringify(line));
  }
});

test("security-sbom: a pass that finds the lock held skips instead of doubling the writes", { skip: NOT_LINUX }, async () => {
  // The timer and a manual run on the same host: two passes unpack two images into the same filesystem at once. A second
  // pass started while the first holds data/modules/security/sbom/.lock says so and runs no scan.
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-lock-"));
  const data = join(dir, "data");
  const out = join(data, "modules/security/sbom");
  mkdirSync(out, { recursive: true });
  // A separate process holds the lock, as a running pass would: a shell that `exec`s into the script hands its own
  // description over and the script's reopen drops it.
  const holder = spawn("flock", [join(out, ".lock"), "sleep", "5"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      env: { ...process.env, AIDENHQ_DATA_DIR: data, PATH: `/usr/bin:/bin` },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  holder.kill();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /another pass holds/);
  assert.equal(existsSync(join(out, "current")), false, "no batch was written");
});

test("security-sbom: a tag-resolved image over the room it needs is refused too, never scanned from the daemon", { skip: NOT_LINUX }, async () => {
  // `docker:<tag>` is no cheaper than the archive: syft's daemon source saves the image itself and unpacks its layers.
  const { status, out, calls, targets } = await run({ FAKE_FREE_KB: String(35 * 1024 * 1024) }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/huge:local" }],
    tags: { "aidenhq/huge:local": "sha256:1111" },
    sizes: { "sha256:1111": String(40 * 1024 ** 3) },
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:1111");
  assert.ok(line, `the target keeps a line:\n${targets.join("|")}\n${out}`);
  assert.match(line[2], /skipped: 40 GB image/, JSON.stringify(line));
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("docker:aidenhq/huge:local")), `no daemon scan:\n${calls.join("\n")}`);
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

test("security-sbom: an image whose size can't be read is recorded and never scanned, whatever room there is", { skip: NOT_LINUX }, async () => {
  // Unknown demand is not zero demand: treating a failed size read as 0 slipped past the half-room guard and started a
  // scan that could fill the disk. Plenty of room here, so only the missing size can stop it.
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/nosize:local" }],
    tags: { "aidenhq/nosize:local": "sha256:1111" },
    sizeErrors: ["sha256:1111"],
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:1111");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /docker image inspect: .*cannot inspect/, JSON.stringify(line));
  assert.equal(line[1], "-", "no syft ran for it");
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("aidenhq/nosize:local")), `no scan started:\n${calls.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("save ")), `nothing was saved:\n${calls.join("\n")}`);
});

test("security-sbom: a size the daemon answers with junk is recorded, not read as 0 GB", { skip: NOT_LINUX }, async () => {
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/junk:local" }],
    tags: { "aidenhq/junk:local": "sha256:1111" },
    sizeJunk: { "sha256:1111": "<no value>" },
  });
  assert.equal(status, 0, out);
  const line = batchLine(targets, "image:sha256:1111");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /docker image inspect: no size/, JSON.stringify(line));
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("aidenhq/junk:local")), `no scan started:\n${calls.join("\n")}`);
});

test("security-sbom: an image the store collected before its size read is left out, like the other inspect paths", { skip: NOT_LINUX }, async () => {
  const { status, out, calls, targets } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/gone:local", label: "sha256:aaaa" }],
    tags: {},
    held: [],
  });
  assert.equal(status, 0, out);
  assert.equal(batchLine(targets, "image:sha256:1111"), undefined, `no line for a collected image:\n${targets.join("\n")}`);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("sha256:1111")), calls.join("\n"));
});

test("security-sbom: the free-space setting can raise the floor but never lower it", { skip: NOT_LINUX }, async () => {
  // The floor is the safeguard: an env value of 0 (or a typo, or a negative) must not switch it off. 5 GB free is under the
  // 30 GB minimum, so with each of these values no scan may start.
  for (const value of ["0", "-100", "", "5", "lots"]) {
    const { status, out, calls, targets } = await run({ FAKE_FREE_KB: String(5 * 1024 * 1024), AIDENHQ_SBOM_MIN_FREE_GB: value }, {
      containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
      tags: { "aidenhq/board:local": "sha256:1111" },
    });
    assert.equal(status, 0, out);
    assert.ok(!calls.some((c) => c.startsWith("run ")), `AIDENHQ_SBOM_MIN_FREE_GB=${JSON.stringify(value)} started a scan:\n${calls.join("\n")}`);
    const line = batchLine(targets, "image:aidenhq/board:local");
    assert.ok(line, `AIDENHQ_SBOM_MIN_FREE_GB=${JSON.stringify(value)} keeps a line:\n${targets.join("\n")}`);
    assert.match(line[2], /under the 30 GB floor/, `${JSON.stringify(value)}: ${JSON.stringify(line)}`);
  }
});

test("security-sbom: a setting above the minimum raises the floor", { skip: NOT_LINUX }, async () => {
  // 40 GB free clears the 30 GB default but not a 50 GB floor, so only a setting that is honoured stops this scan.
  const { status, out, calls, targets } = await run({ FAKE_FREE_KB: String(40 * 1024 * 1024), AIDENHQ_SBOM_MIN_FREE_GB: "50" }, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
  });
  assert.equal(status, 0, out);
  assert.ok(!calls.some((c) => c.startsWith("run ")), `the 50 GB floor stopped the scan:\n${calls.join("\n")}`);
  const line = batchLine(targets, "image:aidenhq/board:local");
  assert.ok(line, `the target keeps a line:\n${targets.join("\n")}`);
  assert.match(line[2], /under the 50 GB floor/, JSON.stringify(line));
});
