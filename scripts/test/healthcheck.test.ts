// scripts/healthcheck.sh against fake `systemctl`, `curl` and `docker`: the host-metrics and security-sbom checks (the
// unit's ExecStart must name the applied checkout's ops/<name>.sh, read the way systemd resolves it) and the sign-in checks
// for a connection whose /healthz says it is unconfigured (a skip) or signed out (a FAIL printing the detail, apostrophes
// and all).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NOT_LINUX = process.platform !== "linux" && "compares realpaths; macOS temp dirs sit behind the /var -> /private/var symlink";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A checkout with the real healthcheck.sh and the given timers' ops/<name>.sh scripts, a module catalog, and a fake
 * systemctl serving the named service's ExecStart. `healthz` maps a service's port to its /healthz body (a fake curl
 * serves it; every other request fails).
 */
function checkout({ modules = true, timer = true, healthz = {}, name = "host-metrics", service = "aidenhq-host-metrics.service", timerUnit = "aidenhq-host-metrics.timer" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "healthcheck-"));
  for (const d of ["scripts", "ops", "bin", "config", "home/.config/systemd/user", "healthz"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(join(here, "../healthcheck.sh"), join(dir, "scripts/healthcheck.sh"));
  writeFileSync(join(dir, `ops/${name}.sh`), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "config/modules.json"), JSON.stringify([{ name: "monitoring", enabled: modules }, { name: "security", enabled: modules }]) + "\n");
  if (timer) writeFileSync(join(dir, "home/.config/systemd/user", timerUnit), "[Timer]\n");
  writeFileSync(join(dir, "execstart"), "");
  for (const [port, body] of Object.entries(healthz)) writeFileSync(join(dir, `healthz/${port}`), body);
  writeFileSync(join(dir, "bin/systemctl"), `#!/usr/bin/env bash
case "$*" in
  *"show ${service}"*) cat "$EXECSTART" ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(dir, "bin/curl"), `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    http://*/healthz) port="\${arg#http://*:}"; port="\${port%/healthz}" ;;
  esac
done
[ -n "\${port:-}" ] && [ -f "$HEALTHZ/$port" ] || exit 7
cat "$HEALTHZ/$port"
`);
  writeFileSync(join(dir, "bin/docker"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["systemctl", "curl", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  return dir;
}

function run(dir) {
  return new Promise((resolve) => {
    execFile("bash", [join(dir, "scripts/healthcheck.sh")], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"), EXECSTART: join(dir, "execstart"), AIDENHQ_SECRETS_DIR: join(dir, "secrets"), HEALTHZ: join(dir, "healthz") },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
}

const execStart = (script, path = "/usr/bin/env") => `{ path=${path} ; argv[]=/usr/bin/env bash ${script} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

test("the host-metrics check fails when the unit runs another checkout's script, naming both paths", { skip: NOT_LINUX }, async () => {
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

test("the security-sbom check fails when the unit runs another checkout's script, naming both paths", { skip: NOT_LINUX }, async () => {
  const dir = checkout({ name: "security-sbom", service: "aidenhq-security-sbom.service", timerUnit: "aidenhq-security-sbom.timer" });
  const other = join(dir, "old-checkout/ops/security-sbom.sh");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "#!/usr/bin/env bash\n");
  // ~/.config/aidenhq-checkout.env names the checkout setup recorded, as on a host the applies never moved, and no
  // per-apply file exists yet: that checkout's script is what the unit would run.
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "execstart"), execStart("${AIDENHQ_DIR}/ops/security-sbom.sh") + "\n");
  const r = await run(dir);
  const line = r.out.split("\n").find((l) => l.includes("security sbom timer runs the applied checkout"));
  assert.ok(line, r.out);
  assert.match(line, /^  FAIL  security sbom timer runs the applied checkout  /, line);
  assert.ok(line.includes(realpathSync(other)), line);
  assert.ok(line.includes(join(realpathSync(dir), "ops/security-sbom.sh")), line);
});

test("the security-sbom check passes when the unit runs this checkout's script", async () => {
  const dir = checkout({ name: "security-sbom", service: "aidenhq-security-sbom.service", timerUnit: "aidenhq-security-sbom.timer" });
  // The checkout setup recorded is another one; the apply's per-apply file, read after it, names this checkout and wins.
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "home/.config/aidenhq-security-sbom.env"), `AIDENHQ_DIR=${dir}\n`);
  writeFileSync(join(dir, "execstart"), execStart("${AIDENHQ_DIR}/ops/security-sbom.sh") + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    security sbom timer runs the applied checkout$/m, r.out);
});

test("the docker prune check fails when the unit runs another checkout's script, naming both paths", { skip: NOT_LINUX }, async () => {
  const dir = checkout({ name: "prune-docker", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  const other = join(dir, "old-checkout/ops/prune-docker.sh");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "#!/usr/bin/env bash\n");
  // No per-apply file yet: ~/.config/aidenhq-checkout.env's checkout is what the unit resolves to.
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "execstart"), execStart("${AIDENHQ_DIR}/ops/prune-docker.sh") + "\n");
  const r = await run(dir);
  const line = r.out.split("\n").find((l) => l.includes("docker prune timer runs the applied checkout"));
  assert.ok(line, r.out);
  assert.match(line, /^  FAIL  docker prune timer runs the applied checkout  /, line);
  assert.ok(line.includes(realpathSync(other)), line);
  assert.ok(line.includes(join(realpathSync(dir), "ops/prune-docker.sh")), line);
});

test("the docker prune check passes when the apply's per-unit file names this checkout", async () => {
  const dir = checkout({ name: "prune-docker", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${dir}\n`);
  writeFileSync(join(dir, "execstart"), execStart("${AIDENHQ_DIR}/ops/prune-docker.sh") + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout$/m, r.out);
});

const services = [
  { port: "8085", name: "glean", label: "Glean", check: "glean sign-in" },
  { port: "8087", name: "grafana", label: "Grafana", check: "grafana sign-in" },
  { port: "8088", name: "clickhouse", label: "ClickHouse", check: "clickhouse sign-in" },
];

test("an unconfigured connection skips instead of failing a sign-in check, details with an apostrophe included", async () => {
  for (const s of services) {
    for (const body of [
      { ok: false, state: "missing", detail: `${s.label} isn't set up` },
      { ok: false, state: "missing", detail: `${s.label} not connected (Connect on the board)` },
      { ok: false, state: "none", detail: `${s.label} isn't set up` },
    ]) {
      const dir = checkout({ healthz: { [s.port]: JSON.stringify(body) } });
      const r = await run(dir);
      assert.doesNotMatch(r.out, new RegExp(`FAIL  ${s.check}`), r.out);
      assert.match(r.out, new RegExp(`^  skip  ${s.name} `, "m"), r.out);
    }
  }
});

test("a set-up connection whose sign-in failed fails with its detail, apostrophes and all", async () => {
  for (const s of services) {
    const detail = `${s.label} sign-in expired: it's no longer valid (Reconnect on the board)`;
    const dir = checkout({ healthz: { [s.port]: JSON.stringify({ ok: false, state: "expired", detail }) } });
    const r = await run(dir);
    const line = r.out.split("\n").find((l) => l.startsWith(`  FAIL  ${s.check}  `));
    assert.ok(line, r.out);
    assert.ok(line.includes(detail), line);
    assert.doesNotMatch(r.out, /Syntax error/, r.out);
    // The helper returns nonzero rather than exiting, so `check` records the FAIL and the run finishes.
    assert.match(r.out, /check\(s\) failed\.$/m, r.out);
  }
});

test("a set-up connection with no detail still fails, naming the service", async () => {
  const dir = checkout({ healthz: { "8085": JSON.stringify({ ok: false, state: "expired" }) } });
  const r = await run(dir);
  assert.match(r.out, /^  FAIL  glean sign-in  glean-mcp unreachable$/m, r.out);
});
