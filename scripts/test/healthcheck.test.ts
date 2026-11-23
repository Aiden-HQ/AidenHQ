// scripts/healthcheck.sh against fake `systemctl`, `curl` and `docker`: the host-metrics and security-sbom checks (the
// unit's ExecStart must name the applied checkout's ops/<name>.sh, read the way systemd resolves it) and the sign-in checks
// for a connection whose /healthz says it is unconfigured (a skip) or signed out (a FAIL printing the detail, apostrophes
// and all).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

test("the host-metrics check passes when the unit runs this checkout's script", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "execstart"), execStart(join(dir, "ops/host-metrics.sh")) + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    host metrics timer runs the applied checkout$/m, r.out);
});

// prune-docker.service has several ExecStart= lines; systemd prints them one per line, and the check must read the ones
// that run the applied checkout's scripts.
const pruneExecStart = (dir, { container, verify }) => [
  `{ path=/usr/bin/docker ; argv[]=/usr/bin/docker builder prune -f --max-used-space 20GB ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash ${join(dir, "ops/prune-docker-step.sh")} images /usr/bin/docker image prune -af --filter until=48h --filter label!=aidenhq.keep=true ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash ${container} ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash ${verify} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
].join("\n") + "\n";

test("the docker prune check fails when the container step is another checkout's script, naming both paths", { skip: NOT_LINUX }, async () => {
  const dir = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(dir, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  const other = join(dir, "old-checkout/ops/prune-docker-containers.sh");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "#!/usr/bin/env bash\n");
  // No per-apply file yet: ~/.config/aidenhq-checkout.env's checkout is what the unit resolves to.
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "execstart"), pruneExecStart(dir, {
    container: join(dir, "old-checkout/ops/prune-docker-containers.sh"),
    verify: "${AIDENHQ_DIR}/ops/prune-docker-verify.sh",
  }));
  const r = await run(dir);
  const line = r.out.split("\n").find((l) => l.includes("container step"));
  assert.ok(line, r.out);
  assert.match(line, /^  FAIL  docker prune timer runs the applied checkout's container step  /, line);
  assert.ok(line.includes(realpathSync(other)), line);
  assert.ok(line.includes(join(realpathSync(dir), "ops/prune-docker-containers.sh")), line);
});

test("the docker prune check passes when both steps run this checkout, through the apply's per-unit file", async () => {
  const dir = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(dir, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "home/.config/aidenhq-checkout.env"), `AIDENHQ_DIR=${join(dir, "old-checkout")}\n`);
  writeFileSync(join(dir, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${dir}\n`);
  writeFileSync(join(dir, "execstart"), pruneExecStart(dir, {
    container: "${AIDENHQ_DIR}/ops/prune-docker-containers.sh",
    verify: "${AIDENHQ_DIR}/ops/prune-docker-verify.sh",
  }));
  const r = await run(dir);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's verification$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's step wrapper$/m, r.out);
});

test("a timeout-wrapped container step still resolves to the applied checkout", { skip: NOT_LINUX }, async () => {
  // prune-docker.service runs `timeout 5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh`: the check must
  // follow timeout to the command it runs, not report the unit runs /usr/bin/timeout.
  const dir = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(dir, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "ops/prune-docker-step.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${dir}\n`);
  writeFileSync(join(dir, "execstart"), [
    `{ path=/usr/bin/timeout ; argv[]=/usr/bin/timeout 5m /usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-verify.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
});

test("timeout's `--` and an invalid duration are read the way GNU timeout reads them", { skip: NOT_LINUX }, async () => {
  const base = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(base, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(base, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${base}\n`);
  const steps = (exec) => [
    exec,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-verify.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n";
  const runWith = async (argv) => {
    writeFileSync(join(base, "execstart"), steps(`{ path=/usr/bin/timeout ; argv[]=${argv} ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`));
    return run(base);
  };
  // `timeout -- 5m cmd`: `--` before the duration only ends option parsing, so this is valid and resolves.
  let r = await runWith("/usr/bin/timeout -- 5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  // `timeout 5m -- cmd`: here `--` is the command timeout would run, which never runs the prune, so the check fails.
  r = await runWith("/usr/bin/timeout 5m -- /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  FAIL  docker prune timer runs the applied checkout's container step/m, r.out);
  // After `--` option parsing is over: `--verbose` is the duration GNU timeout would read, so this fails instead of being
  // skipped as an option.
  r = await runWith("/usr/bin/timeout -- --verbose 5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  FAIL  docker prune timer runs the applied checkout's container step/m, r.out);
  assert.match(r.out, /not one timeout accepts \(--verbose\)/);
  // A fractional duration with no digits before the point is one GNU timeout accepts (`.5m` is 30 s).
  r = await runWith("/usr/bin/timeout .5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  // The same after `--`, and with `-k` before the duration.
  r = await runWith("/usr/bin/timeout -- .5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  r = await runWith("/usr/bin/timeout -k 30s -- .5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  // GNU timeout also accepts exponent notation (`3e2s` is 300 s) and a bare number of seconds: both resolve.
  for (const d of ["3e2s", "1e-2h", ".5", "90"]) {
    r = await runWith(`/usr/bin/timeout ${d} /usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh`);
    assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, `${d}: ${r.out}`);
    r = await runWith(`/usr/bin/timeout -- ${d} /usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh`);
    assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, `-- ${d}: ${r.out}`);
  }
  // A duration GNU timeout rejects (`5min`) means the script never runs: the check must not pass it.
  r = await runWith("/usr/bin/timeout 5min /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh");
  assert.match(r.out, /^  FAIL  docker prune timer runs the applied checkout's container step/m, r.out);
  assert.match(r.out, /not one timeout accepts/);
});

test("the image step's wrapper and the docker command it runs are both applied-checkout paths", { skip: NOT_LINUX }, async () => {
  // The image prune is an `env bash ${AIDENHQ_DIR}/ops/prune-docker-step.sh images /usr/bin/docker image prune ...`: the
  // check must resolve the script after env and after splitting, not the trailing docker words as a script name.
  const dir = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(dir, "ops/prune-docker-step.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(dir, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${dir}\n`);
  writeFileSync(join(dir, "execstart"), [
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-step.sh images /usr/bin/docker image prune -af --filter until=48h --filter label!=aidenhq.keep=true ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-verify.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's verification$/m, r.out);
});

test("a checkout path with a space is one argument, and still matches", { skip: NOT_LINUX }, async () => {
  // The whole checkout lives under a directory whose name has a space: systemd prints such an argv quoted, and the check
  // must split on unquoted whitespace only, so the path stays one argument instead of two.
  const base = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(base, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  const spaced = join(base, "aiden hq");
  mkdirSync(spaced);
  for (const e of ["scripts", "ops", "bin", "config", "home", "healthz", "execstart"]) renameSync(join(base, e), join(spaced, e));
  writeFileSync(join(spaced, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${spaced}\n`);
  writeFileSync(join(spaced, "execstart"), [
    `{ path=/usr/bin/docker ; argv[]=/usr/bin/docker builder prune -f --max-used-space 20GB ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash "${spaced}/ops/prune-docker-containers.sh" ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash "${spaced}/ops/prune-docker-verify.sh" ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n");
  const r = await run(spaced);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's verification$/m, r.out);
});

test("an exec that names the checkout through ${AIDENHQ_DIR} expands after the split, so a spaced path still matches", { skip: NOT_LINUX }, async () => {
  // The unit's own ExecStart uses ${AIDENHQ_DIR}, which systemd prints unexpanded. The check substitutes it, and must do so
  // AFTER splitting: substituting first would let a space in the checkout split the one word systemd printed.
  const base = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(base, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  const spaced = join(base, "aiden hq");
  mkdirSync(spaced);
  for (const e of ["scripts", "ops", "bin", "config", "home", "healthz", "execstart"]) renameSync(join(base, e), join(spaced, e));
  writeFileSync(join(spaced, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${spaced}\n`);
  writeFileSync(join(spaced, "execstart"), [
    `{ path=/usr/bin/docker ; argv[]=/usr/bin/docker builder prune -f --max-used-space 20GB ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-verify.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n");
  const r = await run(spaced);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's verification$/m, r.out);
});

test("a checkout path with a literal & is substituted as itself, not as the matched text", { skip: NOT_LINUX }, async () => {
  // Since bash 5.2 an unquoted `&` in a substitution's replacement means "the matched text": an instance at /home/me/A&B
  // would resolve to /home/me/A${AIDENHQ_DIR}B and fail a unit systemd runs correctly. The checkout must go in literally.
  const base = checkout({ name: "prune-docker-containers", service: "prune-docker.service", timerUnit: "prune-docker.timer" });
  writeFileSync(join(base, "ops/prune-docker-verify.sh"), "#!/usr/bin/env bash\n");
  const amped = join(base, "A&B");
  mkdirSync(amped);
  for (const e of ["scripts", "ops", "bin", "config", "home", "healthz", "execstart"]) renameSync(join(base, e), join(amped, e));
  writeFileSync(join(amped, "home/.config/aidenhq-prune-docker.env"), `AIDENHQ_DIR=${amped}\n`);
  writeFileSync(join(amped, "execstart"), [
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-containers.sh ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `{ path=/usr/bin/env ; argv[]=/usr/bin/env bash \${AIDENHQ_DIR}/ops/prune-docker-verify.sh ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
  ].join("\n") + "\n");
  const r = await run(amped);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's container step$/m, r.out);
  assert.match(r.out, /^  ok    docker prune timer runs the applied checkout's verification$/m, r.out);
});

const services = [
  { port: "8085", name: "glean", label: "Glean", check: "glean sign-in" },
  { port: "8087", name: "grafana", label: "Grafana", check: "grafana sign-in" },
  { port: "8088", name: "clickhouse", label: "ClickHouse", check: "clickhouse sign-in" },
];

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

