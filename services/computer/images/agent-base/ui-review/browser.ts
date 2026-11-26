// Chrome for the engine: one Chrome per run, started by playwright-core over the image's Chrome, with a CDP port an agent can
// attach to (`agent-browser --cdp <port>`). Also the things every page of a run shares: the frozen clock and readiness tracker
// (an init script), the readiness wait, the politeness throttle for other origins, and what counts as a local build.
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page as PwPage } from "playwright-core";

export const CHROME = process.env.AGENT_BROWSER_EXECUTABLE_PATH || "/opt/chrome/chrome";

/** A local build: the only kind phase 1 ever clicks on (route checks, motion clicks). */
export const isLocal = (url: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

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

export type Launched = { cdp: string; port: number; browser: Browser; close(): Promise<void> };

/**
 * Starts Chrome with a CDP port (written to <out>/browser.json when `out` is given). With `politeness`, every request to
 * another origin than `politeness.origin` (sub-requests included, from every context of this browser) waits its turn so
 * that together they stay under `rps` requests a second. `target` is the app under review: when it is not a local build,
 * every context is read only from its first navigation: a request that isn't GET, HEAD or OPTIONS is answered by the guard
 * (204) and never sent, and no service worker, WebSocket, WebTransport or peer connection runs, so a live app's own code (a
 * POST on mount, a socket, a data channel) never writes.
 */
export async function launch(o: { port?: number; out?: string; politeness?: { origin: string; rps: number }; target?: string } = {}): Promise<Launched> {
  const port = o.port ?? (await freePort());
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  let cdp = "";
  for (let i = 0; i < 50 && !cdp; i++) {
    try { cdp = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl; } catch { await sleep(100); }
  }
  if (o.out) writeFileSync(join(o.out, "browser.json"), JSON.stringify({ cdp, port }, null, 2));
  const readOnly = o.target !== undefined && !isLocal(o.target);
  if (o.politeness || readOnly) {
    const gap = o.politeness ? (1000 / o.politeness.rps) * 1.05 : 0;
    let nextAt = 0;
    const turn = async () => { const now = Date.now(), at = Math.max(now, nextAt); nextAt = at + gap; if (at > now) await sleep(at - now); };
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => {
      const ctx = await newContext(readOnly ? { ...opts, serviceWorkers: "block" } : opts);
      if (o.politeness) { const { origin } = o.politeness; await ctx.route((u) => u.origin !== origin && /^https?:$/.test(u.protocol), async (route) => { await turn(); await route.continue().catch(() => {}); }); }
      if (readOnly) {
        // Registered last, so it runs first: a write is aborted before the throttle or the app ever sees it.
        // A write is answered by the guard itself (204, empty), so the app goes on as if it went: never sent, and never a page
        // error or a failed load of the app's own in the findings.
        await ctx.route("**/*", (route) => ["GET", "HEAD", "OPTIONS"].includes(route.request().method()) ? route.fallback() : route.fulfill({ status: 204, body: "" }));
        await ctx.routeWebSocket(/.*/, (ws) => void ws.close());
        // The channels request routing doesn't see (WebTransport, peer connections) are gone before the app's own code runs.
        await ctx.addInitScript(() => { for (const k of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) try { delete (globalThis as Record<string, unknown>)[k]; } catch { /* not there */ } });
      }
      return ctx;
    };
  }
  return { cdp, port, browser, close: () => browser.close().catch(() => {}) };
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
