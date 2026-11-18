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

/** The script against one running container (image `aidenhq/board:local`), a throwaway data dir and a logging `docker`. */
async function run(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "security-sbom-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/stat"), "#!/usr/bin/env bash\necho 0\n"); // the Docker socket's group
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
case "$1" in
  ps) echo c1 ;;
  inspect) echo 'aidenhq/board:local' ;;
  run) printf '%s\\n' "$*" >> "$CALLS" ;;
esac
`);
  for (const f of ["stat", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  const calls = join(dir, "calls");
  const r = await new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: join(here, "../.."),
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, AIDENHQ_DATA_DIR: join(dir, "data"), AIDENHQ_INSTANCE_DIR: "", ...env },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [] };
}

/** One target's syft run: the source it scanned and its `--exclude` patterns. */
function syft(calls, target) {
  const line = calls.find((c) => c.includes(`--source-name ${target}`));
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
