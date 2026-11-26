// The route check (#1876's, on Playwright): it clicks, under the live-app guard's --mode (guard.ts: read by default on a live
// target, so a click there writes nothing; any on a local build), with --session signed in (login.ts), at 1512px
// light, at most 300 s, 4 contexts side by side. A hash router's "#/a" is a route like a path. Every check opens its page afresh.
// - The header brand on every page goes to the home view, at the top (from the foot of the page, so a brand that looks
//   clickable and does nothing fails).
// - Every link to another route (one per kind: its route and query names, nav links first) must render on the click, again
//   after Back and Forward, and on a reload: never the app's own not-found view, an empty page or a page error.
// - A link to the page it is on (a path link or an in-page anchor, not a hash router's link to its current route, which
//   browsers leave alone) must visibly act, from the foot of the page.
// - Every visible control (one per kind and label across the pages; not one already selected, current or pressed) should
//   visibly act when clicked: the address, the page, the scroll, the focus or what is open changes. A click that changes
//   nothing is confirmed by a second click after a fresh load, then listed to look at (never blocking). Never a form's submit
//   or one that deletes, sends or pays.
// The app's not-found view is fingerprinted first: what loads at a path, a hash route and a route under each section of the
// app that can't exist (kept only when it differs from home and from that section's own page).
// Writes report.json (a version-2 Report: its findings in `blocking` and `bugs`, the controls that changed nothing in
// `candidates`, never blocking) and report.md; exits 1 on blocking findings.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Page as PwPage } from "playwright-core";
import { launch, ready, routeOf, workerContext } from "./browser.ts";
import { modeOf } from "./guard.ts";
import { readSession, signedOut } from "./login.ts";
import { pageList } from "./pages.ts";
import { readReport, splitPreexisting } from "./report.ts";
import type { Bug, Report } from "./types.ts";

const WIDTH = 1512, HEIGHT = 900, WORKERS = 4, BUDGET_MS = 300_000, CHECK_MS = 45_000, LINK_KINDS = 60;
const MISSING = "ui-review-missing"; // letters and hyphens: what route params usually accept
const DEAD = "clicking it changes nothing, even on a second click after a fresh load: same address, same page, same focus, nothing opens, no request";
// A link whose URL changes while the page stays, and whose target opened afresh is that same page: an alias of this page, or a
// route the app doesn't know and falls back from. Both read the same to the check, so it is one to look at, never blocking.
const SAME = "clicking it changes the URL but the same page shows, also when the new URL is opened afresh: an alias of this page, or a route the app doesn't know";
const LOOK = new Set([DEAD, SAME]);

type View = { route: string; status: number; blank: boolean; text: string; all: string }; // text: the main region's (else the page's); all: the page's
type Snap = { origin: string; route: string; scrollY: number; focus: string; html: string; live: string; reqs: number };
type Check = { from: string; what: string; to?: string; problems: string[]; skipped?: string };

/** How alike two pages' text is (shared words over all words, 0..1): live clocks and counts don't make two views differ. */
export function alike(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().replace(/\d+/g, "#").split(/[^\p{L}#]+/u).filter(Boolean));
  const A = words(a), B = words(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return A.size + B.size === 0 ? 1 : both / (A.size + B.size - both);
}

// In-page helpers, injected once per document by `prep` (window.__uiRoutes). `routeOf` mirrors browser.ts.
const HELPERS = () => {
  const routeOf = (u: URL) => {
    if (!u.hash.startsWith("#/")) return u.pathname + u.search;
    const q = u.hash.indexOf("?"), p = (q < 0 ? u.hash : u.hash.slice(0, q)).replace(/\/+$/, ""), query = q < 0 ? "" : u.hash.slice(q);
    return u.pathname + u.search + (p === "#" && !query ? "" : p + query);
  };
  const seen = (e: Element) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[inert], [aria-hidden=true]"); };
  const label = (e: Element) => (e.getAttribute("aria-label") || e.textContent || e.getAttribute("title") || e.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  const here = () => routeOf(new URL(location.href));
  const appLink = (a: HTMLAnchorElement) => { const u = new URL(a.href, location.href); return u.origin === location.origin && !a.target && !a.hasAttribute("download") && !u.pathname.startsWith("/api/") && !/\.(?!html?$)[a-z0-9]{2,5}$/i.test(u.pathname) && !/log-?out|sign-?out/i.test(u.pathname + u.hash + " " + a.textContent) && seen(a); };
  const links = () => ([...document.querySelectorAll("a[href]")] as HTMLAnchorElement[]).filter(appLink);
  // Other routes: one per kind (route path and query names).
  const routeLinks = () => links().filter((a) => routeOf(new URL(a.href)) !== here()).map((a) => {
    const u = new URL(a.href), r = routeOf(u), [path, query = ""] = r.split("?");
    return { href: a.getAttribute("href"), to: r, kind: path + "?" + [...new URLSearchParams(query).keys()].sort().join(","), label: label(a), nav: !!a.closest("nav,header,aside,[role=navigation]") };
  });
  // Links to this page: a path link or an in-page anchor (a hash router's link to its current route does nothing, by design).
  const sameLinks = () => links().filter((a) => { const u = new URL(a.href); return routeOf(u) === here() && !u.hash.startsWith("#/") && !(a.closest("header, [role=banner], [data-slot=sidebar-header]") && !a.closest("nav, [role=navigation]") && u.pathname === "/") && !RISKY_RE.test(a.getAttribute("aria-label") || a.textContent || ""); });
  const RISKY_RE = /\b(delete|remove|discard|sign ?out|log ?out|pay|purchase|send|publish|deploy|archive|reset)\b/i;
  const controls = () => [...document.querySelectorAll("button, [role=button], [role=tab], [role=option], [role=menuitem], [role=switch], [role=checkbox], [role=link], summary, input[type=checkbox], input[type=radio], [onclick]")]
    .filter((e) => seen(e) && !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true" && !(e.closest("form") && (e as HTMLButtonElement).type === "submit") && !(e.tagName === "A" && (e as HTMLAnchorElement).href) && !current(e))
    .filter((e) => !RISKY_RE.test(e.getAttribute("aria-label") || e.textContent || ""));
  // Already selected, current or pressed (the active tab, the chosen segment, a checked radio): clicking it again rightly does nothing.
  const current = (e: Element) => e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-pressed") === "true" || (e.hasAttribute("aria-current") && e.getAttribute("aria-current") !== "false")
    || /^(active|on)$/.test(e.getAttribute("data-state") ?? "") || ((e as HTMLInputElement).type === "radio" && (e as HTMLInputElement).checked);
  const kindOf = (e: Element) => e.tagName === "BUTTON" ? "button" : e.getAttribute("role") || (e as HTMLInputElement).type || e.tagName.toLowerCase();
  // The header's brand: the first header link outside the nav that goes home, else the one named or styled as the brand.
  const brand = (home: string) => {
    const all = ([...document.querySelectorAll("header a[href], [role=banner] a[href], [data-slot=sidebar-header] a[href], nav a[href]")] as HTMLAnchorElement[])
      .filter((a) => a.closest("header, [role=banner], [data-slot=sidebar-header]") && !a.closest("nav, [role=navigation]") && seen(a) && new URL(a.href).origin === location.origin);
    return all.find((a) => [home, "/"].includes(routeOf(new URL(a.href)))) ?? all.find((a) => /brand|logo|home/i.test(`${a.className} ${a.id} ${a.getAttribute("aria-label") ?? ""}`));
  };
  const view = () => {
    const empty = (e: Element) => !(e as HTMLElement).innerText.trim() && !e.querySelector("img, svg, canvas, video, iframe, input, textarea, select");
    // A not-found view is told by the main region's text (the app's frame and nav are alike on every page), else the page's.
    const main = document.querySelector("main, [role=main]") as HTMLElement | null;
    const parts = [document.querySelector("#root, #app, #__next, [data-reactroot]"), main].filter(Boolean) as Element[];
    return { route: here(), status: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseStatus ?? 0,
      blank: parts.length ? parts.some(empty) : !(document.body?.innerText || "").trim(), text: (main?.innerText.trim() ? main.innerText : document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000),
      all: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000) };
  };
  // What a click may change: the address, the scroll (page or inner), the focus, the page, a control's live state, requests.
  const snap = () => {
    const html = document.documentElement.outerHTML.replace(/\sdata-ui-review-[a-z-]+(="[^"]*")?/g, "");
    let h = 0;
    for (let i = 0; i < html.length; i++) h = (Math.imul(31, h) + html.charCodeAt(i)) | 0;
    const live = [...document.querySelectorAll("input, select, textarea")].map((e) => { const x = e as HTMLInputElement & HTMLSelectElement; return [x.type, x.checked, x.selectedIndex, x.value].join(":"); }).join("|");
    const inner = [...document.querySelectorAll("*")].reduce((n, e) => n + e.scrollTop, 0);
    const f = document.activeElement;
    return { origin: location.origin, route: here(), scrollY: Math.round(scrollY + inner), focus: f && f !== document.body ? (f.tagName + " " + label(f)) : "", html: h + ":" + html.length, live, reqs: (window as unknown as { __uiReview?: { started: number } }).__uiReview?.started ?? 0 };
  };
  const mark = (attr: string, e: Element | undefined) => { document.querySelectorAll(`[${attr}]`).forEach((x) => x.removeAttribute(attr)); if (!e) return false; e.setAttribute(attr, ""); return true; };
  (window as unknown as { __uiRoutes: unknown }).__uiRoutes = { routeLinks, sameLinks, controls, kindOf, label, brand, view, snap, mark, here };
};
type R = { routeLinks(): { href: string; to: string; kind: string; label: string; nav: boolean }[]; sameLinks(): HTMLAnchorElement[]; controls(): Element[]; kindOf(e: Element): string; label(e: Element): string; brand(home: string): HTMLAnchorElement | undefined; view(): View; snap(): Snap; mark(attr: string, e: Element | undefined): boolean };

/** One browser page for checks, with its page errors. */
type Session = { page: PwPage; errs: string[]; origin: string; blockedAt: number };
async function prep(s: Session) { if (!(await s.page.evaluate(() => "__uiRoutes" in window))) await s.page.evaluate(`(${HELPERS.toString()})()`); }
async function openAt(s: Session, base: string, path: string) {
  await s.page.goto("about:blank");
  s.errs.length = 0;
  await s.page.goto(path === "/" ? base : new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await ready(s.page);
}
async function settle(s: Session) { await ready(s.page); }
const look = async (s: Session) => { await prep(s); return s.page.evaluate(() => (window as unknown as { __uiRoutes: R }).__uiRoutes.view()); };
const snap = async (s: Session) => { await prep(s); return s.page.evaluate(() => (window as unknown as { __uiRoutes: R }).__uiRoutes.snap()); };
const toFoot = (s: Session) => s.page.evaluate(() => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }); return Math.round(scrollY); });
const same = (a: Snap, b: Snap, polling: boolean) => a.route === b.route && a.scrollY === b.scrollY && a.focus === b.focus && a.html === b.html && a.live === b.live && (polling || a.reqs === b.reqs);
/** Clicks only on the app under review: a page that redirected elsewhere (a hosted sign-in) is never clicked. */
function guard(s: Session) {
  const u = new URL(s.page.url());
  if (u.origin !== s.origin) throw new Error(`the page left the app for ${u.origin} before the click`);
}
async function click(s: Session, attr: string) {
  guard(s);
  try { await s.page.locator(`[${attr}]`).first().click({ timeout: 2000 }); } catch { await s.page.evaluate((a) => (document.querySelector(`[${a}]`) as HTMLElement | null)?.click(), attr); }
}
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160);

export async function routesCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string", default: "ui-review-routes" }, map: { type: "string" }, "pages-file": { type: "string" }, paths: { type: "string" }, baseline: { type: "string" }, mode: { type: "string" }, session: { type: "string" } } });
  const base = positionals.find((a) => /^https?:\/\//.test(a));
  if (!base) { console.error("usage: ui-review routes <url> --out <dir> [--map f | --pages-file f | --paths /,/x] [--baseline <dir>] [--mode read|test-write|any] [--session state.json]"); return 2; }
  const mode = modeOf(v.mode, base);
  if (!mode) { console.error("ui-review routes: --mode is read, test-write or any"); return 2; }
  const out = v.out!;
  mkdirSync(out, { recursive: true });
  let paths: string[];
  try { paths = v.paths ? v.paths.split(",") : (await pageList(base, { featureMap: v.map, pagesFile: v["pages-file"], crawl: true })).map((p) => p.path); }
  catch (e) { console.error(`ui-review: ${(e as Error).message}`); return 2; }
  const origin = new URL(base).origin;
  if (paths.some((p) => new URL(p, base).origin !== origin)) { console.error("ui-review routes: every path must be on the app under review"); return 2; }
  const t0 = Date.now(), frozenAt = new Date().toISOString();
  let signedIn: ReturnType<typeof readSession> | null = null;
  try { signedIn = v.session ? readSession(v.session) : null; } catch (e) { console.error(`ui-review: ${(e as Error).message}`); return 2; }
  const b = await launch({ out, mode, session: signedIn?.state });
  const sessions: Session[] = [];
  // A session's page in its own context; `renew` replaces it (a timed-out check may still be clicking on the old one).
  const renew = async (s: Session) => {
    await s.page?.context().close().catch(() => {});
    const page = await (await workerContext(b.browser, frozenAt)).newPage();
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.emulateMedia({ colorScheme: "light" });
    s.blockedAt = b.blocked().length;
    // The app's own "Failed to fetch" for a request the live-app guard refused is the guard's doing, listed under blocked.
    page.on("pageerror", (e) => { if (!(/Failed to fetch/.test(e.message) && b.blocked().length > s.blockedAt)) s.errs.push(String(e.message)); });
    s.page = page;
  };
  const session = async () => {
    const s = { errs: [], origin } as unknown as Session;
    await renew(s);
    sessions.push(s);
    return s;
  };
  const checks: Check[] = [], notes: string[] = [];
  try {
    const main = await session();
    // The not-found view's fingerprints (taken after the pages are read: a probe view that looks like one of them is a page).
    const wordsOf = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean));
    const missing: { text: string; only: string[] }[] = [];
    await openAt(main, base, "/");
    const home = await look(main);
    const hashApp = home.route.includes("#/") || paths.some((p) => p.includes("#/"));
    const sections = [...new Set(paths.map((p) => routeOf(new URL(p, base)).replace(/^\/(#\/)?/, "").split(/[/?]/)[0]).filter(Boolean))];
    const pageTexts: { path: string; text: string }[] = [{ path: "/", text: home.text }];
    const fingerprint = async () => {
      const probes = [`/${MISSING}`, `/#/${MISSING}`, ...sections.map((sec) => hashApp ? `/#/${sec}/${MISSING}` : `/${sec}/${MISSING}`)];
      for (const probe of probes) {
        try {
          await openAt(main, base, probe);
          const view = await look(main);
          // Home again (a router that ignores the probe) is not a not-found view. A not-found view is short. Like a reviewed page but not the same: a page template filled for an unknown id, not a
          // not-found view. The same as a reviewed page: that page shows the not-found view too.
          const like = pageTexts.map((t) => ({ ...t, a: alike(view.text, t.text) }));
          if (!view.route.endsWith(MISSING) || alike(view.all, home.all) >= 0.8 || view.text.split(" ").length > 60 || like.some((t) => t.a >= 0.5 && t.a < 0.95) || missing.some((m) => alike(m.text, view.text) >= 0.85)) continue;
          for (const t of like) if (t.a >= 0.95) notes.push(`${t.path} shows the app's own not-found view`);
          // Its own words: on no reviewed page (other than one that shows this view), so a page that has them all shows it.
          const elsewhere = wordsOf(like.filter((t) => t.a < 0.95).map((t) => t.text).join(" "));
          missing.push({ text: view.text, only: [...wordsOf(view.text)].filter((w) => !elsewhere.has(w) && !/^(ui|review|missing)$/.test(w)) });
          notes.push(`the app's not-found view, from ${probe}: "${view.text.slice(0, 100)}"`);
        } catch (e) { notes.push(`not-found probe ${probe}: ${firstLine(e)}`); }
      }
    };
    const isNotFound = (text: string) => missing.some((m) => alike(text, m.text) >= 0.85 || (m.only.length >= 2 && m.only.every((w) => wordsOf(text).has(w))));
    const brokenView = async (s: Session) => {
      const v = await look(s);
      if (s.errs.length) return `the page throws: ${s.errs[0].split("\n")[0].slice(0, 160)}`;
      if (v.blank) return "the page is empty";
      if (isNotFound(v.text)) return "it shows the app's own not-found view";
      return null;
    };
    const readState = async (s: Session) => { const first = await snap(s), start = await snap(s); return { start, polling: first.reqs !== start.reqs }; };
    const confirmed = async <T extends { acted?: boolean } | null>(attempt: () => Promise<T>) => { const first = await attempt(); return first && first.acted === false ? attempt() : first; };

    const tasks: { c: Check; run(s: Session): Promise<void> }[] = [];
    const add = (c: Check, run?: (s: Session, c: Check) => Promise<void>) => { checks.push(c); if (run) tasks.push({ c, run: (s) => run(s, c) }); };
    // The brand, on every page.
    for (const path of paths) add({ from: path, what: "the header brand", problems: [] }, async (s, c) => {
      await openAt(s, base, path);
      await toFoot(s);
      await prep(s);
      const found = await s.page.evaluate((h) => { const a = (window as unknown as { __uiRoutes: R }).__uiRoutes.brand(h); (window as unknown as { __uiRoutes: R }).__uiRoutes.mark("data-ui-review-brand", a); const head = document.querySelector("header, [role=banner], [data-slot=sidebar-header]"); return a ? "ok" : !head ? "none" : head.closest("[inert], [aria-hidden=true]") || document.querySelector("dialog[open], [aria-modal=true]") ? "covered" : "missing"; }, home.route);
      if (found === "covered") { c.skipped = "an open dialog covers the header here"; return; }
      if (found === "none") { c.problems.push(`there is no header brand to click on ${path}`); return; }
      if (found !== "ok") { c.problems.push("its header has no brand link to the home page"); return; }
      // A direct DOM click: a pointer click would scroll the brand into view first, and that scroll would pass for an effect.
      guard(s);
      await s.page.evaluate(() => (document.querySelector("[data-ui-review-brand]") as HTMLElement | null)?.click());
      await settle(s);
      const now = await snap(s), v = await look(s);
      if (now.origin !== new URL(base).origin) c.problems.push(`clicking it leaves the app for ${now.origin}${now.route}`);
      else if (![home.route, "/"].includes(now.route) && alike(v.all, home.all) < 0.8) c.problems.push(`clicking it goes to ${now.route}, not the home page (${home.route})`);
      else if (await s.page.evaluate(() => Math.round(scrollY))) c.problems.push(`clicking it leaves the page scrolled down, not at the top`);
    });
    // Links to this page, links to other routes and controls, read from each page.
    const kinds = new Set<string>(), controlsSeen = new Set<string>();
    const links: { href: string; to: string; label: string; from: string }[] = [];
    for (const path of paths) {
      try {
        await openAt(main, base, path);
        pageTexts.push({ path, text: (await look(main)).text });
        const here = await main.page.evaluate(() => (window as unknown as { __uiRoutes: R }).__uiRoutes.sameLinks().map((a) => ({ href: a.getAttribute("href")!, to: a.href, label: (window as unknown as { __uiRoutes: R }).__uiRoutes.label(a), hash: new URL(a.href).hash })));
        here.forEach((l, i) => add({ from: path, what: `link "${l.label || l.href}" (to this page)`, problems: [] }, async (s, c) => {
          const r = await confirmed(async () => {
            await openAt(s, base, path);
            const foot = await toFoot(s);
            if (!(foot > 1) && !l.hash) return { skipped: "the page is too short to scroll, so a link to it has nothing to do" } as { skipped: string; acted?: boolean };
            await prep(s);
            if (!(await s.page.evaluate((i) => (window as unknown as { __uiRoutes: R }).__uiRoutes.mark("data-ui-review-same", (window as unknown as { __uiRoutes: R }).__uiRoutes.sameLinks()[i]), i))) return { skipped: "the link wasn't on the page when it was opened again" };
            const { start, polling } = await readState(s);
            s.errs.length = 0;
            guard(s);
            await s.page.evaluate(() => (document.querySelector("[data-ui-review-same]") as HTMLElement | null)?.click());
            await settle(s);
            const after = await snap(s);
            return { acted: after.origin !== start.origin || !same(after, start, polling), left: after.origin !== start.origin ? `${after.origin}${after.route}` : "", bad: await brokenView(s) };
          });
          if ("skipped" in r && r.skipped) c.skipped = r.skipped;
          else if ("left" in r && r.left) c.problems.push(`clicking it leaves the app for ${r.left}`);
          else if ("bad" in r && r.bad) c.problems.push(`clicking it: ${r.bad}`);
          else if (!r.acted) c.problems.push(DEAD);
        }));
        for (const l of (await main.page.evaluate(() => (window as unknown as { __uiRoutes: R }).__uiRoutes.routeLinks())).sort((a, b) => Number(b.nav) - Number(a.nav))) {
          if (kinds.has(l.kind)) continue;
          if (links.length >= LINK_KINDS) { notes.push(`more kinds of link than the ${LINK_KINDS} checked: check the rest with --paths on their pages`); break; }
          kinds.add(l.kind); links.push({ ...l, from: path });
        }
        const controls = await main.page.evaluate(() => (window as unknown as { __uiRoutes: R }).__uiRoutes.controls().map((e, i) => ({ i, label: (window as unknown as { __uiRoutes: R }).__uiRoutes.label(e), kind: (window as unknown as { __uiRoutes: R }).__uiRoutes.kindOf(e) })));
        for (const k of controls) {
          if (controlsSeen.has(`${k.kind} ${k.label}`)) continue;
          controlsSeen.add(`${k.kind} ${k.label}`);
          add({ from: path, what: `${k.kind} "${k.label}"`, problems: [] }, async (s, c) => {
            const r = await confirmed(async () => {
              await openAt(s, base, path);
              await prep(s);
              // Found again by kind and label (the list can shift between loads), else by its place.
              const ok = await s.page.evaluate(([i, kind, label]) => { const all = (window as unknown as { __uiRoutes: R }).__uiRoutes.controls(); const e = all.find((x) => (window as unknown as { __uiRoutes: R }).__uiRoutes.kindOf(x) === kind && (window as unknown as { __uiRoutes: R }).__uiRoutes.label(x) === label) ?? all[i]; if (e) { e.scrollIntoView({ block: "center" }); try { (e as HTMLElement).focus({ preventScroll: true }); } catch {} } return (window as unknown as { __uiRoutes: R }).__uiRoutes.mark("data-ui-review-click", e); }, [k.i, k.kind, k.label] as [number, string, string]);
              if (!ok) return null;
              const { start, polling } = await readState(s);
              s.errs.length = 0;
              await click(s, "data-ui-review-click");
              await settle(s);
              return { acted: !same(await snap(s), start, polling), bad: await brokenView(s) };
            });
            if (!r) c.skipped = "the control wasn't on the page when it was opened again";
            else if (r.bad) c.problems.push(`clicking it: ${r.bad}`);
            else if (!r.acted) c.problems.push(DEAD);
          });
        }
      } catch (e) { add({ from: path, what: "its links and controls", problems: [], skipped: `couldn't read them: ${firstLine(e)}` }); }
    }
    for (const l of links) add({ from: l.from, what: `link "${l.label || l.href}" (${l.to})`, to: l.to, problems: [] }, async (s, c) => {
      await openAt(s, base, l.from);
      const start = await look(s);
      if (!(await s.page.evaluate((h) => (window as unknown as { __uiRoutes: R }).__uiRoutes.mark("data-ui-review-link", (([...document.querySelectorAll("a[href]")] as HTMLAnchorElement[]).find((a) => a.getAttribute("href") === h && a.getBoundingClientRect().width > 0))), l.href))) { c.skipped = "the link wasn't on the page when it was opened again"; return; }
      s.errs.length = 0;
      await click(s, "data-ui-review-link");
      await settle(s);
      const clicked = await look(s);
      if (clicked.route === start.route) c.problems.push(`clicking it leaves the URL at ${start.route}`);
      const stays = clicked.route !== start.route && clicked.all === start.all;
      const bad = await brokenView(s);
      if (bad) c.problems.push(`clicking it: ${bad}`);
      await s.page.goBack({ timeout: 10_000 }).catch(() => {});
      await settle(s);
      const back = await look(s);
      if (back.route !== start.route) c.problems.push(`Back goes to ${back.route}, not ${start.route}`);
      else if (alike(back.all, start.all) < 0.8) c.problems.push(alike(back.all, clicked.all) >= 0.8 ? `Back to ${start.route} changes the address, but the page it left stays on screen` : `Back to ${start.route} doesn't show that page again`);
      await s.page.goForward({ timeout: 10_000 }).catch(() => {});
      await settle(s);
      const fwd = await look(s);
      if (fwd.route !== clicked.route) c.problems.push(`Forward goes to ${fwd.route}, not ${clicked.route}`);
      else if (alike(fwd.all, clicked.all) < 0.8) c.problems.push(`Forward to ${clicked.route} doesn't show that page again`);
      await openAt(s, base, clicked.route);
      const fresh = await look(s);
      if (fresh.status >= 400) c.problems.push(`a reload of ${clicked.route} answers ${fresh.status}`);
      else if (fresh.blank || isNotFound(fresh.text)) c.problems.push(`a reload of ${clicked.route} shows ${fresh.blank ? "an empty page" : "the app's own not-found view"}`);
      else if (!stays && alike(fresh.all, clicked.all) < 0.8) c.problems.push(`a reload of ${clicked.route} shows a different page than the click did`);
      // The click left the page as it was: a broken route when the target opened afresh is another page; else an alias or an unknown route.
      if (stays) c.problems.push(alike(fresh.all, start.all) < 0.8 ? `clicking it changes the URL to ${clicked.route} but the page stays the same` : SAME);
    });
    await fingerprint();
    // Links first (the navigation bugs), then brands and controls in page order; the budget cuts what is left.
    tasks.sort((a, b) => Number(!!b.c.to) - Number(!!a.c.to));
    let next = 0, cut = 0;
    for (let i = 1; i < WORKERS; i++) await session();
    await Promise.all(sessions.map(async (s) => {
      while (next < tasks.length) {
        const t = tasks[next++];
        if (Date.now() - t0 > BUDGET_MS) { t.c.skipped = "not checked: the route check's 300 s ran out"; cut++; continue; }
        let timer: NodeJS.Timeout | undefined;
        // Each check in a fresh context: what an earlier check left in storage (an app's remembered last view) never shows.
        try {
          await renew(s); await Promise.race([t.run(s), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${CHECK_MS / 1000} s`)), CHECK_MS); })]);
          // A check that ended on the sign-in page checked the sign-in page, not the route: not counted.
          if (signedIn && (await signedOut(s.page, signedIn.meta))) { t.c.problems = []; t.c.skipped = "couldn't check it: the session ended (signed out)"; }
        }
        catch (e) { t.c.skipped = `couldn't check it: ${firstLine(e)}`; await renew(s); }
        finally { clearTimeout(timer); }
      }
    }));
    if (cut) notes.push(`${cut} of ${tasks.length} checks not run: the route check's 300 s ran out`);
    if (!missing.length) notes.push("the app's not-found view wasn't fingerprinted (unknown routes show home or redirect)");
  } finally { await b.close(); }

  // One finding per page and problem, naming every link or control that shows it (seven nav links with the same broken
  // Back are one bug). A click that changed nothing and a link that shows the same page are generic heuristics: candidates
  // to look at, never blocking.
  type Hit = { from: string; what: string[]; problem: string };
  const hits = new Map<string, Hit>();
  for (const c of checks) for (const p of c.problems) {
    const h = hits.get(`${c.from}\n${p}`);
    if (h) h.what.push(c.what); else hits.set(`${c.from}\n${p}`, { from: c.from, what: [c.what], problem: p });
  }
  const text = (h: Hit) => `${h.from} ${h.what.join(", ")}: ${h.problem}`;
  const found = [...hits.values()].filter((h) => !LOOK.has(h.problem)), candidates = [...hits.values()].filter((h) => LOOK.has(h.problem)).map(text);
  const { introduced, preexisting } = splitPreexisting(found.map(text), v.baseline ? readReport(v.baseline)?.blocking : undefined);
  const bugs: Bug[] = found.filter((h) => introduced.includes(text(h))).map((h): Bug => ({ page: h.from, width: WIDTH, theme: "light", title: `${h.what.join(", ")}: ${h.problem.split(":")[0]}`, evidence: h.problem, captures: [], verified: true, repro: [`open ${h.from}`, `click ${h.what[0]}`] }));
  const done = checks.filter((c) => !c.skipped).length;
  const r: Report = { version: 2, target: base, frozenAt, model: "", coverage: { done, total: checks.length, failed: checks.filter((c) => c.skipped && !c.skipped.startsWith("not checked")).length, deferred: checks.filter((c) => c.skipped?.startsWith("not checked")).length },
    captures: [], improvements: [], motion: [], bugs, notes, cost_usd: 0, blocking: introduced, preexisting, candidates, blocked: b.blocked() };
  writeFileSync(join(out, "report.json"), JSON.stringify(r, null, 2));
  const md = [`# Route check of ${base}`, "", `${checks.length} checks at ${WIDTH}px light, ${Math.round((Date.now() - t0) / 1000)} s`, "",
    introduced.length ? `## Blocking (${introduced.length})` : "## Blocking: none found", "", ...introduced.map((x) => `- ${x}`), "",
    ...(preexisting.length ? [`## Already on this base (${preexisting.length}): not this change's`, "", ...preexisting.map((x) => `- ${x}`), ""] : []),
    ...(candidates.length ? [`## To look at (${candidates.length}): not blocking`, "", "Controls a click didn't visibly change and links that show the same page; some do act (a copy, a download, a dialog the check can't see, an alias). Look before filing:", "", ...candidates.map((x) => `- ${x}`), ""] : []),
    ...(notes.length ? ["## Notes", "", ...notes.map((n) => `- ${n}`), ""] : []),
    ...(r.blocked.length ? [`## Blocked requests (${r.blocked.length})`, "", "The live-app guard refused these (the app's mode doesn't allow them):", "", ...r.blocked.map((x) => `- ${x.method} ${x.origin}${x.path} (from \`${x.page}\`)`), ""] : []),
    "## Checks (brand, links with Back, Forward and reload, controls)", "", ...checks.map((c) => `- ${c.from} ${c.what}: ${c.skipped ?? (c.problems.join("; ") || (c.to ? "renders" : "acts"))}`), ""];
  writeFileSync(join(out, "report.md"), md.join("\n"));
  console.log(`${join(out, "report.md")}: ${checks.length} checks, ${introduced.length} blocking, ${preexisting.length} already on this base, ${candidates.length} to look at, ${Math.round((Date.now() - t0) / 1000)} s`);
  // Nothing checked (the budget went on reading the pages, or every check failed) is no pass: the report says why.
  if (checks.length && !done) { console.error(`ui-review routes: none of the ${checks.length} checks ran; see ${join(out, "report.md")}`); return 2; }
  return introduced.length ? 1 : 0;
}
