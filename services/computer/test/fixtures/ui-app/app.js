// The fixture's whole app: a hash router over 60 routes (home, live, scroll, planted, clock, danger and r01..r54; server.ts `ROUTES`). Plain DOM, no build.
const GENERATED = Array.from({ length: 54 }, (_, i) => `r${String(i + 1).padStart(2, "0")}`);
const app = document.getElementById("app");
const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
const nav = () => `<header><a href="#/">Acme</a><a href="#/live">Live</a><a href="#/scroll">Scroll</a><a href="#/planted">Planted</a><a href="#/clock">Clock</a><a href="#/danger">Danger</a></header>`;
const get = (p) => fetch(p).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${p} ${r.status}`))));
let timer;

const pages = {
  "": () => `<h1>Acme home</h1><div class="card">Welcome to the Acme fixture.</div>`,
  live: () => { timer = setInterval(() => get("/api/live").then((j) => { const n = document.getElementById("t"); if (n) n.textContent = String(j.t); }), 50); return `<h1>Live feed</h1><div class="card">Updated <span id="t">0</span></div>`; },
  scroll: () => `<h1>Scrolling list</h1>`,
  planted: () => `<div class="planted"><h1 id="pt">Planted page</h1>
    <div class="card"><p class="odd-size">A paragraph at a stray size.</p><p class="hot">A stray colour.</p><p style="font-size:12px">Small</p><p style="font-size:14px">Body</p><p style="font-size:16px">Lead</p><p style="font-size:20px">Heading</p></div>
    <div style="display:flex;flex-direction:column"><div style="margin-top:8px">a</div><div style="margin-top:16px">b</div><div style="margin-top:24px">c</div><div class="gap13">d</div></div>
    <div class="cards"><div class="card">One</div><div class="card off">Two</div></div>
    <button class="slow">Hover me</button></div>`,
  clock: () => `<h1>Clock</h1><div class="card">Last sync <span id="ago">${Math.max(0, Math.round((Date.now() - window.__bootAt) / 60000))}m ago</span></div>`,
  "socket-write": () => { const ws = new WebSocket(`ws://${location.host}/ws`); ws.onopen = () => ws.send("write"); return `<h1>Socket writer</h1><div class="card">Writes over a WebSocket on load.</div>`; },
  danger: () => `<h1>Danger zone</h1><div class="card"><button id="del" onclick="fetch('/api/delete',{method:'POST'})">Delete</button> <button class="primary" id="pay" onclick="fetch('/api/pay',{method:'POST'})">Pay</button></div>`,
};
// /#/clicks (not in ROUTES): a dead Archive button, a filter that is lost on reload, and a Save that works, for the clicking pass's repro.
pages.clicks = () => `<h1>Orders</h1><div class="card"><input id="filter" placeholder="Filter orders"> <button id="archive">Archive</button> <button id="save" onclick="document.getElementById('saved').textContent='Saved'">Save</button><p id="saved"></p></div>`;
for (const r of GENERATED) pages[r] = () => `<h1>Section ${r.slice(1)}</h1><div class="card"><div class="skeleton" style="width:0;height:0"></div>Acme report ${r.slice(1)} for example.com.</div><button class="primary">Open</button>`;

window.__bootAt = Date.now() - 2 * 60000; // "2m ago" at boot, from Date.now()

function render() {
  clearInterval(timer);
  const key = location.hash.replace(/^#\/?/, "");
  const page = pages[key] ?? pages[""];
  if (key === "scroll") {
    app.innerHTML = nav() + `<main class="scroller" id="scroller">${pages.scroll()}${Array.from({ length: 40 }, (_, i) => `<div class="row">Row ${i + 1}: Acme line item</div>`).join("")}</main>`;
  } else {
    app.innerHTML = nav() + `<main>${page()}</main>`;
  }
  if (key === "danger") fetch("/api/seen", { method: "POST" }).catch(() => {}); // a write on mount, as live apps do
  if (key === "planted") get("/api/state").then((s) => { const h = document.getElementById("pt"); if (h) h.textContent = s["planted-title"]; }).catch(() => {});
}
window.addEventListener("hashchange", render);
render();
