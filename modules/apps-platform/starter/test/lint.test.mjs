// The linter bites: a typical hand-rolled header (test/fixtures) must fail with the fix in the message, and the same
// source under src/components/blocks/ (library code) keeps its navigation and header exemptions.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
// Oxlint reads files, not stdin: lint a copy of the config and plugin with the source written at the path it pretends to be.
const dir = mkdtempSync(join(tmpdir(), "starter-lint-"));
for (const f of [".oxlintrc.json", "oxlint-plugin.mjs"]) copyFileSync(join(root, f), join(dir, f));
after(() => rmSync(dir, { recursive: true, force: true }));
const lint = (as, source) => {
  mkdirSync(dirname(join(dir, as)), { recursive: true });
  writeFileSync(join(dir, as), source);
  // JSON, whatever the environment: Oxlint picks its own output format on CI (GitHub annotations).
  const r = spawnSync(join(root, "node_modules/.bin/oxlint"), ["-f", "json", "--deny-warnings", as], { cwd: dir, encoding: "utf8" });
  const found = JSON.parse(r.stdout).diagnostics.map((d) => ({ line: d.labels[0].span.line, col: d.labels[0].span.column, text: `${d.message} ${d.help ?? ""}` })).sort((x, y) => x.line - y.line || x.col - y.col);
  return { status: r.status, out: found.map((d) => d.text).join("\n"), hits: found.map((d) => `${d.line}: ${d.text}`) };
};

test("lint: a hand-rolled header fails with the fix", () => {
  const r = lint("src/components/app-header.tsx", fixture("hand-rolled-header.tsx"));
  assert.equal(r.status, 1, r.out);
  for (const fix of ["Use <Link href> from lib/navigation", "Use TopBarShell, SidebarShell or BareShell", "Use a theme token", "into a hook in hooks/ or lib/"])
    assert.ok(r.out.includes(fix), `message: ${fix}`);
});

test("lint: block code is exempt from navigation, header and effect rules", () => {
  const out = lint("src/components/blocks/app-header.tsx", fixture("hand-rolled-header.tsx")).out;
  assert.doesNotMatch(out, /lib\/navigation|TopBarShell|hooks\/ or lib/);
});

test("lint: an emoji in JSX text fails and points to lucide icons; plain symbols pass", () => {
  const bad = lint("src/pages/launch.tsx", fixture("emoji-label.tsx"));
  assert.equal(bad.status, 1, bad.out);
  assert.ok(bad.out.includes("lucide-react icon"), bad.out);
  assert.equal(lint("src/pages/launch.tsx", "export const A = () => <p>© 2026 Acme ✓ saved</p>\n").status, 0);
});

test("lint: the craft slips fail with the fix, and the accessible forms pass", () => {
  const { hits } = lint("src/pages/slips.tsx", fixture("craft-slips.tsx"));
  assert.equal(hits.length, 4, hits.join("\n"));
  assert.match(hits[0], /^4: Use a <button/);
  assert.deepEqual(hits.slice(1).map((h) => h.split(":")[0]), ["6", "6", "6"]);
  assert.equal(lint("src/pages/ok.tsx", 'export const M = () => <meta content="width=device-width, user-scalable=no" />\n').status, 1);
});

test("lint: a routing library or a hand-built DOM in a component test fails with the fix, subpaths included", () => {
  const router = lint("src/pages/nav.tsx", 'import { Link } from "react-router/dom"\nexport const L = Link\n');
  assert.equal(router.status, 1, router.out);
  assert.ok(router.out.includes("Use <Link href> from lib/navigation"), router.out);
  const dom = lint("src/test/dom.test.tsx", 'import { createRoot } from "react-dom/client"\nexport const r = createRoot\n');
  assert.equal(dom.status, 1, dom.out);
  assert.ok(dom.out.includes("Render with @testing-library/react"), dom.out);
});
