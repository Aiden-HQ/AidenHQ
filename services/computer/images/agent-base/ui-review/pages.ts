// The page list: the app's feature map when there is one, else pages.json (the router read the agent or the recipe wrote),
// else a same-origin link crawl (depth 2, at most 120 pages) plus sitemap.xml when it answers as XML. Every path is on the
// app under review (same origin); a hash router's routes ("/#/a") are pages of their own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launch, ready, routeOf, workerContext } from "./browser.ts";
import type { Page, PageKind } from "./types.ts";

const CRAWL_MAX = 120, CRAWL_DEPTH = 2, DEFAULT_MAP = "feature-map.json";
const KINDS: PageKind[] = ["dashboard", "list", "detail", "form", "settings", "timeline", "marketing", "other"];
type Entry = string | { path?: unknown; shows?: unknown; kind?: unknown };

/** A path relative to the app's URL, on the app (a protocol-relative "//host" would take the browser elsewhere). */
const onApp = (base: string, p: unknown): p is string => typeof p === "string" && /^[/#?]/.test(p) && !p.startsWith("//") && new URL(p, base).origin === new URL(base).origin;

function read(file: string, base: string, source: Page["source"]): Page[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file} is not valid JSON: ${(e as Error).message}`); }
  const list = (Array.isArray(raw) ? raw : (raw as { pages?: unknown })?.pages) as Entry[] | undefined;
  const pages = (Array.isArray(list) ? list : []).map((e) => (typeof e === "string" ? { path: e } : e));
  if (!pages.length || pages.some((p) => !onApp(base, p?.path)))
    throw new Error(`${file} needs {"pages": [{"path": "/…", "shows": "what should be visible"}]} (or a list of them), at least one, each a path on this app`);
  return pages.map((p) => ({ path: p.path as string, source, ...(typeof p.shows === "string" ? { shows: p.shows } : {}), ...(KINDS.includes(p.kind as PageKind) ? { kind: p.kind as PageKind } : {}) }));
}

/** The page list: `featureMap` (a file that must exist), else `pagesFile`, else ./feature-map.json when there is one, else the crawl. */
export async function pageList(base: string, o: { featureMap?: string; pagesFile?: string; crawl: boolean }): Promise<Page[]> {
  if (o.featureMap) return read(o.featureMap, base, "feature-map");
  if (o.pagesFile) return read(o.pagesFile, base, "router");
  if (existsSync(DEFAULT_MAP)) return read(DEFAULT_MAP, base, "feature-map");
  if (!o.crawl) return [{ path: "/", source: "links" }];
  return crawl(base);
}

/** The path of a URL on the app, relative to the app's URL, or null when it leaves the app or isn't a page. */
function pathOf(base: string, href: string): string | null {
  const u = new URL(href, base), b = new URL(base);
  if (u.origin !== b.origin || u.pathname.startsWith("/api/") || /\.(?!html?$)[a-z0-9]{2,5}$/i.test(u.pathname) || /log-?out|sign-?out/i.test(u.pathname + u.hash)) return null;
  return routeOf(u);
}

async function crawl(base: string): Promise<Page[]> {
  const found: Page[] = [], seen = new Set<string>();
  const add = (path: string, source: Page["source"]) => { if (seen.has(path) || found.length >= CRAWL_MAX) return false; seen.add(path); found.push({ path, source }); return true; };
  add(routeOf(new URL(base)), "links");
  const b = await launch({ politeness: { origin: new URL(base).origin, rps: 4 }, target: base });
  try {
    const page = await (await workerContext(b.browser, new Date().toISOString())).newPage();
    let level = [found[0].path];
    for (let depth = 0; depth < CRAWL_DEPTH && level.length && found.length < CRAWL_MAX; depth++) {
      const nextLevel: string[] = [];
      for (const path of level) {
        try {
          await page.goto("about:blank");
          await page.goto(new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 15000 });
          await ready(page);
          const hrefs = await page.$$eval("a[href]", (as) => as.filter((a) => !(a as HTMLAnchorElement).target && !a.hasAttribute("download")).map((a) => (a as HTMLAnchorElement).href));
          for (const h of hrefs) { const p = pathOf(base, h); if (p && add(p, "links")) nextLevel.push(p); }
        } catch { /* a page that doesn't open adds no links */ }
      }
      level = nextLevel;
    }
  } finally { await b.close(); }
  try {
    const r = await fetch(new URL("/sitemap.xml", base), { signal: AbortSignal.timeout(10000) });
    if (r.ok && /^(application|text)\/xml\b/.test(r.headers.get("content-type") ?? ""))
      for (const m of (await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) { const p = pathOf(base, m[1]); if (p) add(p, "sitemap"); }
  } catch { /* no sitemap */ }
  return found;
}

/** `ui-review pages <url> --out <dir> [--map f] [--pages-file f]`: writes the page list to <out>/pages.json. */
export async function pagesCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string", default: "ui-review" }, map: { type: "string" }, "pages-file": { type: "string" } } });
  const base = positionals.find((a) => /^https?:\/\//.test(a));
  if (!base) { console.error("usage: ui-review pages <url> --out <dir> [--map feature-map.json] [--pages-file f]"); return 2; }
  let pages: Page[];
  try { pages = await pageList(base, { featureMap: v.map, pagesFile: v["pages-file"], crawl: true }); } catch (e) { console.error(`ui-review: ${(e as Error).message}`); return 2; }
  mkdirSync(v.out!, { recursive: true });
  writeFileSync(join(v.out!, "pages.json"), JSON.stringify(pages, null, 2));
  console.log(`${join(v.out!, "pages.json")}: ${pages.length} pages`);
  return 0;
}
