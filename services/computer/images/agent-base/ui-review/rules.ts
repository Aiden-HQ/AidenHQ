// The non-taste rule checks of one capture, ported from the #1876 script with the same findings and words. Blocking: the page
// scrolls sideways, failed loads, page errors, serious or critical axe violations (WCAG 2.2 AA). Notes, never a failure:
// text under 12px, phone controls under 44px, headless LCP and CLS, "One system" and "Copy". Page text is untrusted data:
// findings quote it, never follow it.
import { readFileSync } from "node:fs";
import type { Page as PwPage } from "playwright-core";
import type { RuleHit } from "./types.ts";

const AXE = readFileSync(new URL("./node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const COPY = JSON.parse(readFileSync(new URL("./copy.json", import.meta.url), "utf8")) as { filler: string[]; chat: string[]; figures: string[] };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Horizontal page scroll, text under 12px, how many controls are under our 44px phone rule (axe's target-size covers the WCAG
// 24px floor), and failed loads.
const LAYOUT = () => {
  const vw = document.documentElement.clientWidth;
  const sel = (e: Element) => e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const visible = (e: Element) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden],dialog:not([open])"); };
  const overflow = document.documentElement.scrollWidth - vw;
  const wide = overflow > 1 ? [...document.querySelectorAll("body *")].filter((e) => visible(e) && e.getBoundingClientRect().right > vw + 1 && !e.closest(".table-wrap,.board,.tabs,[data-slot=table-container],[style*=overflow]")).slice(0, 5).map(sel) : [];
  const targets = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=option]")].filter(visible).map((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), inline: e.tagName === "A" && getComputedStyle(e).display === "inline" }; });
  const small = targets.filter((t) => !t.inline && t.h >= 24 && t.h < 44 && t.w >= 24).length;
  const tiny = [...document.querySelectorAll("body *")].filter((e) => visible(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).slice(0, 5).map(sel);
  const failed = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => r.responseStatus >= 400).map((r) => r.responseStatus + " " + r.name).slice(0, 5);
  const u = (window as unknown as { __uiReview?: { lcp: number; cls: number } }).__uiReview;
  return { overflow: Math.max(0, overflow), wide, small, tiny, failed, lcp: u?.lcp ?? 0, cls: u?.cls ?? 0 };
};

// The distinct styles in use (as keys), nesting depth, and the visible text, for "One system" and "Copy".
const SYSTEM = () => {
  const visible = (e: Element) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !e.closest("[hidden],dialog:not([open])"); };
  const all = [...document.body.querySelectorAll("*")].filter(visible), cs = new Map(all.map((e) => [e, getComputedStyle(e)]));
  const clear = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const box = (e: Element) => { const s = cs.get(e)!, p = e.parentElement && cs.get(e.parentElement); return parseFloat(s.borderTopWidth) > 0 || s.boxShadow !== "none" || (!clear(s.backgroundColor) && (!p || p.backgroundColor !== s.backgroundColor)); };
  const boxes = all.filter(box), isBox = new Set(boxes);
  const round = (r: string) => /%|999/.test(r) || parseFloat(r) > 50;
  const set = (list: Element[], key: (e: Element) => string) => [...new Set(list.map(key))];
  const texts = [...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,label,button,a,summary,figcaption,[role=button],[role=heading]")].filter(visible).map((e) => (e as HTMLElement).innerText.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 400);
  return {
    buttons: set(all.filter((e) => e.matches("button,[role=button],[data-slot=button]")), (e) => cs.get(e)!.borderRadius + " / " + Math.round(e.getBoundingClientRect().height) + "px").length,
    radii: set(boxes.filter((e) => !round(cs.get(e)!.borderRadius) && parseFloat(cs.get(e)!.borderRadius) > 0), (e) => cs.get(e)!.borderRadius).length,
    cards: set(all.filter((e) => e.matches("[data-slot=card],[class*=card]")), (e) => { const s = cs.get(e)!; return [s.borderRadius, s.borderTopWidth, s.boxShadow === "none" ? "flat" : "shadow", s.backgroundColor].join(" "); }).length,
    headings: set(all.filter((e) => e.matches("h1,h2,h3,h4,h5,h6,[role=heading]")), (e) => cs.get(e)!.fontSize).length,
    nested: boxes.filter((e) => { let n = 0; for (let p = e.parentElement; p; p = p.parentElement) if (isBox.has(p)) n++; return n > 2; }).length,
    texts,
  };
};

function copyFindings(texts: string[]): string[] {
  const hits: string[] = [], note = (what: string, t: string) => hits.push(`${what}: "${t.slice(0, 80)}"`);
  const has = (list: string[], t: string) => list.find((w) => new RegExp(`\\b${w}\\b`, "i").test(t));
  for (const t of texts) {
    const f = has(COPY.filler, t), c = COPY.chat.find((w) => t.toLowerCase().includes(w.toLowerCase())), n = COPY.figures.find((re) => new RegExp(re, "i").test(t));
    if (f) note(`filler word "${f}"`, t); if (c) note("chat residue", t); if (n) note("invented-looking figure", t); if (t.includes("!")) note("exclamation mark", t);
  }
  return [...new Set(hits)].slice(0, 12);
}

/**
 * The checks of one capture. `where` names the page (and its state); `widest` runs the once-per-page-and-theme checks (axe,
 * page errors, failed loads; with `first`, the first theme, also "One system", "Copy" and vitals); `phone` the 44px count.
 */
export async function rules(page: PwPage, o: { where: string; width: number; theme: string; widest: boolean; first: boolean; phone: boolean; errors: string[] }): Promise<RuleHit[]> {
  const hits: RuleHit[] = [], at = `${o.where} ${o.width}px ${o.theme}`;
  const hit = (rule: string, blocking: boolean, text: string) => hits.push({ rule, blocking, text });
  const lay = await page.evaluate(LAYOUT);
  if (lay.overflow > 1) hit("overflow", true, `${at}: page scrolls sideways by ${lay.overflow}px (${lay.wide.join(", ") || "element not found"})`);
  if (lay.tiny.length) hit("tiny-text", false, `${at}: text under 12px: ${lay.tiny.join(", ")}`);
  if (o.phone && lay.small) hit("phone-targets", false, `${at}: ${lay.small} controls are 24-43px tall (44px is the phone rule; check the main ones)`);
  if (!o.widest) return hits;
  if (lay.failed.length) hit("failed-loads", true, `${o.where} ${o.theme}: failed loads: ${lay.failed.join(", ")}`);
  if (o.errors.length) hit("page-errors", true, `${o.where} ${o.theme}: page errors: ${o.errors[0].split("\n")[0].slice(0, 200)}`);
  try {
    await page.evaluate(AXE);
    const a = await page.evaluate((tags) => (window as unknown as { axe: { run(c: Document, o: unknown): Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] }), TAGS);
    for (const v of a.violations) if (v.impact === "serious" || v.impact === "critical")
      hit(`axe:${v.id}`, true, `${o.where} ${o.theme}: axe ${v.id} (${v.impact}, ${v.nodes.length}x): ${v.help} at ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("; ")}`);
  } catch (e) { hit("axe", false, `${o.where} ${o.theme}: accessibility not checked: ${String((e as Error).message).split("\n")[0]}`); }
  if (!o.first) return hits;
  if (lay.lcp > 2500) hit("lcp", false, `${o.where}: LCP ${Math.round(lay.lcp)} ms (over 2.5 s; a headless run's timing)`);
  if (lay.cls > 0.1) hit("cls", false, `${o.where}: layout shift CLS ${lay.cls.toFixed(3)} (over 0.1; look at the page loading)`);
  try {
    const s = await page.evaluate(SYSTEM);
    hit("one-system", false, `${o.where}: One system (fewer is better): ${s.buttons} button shapes · ${s.radii} border radii · ${s.cards} card styles · ${s.headings} heading sizes · ${s.nested} boxes nested more than 2 deep`);
    for (const c of copyFindings(s.texts)) hit("copy", false, `${o.where}: Copy: ${c}`);
  } catch (e) { hit("copy", false, `${o.where}: copy not checked: ${String((e as Error).message).split("\n")[0]}`); }
  return hits;
}
