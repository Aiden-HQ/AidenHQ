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

// ---- measurements and references (lane B) ----
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const NEEDS_CHROME = { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" };

/** One page, measured the way a capture does (the capture lane's own pipeline wraps the same two calls). */
async function measuredCapture(url: string, width: number, theme: "light" | "dark") {
  const { chromium } = await import("../images/agent-base/ui-review/node_modules/playwright-core/index.mjs");
  const { measurePage } = await import("../images/agent-base/ui-review/measure.ts");
  const { measureMotion } = await import("../images/agent-base/ui-review/motion.ts");
  const b = await chromium.launch({ executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH });
  try {
    const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForTimeout(400);
    return { measures: await measurePage(p), motion: await measureMotion(p) };
  } finally { await b.close(); }
}

test("measurements find the planted defects", NEEDS_CHROME, async () => {
  const f = await startFixture();
  try {
    const c = await measuredCapture(f.url + "/#/planted", 1512, "light");
    assert.ok(c.measures.spacing.offScale.includes(13)); // one 13px gap among 8/16/24
    assert.ok(c.measures.fonts.some((x) => x.size === 15)); // one stray size among 12/14/16/20
    assert.ok(c.measures.colours.some((x) => x.value === "rgb(255, 0, 170)"));
    assert.ok(c.measures.nearMisses.length >= 1); // two cards 2px out of line
    assert.ok(c.motion.transitions.some((t) => t.duration >= 600)); // the planted slow transition
    assert.ok(!c.motion.animations.some((a) => a.playState === "finished"));
  } finally { await f.close(); }
});

/** A stand-in for a third-party site: /ok serves a page with sub-requests, /429 and /403 refuse; counts requests per second. */
async function thirdPartySite() {
  const hits: number[] = [];
  const server = createServer((req, res) => {
    hits.push(Date.now());
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/429") return void res.writeHead(429).end("slow down");
    if (path === "/403") return void res.writeHead(403).end("no");
    if (path.startsWith("/asset")) return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>`);
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Reference</title><h1>Reference list</h1><ul>${"<li>Row one</li><li>Row two</li>".repeat(3)}</ul>${Array.from({ length: 12 }, (_, i) => `<img src="/asset${i}.svg">`).join("")}`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    maxPerSecond: () => hits.reduce((m, t) => Math.max(m, hits.filter((u) => u >= t && u < t + 1000).length), 0),
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

test("refs skip a refusing site, fall back to the starter for a dead kind, and keep to 4 requests/s", NEEDS_CHROME, async () => {
  const { refs } = await import("../images/agent-base/ui-review/refs.ts");
  const site = await thirdPartySite();
  const starter = await thirdPartySite(); // stands in for the served app starter (any path serves a page)
  try {
    const r = await refs(
      [{ kind: "list", url: site.url("/ok") }, { kind: "list", url: site.url("/429") }, { kind: "form", url: site.url("/403") }],
      { out: mkdtempSync(join(tmpdir(), "ui-refs-test-")), fallbackBase: starter.url(""), gapMs: 0 },
    );
    assert.equal(r.refs.filter((x) => x.kind === "list").length, 1);
    assert.match(r.notes.join("\n"), /429/);
    assert.equal(r.refs.find((x) => x.kind === "form")!.source, "fallback");
    assert.ok(r.refs.find((x) => x.kind === "list")!.tokens.typeScale.length >= 1);
    assert.ok(site.maxPerSecond() <= 4, `max ${site.maxPerSecond()} requests in one second`);
  } finally { await site.close(); await starter.close(); }
});
