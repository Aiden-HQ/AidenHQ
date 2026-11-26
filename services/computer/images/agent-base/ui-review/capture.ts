// One capture: a page at one width, theme and state. Opened afresh (from about:blank, so a hash route loads anew), waited on
// with the one readiness wait (capped, never network idle), measured, then shot: viewport-sized steps through the app's main
// scroller when it scrolls inside a container, else the page itself, at most 6 viewport heights. Every PNG is stamped (an
// `aidenhq` text chunk: commit, url, width, mode, takenAt) for the grader. Rule checks and the motion pass come after the shots,
// so their hovers and clicks never show in a picture.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { crc32 } from "node:zlib";
import type { BrowserContext, Page as PwPage, Route } from "playwright-core";
import { heightOf, isLocal, launch, ready, workerContext } from "./browser.ts";
import { measurePage } from "./measure.ts";
import { measureMotion } from "./motion.ts";
import { pageList } from "./pages.ts";
import { keyOf, openQueue } from "./queue.ts";
import { CHANGED_PCT, CHANGED_PX, readReport, writeReport } from "./report.ts";
import { rules } from "./rules.ts";
import type { Capture, Measures, Page, QueueItem, RuleHit, ShotDiff, State, Theme } from "./types.ts";

export const MAX_STEPS = 6;
const NOT_MEASURED: Measures = { fonts: [], colours: [], radii: [], shadows: [], spacing: { values: [], offScale: [] }, nearMisses: [], content: { width: 0, viewport: 0 }, ctas: [], contrastFails: 0, signatures: { button: [], card: [], heading: [], input: [] } };

export type CaptureOptions = {
  out: string; frozenAt: string; commit?: string; tree?: string;
  slug: string;              // the page's file-name stem
  waitText?: string;         // wait for this text before the shots
  widest?: boolean;          // the run's widest width: axe, page errors, failed loads
  first?: boolean;           // with widest, the first theme: "One system", "Copy", vitals
  phone?: boolean;           // the narrowest width under 600px: the 44px count
  motion?: boolean;          // measure motion (one width and theme per page)
  baseline?: string;         // a baseline run's folder: diff each shot against its shot of the same name
  diffPage?: () => Promise<PwPage>;
};

/** The shot's file name: `<page>-<width>-<mode>.png`, then `-<state>` for a state other than default, `-s<n>` for later steps. */
export const shotName = (slug: string, item: QueueItem, step: number) => `${slug}-${item.width}-${item.theme}${item.state === "default" ? "" : `-${item.state}`}${step ? `-s${step + 1}` : ""}.png`;

/** The URL of a page: "/" is the app's URL itself; a page that takes ?palette= also gets the theme as ?mode=. */
export function urlOf(base: string, path: string, theme: string): string {
  const u = new URL(path === "/" ? base : new URL(path, base).href);
  if (u.searchParams.has("palette")) u.searchParams.set("mode", theme);
  return u.href;
}

// The app's main scroller: the largest visible element that scrolls inside the page, at least a quarter of the viewport.
const SCROLLER = () => {
  document.querySelectorAll("[data-ui-review-scroller]").forEach((e) => e.removeAttribute("data-ui-review-scroller"));
  let best: Element | null = null, area = 0;
  for (const e of document.body.querySelectorAll("*")) {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    if (!/auto|scroll/.test(s.overflowY) || e.scrollHeight <= e.clientHeight + 1 || r.width <= 0 || r.height <= 0 || s.visibility === "hidden") continue;
    if (r.width * r.height > area) { best = e; area = r.width * r.height; }
  }
  if (!best || area < 0.25 * innerWidth * innerHeight) return { height: document.documentElement.scrollHeight, view: innerHeight, inner: false };
  best.setAttribute("data-ui-review-scroller", "");
  return { height: best.scrollHeight, view: best.clientHeight, inner: true };
};
const frames = (page: PwPage) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));

/** Same-origin JSON GETs answered for a state: `empty` lists, an `error` (500), or `loading` (held 10 s). */
function stateRoute(item: QueueItem, origin: string) {
  const empty = (v: unknown): unknown => Array.isArray(v) ? [] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, empty(x)])) : v;
  return async (route: Route) => {
    const req = route.request();
    if (req.method() !== "GET" || !["fetch", "xhr"].includes(req.resourceType()) || new URL(req.url()).origin !== origin) return route.fallback().catch(() => {});
    if (item.state === "error") return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"ui-review: the error state"}' }).catch(() => {});
    if (item.state === "loading") { await new Promise((ok) => setTimeout(ok, 10_000)); return route.continue().catch(() => {}); }
    try {
      const resp = await route.fetch();
      if (!/json/.test(resp.headers()["content-type"] ?? "")) return route.fulfill({ response: resp });
      return route.fulfill({ response: resp, json: empty(await resp.json()) });
    } catch { return route.fallback().catch(() => {}); }
  };
}

const errorsOf = new WeakMap<PwPage, string[]>();
/** The worker's page in this context (one per context, reused), collecting page errors and console errors. */
export async function pageOf(ctx: BrowserContext): Promise<PwPage> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!errorsOf.has(page)) {
    const errs: string[] = [];
    errorsOf.set(page, errs);
    page.on("pageerror", (e) => errs.push(String(e.stack || e.message)));
    page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });
  }
  return page;
}

export async function capture(ctx: BrowserContext, base: string, item: QueueItem, o: CaptureOptions): Promise<Capture> {
  const page = await pageOf(ctx), errs = errorsOf.get(page)!;
  const width = item.width, height = heightOf(width), url = urlOf(base, item.page, item.theme);
  const where = `${item.page}${item.state === "default" ? "" : ` (${item.state})`}`;
  const notes: RuleHit[] = [];
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: item.theme });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (item.state !== "default") await page.route("**/*", stateRoute(item, new URL(base).origin));
  await page.goto("about:blank");
  errs.length = 0;
  const doc = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  if (doc && doc.status() >= 400 && o.widest && item.state === "default") notes.push({ rule: "document-status", blocking: true, text: `${where} ${item.theme}: the page answers ${doc.status()}` });
  let settled: boolean, loading: number;
  if (item.state === "loading") { await page.waitForTimeout(400); settled = false; loading = 0; }
  else {
    ({ settled, loading } = await ready(page));
    if (o.waitText) await page.getByText(o.waitText).first().waitFor({ timeout: 4000 }).catch(() => notes.push({ rule: "wait-text", blocking: false, text: `${where} ${width}px ${item.theme}: "${o.waitText}" never showed` }));
    if (!settled) notes.push({ rule: "not-settled", blocking: false, text: `${where} ${width}px ${item.theme}: not settled within 4 s${loading ? ` (${loading} loading indicators still showing)` : ""}; captured as it was` });
  }
  let measures: Measures;
  try { measures = await measurePage(page); } catch (e) { measures = NOT_MEASURED; notes.push({ rule: "measures", blocking: false, text: `${where} ${width}px ${item.theme}: not measured: ${String((e as Error).message).split("\n")[0]}` }); }

  const stamp = { commit: o.commit, tree: o.tree, url, width, mode: item.theme };
  const shots: string[] = [];
  const sc = await page.evaluate(SCROLLER);
  const shoot = async (step: number, clip?: { x: number; y: number; width: number; height: number }) => {
    const name = shotName(o.slug, item, step), file = join(o.out, name);
    const buf = await page.screenshot({ animations: "disabled", caret: "hide", timeout: 20_000, ...(clip ? { fullPage: true, clip } : {}) });
    writeFileSync(file, stampPng(buf, { ...stamp, takenAt: new Date().toISOString() }));
    shots.push(name);
  };
  if (sc.inner) {
    const steps = Math.min(MAX_STEPS, Math.ceil(sc.height / sc.view));
    for (let i = 0; i < steps; i++) {
      if (i) {
        await page.evaluate((top) => { const e = document.querySelector("[data-ui-review-scroller]"); if (e) e.scrollTop = top; }, i * sc.view);
        await frames(page);
        const r = await ready(page, 1000, 100);
        loading = Math.max(loading, r.loading);
      }
      await shoot(i);
    }
    await page.evaluate(() => { const e = document.querySelector("[data-ui-review-scroller]"); if (e) e.scrollTop = 0; });
  } else {
    await shoot(0, { x: 0, y: 0, width, height: Math.min(Math.max(sc.height, height), MAX_STEPS * height) });
  }
  if (loading) notes.push({ rule: "loading-visible", blocking: false, text: `${where} ${width}px ${item.theme}: ${loading} loading indicators were showing when it was shot` });

  const hits = await rules(page, { where, width, theme: item.theme, widest: !!o.widest && item.state === "default", first: !!o.first, phone: !!o.phone, errors: errs });
  const motion = o.motion && item.state === "default" ? await measureMotion(page, { click: isLocal(url) }).catch(() => undefined) : undefined;
  const c: Capture = { page: item.page, width, theme: item.theme, state: item.state, url, shots, settled, measures, ...(motion ? { motion } : {}), rules: [...notes, ...hits] };
  if (o.baseline && o.diffPage) c.diffs = await diffShots(await o.diffPage(), o.baseline, o.out, shots);
  return c;
}

/** A PNG with an `aidenhq` text chunk after IHDR: the capture's stamp (JSON, ASCII-escaped). */
export function stampPng(buf: Buffer, stamp: object): Buffer {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  const json = JSON.stringify(stamp).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const body = Buffer.concat([Buffer.from("tEXtaidenhq\0", "latin1"), Buffer.from(json, "latin1")]);
  const len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([buf.subarray(0, 33), len, body, crc, buf.subarray(33)]);
}

/** The PNG without its stamp chunk: two shots with the same pixels encode alike. */
const unstamped = (buf: Buffer) => buf.length > 48 && buf.toString("latin1", 37, 48) === "tEXtaidenhq" ? Buffer.concat([buf.subarray(0, 33), buf.subarray(33 + 12 + buf.readUInt32BE(33))]) : buf;

/**
 * Each shot against the baseline's shot of the same name, in Chrome (a canvas: no image library): the share of pixels that
 * differ (a channel off by more than 24 of 255), and for a changed shot (CHANGED_PCT, CHANGED_PX) a diff picture (changes in red over a faded after)
 * and a before|after picture side by side (JPEG: a 2560px pair encodes several times faster than PNG).
 */
export async function diffShots(dp: PwPage, baseline: string, out: string, shots: string[]): Promise<ShotDiff[]> {
  const diffs: ShotDiff[] = [];
  for (const shot of shots) {
    const before = join(baseline, shot);
    if (!existsSync(before)) continue;
    const a = readFileSync(before), b = readFileSync(join(out, shot));
    if (unstamped(a).equals(unstamped(b))) { diffs.push({ shot, pct: 0 }); continue; }
    const r = await dp.evaluate(async ([a, b, min, minPx]) => {
      const load = async (s: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const [A, B] = await Promise.all([load(a), load(b)]);
      const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
      const px = (img: ImageBitmap) => { const c = new OffscreenCanvas(w, h), x = c.getContext("2d")!; x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
      const pa = px(A), pb = px(B);
      let n = 0;
      const changed = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const j = i * 4;
        if (Math.max(Math.abs(pa[j] - pb[j]), Math.abs(pa[j + 1] - pb[j + 1]), Math.abs(pa[j + 2] - pb[j + 2]), Math.abs(pa[j + 3] - pb[j + 3])) > 24) { changed[i] = 1; n++; }
      }
      const pct = Math.round((1e4 * n) / (w * h)) / 100;
      if (pct < min && n < minPx) return { pct };
      const toJpeg = async (c: OffscreenCanvas) => { const buf = await (await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer(); let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
      const d = new OffscreenCanvas(w, h), dx = d.getContext("2d")!;
      const img = dx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const j = i * 4;
        if (changed[i]) { img.data[j] = 255; img.data[j + 1] = 0; img.data[j + 2] = 60; } else { img.data[j] = 255 - (255 - pb[j]) * 0.25; img.data[j + 1] = 255 - (255 - pb[j + 1]) * 0.25; img.data[j + 2] = 255 - (255 - pb[j + 2]) * 0.25; }
        img.data[j + 3] = 255;
      }
      dx.putImageData(img, 0, 0);
      const s = new OffscreenCanvas(A.width + 16 + B.width, h), sx = s.getContext("2d")!;
      sx.fillStyle = "#fff"; sx.fillRect(0, 0, s.width, h); sx.drawImage(A, 0, 0); sx.drawImage(B, A.width + 16, 0);
      return { pct, diff: await toJpeg(d), compare: await toJpeg(s) };
    }, [a.toString("base64"), b.toString("base64"), CHANGED_PCT, CHANGED_PX] as [string, string, number, number]);
    const d: ShotDiff = { shot, pct: r.pct };
    if (r.diff && r.compare) {
      d.diff = `diff-${shot.replace(/\.png$/, ".jpg")}`; d.compare = `compare-${shot.replace(/\.png$/, ".jpg")}`;
      writeFileSync(join(out, d.diff), Buffer.from(r.diff, "base64"));
      writeFileSync(join(out, d.compare), Buffer.from(r.compare, "base64"));
    }
    diffs.push(d);
  }
  return diffs;
}

// ---- the `capture` command: the page list into the coverage queue, worked by --workers contexts on one Chrome ----

/** What the shots show: --commit, else this folder's git HEAD and the tree of its working files (uncommitted changes in, the run's own `out` folder not). */
function source(commit: string | undefined, out: string): { commit?: string; tree?: string } {
  if (commit) return { commit };
  try {
    const git = (a: string[], env?: Record<string, string>) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } }).trim();
    const head = git(["rev-parse", "HEAD"]);
    const index = join(mkdtempSync(join(tmpdir(), "ui-review-tree-")), "index");
    git(["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
    const top = git(["rev-parse", "--show-toplevel"]), rel = relative(realpathSync(top), realpathSync(out));
    git(["add", "-A", "--", top, ...(rel && !rel.startsWith("..") && !isAbsolute(rel) ? [`:(top,exclude,literal)${rel}`] : [])], { GIT_INDEX_FILE: index });
    return { commit: head, tree: git(["write-tree"], { GIT_INDEX_FILE: index }) };
  } catch { return {}; }
}

/** File-name stems, one per page, unique ("/" is home). */
function slugs(pages: Page[]): Map<string, string> {
  const m = new Map<string, string>(), used = new Set<string>();
  for (const p of pages) {
    const s = (p.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "home").slice(0, 60);
    let slug = s;
    for (let n = 2; used.has(slug); n++) slug = `${s}-${n}`;
    used.add(slug); m.set(p.path, slug);
  }
  return m;
}

const list = <T extends string | number>(v: string | undefined, d: T[], f: (s: string) => T): T[] => (v ? v.split(",").filter(Boolean).map(f) : d);
const PAGE_MAX = 120, CAPTURE_TIMEOUT = 60_000;
/** The default widths: phone, tablet, small laptop, the common 1280 laptop, the reference desktop, a large and a 4K-class screen. */
export const WIDTHS = [390, 768, 1024, 1280, 1512, 1920, 2560];

export async function captureCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    out: { type: "string", default: "ui-review" }, "pages-file": { type: "string" }, map: { type: "string" }, paths: { type: "string" },
    widths: { type: "string" }, themes: { type: "string" }, states: { type: "string" }, resume: { type: "boolean" }, baseline: { type: "string" },
    commit: { type: "string" }, workers: { type: "string" }, palettes: { type: "string" }, "wait-text": { type: "string" },
  } });
  const base = positionals.find((a) => /^https?:\/\//.test(a));
  if (!base) { console.error("usage: ui-review capture <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4] [--palettes a,b] [--wait-text t]"); return 2; }
  const out = v.out!;
  mkdirSync(out, { recursive: true });
  const runFile = join(out, "run.json");
  const prior = v.resume && existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) as { base: string; commit?: string; tree?: string; frozenAt: string; pages: Page[]; widths: number[]; themes: Theme[]; states: State[]; baseline?: string } : null;
  const at = source(v.commit, out);
  if (prior && (prior.base !== base || prior.commit !== at.commit || prior.tree !== at.tree)) { console.error(`ui-review: --resume of a run of ${prior.base} at ${prior.commit ?? "an unknown commit"}, not ${base} at ${at.commit ?? "an unknown commit"}: start a new --out`); return 2; }
  const widths = prior?.widths ?? list(v.widths, WIDTHS, Number);
  const themes = prior?.themes ?? list(v.themes, ["light", "dark"] as Theme[], (s) => s as Theme);
  const states = prior?.states ?? list(v.states, ["default"] as State[], (s) => s as State);
  const baseline = v.baseline ?? prior?.baseline;
  let pages = prior?.pages;
  if (!pages) {
    try {
      pages = v.paths ? v.paths.split(",").map((path): Page => ({ path, source: "feature-map" })) : await pageList(base, { featureMap: v.map, pagesFile: v["pages-file"], crawl: true });
    } catch (e) { console.error(`ui-review: ${(e as Error).message}`); return 2; }
    const palettes = list(v.palettes, [] as string[], String);
    // "/" is the URL given (a /catalog.html run keeps to the catalog), so its palette pages are that page's.
    if (palettes.length) pages = pages.flatMap((p) => palettes.map((pal) => { const u = new URL(p.path === "/" ? base : p.path, base); u.searchParams.set("palette", pal); return { ...p, path: u.pathname + u.search + u.hash }; }));
  }
  const frozenAt = (baseline && readReport(baseline)?.frozenAt) || prior?.frozenAt || new Date().toISOString();
  writeFileSync(runFile, JSON.stringify({ base, commit: at.commit, tree: at.tree, frozenAt, pages, widths, themes, states, baseline }, null, 2));
  const q = openQueue(join(out, "queue.json"), pages, { widths, themes, states, max: PAGE_MAX, resume: !!v.resume });
  const slug = slugs(pages);
  const widest = Math.max(...widths), narrowest = Math.min(...widths), motionWidth = widths.includes(1512) ? 1512 : widest;
  const b = await launch({ out, politeness: { origin: new URL(base).origin, rps: 4 } });
  const t0 = Date.now();
  try {
    await Promise.all(Array.from({ length: Math.max(1, Number(v.workers ?? 4)) }, async () => {
      let ctx = await workerContext(b.browser, frozenAt);
      let dp: PwPage | undefined;
      const diffPage = async () => (dp ??= await ctx.newPage());
      for (let item = q.next(); item; item = q.next()) {
        const it = item;
        let timer: NodeJS.Timeout | undefined;
        try {
          const c = await Promise.race([
            capture(ctx, base, it, { out, frozenAt, ...at, slug: slug.get(it.page) ?? "page", waitText: v["wait-text"], widest: it.width === widest, first: it.theme === themes[0], phone: it.width === narrowest && it.width < 600, motion: it.width === motionWidth && it.theme === themes[0], baseline, diffPage }),
            new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${CAPTURE_TIMEOUT / 1000} s`)), CAPTURE_TIMEOUT); }),
          ]);
          q.done(it, c);
        } catch (e) {
          q.failed(it, String((e as Error).message).split("\n")[0].slice(0, 200));
          // A crashed or stuck page: this worker starts over with a fresh context; the run goes on.
          await ctx.close().catch(() => {});
          ctx = await workerContext(b.browser, frozenAt); dp = undefined;
        } finally { clearTimeout(timer); }
      }
      await ctx.close().catch(() => {});
    }));
  } finally { await b.close(); }
  const secs = Math.round((Date.now() - t0) / 1000);

  // A state that looks just like the default is not reachable this way: its pictures are dropped.
  let caps = q.captures();
  const notes: string[] = [];
  const shotOf = new Map(caps.filter((c) => c.state === "default").map((c) => [keyOf(c).replace(/\|default$/, ""), c.shots[0]]));
  caps = caps.filter((c) => {
    if (c.state === "default") return true;
    const d = shotOf.get(keyOf(c).replace(/\|[a-z]+$/, ""));
    const dropped = !!c.shots[0] && !existsSync(join(out, c.shots[0])); // dropped by an earlier pass of this run (before a --resume)
    if (!dropped && (!d || !c.shots[0] || !unstamped(readFileSync(join(out, d))).equals(unstamped(readFileSync(join(out, c.shots[0])))))) return true;
    for (const s of c.shots) rmSync(join(out, s), { force: true });
    notes.push(`${c.page} ${c.width}px ${c.theme}: the ${c.state} state is not reachable (it looks just like the default)`);
    return false;
  });
  for (const i of q.items) if (i.status === "failed") notes.push(`${i.page} ${i.width}px ${i.theme}${i.state === "default" ? "" : ` (${i.state})`}: not captured: ${i.why}`);
  const counts = q.counts();
  const r = writeReport(out, { version: 2, target: base, ...(at.commit ? { commit: at.commit } : {}), frozenAt, model: "", coverage: counts, captures: caps, improvements: [], motion: [], bugs: [], notes, cost_usd: 0 });
  console.log(`${join(out, "report.md")}: ${counts.done}/${counts.total} captures in ${secs} s, ${r.blocking!.length} blocking, ${r.preexisting!.length} already on this base, ${caps.reduce((n, c) => n + c.shots.length, 0)} screenshots${counts.failed ? `, ${counts.failed} failed` : ""}${counts.deferred ? `, ${counts.deferred} deferred` : ""}`);
  if (!counts.done) { console.error("ui-review: nothing was captured (is the app up?)"); return 2; }
  return r.blocking!.length ? 1 : 0;
}
