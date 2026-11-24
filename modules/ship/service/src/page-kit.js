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
  const below = b.bottom + 6 + t.height <= vh || b.top - 6 - t.height < 0;
  tipEl.style.left = `${Math.max(8, Math.min(b.left + b.width / 2 - t.width / 2, vw - t.width - 8))}px`;
  tipEl.style.top = `${Math.max(4, below ? b.bottom + 6 : b.top - 6 - t.height)}px`;
};
addEventListener("keydown", (e) => { if (e.key === "Escape") closeHelp(); });
addEventListener("pointerdown", (e) => { if (tipFor && e.target !== tipFor.btn) closeHelp(); });
addEventListener("resize", closeHelp);
const help = (label, text, more = {}) => {
  const c = { text, ...more }, btn = h("button", { type: "button", className: "q", textContent: "?", ariaLabel: `About ${label}` });
  btn.setAttribute("aria-describedby", "tip"); btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("mouseenter", () => openHelp(btn, c));
  btn.addEventListener("mouseleave", () => { if (!tipPinned) closeHelp(); });
  btn.addEventListener("focus", () => openHelp(btn, c));
  btn.addEventListener("blur", closeHelp);
  btn.addEventListener("click", () => { if (tipFor?.btn === btn && tipPinned) closeHelp(); else { openHelp(btn, c); tipPinned = true; } });
  return more.bare ? btn : h("span", { className: "hd" }, label, btn);
};
// "3 hours ago" for an ISO time, or "" when there is none.
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!(s >= 0)) return ""; const [n, u] = s < 90 ? [0, ""] : s < 5400 ? [Math.round(s / 60), "minute"] : s < 172800 ? [Math.round(s / 3600), "hour"] : [Math.round(s / 86400), "day"]; return u ? `${n} ${u}${n === 1 ? "" : "s"} ago` : "just now"; };
// Handshake with the host, then the page's own first load.
const start = async (name, load) => {
  const init = await send("ui/initialize", { appInfo: { name, version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
  theme(init.hostContext);
  notify("ui/notifications/initialized", {});
  load();
};
