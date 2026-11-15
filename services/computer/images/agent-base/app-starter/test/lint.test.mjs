// The linter bites: a typical hand-rolled header (test/fixtures) must fail with the fix in the message, and the same
// source under src/components/blocks/ (library code) keeps its navigation and header exemptions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(new URL("fixtures/hand-rolled-header.tsx", import.meta.url), "utf8");
const lint = (as) => spawnSync(join("node_modules/.bin/eslint"), ["--stdin", "--stdin-filename", as], { cwd: root, input: source, encoding: "utf8" });

test("lint: a hand-rolled header fails with the fix", () => {
  const r = lint("src/components/app-header.tsx");
  assert.equal(r.status, 1, r.stderr);
  for (const fix of ["Use <Link href> from lib/navigation", "Use TopBarShell, SidebarShell or BareShell", "Use a theme token", "into a hook in hooks/ or lib/"])
    assert.ok(r.stdout.includes(fix), `message: ${fix}`);
});

test("lint: block code is exempt from navigation, header and effect rules", () => {
  const out = lint("src/components/blocks/app-header.tsx").stdout;
  assert.doesNotMatch(out, /lib\/navigation|TopBarShell|hooks\/ or lib/);
});
