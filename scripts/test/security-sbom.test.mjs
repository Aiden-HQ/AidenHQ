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
 * `{ id, image, config }`: its id, the image it runs (`.Image`, an id) and the reference it was created with
 * (`.Config.Image`); `tags` maps each configured reference to the image id it resolves to now, as `docker image inspect` does.
 */
async function run(env = {}, { containers = [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }], tags = { "aidenhq/board:local": "sha256:1111" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\necho 0\n"); // the Docker socket's group
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
case "$1 $2" in
  "ps -q") printf '%s\\n' ${containers.map((c) => `'${c.id}'`).join(" ")} ;;
  "inspect -f") printf '%s\\n' ${containers.map((c) => `'${c.id} ${c.image} ${c.config}'`).join(" ")} ;;
  "image inspect") awk -v ref="$5" '$1 == ref { print $2; found = 1 } END { exit !found }' "$TAGS" ;;
esac
case "$1" in run|save) printf '%s\\n' "$*" >> "$CALLS" ;; esac
exit 0
`);
  for (const f of ["stat", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(join(dir, "tags"), Object.entries(tags).map(([ref, id]) => `${ref} ${id}`).join("\n") + "\n");
  const calls = join(dir, "calls");
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: join(here, "../.."),
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, TAGS: join(dir, "tags"), AIDENHQ_DATA_DIR: join(dir, "data"), AIDENHQ_INSTANCE_DIR: "", ...env },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [] };
}

/** One target's syft run: the source it scanned and its `--exclude` patterns. */
function syft(calls, target) {
  const line = calls.find((c) => c.startsWith("run ") && c.includes(`--source-name ${target}`));
  assert.ok(line, `no syft run for ${target}:\n${calls.join("\n")}`);
  return { line, excludes: [...line.matchAll(/--exclude (\S+)/g)].map((m) => m[1]) };
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

test("security-sbom: a container whose tag has moved is scanned as its running image, under a target that stays put", async () => {
  // Its configured tag was rebuilt after the container started, so it names another image now: the tag is not its image.
  const retagged = { id: "c2", image: "sha256:2222", config: "aidenhq/whisper:local" };
  const { status, out, calls } = await run({}, {
    containers: [{ id: "c1", image: "sha256:1111", config: "aidenhq/board:local" }, retagged],
    tags: { "aidenhq/board:local": "sha256:1111", "aidenhq/whisper:local": "sha256:3333" },
  });
  assert.equal(status, 0, out);
  // The tag still resolves to the running image: its target is the reference, as before.
  assert.match(syft(calls, "image:aidenhq/board:local").line, / docker:aidenhq\/board:local /);
  // The moved tag gets no target of its own, and the image that runs is scanned from what `docker save` wrote, by its id.
  assert.ok(!calls.some((c) => c.includes("--source-name image:aidenhq/whisper:local")), calls.join("\n"));
  assert.match(syft(calls, "image:sha256:2222").line, / docker-archive:\/work\/image\.tar( |$)/);
  const save = calls.find((c) => c.startsWith("save "));
  // The scan's own container is labelled, so the host metrics leave it out of the container inventory.
  assert.ok(syft(calls, "image:sha256:2222").line.includes("--label aidenhq.oneoff=1"), syft(calls, "image:sha256:2222").line);
  assert.ok(save && save.includes("-o ") && save.includes("sha256:2222"), `docker save of the running image:\n${calls.join("\n")}`);
});

test("security-sbom: a container whose configured reference no longer exists is scanned too, and the syft image is not", async () => {
  const { status, out, calls } = await run({}, {
    containers: [
      { id: "c3", image: "sha256:4444", config: "aidenhq/whisper@sha256:0000" },
      { id: "c4", image: "sha256:5555", config: "anchore/syft:v1.57.1" },
    ],
    tags: {},
  });
  assert.equal(status, 0, out);
  assert.match(syft(calls, "image:sha256:4444").line, / docker-archive:\/work\/image\.tar( |$)/);
  assert.ok(!calls.some((c) => c.includes("sha256:5555") || c.includes("--source-name image:anchore/syft")), "the throwaway syft container is not a target");
});
