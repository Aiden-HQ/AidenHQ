// ui-review's default paths come from the app's feature map (feature-map.json, next to server.mjs's PAGES), so the
// filtered view, the open sheet and the deep link are reviewed without naming them; an explicit --paths replaces it,
// and an app with no map is still reviewed at "/" as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const MAP = {
  pages: [
    { path: "/", shows: "Projects: the summary and the table" },
    { path: "/teams", shows: "Teams: one row per team" },
    { path: "/?status=late", shows: "Projects filtered to Late" },
    { path: "/?item=search-v2", shows: "The Search v2 detail sheet open" },
  ],
};
const STUB_PAGES = JSON.stringify({ "/": "Projects", "/teams": "Teams", "/?status=late": "Late projects", "/?item=search-v2": "Search v2" });

/** Run ui-review from `cwd` (the app's folder); `map` is written there as feature-map.json when given. */
function review({ cwd, map = MAP, paths = null, args = [] } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "ui-review-map-"));
  if (map) writeFileSync(join(dir, "feature-map.json"), typeof map === "string" ? map : JSON.stringify(map));
  const out = mkdtempSync(join(tmpdir(), "ui-review-map-out-"));
  const argv = [join(here, "../images/agent-base/ui-review"), "http://127.0.0.1:9", "--out", out, "--widths", "1280", "--modes", "light", "--no-routes"];
  if (paths) argv.push("--paths", paths);
  argv.push(...args);
  let code = 0, stderr = "";
  try {
    execFileSync("node", argv, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_BROWSER: join(here, "fixtures/agent-browser-stub.cjs"), STUB_PAGES } });
  } catch (e) {
    code = e.status;
    stderr = String(e.stderr);
  }
  const report = code === 0 || code === 1 ? JSON.parse(readFileSync(join(out, "report.json"), "utf8")) : null;
  return { code, stderr, report, md: report ? readFileSync(join(out, "report.md"), "utf8") : null };
}

test("no --paths: the feature map's paths are reviewed, each with what should be visible there", () => {
  const r = review({});
  assert.equal(r.code, 0, r.md ?? r.stderr);
  assert.deepEqual(r.report.pages.map((p) => p.path), ["/", "/teams", "/?status=late", "/?item=search-v2"]);
  // The map travels in the report, so a reviewer (or a grader) can tell what was reviewed and why.
  assert.deepEqual(r.report.featureMap, MAP.pages);
  assert.match(r.md, /### \/\?item=search-v2 — The Search v2 detail sheet open/);
});

test("an explicit --paths wins over the feature map", () => {
  const r = review({ paths: "/teams,/?status=late" });
  assert.equal(r.code, 0, r.md ?? r.stderr);
  assert.deepEqual(r.report.pages.map((p) => p.path), ["/teams", "/?status=late"]);
});

test("an app with no feature map is reviewed at / as before, not failed", () => {
  const r = review({ map: null });
  assert.equal(r.code, 0, r.md ?? r.stderr);
  assert.deepEqual(r.report.pages.map((p) => p.path), ["/"]);
  assert.equal(r.report.featureMap, null);
});

test("a feature map that is there but unreadable stops the run instead of being ignored", () => {
  const bad = review({ map: "{ not json" });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /feature-map\.json is not valid JSON/);
  const empty = review({ map: JSON.stringify({ pages: [] }) });
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /needs \{"pages": \[\{"path": "\/…"/);
});

test("a map path that leaves the app's origin is refused", () => {
  const r = review({ map: JSON.stringify({ pages: [{ path: "//elsewhere.example/page", shows: "not this app" }] }) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /each a path on this app/);
});
