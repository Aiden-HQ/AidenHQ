/* DEPRECATED: kept only for apps that still vendor it. New apps use shadcn/ui from the app starter (README.md).
   AidenHQ design system: kit.js. Small, dependency-free progressive enhancement for server-rendered pages: every behaviour
   below is opt-in by a data attribute, and the page still works without JavaScript. Load it with <script src defer>.
   Apps vendor this file unchanged (keep the version line). (Its catalog was removed with the move to shadcn/ui.)

   data-autoapply on a <form method="get">   filters apply on change (text after a short pause): the URL updates in place and
                                              only the regions in data-target are refreshed; focus and typing are kept.
   data-filter-local on a <form>             the same, filtering [data-filter-item] elements in the page (no server).
   data-drawer on a link                     opens the linked page's [data-drawer-content] in a side drawer; Back closes it.
   data-open="#id" / data-close              open or close a <dialog>.
   data-confirm="Question?"                  asks before a link or form submit goes ahead.
   data-async on a <form>                    submits with fetch, refreshes data-target regions, shows data-success as a toast.
   data-sortable on a <table>                headers become sort buttons (data-value on a cell overrides its text).
   data-load-more on a link                  appends the next page's [data-list] items in place (and when scrolled into view).
   data-command on a <dialog>                command palette, opened with Ctrl/Cmd+K or "/", filters its [role=option] items.
   data-relative on a <time datetime>        shows "2 h ago", with the exact time as its title.
   data-theme-toggle on a button             cycles the colour mode: system, light, dark (remembered per browser).
   role="tablist"                            arrow keys move between tabs; aria-controls panels are shown and hidden.
   AidenKit.toast(message, {tone, action})   shows a toast; a server-rendered [data-toast] element is shown once on load. */
/* design-system version: 2.0.0 */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

  // ---- Toasts and the live region every in-place update announces through
  const toasts = () => $(".toasts") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "toasts" }));
  const live = () => $("#kit-live") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "kit-live", className: "sr-only", role: "status" }));
  const announce = (text) => { const l = live(); l.textContent = ""; setTimeout(() => (l.textContent = text), 50); };
  function toast(message, o = {}) {
    const t = document.createElement("div");
    t.className = `toast${o.tone === "danger" ? " toast-danger" : ""}`;
    t.setAttribute("role", o.tone === "danger" ? "alert" : "status");
    const m = Object.assign(document.createElement("span"), { className: "grow", textContent: message });
    t.append(m);
    if (o.action) {
      const b = Object.assign(document.createElement("button"), { className: "btn btn-sm", type: "button", textContent: o.action.label });
      b.onclick = () => { o.action.run(); t.remove(); };
      t.append(b);
    }
    toasts().append(t);
    let timer;
    const arm = () => (timer = setTimeout(() => t.remove(), o.tone === "danger" ? 8000 : 5000));
    t.onmouseenter = t.onfocusin = () => clearTimeout(timer);
    t.onmouseleave = t.onfocusout = arm;
    arm();
    return t;
  }

  // ---- Fetch a page and swap regions by id: the core of every in-place update
  let inflight;
  async function fetchDoc(url, init = {}) {
    inflight?.abort();
    inflight = new AbortController();
    const r = await fetch(url, { ...init, signal: inflight.signal, headers: { "X-Requested-With": "fetch", Accept: "text/html", ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status}`);
    return new DOMParser().parseFromString(await r.text(), "text/html");
  }
  function swap(doc, selectors) {
    for (const sel of selectors) {
      const now = $(sel), next = $(sel, doc);
      if (!now || !next) continue;
      now.replaceWith(next);
      enhance(next);
    }
    const count = selectors.map((s) => $(`${s} [data-count], ${s}[data-count]`)).find(Boolean);
    if (count) announce(count.textContent.trim());
  }
  const targets = (el) => (el.dataset.target || "main").split(",").map((s) => s.trim()).filter(Boolean);
  const busy = (sels, on) => sels.forEach((s) => $(s)?.setAttribute("aria-busy", String(on)));

  // ---- Auto-apply filters: change applies at once, typing after 250 ms; the URL holds the state (replaceState)
  function queryOf(form) {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (String(v).trim() !== "") p.append(k, v);
    return p;
  }
  function autoapply(form) {
    $$("[data-autoapply-submit]", form).forEach((b) => (b.hidden = true)); // the no-JS Apply button
    let t;
    const run = async () => {
      const q = queryOf(form).toString();
      const url = (form.getAttribute("action") || location.pathname) + (q ? `?${q}` : "");
      history.replaceState(history.state, "", url);
      const sels = targets(form);
      busy(sels, true);
      try { swap(await fetchDoc(url), sels); }
      catch (e) { if (e.name !== "AbortError") toast("Couldn't update the results. Check your connection and try again.", { tone: "danger", action: { label: "Retry", run } }); }
      finally { busy(sels, false); }
    };
    form.addEventListener("input", (e) => { if (e.target.matches("input[type=search], input[type=text], textarea")) { clearTimeout(t); t = setTimeout(run, 250); } });
    form.addEventListener("change", (e) => { if (!e.target.matches("input[type=search], input[type=text], textarea")) run(); });
    form.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(t); run(); });
    form.addEventListener("reset", () => setTimeout(run));
  }

  // ---- Local filtering (no server): [data-filter-item] elements match the text box and every select/checked value
  function filterLocal(form) {
    $$("[data-autoapply-submit]", form).forEach((b) => (b.hidden = true));
    const scope = () => (form.dataset.target ? $(form.dataset.target) : document);
    const run = () => {
      const p = queryOf(form), q = (p.get("q") || "").toLowerCase();
      let shown = 0;
      const items = $$("[data-filter-item]", scope());
      for (const it of items) {
        const ok = (!q || it.textContent.toLowerCase().includes(q)) && [...p].every(([k, v]) => k === "q" || (it.dataset[k] ?? "").split(" ").includes(v));
        it.hidden = !ok;
        shown += ok ? 1 : 0;
      }
      $$("[data-filter-empty]", scope()).forEach((e) => (e.hidden = shown > 0));
      $$("[data-count]", scope()).forEach((c) => (c.textContent = `${shown} of ${items.length}`));
      const u = new URLSearchParams(location.search); // keep params that aren't this form's
      for (const el of form.elements) if (el.name) u.delete(el.name);
      for (const [k, v] of p) u.append(k, v);
      history.replaceState(history.state, "", u.toString() ? `?${u}` : location.pathname);
      announce(`${shown} results`);
    };
    form.addEventListener("input", run);
    form.addEventListener("submit", (e) => (e.preventDefault(), run()));
    form.addEventListener("reset", () => setTimeout(run));
    if (location.search) { for (const [k, v] of new URLSearchParams(location.search)) { const f = form.elements[k]; if (f && "value" in f) f.value = v; } run(); }
  }

  // ---- Drawer: a link's detail opens beside the list; the URL changes (shareable) and Back closes it
  let drawer;
  function openDrawer(url, html, title) {
    if (!drawer) {
      drawer = document.createElement("dialog");
      drawer.className = "drawer";
      drawer.setAttribute("aria-labelledby", "kit-drawer-title");
      drawer.addEventListener("close", () => { if (history.state?.kitDrawer) history.back(); });
      drawer.addEventListener("click", (e) => { if (e.target === drawer) drawer.close(); });
      document.body.append(drawer);
    }
    drawer.innerHTML = `<div class="dialog-header"><h2 class="subheading" id="kit-drawer-title"></h2><button class="btn btn-ghost btn-icon" type="button" aria-label="Close" data-close>✕</button></div><div class="dialog-body"></div>`;
    $("#kit-drawer-title", drawer).textContent = title;
    $(".dialog-body", drawer).append(...html);
    enhance(drawer);
    if (!drawer.open) drawer.showModal();
    if (!history.state?.kitDrawer) history.pushState({ kitDrawer: true }, "", url);
  }
  addEventListener("popstate", () => { if (drawer?.open && !history.state?.kitDrawer) { drawer.close(); } });
  async function drawerLink(a, e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab still works
    e.preventDefault();
    try {
      const doc = await fetchDoc(a.href);
      const c = $("[data-drawer-content]", doc) || $("main", doc) || doc.body;
      const title = c.dataset.drawerTitle || $("h1", c)?.textContent || a.textContent;
      openDrawer(a.href, [...c.childNodes], title.trim());
    } catch (err) { if (err.name !== "AbortError") location.href = a.href; }
  }

  // ---- Confirm before destructive actions (one dialog, reused)
  function confirmDialog(question, label = "Confirm") {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "modal";
      d.innerHTML = `<div class="dialog-body"><p class="subheading"></p></div><div class="dialog-footer"><button class="btn" value="no">Cancel</button><button class="btn btn-danger-solid" value="yes"></button></div>`;
      $("p", d).textContent = question;
      $("[value=yes]", d).textContent = label;
      d.addEventListener("click", (e) => { const v = e.target.closest("button")?.value; if (v || e.target === d) d.close(v || "no"); });
      d.addEventListener("close", () => { resolve(d.returnValue === "yes"); d.remove(); });
      document.body.append(d);
      d.showModal();
      $("[value=no]", d).focus();
    });
  }

  // ---- Async forms: fetch submit, busy button, refresh regions, toast
  function asyncForm(form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (form.dataset.confirm && !(await confirmDialog(form.dataset.confirm, form.dataset.confirmLabel))) return;
      const btn = e.submitter || $("[type=submit]", form);
      btn?.setAttribute("aria-busy", "true");
      try {
        const method = (form.getAttribute("method") || "post").toUpperCase();
        const doc = await fetchDoc(form.action, { method, body: new FormData(form, e.submitter) });
        const err = $("[data-form-error]", doc);
        if (err) { const here = $("[data-form-error]", form); if (here) here.replaceWith(err); else form.prepend(err); $("[aria-invalid=true]", form)?.focus(); return; }
        swap(doc, targets(form));
        if (form.dataset.success) toast(form.dataset.success);
        if (form.closest("dialog")) form.closest("dialog").close();
        if (form.dataset.reset !== undefined) form.reset();
      } catch (err) {
        if (err.name !== "AbortError") toast("Couldn't save. Nothing was changed; try again.", { tone: "danger" });
      } finally { btn?.removeAttribute("aria-busy"); }
    });
  }

  // ---- Sortable tables (client-side, for the rows on the page)
  function sortable(table) {
    $$("thead th", table).forEach((th, i) => {
      if (th.dataset.sort === "none") return;
      const b = Object.assign(document.createElement("button"), { type: "button", className: "sort" });
      b.append(...th.childNodes);
      th.append(b);
      th.setAttribute("aria-sort", th.getAttribute("aria-sort") || "none");
      b.onclick = () => {
        const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        $$("thead th", table).forEach((h) => h.hasAttribute("aria-sort") && h.setAttribute("aria-sort", "none"));
        th.setAttribute("aria-sort", dir);
        const body = table.tBodies[0];
        const key = (tr) => { const c = tr.cells[i]; const v = c?.dataset.value ?? c?.textContent.trim() ?? ""; const n = Number(v.replace(/[,%\s]/g, "")); return v !== "" && !Number.isNaN(n) ? n : v.toLowerCase(); };
        const rows = [...body.rows].sort((a, z) => { const x = key(a), y = key(z); return (x > y ? 1 : x < y ? -1 : 0) * (dir === "ascending" ? 1 : -1); });
        body.append(...rows);
        announce(`Sorted by ${b.textContent.trim()}, ${dir}`);
      };
    });
  }

  // ---- Load more / infinite list
  function loadMore(a) {
    const go = async (e) => {
      e?.preventDefault();
      if (a.getAttribute("aria-busy") === "true") return;
      a.setAttribute("aria-busy", "true");
      try {
        const doc = await fetchDoc(a.href);
        const list = $(a.dataset.loadMore || "[data-list]");
        const next = $(a.dataset.loadMore || "[data-list]", doc);
        if (list && next) { const items = [...next.children]; list.append(...items); items.forEach(enhance); announce(`${items.length} more loaded`); }
        const nextLink = $("[data-load-more]", doc);
        if (nextLink) { a.href = nextLink.href; a.removeAttribute("aria-busy"); } else (a.closest(".load-more") || a).remove();
      } catch (err) { a.removeAttribute("aria-busy"); if (err.name !== "AbortError") toast("Couldn't load more. Try again.", { tone: "danger" }); }
    };
    a.addEventListener("click", go);
    if ("IntersectionObserver" in window && a.dataset.auto !== "false") new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && go()).observe(a);
  }

  // ---- Command palette
  function command(d) {
    const input = $("input", d), opts = () => $$("[role=option]", d).filter((o) => !o.hidden);
    const select = (o) => { $$("[role=option]", d).forEach((x) => x.setAttribute("aria-selected", String(x === o))); o?.scrollIntoView({ block: "nearest" }); if (o) input.setAttribute("aria-activedescendant", o.id); };
    $$("[role=option]", d).forEach((o, i) => (o.id ||= `kit-opt-${i}`));
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      $$("[role=option]", d).forEach((o) => (o.hidden = !o.textContent.toLowerCase().includes(q)));
      const empty = $(".command-empty", d); if (empty) empty.hidden = opts().length > 0;
      select(opts()[0]);
    });
    input.addEventListener("keydown", (e) => {
      const list = opts(), i = list.findIndex((o) => o.getAttribute("aria-selected") === "true");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); select(list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]); }
      if (e.key === "Enter" && list[i]) { e.preventDefault(); list[i].click(); }
    });
    d.addEventListener("click", (e) => { const o = e.target.closest("[role=option]"); if (o) { const a = $("a", o) || (o.matches("a") ? o : null); d.close(); if (a) location.href = a.href; } else if (e.target === d) d.close(); });
    addEventListener("keydown", (e) => {
      const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) { e.preventDefault(); input.value = ""; input.dispatchEvent(new Event("input")); d.showModal(); input.focus(); }
    });
  }

  // ---- Tabs with arrow keys
  function tabs(list) {
    const all = $$("[role=tab]", list);
    const pick = (t, focus) => { all.forEach((x) => { const on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; const p = x.getAttribute("aria-controls"); if (p && $(`#${p}`)) $(`#${p}`).hidden = !on; }); if (focus) t.focus(); };
    all.forEach((t) => t.addEventListener("click", (e) => { if (t.getAttribute("aria-controls")) { e.preventDefault(); pick(t); } }));
    list.addEventListener("keydown", (e) => { const i = all.indexOf(document.activeElement); if (i < 0) return; const n = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (n) { e.preventDefault(); pick(all[(i + n + all.length) % all.length], true); } });
    pick(all.find((t) => t.getAttribute("aria-selected") === "true") || all[0]);
  }

  // ---- Relative time
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  function relative(t) {
    const d = new Date(t.getAttribute("datetime")); if (Number.isNaN(+d)) return;
    const s = (d - Date.now()) / 1000, a = Math.abs(s);
    const [v, u] = a < 60 ? [s, "second"] : a < 3600 ? [s / 60, "minute"] : a < 86400 ? [s / 3600, "hour"] : a < 86400 * 30 ? [s / 86400, "day"] : [null];
    t.title = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    t.textContent = v == null ? d.toLocaleDateString(undefined, { dateStyle: "medium" }) : rtf.format(Math.round(v), u);
  }

  // ---- Colour mode: system → light → dark, remembered per browser
  const MODES = ["system", "light", "dark"];
  const applyMode = (m) => { if (m === "light" || m === "dark") document.documentElement.dataset.theme = m; else delete document.documentElement.dataset.theme; };
  applyMode(store.get("aidenkit-mode"));
  function themeToggle(b) {
    const label = () => (b.textContent = `Theme: ${store.get("aidenkit-mode") || "system"}`);
    if (!b.textContent.trim()) label();
    b.addEventListener("click", () => { const next = MODES[(MODES.indexOf(store.get("aidenkit-mode") || "system") + 1) % 3]; store.set("aidenkit-mode", next === "system" ? null : next); applyMode(next); label(); });
  }

  // ---- Wire everything inside a root (the page, and every region swapped in)
  function enhance(root) {
    if (!(root instanceof Element) && root !== document) return;
    const each = (sel, fn) => [...(root.matches?.(sel) ? [root] : []), ...$$(sel, root)].forEach((el) => { if (el.dataset.kitOn?.includes(sel)) return; el.dataset.kitOn = (el.dataset.kitOn || "") + sel; fn(el); });
    each("form[data-autoapply]", autoapply);
    each("form[data-filter-local]", filterLocal);
    each("form[data-async]", asyncForm);
    each("a[data-drawer]", (a) => a.addEventListener("click", (e) => drawerLink(a, e)));
    each("[data-open]", (b) => b.addEventListener("click", (e) => { const d = $(b.dataset.open); if (d?.showModal) { e.preventDefault(); d.showModal(); } }));
    each("[data-close]", (b) => b.addEventListener("click", () => b.closest("dialog")?.close()));
    each("a[data-confirm], button[data-confirm]:not([type=submit])", (el) => el.addEventListener("click", async (e) => { if (el.dataset.kitOk) return delete el.dataset.kitOk; e.preventDefault(); if (await confirmDialog(el.dataset.confirm, el.dataset.confirmLabel)) { el.dataset.kitOk = "1"; el.click(); } }));
    each("form[data-confirm]:not([data-async])", (f) => f.addEventListener("submit", async (e) => { if (f.dataset.kitOk) return delete f.dataset.kitOk; e.preventDefault(); if (await confirmDialog(f.dataset.confirm, f.dataset.confirmLabel)) { f.dataset.kitOk = "1"; f.requestSubmit(e.submitter); } }));
    each("table[data-sortable]", sortable);
    each("a[data-load-more]", loadMore);
    each("dialog[data-command]", command);
    each("[role=tablist]", tabs);
    each("time[data-relative]", relative);
    each("[data-theme-toggle]", themeToggle);
    each("[data-toast]", (el) => { toast(el.dataset.toast, { tone: el.dataset.tone }); });
  }

  window.AidenKit = { toast, announce, confirm: confirmDialog, enhance, refresh: async (url, selectors) => swap(await fetchDoc(url), selectors) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => enhance(document)); else enhance(document);
})();
