// WOR-8858: the 2026-11-19 sweep closed its part WOR-7562 and reported "1 closed" while the item it tracks — the parent on
// the owner's board — stayed todo. The handbook's Delivered step now says the parent is the board's item, that an
// owner-assigned parent is closed the same way (WOR-6662 was), and what a refused status call reports. The rule is stated
// as what to do (the product's handbook rule), so the test also keeps the prohibition the AI reviewer rejected out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { readInstructions } from "../handbook.mjs";
import { BUNDLE } from "./bundle.mjs";

const product = join(import.meta.dirname, "../..");

/** The Follow-up Tracker's compiled handbook: the product compiled with the default bundle plus open-loops. */
function compiled() {
  const dir = mkdtempSync(join(tmpdir(), "open-loops-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({
    product: "0".repeat(40),
    modules: [...BUNDLE, "open-loops"],
    settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" },
  }));
  const r = compile(product, dir);
  return readInstructions(r.paperclip, r.paperclip.agents["open-loops"], { repo: product, instanceDir: dir });
}

/** The Delivered bullet of "Each sweep" step 2: from its `- **Delivered:**` line to the next bullet. */
function deliveredBullet(text) {
  const start = text.indexOf("- **Delivered:**");
  assert.notEqual(start, -1, "the handbook has a Delivered bullet");
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n   - **");
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

test("the compiled Delivered bullet closes the parent on the owner's board, not the part", () => {
  const bullet = deliveredBullet(compiled());
  assert.match(bullet, /The parent is the item on the owner's board/, "the parent is the board's item");
  assert.match(bullet, /close the loop by closing the parent/i, "the loop is closed by closing the parent");
  assert.match(bullet, /count the parent's `done` as the close the sweep reports/, "the sweep's close is the parent's done");
  assert.match(bullet, /the loop stays open until the parent's `done`/, "the part's done does not close the loop");
});

test("the compiled Delivered bullet closes an owner-assigned parent the same way", () => {
  const bullet = deliveredBullet(compiled());
  assert.match(bullet, /An owner-assigned parent is closed the same way/, "owner-assigned parents are closed too");
  assert.match(bullet, /WOR-6662 was closed that way on 2026-11-18/, "the evidence for the owner-assigned case");
});

test("the compiled Delivered bullet reports a refused status call instead of calling the part the close", () => {
  const bullet = deliveredBullet(compiled());
  assert.match(bullet, /quote the tool's exact error on the part/, "the exact error goes on the part");
  assert.match(bullet, /"delivered, needs owner close" in the sweep summary/, "the sweep reports the item as needing the owner's close");
});

test("the rule stays positive instructions, not the prohibition the reviewer rejected", () => {
  // The AI reviewer rejected "a part's `done` never counts as the loop closed" against the handbook's positive-instruction
  // rule; the bullet states the close as the parent's done, so it needs no prohibition.
  assert.doesNotMatch(deliveredBullet(compiled()), /never counts/, "the prohibition is replaced by what to do");
});
