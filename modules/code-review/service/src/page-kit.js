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
// A link: the frame can't navigate, so a click asks the host (ui/open-link) to open it in a new tab. Only http(s) addresses are links; any other is plain text.
const link = (url, text) => {
  if (!/^https?:\/\//i.test(String(url ?? ""))) return h("span", { textContent: text ?? String(url ?? "") });
  const a = h("a", { href: url, textContent: text ?? url, className: "lnk", rel: "noopener noreferrer" });
  const open = (e) => { e.preventDefault(); send("ui/open-link", { url }).catch((err) => say(err.message, true)); };
  a.addEventListener("click", open); a.addEventListener("auxclick", open);
  return a;
};
// A small safe markdown: headings, lists, fenced code, bold, italics, `code` and [text](http…) links. Built from text nodes only, so nothing in the source is ever HTML; a table or quote is shown as preformatted text.
const mdInline = (text) => {
  const out = [], re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(text.slice(i, m.index));
    out.push(m[1] !== undefined ? h("code", { textContent: m[1] }) : m[2] !== undefined ? h("b", { textContent: m[2] }) : m[3] !== undefined ? h("i", { textContent: m[3] }) : link(m[5], m[4]));
    i = re.lastIndex;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
};
const md = (src) => {
  const root = h("div", { className: "md" }), lines = String(src ?? "").replace(/\r/g, "").split("\n");
  let para = [], list = null, i = 0;
  const flush = () => { if (para.length) root.append(h("p", {}, ...mdInline(para.join(" ")))); para = []; list = null; };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const code = []; for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]); i++; root.append(h("pre", { textContent: code.join("\n") })); continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(l), li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
    if (hd) { flush(); root.append(h(`h${Math.min(6, hd[1].length + 2)}`, {}, ...mdInline(hd[2]))); }
    else if (li) { const kind = /\d/.test(li[2]) ? "ol" : "ul"; if (!list || list.kind !== kind) { para.length && flush(); list = { kind, el: h(kind, {}) }; root.append(list.el); } list.el.append(h("li", { style: li[1].length ? `margin-left:${Math.min(6, li[1].length / 2) * 14}px` : "" }, ...mdInline(li[3]))); }
    else if (/^\s*\|/.test(l) || /^>/.test(l)) { flush(); const rows = []; for (; i < lines.length && (/^\s*\|/.test(lines[i]) || /^>/.test(lines[i])); i++) rows.push(lines[i]); root.append(h("pre", { textContent: rows.join("\n") })); continue; }
    else if (!l.trim()) flush();
    else { list = null; para.push(l.trim()); }
    i++;
  }
  flush();
  return root;
};
// Handshake with the host, then the page's own first load. The host context says where the page was opened (hostContext.route: the part of the address after the page's own).
const start = async (name, load) => {
  const init = await send("ui/initialize", { appInfo: { name, version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
  theme(init.hostContext);
  notify("ui/notifications/initialized", {});
  load(init.hostContext);
};
