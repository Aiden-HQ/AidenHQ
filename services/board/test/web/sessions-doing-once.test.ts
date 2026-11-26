// @vitest-environment node
// The sessions list shows "what it is doing" once: the under-the-title copy on a phone, the column copy on a wide
// screen. Below 760px a bare .ses-doing rule here would un-hide the column copy too, printing the line twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../../web/src/sessions.css"), "utf8");

/** The body of the rules inside `@media (max-width: 760px) { … }`. */
function phoneBlock(text: string): string | undefined {
  const open = /@media\s*\(max-width:\s*760px\)\s*\{/.exec(text);
  if (!open) return undefined;
  let depth = 1;
  for (let i = open.index + open[0].length; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open.index + open[0].length, i);
  }
  return undefined;
}

/** Every selector in a block of rules, one per comma-separated part. */
function selectors(block: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{[^{}]*\}/g;
  for (const m of block.matchAll(rule)) out.push(...m[1].split(",").map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim()));
  return out.filter(Boolean);
}

describe("the sessions list's doing line", () => {
  it("shows once below 760px: no bare .ses-doing selector in the phone block", () => {
    const block = phoneBlock(css);
    expect(block, "no @media (max-width: 760px) block in sessions.css").toBeDefined();
    // `.ses-doing` alone, not `.ses-doing-under` or `.ses-doing-col` (or any other suffixed part).
    const bare = selectors(block!).flatMap((sel) => (/(^|[^-\w.])\.ses-doing(?![-\w])/.test(sel) ? [sel] : []));
    expect(bare).toEqual([]);
  });
});
