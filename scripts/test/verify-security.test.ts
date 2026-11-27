// scripts/verify-security.sh runs on the host, so its static checks can drift from the modules they read without CI noticing.
// They run here: the secret scan, the vendor connections' tag rule, the GitHub guard's allowlists, the reviewer's code list,
// Primer's write floors, ClickHouse's and Grafana's manifests and the engines' web-search probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
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
    // The vendor connections' tag rule and the GitHub guard's allowlists read the modules' manifests and sources, so they
    // run here too: a connection that grows a tool or a route fails CI, not a host.
    slice(/^# Vendor connections pass/, /^# A job never sees/),
    slice(/^# GitHub: the owner's token and the App's/, /^# C3-final/),
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 16 << 20 });
  const out = r.stdout.split("\n");
  assert.deepEqual(out.filter((l) => l.startsWith("FAIL")), [], r.stderr.slice(-2000));
  assert.ok(out.filter((l) => l.startsWith("ok")).length >= 9);
});
