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

test("lint: an emoji in JSX text fails and points to lucide icons; plain symbols pass", () => {
  const run = (src) => spawnSync(join("node_modules/.bin/eslint"), ["--stdin", "--stdin-filename", "src/pages/launch.tsx"], { cwd: root, input: src, encoding: "utf8" });
  const bad = run(readFileSync(new URL("fixtures/emoji-label.tsx", import.meta.url), "utf8"));
  assert.equal(bad.status, 1, bad.stderr);
  assert.ok(bad.stdout.includes("lucide-react icon"), bad.stdout);
  assert.equal(run("export const A = () => <p>© 2026 Acme ✓ saved</p>\n").status, 0);
});

test("lint: the craft slips fail with the fix, and the accessible forms pass", () => {
  const r = spawnSync(join("node_modules/.bin/eslint"), ["--stdin", "--stdin-filename", "src/pages/slips.tsx", "--format", "json"], { cwd: root, input: readFileSync(new URL("fixtures/craft-slips.tsx", import.meta.url), "utf8"), encoding: "utf8" });
  const hits = JSON.parse(r.stdout)[0].messages.map((m) => `${m.line}: ${m.message.split(":")[0].slice(0, 40)}`);
  assert.equal(hits.length, 4, hits.join("\n"));
  assert.match(hits[0], /^4: Use a <button/);
  assert.deepEqual(hits.slice(1).map((h) => h.split(":")[0]), ["6", "6", "6"]);
  assert.equal(spawnSync(join("node_modules/.bin/eslint"), ["--stdin", "--stdin-filename", "src/pages/ok.tsx"], { cwd: root, input: '<meta content="width=device-width, user-scalable=no" />', encoding: "utf8" }).status, 1);
});
