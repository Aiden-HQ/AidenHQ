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
import { NODE_DIR } from "./node-dir.ts";
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
  // `docker compose config` serves the module model in MODULES (absent: none), and `docker inspect` the state a service's
  // container reports in STATE (`<service>=<running> <health>`), so the module-service probe can be exercised without Docker.
  writeFileSync(join(dir, "state"), "");
  writeFileSync(join(dir, "modules.json"), "");
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
if [ "$1" = compose ]; then
  [ -f "$MODULES" ] && { cat "$MODULES"; exit 0; }
  exit 1
fi
if [ "$1" = ps ]; then
  label=""; mod=""; running=""; for a in "$@"; do
    case "$a" in
      label=aidenhq.service=*) label="\${a#label=aidenhq.service=}";;
      label=aidenhq.module=*) mod="\${a#label=aidenhq.module=}";;
      -q) ;;
      *) [ "$a" = "-aq" ] && running="\${a%-aq}" ;;
    esac
  done
  # A state line may name <module>/<service> when two modules declare the same service name (absent: the service alone).
  state=""; [ -n "$mod" ] && state="$(sed -n "s|^$mod/$label=||p" "$STATE" 2>/dev/null | head -1)"
  [ -n "$state" ] || state="$(sed -n "s|^$label=||p" "$STATE" 2>/dev/null | head -1)"
  [ -n "$state" ] || exit 0
  id="id-\${mod:+$mod/}$label"
  case "$state" in running*) echo "$id" ;; *) [ -n "$running" ] || echo "$id" ;; esac
  exit 0
fi
if [ "$1" = inspect ]; then
  svc="\${4#id-}"; state="$(sed -n "s|^$svc=||p" "$STATE" 2>/dev/null | head -1)"
  [ -n "$state" ] || { svc="\${svc##*/}"; state="$(sed -n "s|^$svc=||p" "$STATE" 2>/dev/null | head -1)"; }
  printf '%s\n' "$state"
  exit 0
fi
exit 0
`);
  for (const f of ["systemctl", "curl", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  return dir;
}

function run(dir) {
  return new Promise((resolve) => {
    execFile("bash", [join(dir, "scripts/healthcheck.sh")], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin`, HOME: join(dir, "home"), EXECSTART: join(dir, "execstart"), AIDENHQ_SECRETS_DIR: join(dir, "secrets"), HEALTHZ: join(dir, "healthz"), MODULES: join(dir, "modules.json"), STATE: join(dir, "state") },
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


test("an ops-mcp health body names a failing vault check", async () => {
  const dir = checkout({ healthz: { 8080: JSON.stringify({ ok: false, detail: "vault_writable: not writable: Meetings", checks: { sqlite_writable: { ok: true }, transcripts_readable: { ok: true }, vault_available: { ok: false }, vault_writable: { ok: false }, paperclip_api: { ok: true } } }) } });
  writeFileSync(join(dir, "config/modules.json"), JSON.stringify([{ name: "meetings", enabled: true }]) + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  FAIL  ops-mcp vault_available/m, r.out);
  assert.match(r.out, /^  FAIL  ops-mcp vault_writable/m, r.out);
});

test("an ops-mcp vault that is not configured is skipped, never a failed check", async () => {
  // A blank VAULT_FOLDERS install upgrades from an image whose own /vault read as available: its vault checks must not
  // turn a baseline ok into a FAIL, which the apply takes for a regression and rolls back.
  const dir = checkout({ healthz: { 8080: JSON.stringify({ ok: false, state: "missing", detail: "vault not configured (set VAULT_DIR and VAULT_FOLDERS in .env); vault_available: not usable: Meetings; vault_writable: not writable: Meetings", checks: { sqlite_writable: { ok: true }, transcripts_readable: { ok: true }, vault_available: { ok: false }, vault_writable: { ok: false }, paperclip_api: { ok: true } } }) } });
  writeFileSync(join(dir, "config/modules.json"), JSON.stringify([{ name: "meetings", enabled: true }]) + "\n");
  const r = await run(dir);
  assert.match(r.out, /^  skip  ops-mcp vault_available/m, r.out);
  assert.match(r.out, /^  skip  ops-mcp vault_writable/m, r.out);
  assert.doesNotMatch(r.out, /^  FAIL  ops-mcp vault/m, r.out);
});

// The module-service probe (WOR-14006): a module turned on must not land "container up, nobody knows if it answers". The
// model is `docker compose config`'s (MODULES), the verdict Docker's own HEALTHCHECK (STATE), so a module whose image
// declares none is listed, never failed, and an `on_demand` service (a profile) is not a service the host runs.
const moduleModel = (entries) => JSON.stringify({ services: Object.fromEntries(entries.map(([label, mod, extra = {}]) => [
  `${mod}-${label}`, { image: `${mod}-${label}:local`, labels: { "aidenhq.module": mod, "aidenhq.service": label }, healthcheck: { test: ["CMD", "node", "-e", "x"] }, ...extra },
])) }) + "\n";

test("a module service whose container is running and healthy passes", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["ssh", "server-manager"]]));
  writeFileSync(join(dir, "state"), "ssh=running healthy\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    module service server-manager\/ssh$/m, r.out);
  assert.doesNotMatch(r.out, /^  FAIL  module service/m, r.out);
});

test("two modules that each declare a service named api are two checks, never one", async () => {
  // The check's name is <module>/<service>: a baseline line for one module's `api` must not excuse the other's (WOR-14006
  // review). One healthy and one unhealthy, in one model, prints one ok and one FAIL.
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["api", "alpha"], ["api", "beta"]]));
  writeFileSync(join(dir, "state"), "alpha/api=running healthy\nbeta/api=running unhealthy\n");
  const r = await run(dir);
  assert.match(r.out, /^  ok    module service alpha\/api$/m, r.out);
  assert.match(r.out, /^  FAIL  module service beta\/api  running unhealthy$/m, r.out);
});

test("a module service whose container is unhealthy fails, naming it and its module", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["ssh", "server-manager"]]));
  writeFileSync(join(dir, "state"), "ssh=running unhealthy\n");
  const r = await run(dir);
  assert.match(r.out, /^  FAIL  module service server-manager\/ssh  running unhealthy$/m, r.out);
  assert.match(r.out, /check\(s\) failed\.$/m, r.out);
});

test("a module service with no container at all fails: an enabled module's service that never started is not 'up'", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["server-manager-ssh", "server-manager"]]));
  const r = await run(dir);
  assert.match(r.out, /^  FAIL  module service server-manager\/server-manager-ssh  no container$/m, r.out);
});

test("a module service whose image declares no health check is listed, never failed", async () => {
  // It cannot be judged from here: the probe reports a service that answers nothing, it does not invent a contract for one
  // whose image declares none (and failing those would roll back every apply that adds one).
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["db", "primer"]]));
  writeFileSync(join(dir, "state"), "db=running none\n");
  const r = await run(dir);
  assert.match(r.out, /^  skip  module service primer\/db \(its image declares no health check\)$/m, r.out);
  assert.doesNotMatch(r.out, /^  FAIL  module service/m, r.out);
});

test("an on_demand service (a compose profile) is not probed: the host never starts one", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), moduleModel([["runner", "ci", { profiles: ["ci"] }]]));
  const r = await run(dir);
  assert.doesNotMatch(r.out, /^  (ok|FAIL|skip)  module service ci\/(runner|ci-runner)/m, r.out);
});

test("a compose model that cannot be read skips the probe rather than failing every service", async () => {
  const dir = checkout();
  writeFileSync(join(dir, "modules.json"), "__unreadable__");
  const r = await run(dir);
  assert.match(r.out, /^  skip  module services \(the compiled compose could not be read\)$/m, r.out);
  assert.doesNotMatch(r.out, /^  FAIL  module service/m, r.out);
});
