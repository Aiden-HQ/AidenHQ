// The product's GATE_CORE (src/gate-core.mjs) covers every product file in a gate directory, and every entry still names a
// product file (lean-core 0a). The official modules hold their half to the same rule in their own repo (platform's tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coverageProblems } from "../src/gate-core.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const product = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 << 20, encoding: "utf8" }).split("\0").filter(Boolean);
const moved = (from, to) => product.map((f) => (f === from ? to : f));

test("every gate file is covered and every entry is used", () => assert.deepEqual(coverageProblems(product), []));

test("a moved gate file fails", () => {
  const problems = coverageProblems(moved("services/runner/src/state.ts", "services/runner/src/store.ts"));
  assert.ok(problems.includes("uncovered: services/runner/src/store.ts"));
  assert.ok(problems.some((p) => p.startsWith("dead entry: ^services\\/runner\\/src\\/state")));
});

test("a renamed board gate file fails", () => {
  const problems = coverageProblems(moved("services/board/src/fleet.ts", "services/board/src/fleets.ts"));
  assert.ok(problems.includes("dead entry: ^services\\/board\\/src\\/fleet\\.ts$"));
});
