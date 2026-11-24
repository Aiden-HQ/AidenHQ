import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Every page the owner sees is the board's app (web/src) on its design system; the server sends data, redirects and the
// app's own files, never an HTML page of its own (they came out unstyled: the sign-in scope picker, sign-in errors).
// A page belongs in the app as a #/ route, with what it needs from an /api/ route.
it("the board's server builds no HTML pages, and allows no form submissions", () => {
  const dir = join(import.meta.dirname, "../src");
  const offenders = readdirSync(dir, { recursive: true })
    .map(String)
    // module-views.ts relays a module's own view (MCP Apps) into its sandboxed frame: the module's HTML, never the board's.
    .filter((f) => f.endsWith(".ts") && f !== "module-views.ts")
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      // text/html only as the static files' type (TYPES[".html"], the app's index).
      const html = text.split("\n").filter((l) => /text\/html/.test(l) && !/^\s*"\.html": "text\/html; charset=utf-8",$/.test(l));
      return [/<!doctype/i, /<html[\s>]/i, /<body[\s>]/i, /form-action 'self'/].filter((re) => re.test(text)).map((re) => `${f}: ${re}`).concat(html.map((l) => `${f}: ${l.trim()}`));
    });
  expect(offenders).toEqual([]);
});
