// The ui-review engine's end-to-end tests. The ones that drive Chrome skip without AGENT_BROWSER_EXECUTABLE_PATH (so CI skips them).
// Run them in the agent-base image against this worktree's code (WT = the worktree's absolute path):
//   docker run --rm --cpus 2 --memory 6g -v "$WT":/w aidenhq/computer-agent-base:current sh -c 'cd /w/services/computer/images/agent-base/ui-review && npm ci --ignore-scripts --no-audit --no-fund && cd /w/services/computer && perl -e "alarm shift; exec @ARGV" 900 node --test test/ui-review.e2e.test.ts'
// The lanes add their tests below (capture, queue, measurements, references), each skipped without Chrome:
//   { skip: !process.env.AGENT_BROWSER_EXECUTABLE_PATH && "no Chrome" }
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Capture, Report } from "../images/agent-base/ui-review/types.ts";
import { totp as totpCode } from "../images/agent-base/ui-review/totp.ts";
import { type Fixture, ROUTES, SIGN_IN, startFixture } from "./fixtures/ui-app/server.ts";

const main = fileURLToPath(new URL("../images/agent-base/ui-review/main.ts", import.meta.url));

test("ui-review --help lists its subcommands", () => {
  const r = spawnSync("node", [main, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  for (const c of ["capture", "pages", "routes", "refs", "review", "fix-check", "login", "browser"]) assert.match(r.stdout, new RegExp(`^  ${c} `, "m"));
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
type Run = { out: string; notes: string[]; blocked: { method: string; origin: string; path: string; page: string }[]; session?: { rung: string; relogins: number }; coverage: { done: number; total: number; failed: number; deferred: number }; captures: { page: string; width: number; theme: string; state: string; shots: string[]; settled: boolean; motion?: unknown; rules: { rule: string }[]; diffs?: { shot: string; pct: number; diff?: string }[] }[]; lookFirst: { page: string }[] };
const tmp = () => mkdtempSync(join(tmpdir(), "ui-review-test-"));
const capArgs = (url: string, o: { out: string; pagesFile?: string; widths?: number[]; themes?: string[]; resume?: boolean; baseline?: string; mode?: string; session?: string }) =>
  [main, "capture", url, "--out", o.out, ...(o.pagesFile ? ["--pages-file", o.pagesFile] : []), ...(o.widths ? ["--widths", o.widths.join(",")] : []), ...(o.themes ? ["--themes", o.themes.join(",")] : []), ...(o.resume ? ["--resume"] : []), ...(o.baseline ? ["--baseline", o.baseline] : []), ...(o.mode ? ["--mode", o.mode] : []), ...(o.session ? ["--session", o.session] : []), "--commit", "test"];
const pagesFile = (paths: string[]) => { const f = join(tmp(), "pages.json"); writeFileSync(f, JSON.stringify(paths)); return f; };
const pages = (n: number) => pagesFile(Array.from({ length: n }, (_, i) => `/#/p${String(i + 1).padStart(3, "0")}`));
function startCapture(url: string, o: Parameters<typeof capArgs>[1]) { return spawn("node", capArgs(url, o), { stdio: "ignore" }); }
async function runCapture(url: string, o: Partial<Parameters<typeof capArgs>[1]> & { pages?: string[] }): Promise<Run> {
  const out = o.out ?? tmp();
  const p = startCapture(url, { ...o, out, pagesFile: o.pages ? pagesFile(o.pages) : o.pagesFile });
  const code = await new Promise((ok) => p.on("exit", ok));
  assert.ok(code === 0 || code === 1, `ui-review capture exited ${code}`);
  const r = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Run;
  // "Look at these first": the pages with a changed shot against the baseline (it has a diff picture), biggest change first.
  const changed = r.captures.map((c) => ({ page: c.page, pct: Math.max(-1, ...(c.diffs ?? []).filter((d) => d.diff).map((d) => d.pct)) })).filter((c) => c.pct >= 0).sort((a, b) => b.pct - a.pct);
  return { ...r, out, lookFirst: [...new Map(changed.map((c) => [c.page, c])).values()] };
}
const runRoutes = (url: string) => new Promise<number>((ok) => spawn("node", [main, "routes", url, "--out", tmp(), "--paths", "/#/danger"], { stdio: "ignore" }).on("exit", (c) => ok(c ?? 2)));
/** `ui-review login <rung>`: its exit code and output (stdout and stderr). */
function login(rung: string, o: Record<string, string>, env: Record<string, string> = {}) {
  const args = [main, "login", rung, ...Object.entries(o).flatMap(([k, v]) => [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, ...(v === "" ? [] : [v])])]; // "" is a flag
  return new Promise<{ code: number; text: string }>((ok) => {
    const p = spawn("node", args, { env: { ...process.env, ...env } });
    let text = "";
    p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
    p.on("exit", (code) => ok({ code: code ?? 2, text }));
  });
}
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

  test("capture covers 60 routes at the 7 default widths x 2 themes under 600 s", async () => {
    const t0 = Date.now(); const r = await runCapture(fixtureUrl, { pagesFile: pagesFile(ROUTES) });
    console.log(`capture: 840 captures in ${Math.round((Date.now() - t0) / 1000)} s`);
    assert.equal(r.coverage.total, 840); assert.equal(r.coverage.done, 840); assert.ok(Date.now() - t0 < 600_000);
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
  test("a live target is read only: captured, clicked by the route check, never written to", async () => {
    const w0 = fixture.writes();
    const r = await runCapture(liveAlias + "/#/danger", { widths: [1512], themes: ["light"] });
    assert.ok([0, 1].includes(await runRoutes(liveAlias + "/#/danger"))); // the route check runs on a live target now: the guard is on
    assert.equal(fixture.writes() - w0, 0); assert.ok(r.captures[0].motion); // its POST on mount was refused by the guard
    assert.ok(r.blocked.some((b) => b.method === "POST" && b.path === "/api/seen"));
    assert.ok(!r.captures[0].rules.some((h) => h.rule === "page-errors")); // and the guard is no page error of the app's
    await runCapture(fixtureUrl + "/#/danger", { widths: [1512], themes: ["light"] });
    assert.ok(fixture.writes() - w0 >= 1); // the same page as a local build does write: the guard is what stopped it
  });
  test("the queue takes 120 pages and defers the rest", async () => {
    const r = await runCapture(fixtureUrl, { pagesFile: pages(300), widths: [1512], themes: ["light"] });
    assert.equal(r.coverage.done, 120); assert.equal(r.coverage.deferred, 180);
    const next = await runCapture(fixtureUrl, { out: r.out, resume: true }); assert.equal(next.coverage.done, 240);
  });
});

// ---- login ladder, session check, live-app guard (phase 2, lane E) ----
describe("signed in and guarded", chrome, () => {
  let fixture: Fixture, fx: (p: string) => string, liveAlias: string;
  // Sessions die 8 s after sign-in here (30 s by default), so one run crosses the expiry more than once.
  before(async () => { fixture = await startFixture(0, { sessionSeconds: 8 }); fx = (p) => fixture.url + p; liveAlias = `http://live.localhost:${fixture.port}`; });
  after(() => fixture.close());
  const secrets = () => { const d = tmp(), pw = join(d, "pw"), totp = join(d, "totp"); writeFileSync(pw, SIGN_IN.password); writeFileSync(totp, SIGN_IN.totp); return { pw, totp, st: join(tmp(), "state.json") }; };
  const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

  test("form login captures signed-in pages and notices a dead session", async () => {
    const { pw, totp, st } = secrets();
    const l = await login("form", { url: fx("/login"), user: SIGN_IN.user, passwordFile: pw, totpFile: totp, out: st });
    assert.equal(l.code, 0, l.text); assert.equal(l.text.trim(), "signed in (form) at /login"); assert.ok(!l.text.includes(SIGN_IN.password));
    const r = await runCapture(fx("/app/home"), { session: st, pages: ["/app/home", "/app/orders", "/app/billing", "/app/team"], widths: [390, 768, 1024, 1280, 1512, 1920, 2560] });
    assert.equal(r.coverage.done, r.coverage.total);
    assert.ok(r.captures.every((c) => !c.url.endsWith("/login")));
    assert.ok(r.notes.some((n) => /re-signed in/.test(n)), r.notes.join("\n")); // the expiry was crossed
    assert.equal(r.session?.rung, "form"); assert.ok(r.session!.relogins >= 1);
    const shot = readFileSync(join(r.out, r.captures.find((c) => c.page === "/app/orders")!.shots[0]));
    assert.ok(shot.length > 0);
    assert.ok(!files(r.out).some((f) => readFileSync(f).includes(SIGN_IN.password) || readFileSync(f).includes(SIGN_IN.totp)));
  });

  test("sign-up through Mailpit works and CAPTCHA stops the rung", async () => {
    const st = join(tmp(), "state.json"), st2 = join(tmp(), "state.json");
    const l = await login("signup", { url: fx("/signup"), out: st });
    assert.equal(l.code, 0, l.text); assert.ok(existsSync(st)); assert.equal(fixture.signups(), 1);
    const c = await login("signup", { url: fx("/signup-captcha"), out: st2 });
    assert.equal(c.code, 1); assert.match(c.text, /CAPTCHA/); assert.ok(!existsSync(st2));
  });

  test("a supplied login spends its nonce, leaves the next one for a re-login, and a spent one is refused", async () => {
    // The design module's job tool as the kernel forwards it: one nonce, spent by each answer, which carries the next.
    let current = "n1", calls = 0;
    const tool = createServer((req, res) => {
      let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
        calls++;
        const b = JSON.parse(body) as { app: string; nonce?: string };
        if (req.url !== "/v1/jobtools/module/design/login" || b.app !== "acme" || b.nonce !== current) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "not this pass's nonce" }));
        current = `n${calls + 1}`;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ login_url: fx("/login"), username: SIGN_IN.user, password: SIGN_IN.password, totp: totpCode(SIGN_IN.totp), nonce: current }));
      });
    });
    await new Promise<void>((ok) => tool.listen(0, "127.0.0.1", ok));
    const dir = tmp(), nonce = join(dir, "login-nonce"), st = join(tmp(), "state.json");
    const env = { AIDENHQ_GATEWAY_URL: `http://127.0.0.1:${(tool.address() as { port: number }).port}`, AIDENHQ_RUN_TOKEN: "run-token", AIDENHQ_LOGIN_NONCE: nonce };
    try {
      writeFileSync(nonce, "run-token"); // the run token in place of the nonce
      let l = await login("supplied", { app: "acme", out: st }, env);
      assert.equal(l.code, 1); assert.match(l.text, /refused \(403\)/); assert.ok(!existsSync(st));
      writeFileSync(nonce, "n1");
      l = await login("supplied", { app: "acme", out: st }, env);
      assert.equal(l.code, 0, l.text); assert.equal(l.text.trim(), "signed in (supplied) at /login");
      assert.equal(readFileSync(nonce, "utf8"), current); // the next nonce, for a re-login
      l = await login("supplied", { app: "acme", out: st, renew: "" }, env);
      assert.equal(l.code, 0, l.text);
      writeFileSync(nonce, "n1"); // a replay of a spent nonce
      l = await login("supplied", { app: "acme", out: join(tmp(), "state.json") }, env);
      assert.equal(l.code, 1); assert.ok(!l.text.includes(SIGN_IN.password) && !l.text.includes(SIGN_IN.user));
    } finally { tool.closeAllConnections(); tool.close(); }
  });

  test("the guard blocks writes in read mode and destructive paths in test-write", async () => {
    const clickAll = async (mode: string, url: string) => {
      const { launch } = await import("../images/agent-base/ui-review/browser.ts");
      const b = await launch({ mode: mode as "read" });
      try {
        const p = await (await b.browser.newContext()).newPage();
        await p.goto(url); await p.waitForTimeout(300);
        for (const btn of await p.locator("button").all()) { await btn.click(); await p.waitForTimeout(200); }
        await p.waitForTimeout(300);
        return b.blocked();
      } finally { await b.close(); }
    };
    const w0 = fixture.writes();
    const r = await clickAll("read", fx("/#/danger"));
    assert.ok(r.some((b) => b.method === "POST")); assert.equal(fixture.writes() - w0, 0);
    const t = await clickAll("test-write", fx("/#/danger"));
    assert.ok(t.some((b) => /\/pay/.test(b.path)) && t.some((b) => /\/delete/.test(b.path))); assert.ok(fixture.writes() - w0 > 0); // its POST on mount went
    const w = await runCapture(liveAlias + "/#/socket-write", { widths: [1512], themes: ["light"] }); // a live target: read by default
    assert.ok(w.blocked.some((b) => b.method === "WS"), JSON.stringify(w.blocked)); assert.equal(fixture.socketWrites(), 0);
  });

  test("read mode blocks a write to a separate API origin, and the agent's own tab is guarded", async () => {
    const { launch } = await import("../images/agent-base/ui-review/browser.ts");
    const { chromium } = await import("../images/agent-base/ui-review/node_modules/playwright-core/index.mjs");
    const b = await launch({ mode: "read" });
    try {
      const p = await (await b.browser.newContext()).newPage();
      await p.goto(fx("/split")); await p.click("text=Save"); await p.waitForTimeout(500);
      assert.ok(b.blocked().some((x) => x.method === "POST" && /api\./.test(x.origin)), JSON.stringify(b.blocked())); assert.equal(fixture.apiWrites(), 0);
      // The clicking pass's attachment: another CDP client opens its own context and tab, and clicks Pay; that target is guarded too.
      const w0 = fixture.writes();
      const agent = await chromium.connectOverCDP(`http://127.0.0.1:${b.port}`);
      const tab = await (await agent.newContext()).newPage();
      await tab.goto(fx("/#/danger")); await tab.click("text=Pay"); await tab.waitForTimeout(500);
      assert.ok(b.blocked().some((x) => x.method === "POST" && /\/pay/.test(x.path)), JSON.stringify(b.blocked())); assert.equal(fixture.writes() - w0, 0);
      await agent.close();
    } finally { await b.close(); }
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

// Review pipeline and fix-check (no Chrome): a fake OpenRouter-style server answers canned JSON per prompt (its first line names it).

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
  writeFileSync(join(dir, "run.json"), JSON.stringify({ base: "http://127.0.0.1:1", frozenAt: "2026-01-01T00:00:00Z", widths: [390, 1512, 2560], themes: ["light"], states: ["default"], pages: [{ path: "/#/r01", kind: "list", source: "router" }, { path: "/#/r02", kind: "list", source: "router" }, { path: "/#/r03", kind: "form", source: "router" }] }));
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
