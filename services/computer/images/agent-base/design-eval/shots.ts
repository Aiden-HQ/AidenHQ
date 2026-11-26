// Browser side of the regression set: the engine's Chrome (playwright-core from the ui-review package), the app starter built
// and served locally, and a screenshot helper. Third-party pages get the politeness cap: 4 requests a second in total, GET only.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const ENGINE = process.env.AIDENHQ_UI_REVIEW ?? "/opt/aidenhq/ui-review";
export const STARTER = process.env.AIDENHQ_APP_STARTER ?? "/opt/aidenhq/app-starter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isLocal = (url: string) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname);

let browser: any;
const children: ChildProcess[] = [];

export async function launch() {
  if (browser) return browser;
  const exe = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (!exe) throw new Error("AGENT_BROWSER_EXECUTABLE_PATH is not set: shots are taken in the agent-base image, or give --work a folder that already holds them");
  const { chromium } = createRequire(join(ENGINE, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--headless=new"] });
  return browser;
}

export async function shutdown() {
  await browser?.close().catch(() => {});
  for (const c of children) c.kill();
}

/** The app starter, built and served on 127.0.0.1:<port> from a copy in `work` (the image's copy already has node_modules and needs no download). */
export async function serveStarter(work: string, port: number): Promise<string> {
  const dir = join(work, "starter");
  if (!existsSync(dir)) cpSync(STARTER, dir, { recursive: true });
  const run = (...a: string[]) => execFileSync("npm", a, { cwd: dir, stdio: "pipe" });
  if (!existsSync(join(dir, "node_modules"))) run("ci", "--ignore-scripts", "--no-audit", "--no-fund");
  if (!existsSync(join(dir, "dist"))) run("run", "build");
  const child = spawn("node", ["server.mjs"], { cwd: dir, stdio: "ignore", env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) } });
  children.push(child);
  // Another server on the port would answer the health check too: a child that exits (it couldn't bind) fails the run.
  let exited = false;
  child.on("exit", () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (exited) throw new Error(`the app starter exited: is port ${port} taken? (--port picks another)`);
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) { await sleep(300); if (!exited) return base; }
    await sleep(200);
  }
  throw new Error(`the app starter did not come up on ${base}`);
}

/** At most 4 requests a second across everything a third-party page loads; nothing but GET and HEAD. */
let last = 0;
async function polite(route: any) {
  const m = route.request().method();
  if (m !== "GET" && m !== "HEAD") return route.abort();
  const wait = Math.max(0, last + 250 - Date.now());
  last = Date.now() + wait;
  await sleep(wait);
  return route.continue();
}

export type ShotOptions = { width: number; theme?: "light" | "dark"; height?: number };

/** Opens `url` at a width and returns the page and a screenshot function; the page loads once, so a before and an after share one load. */
export async function open(url: string, o: ShotOptions) {
  const ctx = await (await launch()).newContext({ viewport: { width: o.width, height: o.height ?? 900 }, colorScheme: o.theme ?? "light", serviceWorkers: "block" });
  if (!isLocal(url)) {
    await ctx.route("**/*", polite);
    await ctx.routeWebSocket(/.*/, (ws: any) => void ws.close()); // read only: no socket traffic
    // Nor the channels routing doesn't see: WebTransport and peer connections are gone before the page's own code runs.
    await ctx.addInitScript(() => { for (const k of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) try { delete (globalThis as any)[k]; } catch { /* not there */ } });
  }
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
  // A refusal (403, 429, a server error) is not the product: never shot, never cached.
  if (res && res.status() >= 400) { await ctx.close(); throw new Error(`${url} answered ${res.status()}`); }
  await page.evaluate(() => document.fonts.ready);
  await sleep(isLocal(url) ? 600 : 2500); // settle without waiting for network idle
  return {
    page,
    shot: async (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); await page.screenshot({ path }); },
    close: () => ctx.close(),
  };
}
