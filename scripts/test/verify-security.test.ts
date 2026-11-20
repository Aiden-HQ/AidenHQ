// scripts/verify-security.sh runs on the host, so its code checks (the secret scan and the pinned gate code) can drift
// from the code they pin without CI noticing. Its static parts run here: the Repository section and the pinned checks up
// to the live engine probe.
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
    slice(/^rm_="modules\//, /^# engine@1:/),
    // The vendor connections' tag rule and the GitHub guard's allowlists read the modules' manifests and sources, so they
    // run here too: a connection that grows a tool or a route fails CI, not a host.
    slice(/^# Vendor connections pass/, /^vp="kernel/),
    slice(/^# GitHub: the user's gh token/, /^# The code host \(codehost-github\) merges/),
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 16 << 20 });
  const out = r.stdout.split("\n");
  assert.deepEqual(out.filter((l) => l.startsWith("FAIL")), [], r.stderr.slice(-2000));
  assert.ok(out.filter((l) => l.startsWith("ok")).length >= 11);
});

// The live probe can't run here (no docker): it needs the compiled compose files and the running stack. What can be checked
// is that it learns which services the compiled stack contains, and skips a connection whose host is none of them before
// it tries to resolve it.
test("verify-security's connection probe skips a host the compiled stack does not contain", () => {
  const text = lines.join("\n");
  const derive = text.match(/compiled="\$\(docker compose -f compose\.yaml -f compose\.modules\.yaml config --format json 2>\/dev\/null \| node -e '([\s\S]*?)' 2>\/dev\/null\)"/);
  assert.ok(derive, "the compiled service set is derived from compose.yaml and compose.modules.yaml");
  const compose = JSON.stringify({ services: {
    "meetings-ops-mcp": { labels: { "aidenhq.service": "ops-mcp" } },
    gate: { labels: {} },
  } });
  const r = spawnSync("node", ["-e", derive[1]], { encoding: "utf8", input: compose });
  assert.equal(r.status, 0, r.stderr.slice(-1000));
  const out = r.stdout.trim().split("\n");
  assert.deepEqual(out.find((l) => l.startsWith("@services ")).split(" ").slice(1).sort(), ["gate", "meetings-ops-mcp", "ops-mcp"]);
  assert.equal(out.find((l) => l.startsWith("@nets ")), "@nets meetings-ops-mcp");

  const probe = text.slice(text.indexOf('P="$project" S="$compiled_services" node'));
  const skip = probe.indexOf("!compiled.has(host)");
  const resolve = probe.indexOf("services.resolve(c.url)");
  assert.ok(skip >= 0 && resolve > skip, "a connection outside the compiled stack is skipped before it is resolved");
});
