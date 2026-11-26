// Design measurements: what a page's numbers say about its consistency (type, colour, radius, spacing, alignment, CTAs, contrast).
// The engine measures; it decides nothing about taste (the review prompts and rules do). The in-page script is ported from the spike's
// stats (design/cap.mjs) and #1876's "One system" check.
import type { Page as PwPage } from "playwright-core";
import type { Capture, Measures } from "./types.ts";

type Component = keyof Measures["signatures"];

/** Runs in the page: one pass over the visible elements of the first three viewports. */
const MEASURE = () => {
  const vw = innerWidth, vh = innerHeight;
  // Any CSS colour (rgb, oklch, color(), color-mix) as [r, g, b] + alpha, through a canvas.
  const px = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  px.canvas.width = px.canvas.height = 1;
  const cache = new Map<string, { c: number[]; a: number } | null>();
  const parse = (s: string) => {
    if (!s || s === "transparent") return s ? { c: [0, 0, 0], a: 0 } : null;
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
    px.clearRect(0, 0, 1, 1);
    px.fillStyle = "#000";
    px.fillStyle = s;
    px.fillRect(0, 0, 1, 1);
    const d = px.getImageData(0, 0, 1, 1).data;
    const out = { c: [d[0], d[1], d[2]], a: d[3] / 255 };
    cache.set(s, out);
    return out;
  };
  const over = (fg: { c: number[]; a: number }, bg: number[]) => fg.c.map((v, i) => Math.round(v * fg.a + bg[i] * (1 - fg.a)));
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => { const l1 = lum(a) + 0.05, l2 = lum(b) + 0.05; return Math.max(l1, l2) / Math.min(l1, l2); };
  const darkCanvas = matchMedia("(prefers-color-scheme: dark)").matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme);
  const canvas = darkCanvas ? [18, 18, 18] : [255, 255, 255];
  // The colour behind an element; null when a background image or gradient sits behind it (the colour is then unknown).
  const bgOf = (el: Element): number[] | null => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      const p = parse(cs.backgroundColor);
      if (p && p.a > 0.5) return p.c;
    }
    return canvas;
  };
  const all = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0 && r.bottom > 0 && r.top < vh * 3;
  });
  const cs = new Map(all.map((e) => [e, getComputedStyle(e)]));
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const sel = (e: Element) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");

  const textEls = all.filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim()));
  const fonts = new Map<string, number>(), colours = new Map<string, number>();
  let contrastFails = 0, checked = 0;
  for (const e of textEls) {
    const s = cs.get(e)!;
    count(fonts, `${Math.round(parseFloat(s.fontSize) * 2) / 2}|${s.fontWeight}`);
    count(colours, s.color);
    const fg = parse(s.color), bg = bgOf(e);
    if (fg && bg && fg.a > 0 && checked < 400) {
      checked++;
      const big = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
      if (ratio(over(fg, bg), bg) < (big ? 3 : 4.5) * 0.999) contrastFails++;
    }
  }
  const clear = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const isBox = (e: Element) => {
    const s = cs.get(e)!, p = e.parentElement && cs.get(e.parentElement);
    return parseFloat(s.borderTopWidth) > 0 || s.boxShadow !== "none" || (!clear(s.backgroundColor) && (!p || p.backgroundColor !== s.backgroundColor));
  };
  const boxes = all.filter(isBox);
  const radii = new Map<string, number>(), shadows = new Map<string, number>();
  const spacing = new Set<number>();
  for (const e of all) {
    const s = cs.get(e)!;
    const b = parse(s.backgroundColor);
    if (b && b.a > 0.1) count(colours, s.backgroundColor);
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none") count(colours, s.borderTopColor);
    if (s.borderTopLeftRadius !== "0px") count(radii, s.borderTopLeftRadius);
    if (s.boxShadow !== "none") count(shadows, s.boxShadow.slice(0, 80));
    for (const p of ["marginTop", "marginBottom", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "rowGap", "columnGap"] as const) {
      const v = parseFloat(s[p]);
      if (v > 0 && isFinite(v)) spacing.add(Math.round(v * 2) / 2);
    }
  }
  const values = [...spacing].sort((a, b) => a - b);
  const offScale = values.filter((v) => v % 4 !== 0 && !(v < 8 && v === 2));

  // Left edges 1-3px apart between boxes and text blocks that are not nested in each other: misalignments the eye reads as a mistake.
  const blocks = all.filter((e) => {
    const s = cs.get(e)!, r = e.getBoundingClientRect();
    return !s.display.startsWith("inline") && r.width >= 48 && r.height >= 16 && (isBox(e) || textEls.includes(e));
  }).map((e) => ({ e, left: e.getBoundingClientRect().left })).sort((a, b) => a.left - b.left);
  const nearMisses: { a: string; b: string; dx: number }[] = [];
  for (let i = 0; i < blocks.length && nearMisses.length < 10; i++) {
    for (let j = i + 1; j < blocks.length && blocks[j].left - blocks[i].left <= 3; j++) {
      const dx = Math.round((blocks[j].left - blocks[i].left) * 10) / 10;
      if (dx < 1 || blocks[i].e.contains(blocks[j].e) || blocks[j].e.contains(blocks[i].e)) continue;
      nearMisses.push({ a: sel(blocks[i].e), b: sel(blocks[j].e), dx });
      if (nearMisses.length >= 10) break;
    }
  }

  // Main content width: the extent of the text, not the container (a max-width app on a 2560 screen shows here).
  let minL = 1e9, maxR = 0;
  for (const e of textEls) { const r = e.getBoundingClientRect(); if (r.left >= -5 && r.right <= vw + 5 && r.width < vw) { minL = Math.min(minL, r.left); maxR = Math.max(maxR, r.right); } }
  const content = { width: maxR > minL ? Math.round(maxR - minL) : 0, viewport: vw };

  const pageBg = bgOf(document.body) ?? canvas;
  const ctas = all.filter((e) => e.matches("button,[role=button],[data-slot=button],input[type=submit],a[class*=btn],a[class*=button],a[class*=Button]") && e.getBoundingClientRect().top < vh)
    .map((e) => {
      const s = cs.get(e)!, r = e.getBoundingClientRect(), bg = parse(s.backgroundColor), fg = parse(s.color);
      const filled = !!(bg && bg.a > 0.5 && ratio(over(bg, pageBg), pageBg) > 1.05);
      return { label: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").trim().slice(0, 30), filled, contrast: Math.round(ratio(filled ? over(bg!, pageBg) : fg ? over(fg, pageBg) : [0, 0, 0], pageBg) * 100) / 100, area: Math.round(r.width * r.height) };
    }).sort((a, b) => b.area - a.area).slice(0, 8);

  const set = (list: Element[], key: (e: Element) => string) => [...new Set(list.map(key))].slice(0, 12);
  const h = (e: Element) => Math.round(e.getBoundingClientRect().height);
  const signatures = {
    button: set(all.filter((e) => e.matches("button,[role=button],[data-slot=button]")), (e) => `h${h(e)} r${cs.get(e)!.borderTopLeftRadius} fs${cs.get(e)!.fontSize}`),
    card: set(all.filter((e) => e.matches("[data-slot=card],[class*=card],[class*=Card]")), (e) => { const s = cs.get(e)!; return `r${s.borderTopLeftRadius} b${s.borderTopWidth} ${s.boxShadow === "none" ? "flat" : "shadow"} ${s.backgroundColor}`; }),
    heading: set(all.filter((e) => e.matches("h1,h2,h3,h4,h5,h6,[role=heading]")), (e) => `${e.tagName.toLowerCase()} ${cs.get(e)!.fontSize}/${cs.get(e)!.fontWeight}`),
    input: set(all.filter((e) => e.matches("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea")), (e) => `h${h(e)} r${cs.get(e)!.borderTopLeftRadius}`),
  };
  return {
    fonts: top(fonts, 20).map(([k, n]) => { const [size, weight] = k.split("|"); return { size: +size, weight: +weight, n }; }),
    colours: top(colours, 40).map(([value, n]) => ({ value, n })),
    radii: top(radii, 8).map(([k]) => k), shadows: top(shadows, 6).map(([k]) => k),
    spacing: { values, offScale }, nearMisses, content, ctas, contrastFails, signatures,
  };
};

export async function measurePage(page: PwPage): Promise<Measures> {
  return page.evaluate(MEASURE) as Promise<Measures>;
}

/** Cross-page consistency: components whose look differs between pages, compared within one width, theme and state (a responsive
 *  button differs between 390 and 1512 by design). A variant that is on every page is the system's own (primary and secondary
 *  buttons); a variant on only some pages is the inconsistency the review looks at. */
export function crossPage(caps: Capture[]): { component: string; variants: { signature: string; pages: string[] }[] }[] {
  const out: { component: string; variants: { signature: string; pages: string[] }[] }[] = [];
  const groups = new Map<string, Capture[]>();
  for (const c of caps) { const k = `${c.width} ${c.theme} ${c.state}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
  for (const [group, list] of groups) {
    for (const component of ["button", "card", "heading", "input"] as Component[]) {
      const by = new Map<string, Set<string>>();
      for (const c of list) for (const s of c.measures.signatures[component]) (by.get(s) ?? by.set(s, new Set()).get(s)!).add(c.page);
      // Pages that show the component at all: a page without any input is not "missing" the input signature.
      const showing = new Set(list.filter((c) => c.measures.signatures[component].length).map((c) => c.page));
      if (by.size < 2 || showing.size < 2 || ![...by.values()].some((p) => p.size < showing.size)) continue;
      out.push({ component: `${component} (${group})`, variants: [...by.entries()].map(([signature, pages]) => ({ signature, pages: [...pages] })).sort((a, b) => b.pages.length - a.pages.length) });
    }
  }
  return out;
}
