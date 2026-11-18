// scripts/healthcheck.sh's host-metrics check: the unit's ExecStart must name the applied checkout's ops/host-metrics.sh,
// read through a fake `systemctl` the way systemd resolves it. Every other probe fails or skips against the fakes, so the
// test reads that one line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** A checkout with the real healthcheck.sh and host-metrics.sh, a module catalog, and a fake systemctl serving ExecStart. */
function checkout({ modules = true, timer = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "healthcheck-"));
  for (const d of ["scripts", "ops", "bin", "config", "home/.config/systemd/user"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(join(here, "../healthcheck.sh"), join(dir, "scripts/healthcheck.sh"));
  writeFileSync(join(dir, "ops/host-metrics.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "config/modules.json"), JSON.stringify([{ name: "monitoring", enabled: modules }]) + "\n");
  if (timer) writeFileSync(join(dir, "home/.config/systemd/user/aidenhq-host-metrics.timer"), "[Timer]\n");
  writeFileSync(join(dir, "execstart"), "");
  writeFileSync(join(dir, "bin/systemctl"), `#!/usr/bin/env bash
case "$*" in
  *"show aidenhq-host-metrics.service"*) cat "$EXECSTART" ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(dir, "bin/curl"), "#!/usr/bin/env bash\nexit 7\n");
  writeFileSync(join(dir, "bin/docker"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["systemctl", "curl", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  return dir;
}

function run(dir) {
  return new Promise((resolve) => {
    execFile("bash", [join(dir, "scripts/healthcheck.sh")], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"), EXECSTART: join(dir, "execstart"), AIDENHQ_SECRETS_DIR: join(dir, "secrets") },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
}

const execStart = (script, path = "/usr/bin/env") => `{ path=${path} ; argv[]=/usr/bin/env bash ${script} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

test("the host-metrics check fails when the unit runs another checkout's script, naming both paths", async () => {
  const dir = checkout();
  const other = join(dir, "old-checkout/ops/host-metrics.sh");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "execstart"), execStart(other) + "\n");
  const r = await run(dir);
  const line = r.out.split("\n").find((l) => l.includes("host metrics timer runs the applied checkout"));
  assert.ok(line, r.out);
  assert.match(line, /^  FAIL  host metrics timer runs the applied checkout  /, line);
  assert.ok(line.includes(realpathSync(other)), line);
  assert.ok(line.includes(join(realpathSync(dir), "ops/host-metrics.sh")), line);
});

test("the host-metrics check fails when the executable systemd starts is not the one its argv names", async () => {
  const dir = checkout();
  // systemd starts /bin/sh, but argv[] pretends env runs the applied script.
  writeFileSync(join(dir, "execstart"), execStart(join(dir, "ops/host-metrics.sh"), "/bin/sh") + "\n");
  const r = await run(dir);
  const line = r.out.split("\n").find((l) => l.includes("host metrics timer runs the applied checkout"));
  assert.ok(line, r.out);
  assert.match(line, /^  FAIL  host metrics timer runs the applied checkout  /, line);
  assert.ok(line.includes(realpathSync("/bin/sh")), line);
  assert.ok(line.includes(realpathSync("/usr/bin/env")), line);
});

test("the host-metrics check passes when the unit runs this checkout's script", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "execstart"), execStart(join(dir, "ops/host-metrics.sh")) + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    host metrics timer runs the applied checkout$/m, r.out);
});
