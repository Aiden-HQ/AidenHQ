// The design system's colour tokens meet WCAG AA in every palette, light and dark, and the catalog uses only classes
// components.css defines. (The catalog's rendering is checked in a browser with ui-review; see the README.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../../modules/core/design-system/", import.meta.url);
const tokens = readFileSync(new URL("tokens.css", dir), "utf8");
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Every rule block's hex custom properties, keyed by selector (media-wrapped dark blocks included). */
function blocks() {
  const out = {};
  for (const m of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split("\n").pop().trim();
    for (const [, k, v] of m[2].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)) (out[sel] ??= {})[k] = v;
  }
  return out;
}

test("every palette in light and dark passes AA for text, controls and focus", () => {
  const b = blocks();
  const pal = (p) => (p === "neutral" ? ":root" : `:root[data-palette="${p}"]`);
  let checked = 0;
  for (const p of ["neutral", "warm", "contrast", "data"]) {
    for (const [mode, sel] of [["light", pal(p)], ["dark", `${pal(p)}[data-theme="dark"]`], ["dark (system)", `${pal(p)}:not([data-theme="light"])`]]) {
      const t = b[sel];
      assert.ok(t?.["--text"], `${p} ${mode}: no colour block ${sel}`);
      const need = (fg, bg, min) => { const r = ratio(t[fg], t[bg]); assert.ok(r >= min, `${p} ${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}`); checked++; };
      for (const bg of ["--bg", "--surface", "--surface-2"]) for (const fg of ["--text", "--text-muted", "--accent-ink", "--ok", "--warn", "--danger", "--info"]) need(fg, bg, 4.5);
      for (const k of ["accent", "ok", "warn", "danger", "info"]) need(k === "accent" ? "--accent-ink" : `--${k}`, `--${k}-soft`, 4.5);
      need("--accent-text", "--accent", 4.5);
      for (const k of ["ok", "warn", "danger", "info"]) need(`--${k}-solid-text`, `--${k}-solid`, 4.5);
      for (const bg of ["--bg", "--surface"]) { need("--line-strong", bg, 3); need("--focus", bg, 3); }
      for (let i = 1; i <= 6; i++) need(`--chart-${i}`, "--surface", 3);
    }
  }
  assert.equal(checked, 492);
});

test("the catalog and the app starter use only classes the kit defines", () => {
  const css = readFileSync(new URL("components.css", dir), "utf8");
  const defined = new Set([...css.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]));
  const catalogOnly = new Set(["swatches", "swatch", "spacing", "demo-frame", "toc", "optional", "count", "spacer", "actions", "pages", "when", "current", "ok", "warn", "danger", "up", "down", "summary-value"]);
  for (const f of [new URL("catalog.html", dir), new URL("../templates/app/server.mjs", dir)]) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(/class="([^"$]+)"/g))
      for (const c of m[1].split(/\s+/).filter((c) => c && !c.includes("{")))
        assert.ok(defined.has(c) || catalogOnly.has(c), `${f.pathname.split("/").pop()}: class "${c}" isn't in components.css`);
  }
});
