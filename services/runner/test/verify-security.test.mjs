// scripts/verify-security.sh runs on the host, so its code checks (the secret scan and the pinned gate code) can drift
// from the code they pin without CI noticing. Its static parts run here: the Repository section and the pinned checks up
// to the live engine probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const lines = readFileSync(`${repo}/scripts/verify-security.sh`, "utf8").split("\n");
const slice = (from, to) => {
  const a = lines.findIndex((l) => from.test(l)), b = lines.findIndex((l, i) => i > a && to.test(l));
  assert.ok(a >= 0 && b > a, `markers ${from} … ${to}`);
  return lines.slice(a, b).join("\n");
};

test("verify-security's code checks pass on this checkout", () => {
  const script = [
    "set -uo pipefail",
    `repo=${JSON.stringify(repo)}; cd "$repo"`,
    'pass() { echo "ok    $1"; }; fail() { echo "FAIL  $1"; }',
    slice(/^echo "Repository"/, /^echo "Capabilities/),
    slice(/^rm_="modules\//, /^# engine@1:/),
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 16 << 20 });
  const out = r.stdout.split("\n");
  assert.deepEqual(out.filter((l) => l.startsWith("FAIL")), [], r.stderr.slice(-2000));
  assert.ok(out.filter((l) => l.startsWith("ok")).length >= 8);
});
