// The ui-review engine's end-to-end tests. The ones that drive Chrome skip without AGENT_BROWSER_EXECUTABLE_PATH (so CI skips them).
// Run them in the agent-base image against this worktree's code (WT = the worktree's absolute path):
//   docker run --rm --cpus 2 --memory 6g -v "$WT":/w aidenhq/computer-agent-base:current sh -c 'cd /w/services/computer/images/agent-base/ui-review && npm ci --ignore-scripts --no-audit --no-fund && cd /w/services/computer && perl -e "alarm shift; exec @ARGV" 900 node --test test/ui-review.e2e.test.ts'
// The lanes add their tests below (capture, queue, measurements, references), each skipped without Chrome:
//   { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" }
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROUTES, startFixture } from "./fixtures/ui-app/server.ts";

const main = fileURLToPath(new URL("../images/agent-base/ui-review/main.ts", import.meta.url));

test("ui-review --help lists the six subcommands", () => {
  const r = spawnSync("node", [main, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  for (const c of ["capture", "pages", "routes", "refs", "review", "fix-check"]) assert.match(r.stdout, new RegExp(`^  ${c} `, "m"));
});

test("the fixture app serves 60 routes and counts writes", async () => {
  const f = await startFixture();
  try {
    assert.equal(ROUTES.length, 60);
    assert.equal((await fetch(f.url + "/")).status, 200);
    await fetch(f.url + "/api/delete", { method: "POST" });
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("every fixture route renders its own page, and /planted carries its defects", { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" }, async () => {
  const { chromium } = await import("../images/agent-base/ui-review/node_modules/playwright-core/index.mjs");
  const f = await startFixture();
  const b = await chromium.launch({ executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH });
  try {
    const p = await b.newPage();
    const headings = new Set<string | null>();
    for (const r of ROUTES) { await p.goto(f.url + r); await p.waitForTimeout(30); headings.add(await p.locator("h1").first().textContent()); }
    assert.equal(headings.size, 60);
    await p.goto(f.url + "/#/planted");
    const odd = await p.evaluate(() => getComputedStyle(document.querySelector(".odd-size")!).fontSize);
    assert.equal(odd, "15px");
  } finally { await b.close(); await f.close(); }
});
