// ci.yml's suite selection (.github/ci/select.mjs over the real map, .github/ci/areas.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { reuse, suitesFor } from "../../.github/ci/select.mjs";

const map = JSON.parse(readFileSync(new URL("../../.github/ci/areas.json", import.meta.url), "utf8"));
const every = map.suites.map((s) => s.name);

test("a docs-only change selects nothing", () => {
  assert.deepEqual(suitesFor(map, ["docs/operations.md", "README.md", "kernel/README.md", "docs/img/flow.png"]), { all: false, names: [] });
});

test("a runner change selects the runner's jobs, not the board's alone", () => {
  const { all, names } = suitesFor(map, ["services/runner/src/land.mjs"]);
  assert.equal(all, false);
  for (const n of ["services/runner", "services/runner#flows", "scripts"]) assert.ok(names.includes(n), n);
  assert.deepEqual(suitesFor(map, ["services/runner/src/prompt.ts"]).names.includes("services/runner#flows"), false, "prompt text skips the flows");
  assert.deepEqual(suitesFor(map, ["services/board/web/App.tsx"]).names, ["scripts", "services/board"]);
});

test("an unknown path, CI itself or the map selects everything", () => {
  for (const f of ["ops/apply-config.sh", "compose.yaml", ".github/ci/areas.json", ".github/workflows/ci.yml", "modules-pin.json"]) {
    assert.deepEqual(suitesFor(map, ["docs/x.md", f]).names, every, f);
  }
  assert.deepEqual(suitesFor(map, ["SETUP.md", "docs/setup.md"]).names, ["scripts"], "Markdown the tests read counts");
});

test("a rebased head re-runs only the suites main's new commits also touch", () => {
  const pr = ["services/board/web/App.tsx"];
  assert.deepEqual(reuse(map, pr, ["docs/x.md", "kernel/README.md"]), []);
  assert.deepEqual(reuse(map, pr, ["services/runner/src/land.mjs"]), ["scripts", "services/board"]);
  assert.deepEqual(reuse(map, pr, ["ops/x.sh"]), ["scripts", "services/board"], "an unknown gained path re-runs all of the PR's");
});
