// App starter: a dependency-free Node server that renders HTML on the server and uses the AidenHQ design system
// (public/design-system/, vendored unchanged). It shows the patterns every app needs: the shell, a page header, filters that
// apply on change and update the results in place (state in the URL), a responsive sortable table, details in a drawer,
// and empty and error states. Replace ITEMS with the app's real data source; keep the patterns.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const APP_NAME = process.env.APP_NAME || "Starter app";

// Sample data so the app renders out of the box (and for UI review). Real apps read their store here.
export const ITEMS = [
  { id: "billing-export", name: "Billing export", team: "Payments", status: "ontrack", due: "2026-12-04", note: "CSV and API export of invoices." },
  { id: "search-v2", name: "Search v2", team: "Platform", status: "atrisk", due: "2026-11-28", note: "Indexer migration is two weeks behind." },
  { id: "offline-mode", name: "Offline mode", team: "Mobile", status: "late", due: "2026-11-01", note: "Waiting on the sync API." },
  { id: "refund-flow", name: "Refund flow", team: "Payments", status: "ontrack", due: "2026-11-20", note: "In final review." },
];
const STATUS = { ontrack: ["On track", "ok"], atrisk: ["At risk", "warn"], late: ["Late", "danger"] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const date = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const status = (s) => `<span class="status status-${STATUS[s][1]}">${STATUS[s][0]}</span>`;

function page(title, body, current = "/") {
  return `<!doctype html>
<html lang="en" data-palette="neutral">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)} · ${esc(APP_NAME)}</title>
<link rel="stylesheet" href="/design-system/tokens.css"><link rel="stylesheet" href="/design-system/components.css">
<script src="/design-system/kit.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="app">
  <header class="topbar">
    <a class="brand" href="/">${esc(APP_NAME)}</a>
    <nav aria-label="Primary"><a class="nav-link" href="/"${current === "/" ? ' aria-current="page"' : ""}>Items</a></nav>
    <span class="spacer"></span><button class="btn btn-ghost btn-sm" type="button" data-theme-toggle></button>
  </header>
  <main id="main" class="page">${body}</main>
  <nav class="bottombar" aria-label="Primary"><a class="nav-link" href="/"${current === "/" ? ' aria-current="page"' : ""}>Items</a></nav>
</div>
</body>
</html>`;
}

export function listPage(params) {
  const q = (params.get("q") || "").trim(), want = params.get("status") || "";
  const unknown = want && !STATUS[want];
  const rows = unknown ? [] : ITEMS.filter((i) => (!want || i.status === want) && (!q || `${i.name} ${i.team}`.toLowerCase().includes(q.toLowerCase())));
  const counts = Object.fromEntries(Object.keys(STATUS).map((s) => [s, ITEMS.filter((i) => i.status === s).length]));
  const options = Object.entries(STATUS).filter(([s]) => counts[s] > 0).map(([s, [label]]) => `<option value="${s}"${s === want ? " selected" : ""}>${label} (${counts[s]})</option>`).join("");
  const filtered = q || want;
  const results = unknown
    ? `<div class="notice notice-warn" role="status">Unknown status "${esc(want)}". <a href="/">Show all items</a></div>`
    : rows.length === 0
      ? filtered
        ? `<div class="card card-flush"><div class="empty"><p class="heading">No items match these filters</p><p>Try another status or search, or clear the filters.</p><a class="btn" href="/">Clear filters</a></div></div>`
        : `<div class="card card-flush"><div class="empty"><p class="heading">No items yet</p><p>Items show up here with their status and due date.</p></div></div>`
      : `<div class="table-wrap"><table class="table table-stack" data-sortable>
<thead><tr><th scope="col">Item</th><th scope="col">Team</th><th scope="col">Status</th><th scope="col" class="num">Due</th></tr></thead>
<tbody>${rows.map((i) => `<tr><td data-label="Item"><a href="/items/${esc(i.id)}" data-drawer>${esc(i.name)}</a></td><td data-label="Team">${esc(i.team)}</td><td data-label="Status">${status(i.status)}</td><td data-label="Due" class="num" data-value="${esc(i.due)}">${date(i.due)}</td></tr>`).join("")}</tbody></table></div>`;
  return page("Items", `
<div class="page-header"><div class="stack-sm"><h1 class="title">Items</h1><p class="muted">What's in flight and what needs attention.</p></div></div>
<div class="stack">
  <form class="filter-bar" method="get" action="/" data-autoapply data-target="#results" role="search" aria-label="Filter items">
    <div class="field field-search"><label class="label" for="q">Search</label><input class="input input-sm" type="search" id="q" name="q" value="${esc(q)}" placeholder="Name or team" autocomplete="off"></div>
    <div class="field"><label class="label" for="status">Status</label><select class="select input-sm" id="status" name="status"><option value="">Any status</option>${options}</select></div>
    <button class="btn btn-sm" type="submit" data-autoapply-submit>Apply</button>
  </form>
  <section id="results" class="stack-sm" aria-label="Results">
    <p class="filter-status"><span data-count>${rows.length} of ${ITEMS.length} items</span>${filtered ? ' · <a href="/">Clear filters</a>' : ""}</p>
    ${results}
  </section>
</div>`);
}

export function itemPage(id) {
  const i = ITEMS.find((x) => x.id === id);
  if (!i) return null;
  return page(i.name, `
<div data-drawer-content data-drawer-title="${esc(i.name)}" class="stack">
  <h1 class="title">${esc(i.name)}</h1>
  <div class="summary summary-${STATUS[i.status][1]}">${status(i.status)}<span class="summary-value">Due ${date(i.due)}</span><span class="small">${esc(i.note)}</span></div>
  <dl class="kv"><dt>Team</dt><dd>${esc(i.team)}</dd><dt>Due</dt><dd>${date(i.due)}</dd></dl>
</div>`);
}

async function serveStatic(path, res) {
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=300" });
    res.end(body);
    return true;
  } catch { return false; }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const html = (code, body) => (res.writeHead(code, { "content-type": "text/html; charset=utf-8" }), res.end(body));
  try {
    if (url.pathname === "/health") return res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ ok: true, checks: [] }));
    if (url.pathname === "/") return html(200, listPage(url.searchParams));
    if (url.pathname.startsWith("/items/")) { const p = itemPage(decodeURIComponent(url.pathname.slice(7))); return p ? html(200, p) : html(404, page("Not found", `<div class="empty"><p class="heading">That item doesn't exist</p><a class="btn" href="/">Back to items</a></div>`)); }
    if (req.method === "GET" && (await serveStatic(url.pathname, res))) return;
    html(404, page("Not found", `<div class="empty"><p class="heading">Page not found</p><a class="btn" href="/">Back to items</a></div>`));
  } catch (e) {
    console.error(e);
    html(500, page("Error", `<div class="error-state" role="alert"><p class="heading">Couldn't load this page</p><p>Try again in a moment.</p><a class="btn" href="${esc(url.pathname)}">Try again</a></div>`));
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`listening on ${port}`));
}
