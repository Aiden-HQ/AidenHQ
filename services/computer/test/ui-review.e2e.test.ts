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

// Review pipeline and fix-check (no Chrome): a fake OpenRouter-style server answers canned JSON per prompt (its first line names it).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture, Report } from "../images/agent-base/ui-review/types.ts";

const PNG = (n: number) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), Buffer.from(String(n))]);

type Call = { name: string; retry: boolean };
async function fakeModel(answer: (name: string, text: string, images: string[], n: number) => unknown) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      const name = String(m.messages[0].content).split("\n")[0].replace(/^# /, "");
      const parts = m.messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
      const text = parts.find((p) => p.type === "text")?.text ?? "";
      const images = parts.filter((p) => p.type === "image_url").map((p) => p.image_url!.url);
      calls.push({ name, retry: m.messages.length > 2 });
      counts[name] = (counts[name] ?? 0) + 1;
      const out = answer(name, text, images, counts[name]);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: typeof out === "string" ? out : JSON.stringify(out) } }], usage: { cost: 0.01 } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, calls: (n: string) => calls.filter((c) => c.name === n), close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

const measures = (sig: string): Capture["measures"] => ({
  fonts: [{ size: 14, weight: 400, n: 20 }], colours: [{ value: "rgb(0, 0, 0)", n: 9 }], radii: ["6px"], shadows: [], spacing: { values: [8, 16], offScale: [13] },
  nearMisses: [], content: { width: 900, viewport: 1512 }, ctas: [{ label: "Save changes", filled: true, contrast: 7, area: 4000 }], contrastFails: 0,
  signatures: { button: [sig], card: [], heading: [], input: [] },
});

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-run-"));
  mkdirSync(join(dir, "shots"));
  const captures: Capture[] = [];
  for (const page of ["/#/r01", "/#/r02", "/#/r03"]) for (const width of [390, 1512, 2560]) {
    const shot = `shots/${page.slice(3)}-${width}-light.png`;
    writeFileSync(join(dir, shot), PNG(width));
    captures.push({
      page, width, theme: "light", state: "default", url: page, shots: [shot], settled: true, rules: [], measures: measures(page === "/#/r03" ? "r6 fill" : "r8 fill"),
      ...(width === 1512 ? { motion: { transitions: [{ property: "all", duration: 600, easing: "ease", n: 3, examples: [".btn"] }], animations: [], hover: [".btn:hover { transform: scale(1.1) }"], active: [], keyframes: [], longFrames: [], shifts: [] } } : {}),
    });
  }
  const report: Report = { version: 2, target: "http://127.0.0.1:1", frozenAt: "2026-01-01T00:00:00Z", model: "", coverage: { done: 9, total: 9, failed: 0, deferred: 0 }, captures, improvements: [], motion: [], bugs: [], notes: [], cost_usd: 0 };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  writeFileSync(join(dir, "pages.json"), JSON.stringify([{ path: "/#/r01", kind: "list", source: "router" }, { path: "/#/r02", kind: "list", source: "router" }, { path: "/#/r03", kind: "form", source: "router" }]));
  return dir;
}

test("review ranks concrete improvements and drops bad citations", async () => {
  const dir = runDir();
  process.env.OPENROUTER_API_KEY = "test";
  const { runReview } = await import("../images/agent-base/ui-review/review.ts");
  const fake = await fakeModel((name, text) => {
    const files = [...text.matchAll(/Capture: (\S+\.png)/g)].map((m) => m[1]);
    const imp = (i: number, captures: string[]) => ({ category: i % 2 ? "ease" : "polish", where: { page: "/#/r01", width: 1512, theme: "light", region: `Region ${i}` }, weak: `Weak thing number ${i} on the page`, change: `Change the padding to ${8 * i}px`, why: `Because it reads clearer ${i}`, best: `The best products use a stepped scale ${i}`, captures });
    if (name === "design") {
      if (fake.calls("design").length === 1) return "this is not json";
      return { improvements: [imp(1, [files[0]]), imp(2, [files[1]]), imp(3, ["shots/missing.png"])] };
    }
    if (name === "consolidate") {
      const cands = JSON.parse(text.split("<candidates>")[1].split("</candidates>")[0]) as unknown[];
      return { improvements: [...cands.slice(0, 5), { ...(cands[0] as object), captures: ["shots/not-in-run.png"] }] };
    }
    if (name === "motion") {
      const first = text.split("Measured CSS (")[1].split("<untrusted>")[1].split("\n")[1];
      return { rows: [{ where: "Buttons", before: "transition: all 600ms ease", after: "transition: background-color 150ms ease-out", why: "frequent action", css: first.replace(/\/\*.*\*\//, "").trim() }, { where: "Cards", before: "x", after: "y", why: "z", css: "transition: opacity 5000ms linear" }] };
    }
    throw new Error(`unexpected prompt ${name}`);
  });
  try {
    const r = await runReview(dir, { model: "fake/m", base: fake.url });
    assert.ok(r.improvements.length >= 3 && r.improvements.length <= 10);
    for (const i of r.improvements) for (const k of ["weak", "change", "why", "best"] as const) assert.ok(i[k].length > 10);
    assert.ok(r.improvements.every((i) => i.captures.every((f) => existsSync(join(dir, f)))));
    assert.deepEqual(r.improvements.map((i) => i.rank), r.improvements.map((_, i) => i + 1));
    assert.equal(fake.calls("design").filter((c) => c.retry).length, 1); // the malformed answer was retried once
    assert.ok(r.motion.length >= 1 && r.motion.every((m) => m.css.length > 0 && !m.css.includes("5000ms")));
    assert.ok(!JSON.stringify(r).match(/"score"|\/10/)); // no scores
    assert.match(readFileSync(join(dir, "report.md"), "utf8"), /## Improvements/);
  } finally { await fake.close(); }
});

test("fix-check needs AFTER in 2 of 3 in each order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-fix-"));
  const before = join(dir, "before.png"), after = join(dir, "after.png");
  writeFileSync(before, PNG(1)); writeFileSync(after, PNG(2));
  const uri = (p: string) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
  process.env.OPENROUTER_API_KEY = "test";
  const { fixCheck } = await import("../images/agent-base/ui-review/pairwise.ts");
  const fake = await fakeModel((_n, _t, images) => ({ better: images[0] === uri(after) ? "A" : "B", reasons: [], regression: "none" }));
  const biased = await fakeModel(() => ({ better: "A", reasons: [], regression: "none" }));
  try {
    const good = await fixCheck({ before, after, width: 1512, model: "fake/after-wins", base: fake.url });
    assert.deepEqual(good, { wins: [3, 3], accepted: true });
    const bad = await fixCheck({ before, after, width: 1512, model: "fake/always-first", base: biased.url });
    assert.equal(bad.accepted, false); // position bias never passes a fix
    assert.equal(fake.calls("pairwise").length + biased.calls("pairwise").length, 12);
  } finally { await fake.close(); await biased.close(); }
});
