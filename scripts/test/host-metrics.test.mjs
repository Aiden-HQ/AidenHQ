// ops/host-metrics.sh with fake `systemctl` and `docker` on PATH: the textfiles it writes are read back, so
// "a recorded drain is not a failure" is a value in units.prom, not an inference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/host-metrics.sh");

/**
 * A checkout with a data dir and a fake `systemctl` whose `list-units` prints `units`, `list-unit-files` prints `enabled`,
 * and a fake `docker` whose `ps -q` prints `containers`' ids and `inspect` prints their compose-name-id-running-restarts-health.
 */
function checkout(units, record, enabled = [], containers = []) {
  const dir = mkdtempSync(join(tmpdir(), "host-metrics-"));
  for (const d of ["data/modules/monitoring/textfile", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "ops-script"), "");
  mkdirSync(join(dir, "ops"), { recursive: true });
  if (record) writeFileSync(join(dir, "data/fleet-paused.json"), typeof record === "string" ? record : JSON.stringify(record, null, 2) + "\n");
  writeFileSync(
    join(dir, "bin/systemctl"),
    `#!/usr/bin/env bash
case "$*" in
  *" list-units "*) cat "$UNITS" ;;
  *" list-unit-files "*)
    pats=(); for a in "$@"; do case "$a" in --*|list-unit-files|--user) ;; *) pats+=("$a") ;; esac; done
    while read -r line; do
      for p in "\${pats[@]}"; do case "\${line%% *}" in $p) echo "$line"; break ;; esac; done
    done < "$ENABLED" ;;
esac
exit 0
`,
  );
  // `ps` honours `-q`/`-aq` and `--filter label=key[=value]` as Docker does; `inspect` prints the given ids' fields.
  writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash
q=0; filters=(); ids=()
for a in "\${@:2}"; do
  case "$a" in
    --filter) want=label ;;
    --format) want=format ;;
    -*) case "$a" in *q*) q=1 ;; esac ;;
    *) case "\${want:-}" in label) filters+=("\${a#label=}"); want= ;; format) want= ;; *) ids+=("$a") ;; esac ;;
  esac
done
awk -v q="$q" -v fs="\${filters[*]}" -v want="\${ids[*]}" 'BEGIN { n = split(fs, f, " ") }
  { keep = (n == 0); split($8, kv, ",")
    for (i = 1; i <= n; i++) for (j in kv) if (kv[j] == f[i] || index(kv[j], f[i] "=") == 1) keep = 1
    if (!keep) next
    if (want != "" && index(" " want " ", " " $1 " ") == 0) next
    if (q) print $1; else print $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 }' "$CONTAINERS"
exit 0
`);
  for (const f of ["systemctl", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(join(dir, "units"), units.join("\n") + "\n");
  writeFileSync(join(dir, "containers"), containers.map((c) => Object.values(c).join(" ")).join("\n") + (containers.length ? "\n" : ""));
  writeFileSync(join(dir, "enabled"), enabled.map((u) => `${u} enabled`).join("\n") + "\n");
  return dir;
}

function metrics(dir, file = "units.prom") {
  return new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        AIDENHQ_DATA_DIR: join(dir, "data"),
        UNITS: join(dir, "units"),
        ENABLED: join(dir, "enabled"),
        CONTAINERS: join(dir, "containers"),
      },
    }, (error, stdout, stderr) => {
      const path = join(dir, `data/modules/monitoring/textfile/${file}`);
      resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, prom: existsSync(path) ? readFileSync(path, "utf8") : "" });
    });
  });
}

const value = (prom, metric, labels = "") => {
  const line = prom.split("\n").find((l) => l.startsWith(`${metric}{${labels}} `) || (!labels && l.startsWith(`${metric} `)));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
};

const ciUnits = [
  "aidenhq-ci-runner@1.service loaded failed failed AidenHQ CI runner 1",
  "aidenhq-ci-runner@4.service loaded failed failed AidenHQ CI runner 4",
  "aidenhq-runner.service loaded active running Engineer jobs",
];

test("a failed unit reads 1, and a unit that is fine reads 0", async () => {
  const r = await metrics(checkout(ciUnits));
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@1.service"'), 1);
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-runner.service"'), 0);
  assert.equal(value(r.prom, "aidenhq_unit_active", 'scope="user",unit="aidenhq-runner.service"'), 1);
  assert.match(r.prom, /^aidenhq_fleet_draining 0$/m, "no record, no drain");
});

test("a drain recorded in data/fleet-paused.json raises no UnitFailed for the units it stopped", async () => {
  const r = await metrics(checkout(ciUnits, {
    pausedAt: "2026-11-16T00:58:45.000Z",
    routines: { c1: ["r1"] },
    units: ["aidenhq-ci-runner@1.service", "aidenhq-ci-runner@4.service"],
  }));
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@1.service"'), 0);
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@4.service"'), 0);
  assert.equal(value(r.prom, "aidenhq_fleet_draining"), 1);
});

test("a unit that failed outside the recorded drain still reads 1, and one line of JSON parses too", async () => {
  const r = await metrics(checkout(ciUnits, '{"pausedAt":"t","routines":{},"units":["aidenhq-ci-runner@1.service"]}'));
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@1.service"'), 0);
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@4.service"'), 1);
});

test("a declared unit reads 1, a unit the host has disabled has no declared series, and the state metrics are unchanged", async () => {
  const r = await metrics(checkout(ciUnits, undefined, ["aidenhq-ci-runner@1.service", "aidenhq-runner.service", "docker.service"]));
  assert.equal(value(r.prom, "aidenhq_unit_declared", 'scope="user",unit="aidenhq-ci-runner@1.service"'), 1);
  assert.equal(value(r.prom, "aidenhq_unit_declared", 'scope="user",unit="aidenhq-runner.service"'), 1);
  assert.equal(value(r.prom, "aidenhq_unit_declared", 'scope="user",unit="aidenhq-ci-runner@4.service"'), undefined, "a disabled unit is not declared");
  assert.equal(value(r.prom, "aidenhq_unit_declared", 'scope="system",unit="aidenhq-ci-runner@1.service"'), undefined, "declared is user scope only");
  assert.equal(value(r.prom, "aidenhq_unit_declared", 'scope="user",unit="docker.service"'), undefined, "only the AidenHQ units are declared");
  assert.equal(value(r.prom, "aidenhq_unit_failed", 'scope="user",unit="aidenhq-ci-runner@1.service"'), 1);
  assert.equal(value(r.prom, "aidenhq_unit_active", 'scope="user",unit="aidenhq-runner.service"'), 1);
});

// A container as the fake reports it: the fields `docker inspect` fills (its image last), its labels as one
// `key=value,key=value` field, and the two label flags the writer reads (`computer`, `oneoff`).
const box = (id, project, service, name, { running = "true", restarts = 0, health = "none", computer = false, oneoff = false, image = "aidenhq/gate:local" } = {}) => ({
  id, project, service, name, running, restarts, health, computer: computer ? "yes" : "no", oneoff: oneoff ? "yes" : "no", image,
  labels: [project === "-" ? "" : `com.docker.compose.project=${project}`, service === "-" ? "" : `com.docker.compose.service=${service}`, computer ? "aidenhq.computer=" : "", oneoff ? "aidenhq.oneoff=1" : ""].filter(Boolean).join(",") || "-",
});

test("a live container with no compose labels and one whose tag has moved are named, and a stopped service still reads 0", async () => {
  const r = await metrics(checkout(ciUnits, undefined, [], [
    box("a1b2c3", "aidenhq", "gate", "/aidenhq-gate-1"),
    // `docker run` with no labels at all, and its image rebuilt under it since: the writing keys on neither.
    box("d4e5f6", "-", "-", "/n-whisper", { restarts: 2, health: "unhealthy" }),
    box("f7a8b9", "aidenhq-mod-monitoring", "gateway", "/aidenhq-mod-monitoring-gateway-1"),
    // The security scan's own container while it runs: not part of the fleet. A one-off running another image is,
    // so only the syft container is left out. A stopped service keeps a 0, which CoreServiceDown reads; a finished
    // one-off gets no series.
    box("b0b0", "-", "-", "/gallant_syft", { oneoff: true, image: "anchore/syft:v1.57.1" }),
    box("b1b1", "-", "-", "/adhoc_check", { oneoff: true, image: "alpine:3.22" }),
    box("c0ffee", "aidenhq", "board", "/aidenhq-board-1", { running: "false" }),
    box("5ca9", "-", "-", "/sad_syft", { running: "false" }),
  ]), "containers.prom");
  assert.equal(r.status, 0, r.out);
  assert.equal(value(r.prom, "aidenhq_container_running", 'id="/system.slice/docker-a1b2c3.scope",project="aidenhq",service="gate",name="aidenhq-gate-1"'), 1);
  assert.equal(value(r.prom, "aidenhq_container_running", 'id="/system.slice/docker-d4e5f6.scope",project="-",service="-",name="n-whisper"'), 1);
  assert.equal(value(r.prom, "aidenhq_container_restarts", 'id="/system.slice/docker-d4e5f6.scope",project="-",service="-",name="n-whisper"'), 2);
  assert.equal(value(r.prom, "aidenhq_container_unhealthy", 'id="/system.slice/docker-d4e5f6.scope",project="-",service="-",name="n-whisper"'), 1);
  assert.equal(value(r.prom, "aidenhq_container_running", 'id="/system.slice/docker-f7a8b9.scope",project="aidenhq-mod-monitoring",service="gateway",name="aidenhq-mod-monitoring-gateway-1"'), 1);
  assert.equal(value(r.prom, "aidenhq_container_running", 'id="/system.slice/docker-c0ffee.scope",project="aidenhq",service="board",name="aidenhq-board-1"'), 0);
  assert.doesNotMatch(r.prom, /docker-(b0b0|5ca9)\.scope/);
  assert.equal(value(r.prom, "aidenhq_container_running", 'id="/system.slice/docker-b1b1.scope",project="-",service="-",name="adhoc_check"'), 1);
  assert.equal(r.prom.split("\n").filter((l) => l.startsWith("aidenhq_container_running{")).length, 5);
});
