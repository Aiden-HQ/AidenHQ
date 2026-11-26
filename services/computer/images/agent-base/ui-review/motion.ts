// Motion measurements, never from video: computed transitions, running animations, :hover/:active rules, @keyframes, long animation
// frames, and the layout shift while controls are hovered (and, on a local build only, clicked). Lessons from the spike
// (taste/motion.mjs): an animation held by fill-mode after it finished is not motion (filter by playState), and a stylesheet's
// :active and :hover rules say more than the resting state does.
import type { Page as PwPage } from "playwright-core";
import type { Motion } from "./types.ts";

const SETTLE = async () => {
  const sel = (e: Element) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const ms = (d: string) => (d.endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000);
  // Transitions: one row per property, duration and easing; the three lists of a computed transition run in parallel.
  const groups = new Map<string, { property: string; duration: number; easing: string; n: number; ex: Set<string> }>();
  for (const e of document.querySelectorAll("body *")) {
    const s = getComputedStyle(e);
    const durs = s.transitionDuration.split(/,\s*(?![^(]*\))/), props = s.transitionProperty.split(/,\s*/), eases = s.transitionTimingFunction.split(/,\s*(?![^(]*\))/);
    props.forEach((property, i) => {
      const duration = Math.round(ms(durs[i % durs.length] ?? "0s"));
      if (!duration) return;
      const easing = eases[i % eases.length] ?? "ease";
      const k = `${property}|${duration}|${easing}`;
      const g = groups.get(k) ?? groups.set(k, { property, duration, easing, n: 0, ex: new Set() }).get(k)!;
      g.n++;
      if (g.ex.size < 3) g.ex.add(sel(e));
    });
  }
  const transitions = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 20).map((g) => ({ property: g.property, duration: g.duration, easing: g.easing, n: g.n, examples: [...g.ex] }));
  // Only what is running now: a finished animation held by fill-mode stays in getAnimations() and is not motion.
  const animations = document.getAnimations().filter((a) => a.playState === "running").slice(0, 25).map((a) => {
    const t = a.effect?.getTiming?.() ?? ({} as OptionalEffectTiming), el = (a.effect as KeyframeEffect | null)?.target;
    return {
      name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.constructor.name,
      target: el ? sel(el) : "", duration: Number(t.duration) || 0, easing: String(t.easing ?? "linear"), iterations: Number(t.iterations ?? 1), playState: a.playState,
    };
  });
  // Rules from same-origin stylesheets (a cross-origin sheet throws on cssRules and is skipped).
  const hover: string[] = [], active: string[] = [], keyframes: { name: string; css: string }[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSKeyframesRule) { if (keyframes.length < 20) keyframes.push({ name: r.name, css: r.cssText.slice(0, 600) }); }
      else if (r instanceof CSSStyleRule) {
        const text = r.cssText.slice(0, 240);
        if (r.selectorText.includes(":hover") && hover.length < 30) hover.push(text);
        if (r.selectorText.includes(":active") && active.length < 30) active.push(text);
      } else if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
  // Long animation frames reach only a PerformanceObserver; a buffered one replays those since the page loaded.
  const longFrames: number[] = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longFrames.push(Math.round(e.duration)); });
    po.observe({ type: "long-animation-frame", buffered: true });
    await new Promise((ok) => setTimeout(ok, 100));
    po.disconnect();
  } catch { /* not supported */ }
  longFrames.splice(20);
  return { transitions, animations, hover, active, keyframes, longFrames };
};

const isLocal = (url: string) => { try { return ["127.0.0.1", "localhost"].includes(new URL(url).hostname); } catch { return false; } };
// Clicks are opt-in: the caller passes click only for a build it runs itself and only while the page is on a loopback address (Phase 1: a local build, 127.0.0.1 or localhost; a redirect elsewhere ends them).
// A click may still change data, so controls named like a write are never clicked.
const RISKY = /delete|remove|destroy|pay|purchase|buy|submit|confirm|send|reset|sign out|log ?out|archive|cancel subscription/i;

export async function measureMotion(page: PwPage, opts: { click?: boolean } = {}): Promise<Motion> {
  const base = (await page.evaluate(SETTLE)) as Omit<Motion, "shifts">;
  await page.evaluate(() => {
    const w = window as unknown as { __shift?: number };
    w.__shift = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number })[]) w.__shift! += e.value; }).observe({ type: "layout-shift" });
  }).catch(() => {});
  const shifts: number[] = [];
  const read = () => page.evaluate(() => { const w = window as unknown as { __shift?: number }; const v = w.__shift ?? 0; w.__shift = 0; return v; });
  const controls = await page.locator("button, [role=button], a[href]").all();
  let tried = 0;
  for (const c of controls) {
    if (tried >= 5) break;
    const box = await c.boundingBox().catch(() => null);
    if (!box || box.y > (page.viewportSize()?.height ?? 900) || box.y < 0) continue;
    tried++;
    await read();
    await c.hover({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(150);
    const hovered = await read();
    if (hovered > 0) shifts.push(Math.round(hovered * 10000) / 10000);
    // Clicks only when the caller asked for them, only on buttons (a link would navigate), never on a control named like a write.
    const label = ((await c.innerText().catch(() => "")) || (await c.getAttribute("aria-label").catch(() => "")) || "").trim();
    if (opts.click && isLocal(page.url()) && (await c.evaluate((e) => e.tagName === "BUTTON" || e.getAttribute("role") === "button").catch(() => false)) && !RISKY.test(label)) {
      await c.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(250);
      const clicked = await read();
      if (clicked > 0) shifts.push(Math.round(clicked * 10000) / 10000);
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  await page.mouse.move(0, 0).catch(() => {});
  return { ...base, shifts };
}
