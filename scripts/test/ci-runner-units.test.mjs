// ops/ci-runner-units.sh, the apply's CI runner step: a fake `systemctl` records every call, so what the step asked the
// host to do is read from a log rather than inferred. Its states say which runner instances are enabled (declared) and
// which have failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../ops/ci-runner-units.sh");

/**
 * A data dir with an optional drain record, and a fake systemctl. `units` are the loaded runner instances as
 * [unit, active state] (systemd's UNIT LOAD ACTIVE SUB columns); `enabled` are the ones the config declares. Every call
 * is logged.
 */
function setup({ record, units = [], enabled = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-units-"));
  for (const d of ["data", "bin", "state"]) mkdirSync(join(dir, d), { recursive: true });
  if (record) writeFileSync(join(dir, "data/fleet-paused.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(dir, "state/units"), units.map(([unit, state]) => `${unit} loaded ${state} loaded`).join("\n") + "\n");
  writeFileSync(join(dir, "state/enabled"), enabled.join("\n") + "\n");
  writeFileSync(
    join(dir, "bin/systemctl"),
    `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$CALLS"
unit="\${!#}"
case "$2" in
  list-units) case "$*" in *--state=failed*) awk '$3 == "failed"' "$STATE/units" ;; *) cat "$STATE/units" ;; esac ;;
  is-enabled) grep -qxF "$unit" "$STATE/enabled" ;;
  is-failed) awk -v u="$unit" '$1 == u && $3 == "failed" { f = 1 } END { exit !f }' "$STATE/units" ;;
  *) true ;;
esac
`,
  );
  chmodSync(join(dir, "bin/systemctl"), 0o755);
  return { dir, calls: join(dir, "calls") };
}

function run({ dir, calls }) {
  writeFileSync(calls, "");
  return new Promise((resolve) => {
    execFile("bash", [script, join(dir, "data")], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls, STATE: join(dir, "state") } },
      (error, stdout, stderr) => {
        const all = readFileSync(calls, "utf8").split("\n").filter(Boolean);
        resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, calls: all, actions: all.filter((c) => / (reset-failed|start) /.test(c)) });
      });
  });
}

test("a declared unit that failed with no drain record is reset then started", async () => {
  const r = await run(setup({ units: [["aidenhq-ci-runner@2.service", "failed"]], enabled: ["aidenhq-ci-runner@2.service"] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.actions, ["systemctl --user reset-failed aidenhq-ci-runner@2.service", "systemctl --user start aidenhq-ci-runner@2.service"]);
  assert.match(r.out, /ci runner unit started: aidenhq-ci-runner@2\.service/, r.out);
});

test("a declared unit that is up is left alone", async () => {
  const r = await run(setup({ units: [["aidenhq-ci-runner@2.service", "active"]], enabled: ["aidenhq-ci-runner@2.service"] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.actions, []);
});

test("a failed unit the config no longer declares is not started", async () => {
  const r = await run(setup({ units: [["aidenhq-ci-runner@9.service", "failed"]], enabled: ["aidenhq-ci-runner@2.service"] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.actions, []);
});

test("a unit the drain record names is reset then started, and one unit handled once", async () => {
  const r = await run(setup({
    record: { pausedAt: "t", routines: {}, units: ["aidenhq-ci-runner@4.service", "aidenhq-ci-runner@Aiden-HQ-8.service"] },
    units: [["aidenhq-ci-runner@4.service", "failed"], ["aidenhq-ci-runner@Aiden-HQ-8.service", "inactive"]],
    enabled: ["aidenhq-ci-runner@4.service"],
  }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.actions, [
    "systemctl --user reset-failed aidenhq-ci-runner@4.service",
    "systemctl --user start aidenhq-ci-runner@4.service",
    "systemctl --user reset-failed aidenhq-ci-runner@Aiden-HQ-8.service",
    "systemctl --user start aidenhq-ci-runner@Aiden-HQ-8.service",
  ]);
});

test("no record and nothing failed starts nothing", async () => {
  for (const opts of [
    {},
    { record: { pausedAt: "t", routines: { c1: ["r1"] }, units: [] }, units: [["aidenhq-ci-runner@1.service", "active"]], enabled: ["aidenhq-ci-runner@1.service"] },
  ]) {
    const r = await run(setup(opts));
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.actions, []);
  }
});
