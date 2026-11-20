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
  held = null,
  inspectErrors = [],
  saveErrors = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const containersFile = join(dir, "containers");
  const tagsFile = join(dir, "tags");
  const heldFile = join(dir, "held");
  const brokenFile = join(dir, "broken");
  const saveErrorsFile = join(dir, "save-errors");
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\necho 0\n"); // the Docker socket's group
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
# A fake daemon: containers (\`id<TAB>.Image<TAB>.Config.Image<TAB>compose image label\`), the tag table (ref<TAB>
# top-level id<TAB>platform manifest) and the image ids it holds. Every syft run and save is logged.
case "$1" in run|save) printf '%s\\n' "$*" >> "$CALLS" ;; esac
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
  for (const f of ["stat", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(containersFile, containers.map((c) => `${c.id}\t${c.image}\t${c.config}\t${c.label ?? ""}`).join("\n") + "\n");
  writeFileSync(tagsFile, Object.entries(tags).map(([ref, id]) => `${ref}\t${id}\t${manifests[ref] ?? id}`).join("\n") + "\n");
  writeFileSync(heldFile, (held ?? [...containers.map((c) => c.image), ...Object.values(tags)]).join("\n") + "\n");
  writeFileSync(brokenFile, inspectErrors.join("\n") + "\n");
  writeFileSync(saveErrorsFile, Object.entries(saveErrors).map(([id, err]) => `${id}\t${err}`).join("\n") + "\n");
  const calls = join(dir, "calls");
  const data = join(dir, "data");
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: join(here, "../.."),
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: data,
        AIDENHQ_INSTANCE_DIR: "", CONTAINERS: containersFile, TAGS: tagsFile, HELD: heldFile, BROKEN: brokenFile,
        SAVE_ERRORS: saveErrorsFile, SAVED: join(dir, "saved.tar"), ...env,
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  const batch = join(data, "modules/security/sbom/current/targets.tsv");
  const targets = existsSync(batch) ? readFileSync(batch, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  return { ...r, targets, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [] };
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
