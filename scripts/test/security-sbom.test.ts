// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  seed,
  psFails = false,
  inspectFails = [],
  drift = {},
  scriptPath,
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
lockstate() { if [ -n "$FAKE_APPLY_LOCK" ] && flock -n "$FAKE_APPLY_LOCK" -c true 2>/dev/null; then echo free; else echo held; fi; }
case "$1" in run|save) printf '%s\\n' "$*" >> "$CALLS" ;; esac
[ "$1" = run ] && printf 'run %s\\n' "$(lockstate)" >> "$LOCKS"
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
  ps) [ "$PS_FAILS" = 1 ] && { echo "Error response from daemon: cannot list containers" >&2; exit 1; }; printf '%s\\n' ${containers.map((c) => `'${c.id}'`).join(" ")} ;;
  inspect)
    [ "$2" = -f ] || exit 1
    # A container the fake daemon cannot answer for, as a daemon that stops mid-enumeration does.
    for bad in \${INSPECT_FAILS:-}; do
      if [ "$bad" = "$4" ] && [ "$PS_FAILS" != 1 ]; then echo "Error response from daemon: cannot inspect $4: EOF" >&2; exit 1; fi
    done
    case "$3" in
      # The label column is empty for a container without one, as the format's with-block renders an absent label.
      *com.docker.compose.image*) cut -f1-4 "$CONTAINERS" ;;
      *) cut -f1-3 "$CONTAINERS" ;;
    esac ;;
  image)
    shift
    if [ "$1" = ls ] || [ "$1" = list ]; then
      awk -F '\\t' '$3 != "" { print $2 "\t" $1 }' "$TAGS"
      exit 0
    fi
    if [ "$1" = save ]; then
      printf 'save %s\n' "$*" >> "$CALLS"; printf 'save %s\n' "$(lockstate)" >> "$LOCKS"
      shift
      file=""; id=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          -o) file="$2"; shift 2 ;;
          --platform) shift 2 ;;
          -*) shift ;;
          *) id="$1"; shift ;;
        esac
      done
      failed="$(awk -F '\\t' -v ref="$id" '$1 == ref { print $2; found = 1 } END { exit !found }' "$SAVE_ERRORS")" && { echo "$failed" >&2; exit 1; }
      if grep -qxF -- "$id" "$HELD" || awk -F '\\t' -v ref="$id" '$1 == ref { found = 1 } END { exit !found }' "$TAGS"; then
        [ -n "$file" ] && : > "$file"; : > "$SAVED"; exit 0
      fi
      echo "Error response from daemon: No such image: $id" >&2; exit 1
    fi
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
        # A configured tag resolves to the image it names, as the daemon does; the table holds ref<TAB>id<TAB>manifest.
        # An image id in the table's first column is that image, not a tag naming another one.
        by_tag="$(awk -F '\\t' -v ref="$1" '$1 == ref && $3 != "" { print $2; found = 1 }' "$TAGS")"
        if [ -n "$by_tag" ] && ! grep -qxF -- "$1" "$HELD"; then set -- "$by_tag"; fi
        if grep -qxF -- "$1" "$HELD"; then printf '0\\n'; exit 0; fi
        if grep -qxF -- "$1" "$BROKEN"; then echo "Error response from daemon: cannot inspect $1: unexpected EOF" >&2; exit 1; fi
        echo "Error response from daemon: No such image: $1" >&2; exit 1
      fi
      plat=""
      if [ "$1" = --platform ]; then plat=1; col=3; shift 2; fi
      [ "$1" = -f ] && shift 2
      if [ "$#" -eq 0 ]; then cut -f"$col" "$TAGS"; exit 0; fi
      found="$(awk -F '\\t' -v ref="$1" '$1 == ref { print $'"$col"'; found = 1 }' "$TAGS")"
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
        AIDENHQ_INSTANCE_DIR: "", CONTAINERS: containersFile, TAGS: tagsFile, HELD: heldFile, BROKEN: brokenFile,
        SAVE_ERRORS: saveErrorsFile, SAVED: join(dir, "saved.tar"), CLEAN: join(dir, "clean"), SIZES: sizesFile, LABELLED: join(dir, "labelled"), SIZE_ERRORS: sizeErrorsFile, SIZE_JUNK: sizeJunkFile, PS_FAILS: psFails ? "1" : "", INSPECT_FAILS: inspectFails.join(" "), DRIFT: join(dir, "drift"), DRIFT_COUNT: join(dir, "drift-count"), LOCKS: join(dir, "locks"), FAKE_APPLY_LOCK: join(dirname(dirname(scriptPath_)), "data/apply.lock"),
        ...env,
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
  assert.notEqual(scanned[1], "-", "the target reached syft");
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
  assert.notEqual(scanned[1], "-", "the target reached syft");
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

test("security-sbom: a tag that moves before its scan is a line, not the replacement's packages", { skip: NOT_LINUX }, async () => {
  // The tag matches the container during the snapshot and is pinned there; after two reads it names a rebuilt image,
  // by the time syft would open it. The pass must not publish the new build under the running container's target.
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
    drift: { "aidenhq/board:local": { after: 2, then: "sha256:8888" } },
  });
  assert.equal(status, 0, out);
  const line = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(line, targets.map((t) => t.join("\t")).join("\n"));
  assert.equal(line[1], "-", "it was not scanned");
  assert.match(line[2], /tag moved during this pass/);
  assert.ok(!calls.some((c) => c.startsWith("run ") && c.includes("docker:aidenhq/board:local")), calls.join("\n"));
});

test("security-sbom: a tag that stays put is scanned through the daemon", { skip: NOT_LINUX }, async () => {
  const { status, out, targets, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local", label: "sha256:1111" }],
    tags: { "aidenhq/board:local": "sha256:1111" },
    manifests: { "aidenhq/board:local": "sha256:1111" },
  });
  assert.equal(status, 0, out);
  const scanned = targets.find((t) => t[0] === "image:aidenhq/board:local");
  assert.ok(scanned && scanned[1] !== "-", targets.map((t) => t.join("\t")).join("\n"));
  assert.ok(calls.some((c) => c.includes("docker:aidenhq/board:local")), calls.join("\n"));
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
