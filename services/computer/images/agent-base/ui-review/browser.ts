// Chrome for the engine: one Chrome per run, started by playwright-core over the image's Chrome, with a CDP port an agent can
// attach to (`agent-browser --cdp <port>`), guarded (guard.ts) on every target it ever has. Also the things every page of a run
// shares: the frozen clock and readiness tracker (an init script), the readiness wait and the politeness throttle for other origins.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page as PwPage } from "playwright-core";
import { type Blocked, type Guard, installGuard, type Mode, modeOf, type StorageState } from "./guard.ts";

export const CHROME = process.env.AGENT_BROWSER_EXECUTABLE_PATH || "/opt/chrome/chrome";
/**
 * The gate's test listener (docs/design/access.md, Test-user sign-in), host:port: an AidenHQ app's read-only test-user session is
 * served at http://<app>.canary.localhost:<port>, and every Chrome this module starts maps *.canary.localhost to its host.
 */
export const TEST_LISTENER = process.env.AIDENHQ_TEST_LISTENER || "10.231.6.1:3132";

/**
 * Where a URL is in the app: path and query, plus the hash when it is a hash router's route ("#/a/b", a trailing slash
 * dropped; "#/" alone is the root). An in-page anchor ("#section") is not a route.
 */
export function routeOf(u: URL | string): string {
  const url = typeof u === "string" ? new URL(u) : u;
  if (!url.hash.startsWith("#/")) return url.pathname + url.search;
  const q = url.hash.indexOf("?"), path = (q < 0 ? url.hash : url.hash.slice(0, q)).replace(/\/+$/, ""), query = q < 0 ? "" : url.hash.slice(q);
  return url.pathname + url.search + (path === "#" && !query ? "" : path + query);
}

const freePort = () => new Promise<number>((ok, no) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }).on("error", no);
});
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export type Launched = { cdp: string; port: number; browser: Browser; guard: Guard; blocked(): Blocked[]; close(): Promise<void> };

/**
 * Starts Chrome with a CDP port (written to <out>/browser.json when `out` is given) and the live-app guard in `mode` on it
 * (guard.ts: every target, every origin; blocked requests also go to <out>/blocked.jsonl). `session`: storage state every
 * context starts signed in with. With `politeness`, every request to another origin than `politeness.origin` (sub-requests
 * included, from every context the engine makes) waits its turn so that together they stay under `rps` requests a second.
 */
export async function launch(o: { mode: Mode; port?: number; out?: string; politeness?: { origin: string; rps: number }; session?: StorageState | null }): Promise<Launched> {
  const port = o.port ?? (await freePort());
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--host-resolver-rules=MAP *.canary.localhost ${TEST_LISTENER.replace(/:\d+$/, "")}`, "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  let cdp = "";
  for (let i = 0; i < 50 && !cdp; i++) {
    try { cdp = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl; } catch { await sleep(100); }
  }
  const guard = await installGuard(cdp, o.mode, { log: o.out ? join(o.out, "blocked.jsonl") : undefined, state: o.session, lost: () => { console.error("ui-review: the live-app guard lost Chrome; stopping it"); void browser.close().catch(() => {}); } });
  if (o.out) writeFileSync(join(o.out, "browser.json"), JSON.stringify({ cdp, port, mode: o.mode }, null, 2));
  if (o.politeness) {
    const gap = (1000 / o.politeness.rps) * 1.05, { origin } = o.politeness;
    let nextAt = 0;
    const turn = async () => { const now = Date.now(), at = Math.max(now, nextAt); nextAt = at + gap; if (at > now) await sleep(at - now); };
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => {
      const ctx = await newContext(opts);
      await ctx.route((u) => u.origin !== origin && /^https?:$/.test(u.protocol), async (route) => { await turn(); await route.continue().catch(() => {}); });
      return ctx;
    };
  }
  return { cdp, port, browser, guard, blocked: guard.blocked, close: async () => { guard.close(); await browser.close().catch(() => {}); } };
}

/**
 * The init script every page of a run gets, before the app's own scripts: Date pinned to one instant (the baseline's when
 * there is one, so "2m ago" reads alike in a before|after pair), a tracker of fetch/XHR in flight and DOM changes for the
 * readiness wait, and buffered LCP and layout shifts for the web-vitals notes.
 */
export const initScript = (frozenAt: string) => `(() => {
  const T = ${Date.parse(frozenAt)};
  window.Date = new Proxy(Date, { construct: (d, a, nt) => Reflect.construct(d, a.length ? a : [T], nt), apply: (d) => new d(T).toString(), get: (d, k) => k === "now" ? () => T : Reflect.get(d, k) });
  const u = (window.__uiReview = { pending: 0, started: 0, changed: false, lcp: 0, cls: 0 }), end = () => { u.pending--; };
  const f = window.fetch;
  window.fetch = function (...a) { u.pending++; u.started++; return f.apply(this, a).finally(end); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) { u.pending++; u.started++; this.addEventListener("loadend", end, { once: true }); return send.apply(this, a); };
  new MutationObserver(() => { u.changed = true; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) u.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) u.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  } catch {}
})();`;

/** Loading indicators: a node matching this, visible, means the page is still loading. */
export const LOADING = "[aria-busy=true], [data-loading], [class*=skeleton], [role=progressbar]";

/**
 * Readiness, never network idle (a page that polls or streams never idles): loaded, fonts in, no fetch or XHR in flight, no
 * visible loading indicator (LOADING) and no DOM change or new resource for `quiet` ms; at most `cap` ms. Returns whether it
 * settled and how many loading indicators were still visible.
 */
export async function ready(page: PwPage, cap = 4000, quiet = 200): Promise<{ settled: boolean; loading: number }> {
  const fn = ([cap, quiet, sel]: [number, number, string]) => new Promise<{ settled: boolean; loading: number }>((done) => {
    const w = window as unknown as { __uiReview?: { pending: number; changed: boolean } };
    const t0 = performance.now();
    let seen = -1, calm = t0;
    const busy = () => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0; }).length;
    const tick = () => {
      const now = performance.now(), n = performance.getEntriesByType("resource").length, u = w.__uiReview;
      if (n !== seen || u?.changed || (u?.pending ?? 0) > 0 || document.readyState !== "complete" || document.fonts.status === "loading" || busy()) { seen = n; calm = now; if (u) u.changed = false; }
      if (now - calm >= quiet) done({ settled: true, loading: 0 });
      else if (now - t0 >= cap) done({ settled: false, loading: busy() });
      else setTimeout(tick, 25);
    };
    tick();
  });
  try { return await page.evaluate(fn, [cap, quiet, LOADING] as [number, number, string]); } catch {
    // The document was replaced under the wait (a redirect, a click that navigated): wait for the new one, then once more.
    await page.waitForLoadState("domcontentloaded", { timeout: cap }).catch(() => {});
    return page.evaluate(fn, [cap, quiet, LOADING] as [number, number, string]).catch(() => ({ settled: false, loading: 0 }));
  }
}

/** A context for one worker: the frozen clock and tracker in every document. */
export async function workerContext(browser: Browser, frozenAt: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(initScript(frozenAt));
  return ctx;
}

/** Viewport heights per width: the common device or window at that width. */
export const heightOf = (w: number) => ({ 360: 780, 390: 844, 768: 1024, 1024: 768, 1280: 800, 1512: 982, 1920: 1080, 2560: 1440 } as Record<number, number>)[w] ?? 900;

/**
 * `ui-review browser start [--url u] [--mode m] [--session state.json] [--out dir] [--record dir]`: a guarded Chrome for an agent
 * to attach to (the clicking pass: `agent-browser --cdp <port>`), signed in with the session, until it gets SIGTERM or SIGINT.
 * Prints `cdp port <port>`; the requests the guard refuses go to <out>/blocked.jsonl. Mode: --mode, else read (any for a local
 * --url). --record: each flow's clip (record.ts) into that folder, with recordings.json, written once the browser stops.
 */
export async function browserCommand(argv: string[]): Promise<number> {
  const { readSession } = await import("./login.ts"); // login.ts signs in through this module
  const [sub, ...rest] = argv;
  // `ui-review browser flow [--out dir] "<title>"`: the clicking agent starts its next flow; a recording cuts its clip there.
  if (sub === "flow") {
    const { values: f, positionals: title } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: "string", default: "ui-review-browser" } } });
    if (!title.length) { console.error('usage: ui-review browser flow [--out dir] "<flow title>"'); return 2; }
    mkdirSync(f.out!, { recursive: true });
    const mark = join(f.out!, "flow.txt");
    writeFileSync(mark, title.join(" "));
    // A recording browser acknowledges the mark (record.ts) before the flow's first step; without one there is nothing to wait for.
    const at = statSync(mark).mtimeMs;
    if (!existsSync(`${mark}.ack`)) return 0;
    for (let i = 0; i < 50; i++) {
      try { if (Number(readFileSync(`${mark}.ack`, "utf8")) >= at) return 0; } catch { return 0; } // the recorder stopped
      await sleep(100);
    }
    console.error("ui-review: the recorder hasn't taken the mark in 5 s; this flow's clip may start late");
    return 1;
  }
  const { values: v } = parseArgs({ args: rest, options: { url: { type: "string" }, mode: { type: "string" }, session: { type: "string" }, out: { type: "string", default: "ui-review-browser" }, port: { type: "string" }, record: { type: "string" } } });
  const mode = modeOf(v.mode, v.url ?? "http://app.invalid/");
  if (sub !== "start" || !mode) { console.error("usage: ui-review browser start [--url u] [--mode read|test-write|any] [--session state.json] [--out dir] [--record dir]"); return 2; }
  let session: StorageState | null = null;
  try { session = v.session ? readSession(v.session).state : null; } catch (e) { console.error(`ui-review: ${(e as Error).message}`); return 2; }
  mkdirSync(v.out!, { recursive: true });
  const b = await launch({ mode, out: v.out, session, port: v.port ? Number(v.port) : undefined });
  const rec = v.record ? await (await import("./record.ts")).recordPages(b.cdp, v.record, { marks: join(v.out!, "flow.txt") }) : undefined;
  if (v.url) { const ctx = await b.browser.newContext({ viewport: { width: 1512, height: 900 } }); await (await ctx.newPage()).goto(v.url, { waitUntil: "domcontentloaded" }).catch(() => {}); }
  console.log(`cdp port ${b.port}`);
  await new Promise<void>((ok) => { process.once("SIGTERM", ok); process.once("SIGINT", ok); });
  // The clips end (ffmpeg writes each one's index) before the browser goes.
  if (rec) console.log(`${(await rec.stop()).length} recordings in ${v.record}`);
  await b.close();
  return 0;
}
