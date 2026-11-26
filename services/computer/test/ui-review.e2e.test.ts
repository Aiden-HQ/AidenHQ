// The ui-review engine's end-to-end tests. The ones that drive Chrome skip without AGENT_BROWSER_EXECUTABLE_PATH (so CI skips them).
// Run them in the agent-base image against this worktree's code (WT = the worktree's absolute path):
//   docker run --rm --cpus 2 --memory 6g -v "$WT":/w aidenhq/computer-agent-base:current sh -c 'cd /w/services/computer/images/agent-base/ui-review && npm ci --ignore-scripts --no-audit --no-fund && cd /w/services/computer && perl -e "alarm shift; exec @ARGV" 900 node --test test/ui-review.e2e.test.ts'
// The lanes add their tests below (capture, queue, measurements, references), each skipped without Chrome:
//   { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" }
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Fixture, ROUTES, startFixture } from "./fixtures/ui-app/server.ts";

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

// ---- capture, coverage queue, route check (lane A) ----
const chrome = { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" };
const W6 = [390, 768, 1024, 1512, 1920, 2560];
type Run = { out: string; coverage: { done: number; total: number; failed: number; deferred: number }; captures: { page: string; width: number; theme: string; state: string; shots: string[]; settled: boolean; motion?: unknown; diffs?: { shot: string; pct: number }[] }[]; lookFirst: { page: string }[] };
const tmp = () => mkdtempSync(join(tmpdir(), "ui-review-test-"));
const capArgs = (url: string, o: { out: string; pagesFile?: string; widths?: number[]; themes?: string[]; resume?: boolean; baseline?: string }) =>
  [main, "capture", url, "--out", o.out, ...(o.pagesFile ? ["--pages-file", o.pagesFile] : []), ...(o.widths ? ["--widths", o.widths.join(",")] : []), ...(o.themes ? ["--themes", o.themes.join(",")] : []), ...(o.resume ? ["--resume"] : []), ...(o.baseline ? ["--baseline", o.baseline] : []), "--commit", "test"];
const pagesFile = (paths: string[]) => { const f = join(tmp(), "pages.json"); writeFileSync(f, JSON.stringify(paths)); return f; };
const pages = (n: number) => pagesFile(Array.from({ length: n }, (_, i) => `/#/p${String(i + 1).padStart(3, "0")}`));
function startCapture(url: string, o: Parameters<typeof capArgs>[1]) { return spawn("node", capArgs(url, o), { stdio: "ignore" }); }
async function runCapture(url: string, o: Partial<Parameters<typeof capArgs>[1]> & { pages?: string[] }): Promise<Run> {
  const out = o.out ?? tmp();
  const p = startCapture(url, { ...o, out, pagesFile: o.pages ? pagesFile(o.pages) : o.pagesFile });
  const code = await new Promise((ok) => p.on("exit", ok));
  assert.ok(code === 0 || code === 1, `ui-review capture exited ${code}`);
  const r = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Run;
  // "Look at these first": the pages with a shot changed by 0.1% or more against the baseline, biggest change first.
  const changed = r.captures.map((c) => ({ page: c.page, pct: Math.max(0, ...(c.diffs ?? []).map((d) => d.pct)) })).filter((c) => c.pct >= 0.1).sort((a, b) => b.pct - a.pct);
  return { ...r, out, lookFirst: [...new Map(changed.map((c) => [c.page, c])).values()] };
}
const runRoutes = (url: string) => new Promise<number>((ok) => spawn("node", [main, "routes", url, "--out", tmp(), "--paths", "/#/danger"], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 2)));
async function waitForDone(out: string, n: number) {
  for (;;) {
    try { if ((JSON.parse(readFileSync(join(out, "queue.json"), "utf8")) as { status: string }[]).filter((i) => i.status === "done").length >= n) return; } catch { /* not written yet */ }
    await sleep(100);
  }
}
const key = (c: Run["captures"][number]) => `${c.page}|${c.width}|${c.theme}|${c.state}`;

describe("capture", chrome, () => {
  let fixture: Fixture, fixtureUrl: string, liveAlias: string;
  before(async () => { fixture = await startFixture(); fixtureUrl = fixture.url; liveAlias = `http://live.localhost:${fixture.port}`; }); // *.localhost: loopback for Chrome, not a local build for the engine
  after(() => fixture.close());

  test("capture covers 60 routes at 6 widths x 2 themes under 600 s", async () => {
    const t0 = Date.now(); const r = await runCapture(fixtureUrl, { pagesFile: pagesFile(ROUTES), widths: W6, themes: ["light", "dark"] });
    console.log(`capture: 720 captures in ${Math.round((Date.now() - t0) / 1000)} s`);
    assert.equal(r.coverage.total, 720); assert.equal(r.coverage.done, 720); assert.ok(Date.now() - t0 < 600_000);
    assert.ok(r.captures.find((c) => c.page === "/#/scroll" && c.width === 1512)!.shots.length >= 2);
    assert.equal(r.captures.find((c) => c.page === "/#/live")!.settled, false); // capped, not aborted
  });
  test("resume picks up a killed run without repeats", async () => {
    const out = tmp(), o = { out, pagesFile: pagesFile(ROUTES), widths: [390, 1512], themes: ["light"] };
    const p = startCapture(fixtureUrl, o); await waitForDone(out, 100); p.kill("SIGKILL");
    const r = await runCapture(fixtureUrl, { out, resume: true });
    assert.equal(r.coverage.done, r.coverage.total); assert.equal(new Set(r.captures.map(key)).size, r.captures.length);
  });
  test("two runs with one baseline show identical relative times", async () => {
    const before = await runCapture(fixtureUrl, { pages: ["/#/clock", "/#/planted"], widths: [1512], themes: ["light"] });
    await sleep(61_000); fixture.set("planted-title", "Changed");
    const after = await runCapture(fixtureUrl, { pages: ["/#/clock", "/#/planted"], widths: [1512], themes: ["light"], baseline: before.out });
    fixture.set("planted-title", "Planted page");
    assert.deepEqual(after.lookFirst.map((c) => c.page), ["/#/planted"]); // /clock unchanged: the clock is frozen
  });
  test("a live target is never clicked", async () => {
    const w0 = fixture.writes();
    const r = await runCapture(liveAlias + "/#/danger", { widths: [1512], themes: ["light"] });
    assert.equal(await runRoutes(liveAlias + "/#/danger"), 2);
    assert.equal(fixture.writes() - w0, 0); assert.ok(r.captures[0].motion); // measured passively
  });
  test("the queue takes 120 pages and defers the rest", async () => {
    const r = await runCapture(fixtureUrl, { pagesFile: pages(300), widths: [1512], themes: ["light"] });
    assert.equal(r.coverage.done, 120); assert.equal(r.coverage.deferred, 180);
    const next = await runCapture(fixtureUrl, { out: r.out, resume: true }); assert.equal(next.coverage.done, 240);
  });
});

// ---- measurements and references (lane B) ----
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
