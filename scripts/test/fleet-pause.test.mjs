import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciDrain, listedUnits, mergePaused } from "../fleet-pause.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../fleet-pause.mjs");

test("a second pause keeps what the first recorded (those routines are paused now, so it doesn't see them)", () => {
  const first = mergePaused(undefined, { pausedAt: "t1", routines: { c1: ["a", "b"] }, units: ["aidenhq-ci-runner@1.service"] });
  const second = mergePaused(first, { pausedAt: "t2", routines: { c1: [], c2: ["x"] }, units: [] });
  assert.deepEqual(second, { pausedAt: "t1", routines: { c1: ["a", "b"], c2: ["x"] }, units: ["aidenhq-ci-runner@1.service"] });
});

test("list-units rows read as unit, active state and sub-state", () => {
  const text = [
    "aidenhq-ci-runner@1.service loaded active running AidenHQ CI runner 1",
    "aidenhq-ci-runner@4.service loaded activating auto-restart AidenHQ CI runner 4",
    "aidenhq-ci-runner@7.service loaded failed failed AidenHQ CI runner 7",
    "",
  ].join("\n");
  assert.deepEqual(listedUnits(text), [
    { unit: "aidenhq-ci-runner@1.service", active: "active", sub: "running" },
    { unit: "aidenhq-ci-runner@4.service", active: "activating", sub: "auto-restart" },
    { unit: "aidenhq-ci-runner@7.service", active: "failed", sub: "failed" },
  ]);
});

test("a drain stops idle units now and waits for one running a job", () => {
  const rows = listedUnits(
    [
      "aidenhq-ci-runner@1.service loaded active running", // a job is on it
      "aidenhq-ci-runner@4.service loaded activating auto-restart", // between jobs
      "aidenhq-ci-runner@5.service loaded activating start", // its job's container is starting
      "aidenhq-ci-runner@7.service loaded failed failed", // already down
    ].join("\n"),
  );
  assert.deepEqual(ciDrain(rows), { stop: ["aidenhq-ci-runner@4.service"], wait: ["aidenhq-ci-runner@1.service", "aidenhq-ci-runner@5.service"] });
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

test("a runner waiting for its next job (activating) counts as up", async () => {
  const units = ["aidenhq-ci-runner@5.service"];
  const dir = checkout(units);
  writeFileSync(join(dir, "active"), "activating\n");
  const r = await resume(dir, { FAKE_IS_ACTIVE: join(dir, "active") });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /started aidenhq-ci-runner@5\.service/);
});

test("a unit that refuses its start is reported, and the record is kept", async () => {
  const units = ["aidenhq-ci-runner@10.service"];
  const dir = checkout(units);
  writeFileSync(join(dir, "active"), "failed\n");
  const r = await resume(dir, { FAKE_IS_ACTIVE: join(dir, "active") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not running after start: aidenhq-ci-runner@10\.service/, r.out);
  assert.ok(readFileSync(join(dir, "data/fleet-paused.json"), "utf8").includes("aidenhq-ci-runner@10.service"), "the record stays");
});
