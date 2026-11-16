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

/** A checkout with a data dir and a fake `systemctl` whose `list-units` prints `units`. */
function checkout(units, record) {
  const dir = mkdtempSync(join(tmpdir(), "host-metrics-"));
  for (const d of ["data/monitoring/textfile", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "ops-script"), "");
  mkdirSync(join(dir, "ops"), { recursive: true });
  if (record) writeFileSync(join(dir, "data/fleet-paused.json"), typeof record === "string" ? record : JSON.stringify(record, null, 2) + "\n");
  writeFileSync(
    join(dir, "bin/systemctl"),
    `#!/usr/bin/env bash
case "$*" in *" list-units "*) cat "$UNITS" ;; esac
exit 0
`,
  );
  writeFileSync(join(dir, "bin/docker"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["systemctl", "docker"]) chmodSync(join(dir, "bin", f), 0o755);
  writeFileSync(join(dir, "units"), units.join("\n") + "\n");
  return dir;
}

function metrics(dir) {
  return new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, AIDENHQ_DATA_DIR: join(dir, "data"), UNITS: join(dir, "units") },
    }, (error, stdout, stderr) => {
      const file = join(dir, "data/monitoring/textfile/units.prom");
      resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, prom: existsSync(file) ? readFileSync(file, "utf8") : "" });
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
