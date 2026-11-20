// ops/security-sbom.sh with a fake `docker` on PATH: the syft invocations it would run are read back from the fake's
// log, so the host scan's scope is its argument list, not an inference from the script's text.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../ops/security-sbom.sh");

/**
 * The script against the given running containers, a throwaway data dir and a logging `docker`. Each container is
 * `{ id, image, config, label }`: its id, the image it runs (`.Image`, an id), the reference it was created with
 * (`.Config.Image`) and the `com.docker.compose.image` label. `tags` maps each configured reference to the image's
 * top-level id now and `manifests` to its platform manifest (what `docker image inspect --platform` reports). The two
 * differ on the containerd image store, where every build writes a new top-level id over stable content. `held` lists
 * the ids the daemon still has: `docker save` reads those and fails on any other.
 */
async function run(env = {}, {
  containers = [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }],
  tags = { "aidenhq/board:local": "sha256:1111" },
  manifests = {},
  held = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  const containersFile = join(dir, "containers");
  const tagsFile = join(dir, "tags");
  const heldFile = join(dir, "held");
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
      if [ -z "$found" ]; then grep -qxF -- "$1" "$HELD"; exit $?; fi
      printf '%s\\n' "$found"; exit 0
    fi
    if [ -n "$1" ]; then grep -qxF -- "$1" "$HELD"; exit $?; fi ;;
  save)
    id="$4"
    if grep -qxF -- "$id" "$HELD"; then : > "$SAVED"; exit 0; fi
    echo "Error response from daemon: No such image: $id" >&2; exit 1 ;;
esac
exit 0
`);
  for (const f of ["stat", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(containersFile, containers.map((c) => `${c.id}\t${c.image}\t${c.config}\t${c.label ?? ""}`).join("\n") + "\n");
  writeFileSync(tagsFile, Object.entries(tags).map(([ref, id]) => `${ref}\t${id}\t${manifests[ref] ?? id}`).join("\n") + "\n");
  writeFileSync(heldFile, (held ?? [...containers.map((c) => c.image), ...Object.values(tags)]).join("\n") + "\n");
  const calls = join(dir, "calls");
  const data = join(dir, "data");
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: join(here, "../.."),
      env: {
        ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: data,
        AIDENHQ_INSTANCE_DIR: "", CONTAINERS: containersFile, TAGS: tagsFile, HELD: heldFile,
        SAVED: join(dir, "saved.tar"), ...env,
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

test("security-sbom: the host target scans / with /home and /root excluded, and /usr, /opt, /etc and dpkg still in it", async () => {
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

test("security-sbom: the image, repo and app targets keep their own scope", async () => {
  const { status, out, calls } = await run();
  assert.equal(status, 0, out);
  assert.deepEqual(syft(calls, "image:aidenhq/board:local").excludes, []);
  const repo = syft(calls, "repo:product");
  assert.deepEqual(repo.excludes, ["./data/**", "./.git/**", "**/node_modules/**"], "the checkout keeps its own scope");
  assert.ok(!repo.excludes.includes("./home/**"), "the homes are a host scope, not a checkout's");
});

test("security-sbom: an instance checkout elsewhere on the host is excluded where the host scan would otherwise read it", async () => {
  const { status, out, calls } = await run({ AIDENHQ_INSTANCE_DIR: "/home/mudit/aidenhq-instance" });
  assert.equal(status, 0, out);
  assert.ok(syft(calls, "host").excludes.includes("./home/mudit/aidenhq-instance/**"));
  assert.deepEqual(syft(calls, "repo:instance").excludes, ["./.git/**", "**/node_modules/**"]);
});

test("security-sbom: a rebuilt tag keeps its reference target while the container's platform manifest is what the tag names", async () => {
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

test("security-sbom: a container whose platform manifest differs from its tag is scanned from its saved archive", async () => {
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

test("security-sbom: an image id the daemon no longer holds is left out of the batch, with no docker save failure", async () => {
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

test("security-sbom: a container whose configured reference no longer exists is scanned too, and the syft image is not", async () => {
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

test("security-sbom: a container configured with an image id is still scanned from the saved image, never as a docker: source", async () => {
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
