// A publish stays inside the brief: the Engineer handbook says the diff carries the change the task names, and an
// access rule, a config change or an unrelated file comes in only when the brief asks for it by name. A fix that cannot
// work without one is asked about with the tool the Engineer actually holds (`task_wait` for its delegator), which keeps
// the task open for the widened brief.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { readInstructions } from "../handbook.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(import.meta.dirname, "../..");

/** The Engineer's compiled handbook: the product compiled with the default bundle. */
function compiled() {
  const dir = mkdtempSync(join(tmpdir(), "engineer-scope-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({
    product: "0".repeat(40),
    modules: [...BUNDLE],
    settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" },
  }));
  const r = compile(product, dir);
  return readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: dir });
}

/** The scope paragraph, whitespace collapsed: from "Change only what the brief asks" to the next paragraph. */
function scopeParagraph(text = compiled()) {
  const at = text.indexOf("Change only what the brief asks");
  assert.notEqual(at, -1, "the handbook has the scope rule");
  const rest = text.slice(at);
  const end = rest.indexOf("\n\n");
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

test("the Engineer's handbook keeps a publish to the brief's scope", () => {
  const rule = scopeParagraph();
  assert.match(rule, /the diff carries the change the task names/, "the diff is the task's change");
  for (const outside of [/access rule/i, /config/i, /unrelated file/i]) assert.match(rule, outside, `${outside} is named as out of scope`);
  assert.match(rule, /brief asks for it by name/i, "each one needs the brief to name it");
});

test("a fix that needs something outside the brief asks with task_wait and leaves the task open", () => {
  const rule = scopeParagraph();
  assert.match(rule, /`task_wait`/, "the run ends with the tool it holds");
  assert.match(rule, /delegator/i, "the question goes to the delegator");
  assert.match(rule, /(instead of|rather than)\b[^.]*\badd/i, "the change is not added");
  assert.match(rule, /(task|it) (stays|remains|is left) open/i, "the task stays open for the widened brief");
});
