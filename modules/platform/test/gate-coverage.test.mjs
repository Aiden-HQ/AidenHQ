// The modules' half of the gate's core (check.mjs) covers every file in a gate directory of this repository, and every entry
// still names one of its files (lean-core 0a). The product holds its own half to the same rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageProblems } from "../src/check.mjs";

// This repository's files, as the product holds them (at its modules/).
const root = fileURLToPath(new URL("../..", import.meta.url));
const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name))).filter((f) => !/(^|\/)(node_modules|\.git|dist)\//.test(f) && f !== ".sha").map((f) => `modules/${f}`);

test("every gate file is covered and every entry is used", () => assert.deepEqual(coverageProblems(files), []));

test("a moved gate file fails", () => {
  const problems = coverageProblems(files.map((f) => (f === "modules/primer/module.yaml" ? "modules/primer/plugin.yaml" : f)));
  assert.ok(problems.includes("dead entry: ^modules\\/primer\\/module\\.yaml$"));
});
