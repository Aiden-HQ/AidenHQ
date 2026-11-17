// The design system's colour tokens meet WCAG AA in every palette, light and dark,
// and the shadcn theme maps onto tokens that exist. (Rendering is checked in a browser with ui-review.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../modules/apps-platform/design-system/", import.meta.url);
const tokens = readFileSync(new URL("tokens.css", dir), "utf8");
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Every rule block's hex custom properties, keyed by selector (media-wrapped dark blocks included). */
function blocks(css = tokens) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

test("every theme preset passes AA in light and dark, over the tokens it doesn't set", () => {
  const base = blocks();
  const presets = readdirSync(new URL("presets/", dir)).filter((f) => f.endsWith(".css"));
  assert.ok(presets.length >= 8, "the curated presets are there");
  for (const f of presets) {
    const name = f.replace(/\.css$/, "");
    const b = blocks(readFileSync(new URL(`presets/${f}`, dir), "utf8"));
    const sel = `:root[data-palette="${name}"]`;
    assert.ok(b[sel]?.["--accent"], `${f}: no light block ${sel}`);
    // Loaded after tokens.css: the preset's light block overrides the base dark one, and its dark blocks override both.
    for (const [mode, t] of [
      ["light", { ...base[":root"], ...b[sel] }],
      ["dark", { ...base[":root"], ...base[':root[data-theme="dark"]'], ...b[sel], ...b[`${sel}[data-theme="dark"]`] }],
      ["dark (system)", { ...base[":root"], ...base[':root:not([data-theme="light"])'], ...b[sel], ...b[`${sel}:not([data-theme="light"])`] }],
    ]) {
      const need = (fg, bg, min) => { const r = ratio(t[fg], t[bg]); assert.ok(r >= min, `${name} ${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}`); };
      for (const bg of ["--bg", "--surface", "--surface-2"]) for (const fg of ["--text", "--text-muted", "--accent-ink", "--ok", "--warn", "--danger", "--info"]) need(fg, bg, 4.5);
      for (const k of ["accent", "ok", "warn", "danger", "info"]) need(k === "accent" ? "--accent-ink" : `--${k}`, `--${k}-soft`, 4.5);
      need("--accent-text", "--accent", 4.5);
      for (const bg of ["--bg", "--surface"]) { need("--line-strong", bg, 3); need("--focus", bg, 3); }
      for (let i = 1; i <= 6; i++) need(`--chart-${i}`, "--surface", 3);
      if (t["--accent-2"]) need("--accent-text", "--accent-2", 4.5);
      if (t["--sidebar-bg"]) for (const [fg, bg] of [["--sidebar-text", "--sidebar-bg"], ["--sidebar-muted", "--sidebar-bg"], ["--sidebar-text-strong", "--sidebar-hover"]]) need(fg, bg, 4.5);
    }
  }
});

test("the default palette's deep sidebar and primary gradient are AA in light and dark", () => {
  const b = blocks();
  const light = { ...b[":root"], ...b[':root[data-palette="neutral"]'] };
  for (const [mode, t] of [["light", light], ["dark (system)", { ...light, ...b[':root[data-palette="neutral"]:not([data-theme="light"])'] }], ["dark", { ...light, ...b[':root[data-palette="neutral"][data-theme="dark"]'] }]]) {
    for (const [fg, bg] of [["--sidebar-text", "--sidebar-bg"], ["--sidebar-muted", "--sidebar-bg"], ["--sidebar-text-strong", "--sidebar-hover"], ["--accent-text", "--accent-2"], ["--accent-text", "--accent"]]) {
      assert.ok(t[fg] && t[bg], `${mode}: ${fg} or ${bg} missing`);
      assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${mode}: ${fg} on ${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
    }
  }
});

test("the shadcn theme reads only variables that tokens.css or the theme itself defines", () => {
  const theme = readFileSync(new URL("shadcn.css", dir), "utf8");
  const defined = new Set([...`${tokens}\n${theme}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const read = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(read.length > 40);
  for (const v of read) assert.ok(defined.has(v), `shadcn.css reads ${v}, which nothing defines`);
  // Every shadcn colour the starter's components use has a Tailwind colour.
  const ui = new URL("../starter/src/components/ui/", dir);
  const colours = new Set([...theme.matchAll(/--color-([\w-]+):/g)].map((m) => m[1]));
  for (const f of readdirSync(ui)) {
    const src = readFileSync(new URL(f, ui), "utf8");
    for (const m of src.matchAll(/\b(?:bg|text|border|ring|outline|fill|stroke)-((?:sidebar-)?(?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|border|input|ring|sidebar)(?:-foreground|-accent|-border|-ring|-primary)*)\b/g))
      assert.ok(colours.has(m[1]), `${f} uses ${m[0]}, which has no --color-${m[1]} in shadcn.css`);
  }
});
