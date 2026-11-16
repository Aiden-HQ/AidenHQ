// ops/ci-runner-units.sh, the apply's CI runner step: a fake `systemctl` records every call, so what the step asked the
// host to do is read from a log rather than inferred.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../ops/ci-runner-units.sh");

/** A data dir with an optional drain record, and a fake systemctl that records every call. */
function setup(record) {
  const dir = mkdtempSync(join(tmpdir(), "ci-units-"));
  for (const d of ["data", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  if (record) writeFileSync(join(dir, "data/fleet-paused.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(dir, "bin/systemctl"), `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >> "$CALLS"\nexit 0\n`);
  chmodSync(join(dir, "bin/systemctl"), 0o755);
  return { dir, calls: join(dir, "calls") };
}

function run({ dir, calls }) {
  writeFileSync(calls, "");
  return new Promise((resolve) => {
    execFile("bash", [script, join(dir, "data")], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, CALLS: calls } },
      (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, calls: readFileSync(calls, "utf8").split("\n").filter(Boolean) }));
  });
}

test("a unit a drain recorded is reset then started, clearing its start limit before the start", async () => {
  const r = await run(setup({ pausedAt: "t", routines: {}, units: ["aidenhq-ci-runner@1.service"] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ["systemctl --user reset-failed aidenhq-ci-runner@1.service", "systemctl --user start aidenhq-ci-runner@1.service"]);
  assert.match(r.out, /ci runner unit started: aidenhq-ci-runner@1\.service/, r.out);
});

test("every unit the record names is handled, whatever its service instance", async () => {
  const r = await run(setup({ pausedAt: "t", routines: {}, units: ["aidenhq-ci-runner@4.service", "aidenhq-ci-runner@Aiden-HQ-8.service"] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [
    "systemctl --user reset-failed aidenhq-ci-runner@4.service",
    "systemctl --user start aidenhq-ci-runner@4.service",
    "systemctl --user reset-failed aidenhq-ci-runner@Aiden-HQ-8.service",
    "systemctl --user start aidenhq-ci-runner@Aiden-HQ-8.service",
  ]);
});

test("no record, or a record of routines only, starts nothing", async () => {
  for (const record of [undefined, { pausedAt: "t", routines: { c1: ["r1"] }, units: [] }]) {
    const r = await run(setup(record));
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, []);
  }
});
