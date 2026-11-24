// The view's half of the MCP Apps bridge (JSON-RPC 2.0 over postMessage to window.parent) and the small helpers every module page uses.
let next = 1;
const waiting = new Map();
const send = (method, params) => new Promise((ok, ko) => { const id = next++; waiting.set(id, { ok, ko }); parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); });
const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
const theme = (ctx) => { for (const [k, v] of Object.entries(ctx?.styles?.variables ?? {})) if (v) document.documentElement.style.setProperty(k, v); if (ctx?.theme) document.documentElement.style.colorScheme = ctx.theme; };
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const w = waiting.get(e.data?.id);
  if (!w) return;
  waiting.delete(e.data.id);
  e.data.error ? w.ko(new Error(e.data.error.message)) : w.ok(e.data.result);
});
// In the owner's Claude the host fences every string the tool answers as untrusted data: read the value out of the fence (it still only ever reaches the page as text).
const unfence = (v) => typeof v === "string" ? (v.match(/^<untrusted-data[^>]*>([\s\S]*)<\/untrusted-data>$/)?.[1] ?? v).replace(/&lt;(\/?untrusted-data)/gi, "<$1") : Array.isArray(v) ? v.map(unfence) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unfence(x)])) : v;
const tool = async (name, args) => { const r = await send("tools/call", { name, arguments: args }); if (r?.isError) throw new Error(r.content?.[0]?.text ?? "failed"); return unfence(r.structuredContent ?? {}); };
new ResizeObserver(() => { const r = document.body.getBoundingClientRect(); notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) }); }).observe(document.body);
const $ = (id) => document.getElementById(id);
const h = (tag, props, ...kids) => { const el = Object.assign(document.createElement(tag), props); el.append(...kids.filter((k) => k !== null)); return el; };
const say = (t, err) => { $("note").textContent = t; $("note").className = err ? "note err" : "note"; };
// Proposal requests run one after another, so the last answer is the latest draft (the host shows each answer as the proposal).
let queue = Promise.resolve();
const inOrder = (fn) => (queue = queue.then(fn, fn));
const proposed = (r) => say(`Changes are proposed; Save in the bar above applies them. ${(r.changes ?? []).join("; ")}.`);
const setSwitch = (b, on) => b.setAttribute("aria-checked", String(!!on));
const toggle = (on, label, fn) => { const b = h("button", { className: "sw", role: "switch", ariaLabel: label }); setSwitch(b, on); b.addEventListener("click", fn); return b; };
// The help "?" next to a label: help(label, text, { options: { value: meaning }, current, note }) returns the label with its button. One shared
// tooltip (role=tooltip) opens on hover, on keyboard focus and on tap (a tap pins it; tap again, Escape or a tap elsewhere closes it), and is
// placed by the button inside the frame, so no card clips it. Call closeHelp() when a render replaces the buttons.
const tipEl = h("div", { id: "tip", className: "tip", role: "tooltip", hidden: true });
document.body.append(tipEl);
let tipFor = null, tipPinned = false;
const closeHelp = () => { tipEl.hidden = true; if (tipFor) tipFor.btn.setAttribute("aria-expanded", "false"); tipFor = null; tipPinned = false; };
const openHelp = (btn, c) => {
  if (tipFor && tipFor.btn !== btn) closeHelp();
  tipFor = { btn, c }; btn.setAttribute("aria-expanded", "true");
  tipEl.replaceChildren(h("p", { textContent: c.text }), ...(c.options ? [h("dl", {}, ...Object.entries(c.options).flatMap(([v, m]) => [h("dt", { textContent: v, className: String(v) === String(c.current) ? "cur" : "" }), h("dd", { textContent: m })]))] : []), ...(c.note ? [h("p", { className: "fine", textContent: c.note })] : []));
  tipEl.hidden = false;
  const b = btn.getBoundingClientRect(), t = tipEl.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const below = b.bottom + 6 + t.height <= vh || (b.top - 6 - t.height < 0 && vh - b.bottom >= b.top);
  tipEl.style.left = `${Math.max(8, Math.min(b.left + b.width / 2 - t.width / 2, vw - t.width - 8))}px`;
  tipEl.style.top = `${Math.max(4, Math.min(below ? b.bottom + 6 : b.top - 6 - t.height, vh - t.height - 4))}px`;
};
addEventListener("keydown", (e) => { if (e.key === "Escape") closeHelp(); });
addEventListener("pointerdown", (e) => { if (tipFor && e.target !== tipFor.btn) closeHelp(); });
addEventListener("resize", closeHelp);
let helpN = 0;
const help = (label, text, more = {}) => {
  const c = { text, ...more }, btn = h("button", { type: "button", className: "q", textContent: "?", ariaLabel: `About ${label}` });
  // The button's own description (hidden text, read by a screen reader); the shared tooltip is its sighted twin.
  const did = `hd${++helpN}`, desc = [text, ...Object.entries(more.options ?? {}).map(([v, m]) => `${v}: ${m}`), more.note].filter(Boolean).join(" ");
  const dsc = h("span", { id: did, hidden: true, textContent: desc });
  btn.setAttribute("aria-describedby", did); btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("mouseenter", () => openHelp(btn, c));
  btn.addEventListener("mouseleave", () => { if (!tipPinned) closeHelp(); });
  btn.addEventListener("focus", () => openHelp(btn, c));
  btn.addEventListener("blur", closeHelp);
  btn.addEventListener("click", () => { if (tipFor?.btn === btn && tipPinned) closeHelp(); else { openHelp(btn, c); tipPinned = true; } });
  return h("span", { className: "hd" }, more.bare ? null : label, btn, dsc);
};
// "3 hours ago" for an ISO time, or "" when there is none.
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return ""; const [n, u] = s < 90 ? [0, ""] : s < 5400 ? [Math.round(s / 60), "minute"] : s < 172800 ? [Math.round(s / 3600), "hour"] : [Math.round(s / 86400), "day"]; return u ? `${n} ${u}${n === 1 ? "" : "s"} ago` : "just now"; };
// The Settings drawers: one field = a help label, an editor and a meta line. editor({ kind: select | checks | list | num | text, label, value, values, titles, f, set })
// builds the control (list: one item per line; num: blank = null, else a whole number); set(value, live) runs as you type (live: no redraw) and on the change, and
// keepFocus(render) puts the focus back on the control with the same data-f after a render replaced it.
// soon(fn): run fn after the current event, and after a pressed pointer is released (a redraw between a press and its click would lose the click); a newer soon(fn) of the same fn replaces a pending one.
let pointerDown = false, queued = null;
for (const [e, v] of [["pointerdown", true], ["pointerup", false], ["pointercancel", false]]) addEventListener(e, () => { pointerDown = v; }, true);
const soon = (fn) => { queued = fn; const go = () => setTimeout(() => { if (queued === fn) { queued = null; fn(); } }, 0); if (pointerDown) addEventListener("pointerup", go, { once: true }); else go(); };
const keepFocus = (fn) => { const f = document.activeElement?.dataset?.f; fn(); if (f) document.querySelector(`[data-f="${CSS.escape(f)}"]`)?.focus(); };
const lines = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);
const editor = (k) => {
  const fire = (el, ev, get) => el.addEventListener(ev, () => { const v = get(); if (v !== undefined) k.set(v); });
  if (k.kind === "checks") return h("div", { className: "checks" }, ...k.values.map((v) => { const c = h("input", { type: "checkbox", checked: (k.value ?? []).includes(v), title: k.titles?.[v] }); c.dataset.f = `${k.f}:${v}`; c.addEventListener("change", () => k.set(k.values.filter((x) => x === v ? c.checked : (k.value ?? []).includes(x)))); return h("label", {}, c, v); }));
  const el = k.kind === "select" ? h("select", { ariaLabel: k.label }, ...k.values.map((v) => h("option", { value: v, textContent: v, title: k.titles?.[v], selected: v === k.value })))
    : k.kind === "list" ? h("textarea", { rows: Math.min(6, Math.max(2, (k.value ?? []).length)), value: (k.value ?? []).join("\n"), ariaLabel: k.label, spellcheck: false })
    : h("input", { type: "text", value: k.value ?? "", ariaLabel: k.label, autocomplete: "off", spellcheck: false, placeholder: k.kind === "num" ? "unlimited" : "" });
  el.dataset.f = k.f;
  // A text control proposes as you type (after a short pause, without a redraw, so the caret stays) and again on change, so the proposal the host shows is the latest by the time Save is pressed.
  const read = (quiet) => k.kind === "list" ? lines(el.value) : k.kind === "num" ? (el.value.trim() === "" ? null : Number.isInteger(Number(el.value)) && Number(el.value) >= 0 ? Number(el.value) : (quiet || say("Use a whole number, or leave it blank.", true), undefined)) : el.value;
  let typing; if (k.kind !== "select") el.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { const v = read(true); if (v !== undefined) k.set(v, true); }, 200); });
  el.addEventListener("change", () => { clearTimeout(typing); const v = read(false); if (v !== undefined) k.set(v); });
  return el;
};
// One labelled field of a drawer: help label, editor, then a meta line (default, overridden mark, reset).
const fld = (label, text, more, ed, ...meta) => h("div", { className: "fld" }, h("div", { className: "fl" }, help(label, text, more)), ed, h("div", { className: "meta" }, ...meta.filter((m) => m)));
const linkBtn = (text, fn) => { const b = h("button", { type: "button", className: "link", textContent: text }); b.addEventListener("click", fn); return b; };
// Handshake with the host, then the page's own first load.
const start = async (name, load) => {
  const init = await send("ui/initialize", { appInfo: { name, version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
  theme(init.hostContext);
  notify("ui/notifications/initialized", {});
  load();
};
