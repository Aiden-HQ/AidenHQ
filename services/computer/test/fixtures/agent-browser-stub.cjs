#!/usr/bin/env node
// A stand-in for agent-browser in ui-review's tests: answers each subcommand the review script uses. STUB_TINY=n reports
// n elements of text under 12px (a blocking layout finding); STUB_TINY_TEXT=a,b reports exactly those selectors, so a test
// can put the same finding on two paths; STUB_OVERFLOW=px reports a sideways scroll instead.
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const args = process.argv.slice(2);
const json = args.includes("--json");
const cmd = args[0];
const reply = (data) => { if (json) console.log(JSON.stringify({ success: true, data })); };

if (cmd === "screenshot") { mkdirSync(dirname(args[1]), { recursive: true }); writeFileSync(args[1], "stub png"); }
else if (cmd === "eval") {
  const tiny = Number(process.env.STUB_TINY ?? 0), overflow = Number(process.env.STUB_OVERFLOW ?? 0);
  const tinyText = process.env.STUB_TINY_TEXT ? process.env.STUB_TINY_TEXT.split(",") : Array.from({ length: tiny }, (_, i) => `.tiny-${i}`);
  reply({ result: JSON.stringify({ overflow, wide: [], small: 0, tinyText, failed: [] }) });
} else if (cmd === "a11y") reply({ violations: [], incomplete: [] });
else if (cmd === "vitals") reply({ lcp: { startTime: 400 }, cls: { score: 0.01 }, fcp: 300, ttfb: 100, inp: 50 });
else if (cmd === "console") reply({ messages: [] });
else if (cmd === "errors") console.log("");
else if (cmd === "diff") console.log("0.00%");
else if (cmd === "open" || cmd === "set" || cmd === "wait") { /* nothing to do */ }
else { console.error(`stub: unknown command ${cmd}`); process.exit(2); }
