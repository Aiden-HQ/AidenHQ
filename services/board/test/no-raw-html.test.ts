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
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return [/<!doctype/i, /<html[\s>]/i, /<body[\s>]/i, /send\([^)]*["'`]text\/html/, /form-action 'self'/].filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
  expect(offenders).toEqual([]);
});
