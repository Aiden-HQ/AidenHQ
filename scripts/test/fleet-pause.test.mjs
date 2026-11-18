import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciDrain, hasJob, listedUnits, mergePaused, runnerContainer } from "../fleet-pause.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../fleet-pause.mjs");

test("a drain stops idle units now (active or not) and waits for one running a job", () => {
  const rows = listedUnits(
    [
      "aidenhq-ci-runner@1.service loaded active running", // a job is on it
      "aidenhq-ci-runner@2.service loaded active running", // waiting for a job: active too
      "aidenhq-ci-runner@4.service loaded activating auto-restart", // between jobs
      "aidenhq-ci-runner@7.service loaded failed failed", // already down
    ].join("\n"),
  );
  const tops = { "aidenhq-ci-runner-1": "runner 1 Runner.Listener\nrunner 9 Runner.Worker spawnclient", "aidenhq-ci-runner-2": "runner 1 Runner.Listener run" };
  const working = (unit) => hasJob(tops[runnerContainer(unit)] ?? "");
  assert.deepEqual(ciDrain(rows, working), { stop: ["aidenhq-ci-runner@2.service", "aidenhq-ci-runner@4.service"], wait: ["aidenhq-ci-runner@1.service"] });
});

/** A checkout with a data dir holding a pause record, a paperclip key file, and a fake systemctl that records its calls. */
function checkout(units) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pause-"));
  for (const d of ["data", "secrets", "bin", "scripts"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "data/fleet-paused.json"), JSON.stringify({ pausedAt: "t", routines: {}, units }));
  writeFileSync(join(dir, "secrets/paperclip_board_key"), "k\n");
  writeFileSync(
    join(dir, "bin/systemctl"),
    `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$SYSTEMCTL_LOG"
case "$*" in *" is-active "*) cat "$FAKE_IS_ACTIVE" 2>/dev/null || echo failed ;; esac
exit 0
`,
  );
  chmodSync(join(dir, "bin/systemctl"), 0o755);
  return dir;
}

function resume(dir, env = {}) {
  const log = join(dir, "systemctl.log");
  writeFileSync(log, "");
  return new Promise((resolve) => {
    execFile(process.execPath, [script, "resume"], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
        SYSTEMCTL_LOG: log,
        AIDENHQ_ENV_FILE: join(dir, "none.env"),
        AIDENHQ_DATA_DIR: join(dir, "data"),
        AIDENHQ_SECRETS_DIR: join(dir, "secrets"),
        ...env,
      },
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) }));
  });
}

test("resume clears each unit's start limit before starting it: reset-failed, then start", async () => {
  const units = ["aidenhq-ci-runner@1.service", "aidenhq-ci-runner@4.service"];
  const dir = checkout(units);
  writeFileSync(join(dir, "active"), "active\n");
  const r = await resume(dir, { FAKE_IS_ACTIVE: join(dir, "active") });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, [
    `systemctl --user reset-failed ${units.join(" ")}`,
    `systemctl --user start ${units.join(" ")}`,
    ...units.map((u) => `systemctl --user is-active ${u}`),
  ]);
  assert.ok(!existsSync(join(dir, "data/fleet-paused.json")), "the record is deleted once resumed");
});
