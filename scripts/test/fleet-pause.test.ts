import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ciDrain, hasJob, listedUnits, runnerContainer } from "../fleet-pause.ts";

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
