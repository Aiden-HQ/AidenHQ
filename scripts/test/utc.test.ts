// Server code keeps times as UTC instants and never reads the host's timezone (CLAUDE.md "Times are UTC instants"): a
// static scan of the kernel, services, modules, scripts and ops for the patterns that do. Browser code (the board's web app,
// the app starter's src, the design system, page kits, module pages) formats in the viewer's zone and is not scanned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, repo } from "../sync-shared.ts";

const ROOTS = ["kernel", "services", "modules", "scripts", "ops"];
const CODE = /\.(ts|mts|mjs|js)$/;
const BROWSER = [
  /(^|\/)web\//, /(^|\/)starter\/(src|e2e)\//, /app-starter\/(src|e2e)\//, /(^|\/)design-system\//, /page-kit\.js$/, /(^|\/)public\//,
];
const SKIP = [/(^|\/)test\//, /\.test\.[a-z]+$/, /(^|\/)(dist|fixtures|evals|vendor)\//];

/** The text of the call whose "(" is at `open`, to its matching ")". */
function callArgs(src: string, open: number) {
  let depth = 0;
  for (let i = open; i < src.length && i < open + 2000; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open, open + 2000);
}

const RULES: { name: string; find: RegExp; bad: (src: string, m: RegExpExecArray) => boolean; fix: string }[] = [
  {
    name: "host-local date parts",
    find: /\.(getHours|setHours|getMinutes|setMinutes|getDate|setDate|getDay|getMonth|setMonth|getFullYear|setFullYear|getTimezoneOffset)\(/g,
    bad: () => true,
    fix: "use the getUTC*/setUTC* methods, or Intl.DateTimeFormat with the owner's timeZone",
  },
  {
    name: "date formatting without a timeZone",
    find: /(toLocaleDateString|toLocaleTimeString|toLocaleString|Intl\.DateTimeFormat)\(/g,
    bad: (src, m) => {
      const args = callArgs(src, m.index + m[0].length - 1);
      if (m[1] === "toLocaleString" && !/\b(hour|minute|weekday|month|day|year|dateStyle|timeStyle)\b/.test(args)) {
        // No date options: a Date (formatted in the host's zone) unless the receiver is a number.
        const before = src.slice(Math.max(0, src.lastIndexOf("\n", m.index) + 1), m.index);
        if (!/(\bDate\b[^;]*|\w*(date|time|stamp|At|when)\w*\)?)\.$/i.test(before)) return false;
      }
      return !/\btimeZone\b/.test(args);
    },
    fix: "pass timeZone (the owner's `timezone` setting), or keep the ISO instant",
  },
  {
    name: "a zone-less wall clock from an ISO time",
    find: /\.replace\(\s*(["'])T\1\s*,\s*(["']) \2\s*\)|\.replace\(\/T\/,\s*(["']) \3\s*\)/g,
    bad: (src, m) => !/UTC/.test(src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index) >>> 0)),
    fix: "keep the ISO instant with its Z, or say UTC on the same line",
  },
  {
    name: "SQLite zone-less now",
    find: /datetime\(\s*'now'/gi, // SQLite's; Postgres timestamptz (CURRENT_TIMESTAMP, now()) is an instant
    bad: () => true,
    fix: "store epoch ms or strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  },
];

test("server code keeps UTC instants and never reads the host's timezone", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const rel of listFiles(join(repo, root))) {
      const path = `${root}/${rel}`;
      if (!CODE.test(path) || BROWSER.some((r) => r.test(path)) || SKIP.some((r) => r.test(path))) continue;
      const src = readFileSync(join(repo, path), "utf8");
      for (const rule of RULES) {
        for (const m of src.matchAll(rule.find)) {
          if (!rule.bad(src, m as RegExpExecArray)) continue;
          const line = src.slice(0, m.index).split("\n").length;
          found.push(`${path}:${line}: ${rule.name}: ${rule.fix}`);
        }
      }
    }
  }
  assert.deepEqual(found, [], `times on the server are UTC instants (CLAUDE.md "Times are UTC instants"):\n${found.join("\n")}`);
});
