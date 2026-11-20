// ci.yml's suite selection (.github/ci/select.ts over the real map, .github/ci/areas.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { reuse, suitesFor } from "../../.github/ci/select.ts";

const map = JSON.parse(readFileSync(new URL("../../.github/ci/areas.json", import.meta.url), "utf8"));
const every = map.suites.map((s) => s.name);

test("a docs-only change selects nothing", () => {
  assert.deepEqual(suitesFor(map, ["docs/operations.md", "README.md", "kernel/README.md", "docs/img/flow.png"]), { all: false, names: [] });
});

test("a kernel change selects the kernel's suites, not the board's alone", () => {
  const { all, names } = suitesFor(map, ["kernel/src/writes.ts"]);
  assert.equal(all, false);
  for (const n of ["kernel", "scripts#1"]) assert.ok(names.includes(n), n);
  assert.equal(names.includes("services/board"), false);
  assert.deepEqual(suitesFor(map, ["services/board/web/App.tsx"]).names, ["scripts#1", "scripts#2", "scripts#3", "services/board"]);
});

test("an unknown path, CI itself or the map selects everything", () => {
  for (const f of ["ops/apply-config.sh", "compose.yaml", ".github/ci/areas.json", ".github/workflows/ci.yml", "services/shared/reason-codes.ts"]) {
    assert.deepEqual(suitesFor(map, ["docs/x.md", f]).names, every, f);
  }
  assert.deepEqual(suitesFor(map, ["SETUP.md", "docs/setup.md"]).names, ["scripts#1", "scripts#2", "scripts#3"], "Markdown the tests read counts");
});

test("a rebased head re-runs only the suites main's new commits also touch", () => {
  const pr = ["services/board/web/App.tsx"];
  assert.deepEqual(reuse(map, pr, ["docs/x.md", "kernel/README.md"]), []);
  assert.deepEqual(reuse(map, pr, ["kernel/src/writes.ts"]), ["scripts#1", "scripts#2", "scripts#3"]);
  assert.deepEqual(reuse(map, pr, ["ops/x.sh"]), ["scripts#1", "scripts#2", "scripts#3", "services/board"], "an unknown gained path re-runs all of the PR's");
});

test("ci-local reports the selection CI's selector returns for a diff", async () => {
  const { select } = await import("../ci-local.ts");
  const files = ["services/board/web/App.tsx", "docs/x.md"];
  assert.deepEqual(select(files).names, suitesFor(map, files).names);
});

// The map can't rot silently: every official module package with tests is a suite of its own, and every suite's paths cover
// what its files import from outside its folder (a relative path in a string), so a change there runs it.
const root = join(import.meta.dirname, "../..");
const walk = (d) => readdirSync(d).flatMap((f) => (["node_modules", "dist", ".git"].includes(f) ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const under = (f, p) => p === "*" || f === p || f.startsWith(`${p}/`);

test("a change to one module runs that module's suites, not every module's or the product's flows", () => {
  const { all, names } = suitesFor(map, ["modules/jira/connections/jira-mcp/src/server.ts"]);
  assert.equal(all, false);
  assert.deepEqual(names, ["scripts#1", "scripts#2", "scripts#3", "modules/jira/connections/jira-mcp", "modules/platform"]);
  assert.deepEqual(suitesFor(map, ["modules/chief-of-staff/agents/aiden/AGENTS.md"]).names, ["scripts#1", "scripts#2", "scripts#3", "modules/platform"], "a handbook: the compiler and the gate coverage");
});

test("every official module package with tests is a suite, and every suite's folder exists", () => {
  const suites = new Set(map.suites.map((s) => s.name));
  for (const s of map.suites) assert.ok(existsSync(join(root, s.name.split("#")[0])), `${s.name} is in .github/ci/areas.json but its folder is gone`);
  const tested = walk(join(root, "modules")).filter((f) => /\/test\/[^/]+\.test\.m?[jt]s$/.test(f)).map((f) => relative(root, f).replace(/\/test\/.*$/, ""));
  for (const dir of new Set(tested)) assert.ok(suites.has(dir), `${dir} has tests but no suite in .github/ci/areas.json`);
});

test("every suite's paths cover what it imports from outside its folder", () => {
  const misses = [];
  for (const s of map.suites.filter((x) => !x.paths.includes("*"))) {
    const dir = s.name.split("#")[0];
    for (const f of walk(join(root, dir)).filter((x) => /\.(mjs|js|ts|tsx)$/.test(x))) {
      for (const [, spec] of readFileSync(f, "utf8").matchAll(/["'`](\.\.\/[^"'`$\s]*)["'`]/g)) {
        const target = relative(root, resolve(dirname(f), spec));
        if (!target || target.startsWith("..") || !existsSync(join(root, target)) || under(target, dir) || under(dir, target)) continue;
        if (map.everything.some((p) => under(target, p)) || s.paths.some((p) => p !== "*" && under(target, p))) continue;
        misses.push(`${s.name}: ${relative(root, f)} reads ${target}`);
      }
    }
  }
  assert.deepEqual([...new Set(misses)], []);
});
