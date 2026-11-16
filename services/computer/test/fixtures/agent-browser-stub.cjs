#!/usr/bin/env node
// A stand-in for agent-browser in ui-review's tests: answers each subcommand the review script uses. STUB_TINY=n reports
// n elements of text under 12px (a blocking layout finding); STUB_TINY_TEXT=a,b reports exactly those selectors, so a test
// can put the same finding on two paths; STUB_OVERFLOW=px reports a sideways scroll instead.
// Routes: STUB_PAGES='{"/": "text", "/teams": "text"}' is an app whose every page links to each of its pages, kept in the
// STUB_STATE file between calls; STUB_BROKEN=1 makes it the query-only store bug (a click or Back/Forward changes the URL
// and nothing else); STUB_404=/a,/b answers 404 for those on a load. Pages are keyed by path and query. Without STUB_PAGES
// a page has no links and no text. Every page has a header brand that goes home, unless STUB_DEAD_BRAND=1 makes it do
// nothing; every page has one button ("Refresh") that opens the details when STUB_BUTTON=1 (and does nothing under
// STUB_DEAD_BUTTON=1); STUB_CHECKBOX=1 gives it a checkbox whose tick changes only its live checked property, never the
// markup; STUB_SAME_LINK=1 gives every page a "Home" link to the page it is on that scrolls to the top, and
// STUB_DEAD_SAME_LINK=1 one that does nothing; STUB_PRESSED=1 gives it a pressed toggle ("On track") whose click opens
// the details, and STUB_DEAD_PRESSED=1 one that does nothing. So a test can plant a dead click, its opposite, and a
// live-state-only effect.
"use strict";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const args = process.argv.slice(2);
const json = args.includes("--json");
const cmd = args[0];
const reply = (data) => { if (json) console.log(JSON.stringify({ success: true, data })); };

const pages = process.env.STUB_PAGES ? JSON.parse(process.env.STUB_PAGES) : null;
const textOf = (at) => pages?.[at] ?? "";
// One state file per browser session (ui-review runs route checks in several).
const stateFile = process.env.STUB_STATE && `${process.env.STUB_STATE}${process.env.AGENT_BROWSER_SESSION && process.env.AGENT_BROWSER_SESSION !== "default" ? `.${process.env.AGENT_BROWSER_SESSION}` : ""}`;
const load = () => (existsSync(stateFile ?? "") ? JSON.parse(readFileSync(stateFile, "utf8")) : { hist: ["/"], i: 0, text: "", scroll: 0, details: 0 });
const save = (st) => stateFile && writeFileSync(stateFile, JSON.stringify(st));
const go = (st, i, render) => { st.i = i; if (render || !process.env.STUB_BROKEN) st.text = textOf(st.hist[i]); st.scroll = 0; save(st); };

if (cmd === "screenshot") { mkdirSync(dirname(args[1]), { recursive: true }); writeFileSync(args[1], "stub png"); }
else if (["open", "click", "back", "forward"].includes(cmd)) {
  const st = load();
  if (cmd === "open") { const u = new URL(args[1]), at = u.pathname + u.search; Object.assign(st, { hist: [at], details: 0 }); go(st, 0, true); }
  if (cmd === "click" && st.mark === "brand") { if (!process.env.STUB_DEAD_BRAND) { Object.assign(st, { hist: ["/"], i: 0, text: textOf("/"), scroll: 0 }); save(st); } }
  else if (cmd === "click" && st.mark === "click" && process.env.STUB_CHECKBOX) { st.checked = !st.checked; save(st); }
  else if (cmd === "click" && st.mark === "click") { if (!process.env.STUB_DEAD_BUTTON && !process.env.STUB_DEAD_PRESSED) { st.details = st.details ? 0 : 1; save(st); } }
  else if (cmd === "click") { st.hist = [...st.hist.slice(0, st.i + 1), st.mark]; go(st, st.i + 1, false); }
  if (cmd === "back" && st.i > 0) go(st, st.i - 1, false);
  if (cmd === "forward" && st.i < st.hist.length - 1) go(st, st.i + 1, false);
} else if (cmd === "eval" && args[1].startsWith("/*routes:")) {
  const st = load(), at = st.hist[st.i];
  if (args[1].startsWith("/*routes:links*/"))
    reply({ result: JSON.stringify(Object.keys(pages ?? {}).filter((p) => p !== at).map((p) => ({ href: p, to: p, kind: p + "?", label: `Go ${p}`, nav: true }))) });
  else if (args[1].startsWith("/*routes:mark*/")) { st.mark = /=== "([^"]+)"/.exec(args[1])[1]; save(st); reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:mark-brand*/")) { st.mark = "brand"; save(st); reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:click-brand*/")) { if (!process.env.STUB_DEAD_BRAND) { Object.assign(st, { hist: ["/"], i: 0, text: textOf("/"), scroll: 0 }); save(st); } reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:mark-click*/")) { st.mark = "click"; st.focus = process.env.STUB_CHECKBOX ? "INPUT Subscribe" : process.env.STUB_PRESSED || process.env.STUB_DEAD_PRESSED ? "BUTTON On track" : "BUTTON Refresh"; save(st); reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:scroll*/")) { st.scroll = 5000; save(st); reply({ result: "5000" }); }
  else if (args[1].startsWith("/*routes:state*/"))
    reply({ result: JSON.stringify({ origin: "http://127.0.0.1:9", at, scrollY: st.scroll ?? 0, focus: st.focus ?? "", html: `${st.text}|${st.details ?? 0}`, live: `checkbox:${!!st.checked}` }) });
  else if (args[1].startsWith("/*routes:same-links*/"))
    reply({ result: JSON.stringify(process.env.STUB_SAME_LINK || process.env.STUB_DEAD_SAME_LINK ? [{ href: "/", to: "/", label: "Home" }] : []) });
  else if (args[1].startsWith("/*routes:mark-same*/")) { st.mark = "same"; save(st); reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:click-same*/")) { if (!process.env.STUB_DEAD_SAME_LINK) { st.scroll = 0; save(st); } reply({ result: "ok" }); }
  else if (args[1].startsWith("/*routes:clicks*/"))
    reply({ result: JSON.stringify(process.env.STUB_CHECKBOX ? [{ label: "Subscribe", kind: "checkbox" }] : process.env.STUB_PRESSED || process.env.STUB_DEAD_PRESSED ? [{ label: "On track", kind: "button" }] : process.env.STUB_DEAD_BUTTON || process.env.STUB_BUTTON ? [{ label: "Refresh", kind: "button" }] : []) });
  else reply({ result: JSON.stringify({ at, status: pages && ((process.env.STUB_404 ?? "").split(",").includes(at) || !pages[at]) ? 404 : 200, text: st.text }) });
} else if (cmd === "eval") {
  const tiny = Number(process.env.STUB_TINY ?? 0), overflow = Number(process.env.STUB_OVERFLOW ?? 0);
  const tinyText = process.env.STUB_TINY_TEXT ? process.env.STUB_TINY_TEXT.split(",") : Array.from({ length: tiny }, (_, i) => `.tiny-${i}`);
  reply({ result: JSON.stringify({ overflow, wide: [], small: 0, tinyText, failed: [] }) });
} else if (cmd === "a11y") reply({ violations: [], incomplete: [] });
else if (cmd === "vitals") reply({ lcp: { startTime: 400 }, cls: { score: 0.01 }, fcp: 300, ttfb: 100, inp: 50 });
else if (cmd === "console") reply({ messages: [] });
else if (cmd === "errors") console.log("");
else if (cmd === "diff") console.log("0.00%");
else if (["set", "wait", "close"].includes(cmd)) { /* nothing to do */ }
else { console.error(`stub: unknown command ${cmd}`); process.exit(2); }
