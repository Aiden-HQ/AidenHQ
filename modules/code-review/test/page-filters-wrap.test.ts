// The Reviews page's "Recent reviews" header: at 390px the filters (repo and Show selects) overflowed the card, which
// clips its content. The page's own styles wrap the header and let the filters wrap and shrink, so the selects stay
// inside the card. A string assertion on page.html: the rules are what makes the layout, so pin them here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../service/src/page.html", import.meta.url), "utf8");
const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
/** Every declaration block of a simple selector, e.g. `.filters` or `.head`, as written in the page's styles. */
const blocks = (selector: string) => [...styles.matchAll(new RegExp(`(^|[\\n;{}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[2]);

test("the Recent reviews filters and card header wrap so the selects stay inside the card", async () => {
  const filters = blocks(".filters").filter((b) => /display:\s*flex/.test(b));
  assert.equal(filters.length, 1, "one .filters rule lays out the selects");
  assert.match(filters[0], /flex-wrap:\s*wrap/, ".filters wraps its selects");
  assert.match(filters[0], /min-width:\s*0/, ".filters may shrink");
  assert.match(filters[0], /justify-content:\s*flex-end/, "the filters stay right-aligned when they fit");
  assert.match(filters[0], /gap:\s*8px/, "the filter gap is unchanged");

  const heads = blocks(".head").filter((b) => /flex-wrap/.test(b));
  assert.ok(heads.length >= 1, "the page wraps its card header so the filters can drop below the title");
  assert.match(heads[0], /flex-wrap:\s*wrap/);
});
