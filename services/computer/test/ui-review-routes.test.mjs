// ui-review's route check against a stub browser: an app whose link changes the URL but not the page (a store that tracks
// only the query string while the page is picked by the path) fails the review, and the same app built right passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const PAGES = JSON.stringify({ "/": "Projects: Billing export, Search v2", "/teams": "Teams: Payments, Platform, Mobile" });

function review({ pages = PAGES, ...env } = {}) {
  const out = mkdtempSync(join(tmpdir(), "ui-review-routes-"));
  let code = 0;
  try {
    execFileSync("node", [join(here, "../images/agent-base/ui-review"), "http://127.0.0.1:9", "--paths", "/", "--out", out, "--widths", "1280", "--modes", "light"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_BROWSER: join(here, "fixtures/agent-browser-stub.cjs"), STUB_PAGES: pages, STUB_STATE: join(out, "stub.json"), ...env },
    });
  } catch (e) {
    code = e.status;
  }
  return { code, md: readFileSync(join(out, "report.md"), "utf8"), json: JSON.parse(readFileSync(join(out, "report.json"), "utf8")) };
}

test("a nav link that changes the URL but not the page blocks the review", () => {
  const r = review({ STUB_BROKEN: "1" });
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.blocking, [
    '/ link "Go /teams" (/teams): clicking it changes the URL to /teams but the page stays the same',
    '/ link "Go /teams" (/teams): a reload of /teams shows a different page than the click did',
  ]);
  assert.match(r.md, /## Routes \(click, Back, Forward, reload\)/);
});

test("every route rendering on click, Back, Forward and reload passes", () => {
  const r = review({});
  assert.equal(r.code, 0, r.md);
  assert.deepEqual(r.json.routes, [{ from: "/", link: "Go /teams", to: "/teams", problems: [] }]);
});

test("a route the server doesn't list renders on click but answers 404 on reload: that blocks", () => {
  const r = review({ STUB_404: "/teams" });
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.blocking, ['/ link "Go /teams" (/teams): a reload of /teams answers 404']);
});

test("a link that only changes the numbers on the page (a query such as ?range=) renders", () => {
  const r = review({ pages: JSON.stringify({ "/": "Last 7 days: 12 items", "/?range=30": "Last 30 days: 48 items" }) });
  assert.equal(r.code, 0, r.md);
  assert.deepEqual(r.json.routes[0].problems, []);
});
