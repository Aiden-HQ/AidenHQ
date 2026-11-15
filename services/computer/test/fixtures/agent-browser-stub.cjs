#!/usr/bin/env node
// A stand-in for agent-browser in ui-review's tests: answers each subcommand the review script uses. STUB_TINY=n reports
// n elements of text under 12px (a blocking layout finding); STUB_TINY_TEXT=a,b reports exactly those selectors, so a test
// can put the same finding on two paths; STUB_OVERFLOW=px reports a sideways scroll instead.
// Routes: STUB_PAGES='{"/": "text", "/teams": "text"}' is an app whose every page links to each of its pages, kept in the
// STUB_STATE file between calls; STUB_BROKEN=1 makes it the query-only store bug (a click or Back/Forward changes the URL
// and nothing else); STUB_404=/a,/b answers 404 for those on a load. Pages are keyed by path and query. Without STUB_PAGES
// a page has no links.
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const args = process.argv.slice(2);
const json = args.includes("--json");
const cmd = args[0];
const reply = (data) => { if (json) console.log(JSON.stringify({ success: true, data })); };

const pages = process.env.STUB_PAGES ? JSON.parse(process.env.STUB_PAGES) : null;
const load = () => (existsSync(process.env.STUB_STATE ?? "") ? JSON.parse(readFileSync(process.env.STUB_STATE, "utf8")) : { hist: ["/"], i: 0, text: "" });
const save = (st) => process.env.STUB_STATE && writeFileSync(process.env.STUB_STATE, JSON.stringify(st));
const go = (st, i, render) => { st.i = i; if (render || !process.env.STUB_BROKEN) st.text = pages?.[st.hist[i]] ?? "Not found"; save(st); };

if (cmd === "screenshot") { mkdirSync(dirname(args[1]), { recursive: true }); writeFileSync(args[1], "stub png"); }
else if (pages && ["open", "click", "back", "forward"].includes(cmd)) {
  const st = load();
  if (cmd === "open") { const u = new URL(args[1]), at = u.pathname + u.search; Object.assign(st, { hist: [at] }); go(st, 0, true); }
  if (cmd === "click") { st.hist = [...st.hist.slice(0, st.i + 1), st.mark]; go(st, st.i + 1, false); }
  if (cmd === "back" && st.i > 0) go(st, st.i - 1, false);
  if (cmd === "forward" && st.i < st.hist.length - 1) go(st, st.i + 1, false);
} else if (cmd === "eval" && args[1].startsWith("/*routes:")) {
  const st = load(), at = st.hist[st.i];
  if (args[1].startsWith("/*routes:links*/"))
    reply({ result: JSON.stringify(Object.keys(pages ?? {}).filter((p) => p !== at).map((p) => ({ href: p, to: p, kind: p + "?", label: `Go ${p}`, nav: true }))) });
  else if (args[1].startsWith("/*routes:mark*/")) { st.mark = /=== "([^"]+)"/.exec(args[1])[1]; save(st); reply({ result: "ok" }); }
  else reply({ result: JSON.stringify({ at, status: (process.env.STUB_404 ?? "").split(",").includes(at) || !pages?.[at] ? 404 : 200, text: st.text }) });
} else if (cmd === "eval") {
  const tiny = Number(process.env.STUB_TINY ?? 0), overflow = Number(process.env.STUB_OVERFLOW ?? 0);
  const tinyText = process.env.STUB_TINY_TEXT ? process.env.STUB_TINY_TEXT.split(",") : Array.from({ length: tiny }, (_, i) => `.tiny-${i}`);
  reply({ result: JSON.stringify({ overflow, wide: [], small: 0, tinyText, failed: [] }) });
} else if (cmd === "a11y") reply({ violations: [], incomplete: [] });
else if (cmd === "vitals") reply({ lcp: { startTime: 400 }, cls: { score: 0.01 }, fcp: 300, ttfb: 100, inp: 50 });
else if (cmd === "console") reply({ messages: [] });
else if (cmd === "errors") console.log("");
else if (cmd === "diff") console.log("0.00%");
else if (["open", "set", "wait", "click", "back", "forward"].includes(cmd)) { /* nothing to do */ }
else { console.error(`stub: unknown command ${cmd}`); process.exit(2); }
