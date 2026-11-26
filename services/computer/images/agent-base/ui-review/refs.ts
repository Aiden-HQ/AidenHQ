// Category references: public pages of well-known polished products, captured at run time (1512 and 390, light) under the
// politeness caps and measured for tokens (type scale, row height, radius, content width). The product ships URLs and numbers,
// never screenshots. A refusing site (403, 429, a bot wall) is skipped with the reason; a kind whose URLs all fail falls back to
// the app starter's own page for it (refs/fallback.json, served by the caller), and the notes say so.
//   third-party origins: at most 4 requests/s in total (sub-requests included), at most 2 pages per site, never a form submit.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page as PwPage } from "playwright-core";
import type { PageKind } from "./types.ts";

export type RefTokens = { typeScale: number[]; rowHeight: number; radius: string; maxWidth: number };
export type RefEntry = { kind: PageKind; url: string; product?: string; tokens?: RefTokens };
export type RefResult = { kind: PageKind; url: string; product?: string; shots: string[]; tokens: RefTokens; source: "live" | "fallback" };
export type RefsOptions = {
  out?: string;
  /** Where the app starter is served (a URL, or a function that starts it); used only for a kind whose URLs all failed. */
  fallbackBase?: string | (() => Promise<string>);
  /** Minimum gap between two loads on the same origin (default 5000). */
  gapMs?: number;
};

const SPACING_MS = 260; // 260 ms apart keeps any 1 s window at 4 requests or fewer
const MAX_PAGES_PER_SITE = 2;
const WALL = /just a moment|attention required|access denied|are you a robot|verify you are human/i;
const FALLBACK: Record<string, string> = JSON.parse(readFileSync(new URL("./refs/fallback.json", import.meta.url), "utf8"));

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const TOKENS = () => {
  const vw = innerWidth, vh = innerHeight;
  const els = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0 && r.bottom > 0 && r.top < vh * 3;
  });
  const textEls = els.filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()));
  const sizes = new Map<number, number>();
  for (const e of textEls) { const v = Math.round(parseFloat(getComputedStyle(e).fontSize) * 2) / 2; sizes.set(v, (sizes.get(v) ?? 0) + 1); }
  const used = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const typeScale = (used.filter(([, n]) => n >= 2).length >= 3 ? used.filter(([, n]) => n >= 2) : used).slice(0, 8).map(([v]) => v).sort((a, b) => a - b);
  const rows = els.filter((e) => e.matches("tr, li, [role=row], [role=listitem]") && e.getBoundingClientRect().width >= 200).map((e) => Math.round(e.getBoundingClientRect().height)).sort((a, b) => a - b);
  const radii = new Map<string, number>();
  for (const e of els) { const v = getComputedStyle(e).borderTopLeftRadius; const r = parseFloat(v) > 999 ? "9999px" : v; if (r !== "0px") radii.set(r, (radii.get(r) ?? 0) + 1); }
  let minL = 1e9, maxR = 0;
  for (const e of textEls) { const r = e.getBoundingClientRect(); if (r.left >= -5 && r.right <= vw + 5 && r.width < vw) { minL = Math.min(minL, r.left); maxR = Math.max(maxR, r.right); } }
  return { typeScale, rowHeight: rows.length ? rows[rows.length >> 1] : 0, radius: [...radii.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0px", maxWidth: maxR > minL ? Math.round(maxR - minL) : 0 };
};

export async function refs(list: RefEntry[], opts: RefsOptions = {}): Promise<{ refs: RefResult[]; notes: string[] }> {
  const out = opts.out ?? mkdtempSync(join(tmpdir(), "ui-refs-"));
  mkdirSync(out, { recursive: true });
  const gapMs = opts.gapMs ?? 5000;
  const notes: string[] = [];
  const results: RefResult[] = [];
  const browser = await chromium.launch({ executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH, headless: true, args: ["--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 }, colorScheme: "light", deviceScaleFactor: 1, serviceWorkers: "block" });
  // Every third-party request, sub-requests included, goes through one gate: 4 per second in total. Video and audio are not fetched.
  let next = 0, throttled = true; // the app starter's fallback page is ours: not throttled
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    if (!throttled) return route.continue();
    if (req.resourceType() === "media" || !["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.abort(); // read-only: a page-initiated POST never goes out
    const at = Math.max(Date.now(), next);
    next = at + SPACING_MS;
    await sleep(at - Date.now());
    return route.continue().catch(() => {});
  });
  await ctx.routeWebSocket(/.*/, (ws) => void ws.close()); // no socket traffic: a reference is read, never written to
  const loadedAt = new Map<string, number>(), pages = new Map<string, number>();
  let n = 0;
  const capture = async (e: RefEntry, source: "live" | "fallback", url: string): Promise<RefResult | string> => {
    const origin = new URL(url).origin;
    if (source === "live") {
      if ((pages.get(origin) ?? 0) >= MAX_PAGES_PER_SITE) return `skipped, already ${MAX_PAGES_PER_SITE} pages from ${origin}`;
      pages.set(origin, (pages.get(origin) ?? 0) + 1); // a refused page counts too
      await sleep(Math.max(0, (loadedAt.get(origin) ?? 0) + gapMs - Date.now()));
      loadedAt.set(origin, Date.now());
    }
    throttled = source === "live";
    const page: PwPage = await ctx.newPage();
    try {
      await page.setViewportSize({ width: 1512, height: 900 });
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (resp && resp.status() >= 400) return `HTTP ${resp.status()}`;
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      await Promise.race([page.evaluate(() => document.fonts.ready), sleep(5000)]).catch(() => {});
      await page.waitForTimeout(800);
      const title = await page.title().catch(() => "");
      if (WALL.test(title)) return `bot wall ("${title}")`;
      const tokens = (await page.evaluate(TOKENS)) as RefTokens;
      const id = `${e.kind}-${++n}`;
      const shots: string[] = [];
      for (const [w, h] of [[1512, 900], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(500);
        const name = `ref-${id}-${w}.png`; // relative to <out>, where refs.json is written: review reads it from there
        await page.screenshot({ path: join(out, name) });
        shots.push(name);
      }
      return { kind: e.kind, url, product: e.product, shots, tokens, source };
    } catch (err) {
      return String((err as Error).message ?? err).split("\n")[0].slice(0, 160);
    } finally { await page.close().catch(() => {}); }
  };
  try {
    const seen = new Map<string, RefResult | string>(); // a URL listed under two kinds is loaded once
    for (const e of list) {
      const before = seen.get(e.url);
      const r = before ?? (await capture(e, "live", e.url));
      if (!before) { seen.set(e.url, r); if (typeof r === "string") notes.push(`${e.url}: ${r}`); }
      if (typeof r !== "string") results.push({ ...r, kind: e.kind, product: e.product ?? r.product });
    }
    for (const kind of new Set(list.map((e) => e.kind))) {
      if (results.some((r) => r.kind === kind)) continue;
      if (!opts.fallbackBase) { notes.push(`${kind}: every reference failed and no fallback is available`); continue; }
      let base: string;
      try { base = typeof opts.fallbackBase === "function" ? await opts.fallbackBase() : opts.fallbackBase; }
      catch (err) { notes.push(`${kind}: every reference failed and the fallback is unavailable: ${(err as Error).message}`); continue; }
      const r = await capture({ kind, url: "" }, "fallback", new URL(FALLBACK[kind] ?? FALLBACK.other, base).href);
      if (typeof r === "string") notes.push(`${kind}: fallback failed: ${r}`);
      else { results.push({ ...r, product: "app starter" }); notes.push(`${kind}: every reference failed; the app starter's page stands in`); }
    }
  } finally { await ctx.close().catch(() => {}); await browser.close().catch(() => {}); }
  return { refs: results, notes };
}

/** Serves the app starter's dev server on a free port (its dependencies are in the image); returns the base URL and a stop function. */
export async function serveStarter(dir = process.env.AIDENHQ_STARTER ?? "/opt/aidenhq/app-starter"): Promise<{ url: string; stop(): void }> {
  if (!existsSync(join(dir, "node_modules/vite/bin/vite.js"))) throw new Error(`no app starter in ${dir}`);
  const port = await new Promise<number>((ok, bad) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); s.on("error", bad); });
  const child = spawn("node", [join(dir, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: dir, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return { url, stop: () => void child.kill() };
    await sleep(500);
  }
  child.kill();
  throw new Error(`the app starter did not start in ${dir}`);
}

/** `ui-review refs <refs.json> --out <dir> [--measure]`: capture the references, write <dir>/refs.json; --measure writes the measured tokens back into <refs.json>. */
export async function refsCommand(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
  const o = args.indexOf("--out");
  const out = o >= 0 ? args[o + 1] : undefined;
  if (!file || !out) { process.stderr.write("usage: ui-review refs <refs.json> --out <dir> [--measure]\n"); return 2; }
  const list = JSON.parse(readFileSync(file, "utf8")) as RefEntry[];
  let starter: { url: string; stop(): void } | undefined;
  try {
    const r = await refs(list, { out, fallbackBase: async () => (starter ??= await serveStarter()).url });
    writeFileSync(join(out, "refs.json"), JSON.stringify(r.refs, null, 2) + "\n");
    for (const note of r.notes) process.stderr.write(`refs: ${note}\n`);
    if (args.includes("--measure")) {
      const measured = list.map((e) => ({ ...e, tokens: r.refs.find((x) => x.source === "live" && x.url === e.url)?.tokens ?? e.tokens }));
      writeFileSync(file, JSON.stringify(measured, null, 2) + "\n");
    }
    process.stdout.write(`${r.refs.length} references captured to ${out}\n`);
    return 0;
  } finally { starter?.stop(); }
}
