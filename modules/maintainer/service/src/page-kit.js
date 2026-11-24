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
const proposed = (r) => say(`Proposed: ${(r.changes ?? []).join("; ")}. Save it in the bar above.`);
const setSwitch = (b, on) => b.setAttribute("aria-checked", String(!!on));
const toggle = (on, label, fn) => { const b = h("button", { className: "sw", role: "switch", ariaLabel: label }); setSwitch(b, on); b.addEventListener("click", fn); return b; };
// Handshake with the host, then the page's own first load.
const start = async (name, load) => {
  const init = await send("ui/initialize", { appInfo: { name, version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
  theme(init.hostContext);
  notify("ui/notifications/initialized", {});
  load();
};
