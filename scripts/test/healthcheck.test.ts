// scripts/healthcheck.sh against fake `systemctl`, `curl` and `docker`: the host-metrics check (the unit's ExecStart must
// name the applied checkout's ops/host-metrics.sh, read the way systemd resolves it) and the sign-in checks for a
// connection whose /healthz says it is unconfigured (a skip) or signed out (a FAIL printing the detail, apostrophes and
// all).
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
 * A checkout with the real healthcheck.sh and host-metrics.sh, a module catalog, and a fake systemctl serving ExecStart.
 * `healthz` maps a service's port to its /healthz body (a fake curl serves it; every other request fails).
 */
function checkout({ modules = true, timer = true, healthz = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "healthcheck-"));
  for (const d of ["scripts", "ops", "bin", "config", "home/.config/systemd/user", "healthz"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(join(here, "../healthcheck.sh"), join(dir, "scripts/healthcheck.sh"));
  writeFileSync(join(dir, "ops/host-metrics.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "config/modules.json"), JSON.stringify([{ name: "monitoring", enabled: modules }]) + "\n");
  if (timer) writeFileSync(join(dir, "home/.config/systemd/user/aidenhq-host-metrics.timer"), "[Timer]\n");
  writeFileSync(join(dir, "execstart"), "");
  for (const [port, body] of Object.entries(healthz)) writeFileSync(join(dir, `healthz/${port}`), body);
  writeFileSync(join(dir, "bin/systemctl"), `#!/usr/bin/env bash
case "$*" in
  *"show aidenhq-host-metrics.service"*) cat "$EXECSTART" ;;
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
