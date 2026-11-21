// The Engineer's repair-loop rule: a second review rejection of the same change that names no new defect stops the
// republish, and the run asks whoever delegated the task to clarify or accept instead of opening a third head.
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
function engineer() {
  const dir = mkdtempSync(join(tmpdir(), "engineer-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({
    product: "0".repeat(40),
    modules: BUNDLE,
    settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" },
  }));
  const r = compile(product, dir);
  return readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: dir });
}

/** The repair-loop paragraph, from its bold lead to the next blank line. */
function rule(text: string) {
  const start = text.indexOf("**A repair loop stops at two rejections.**");
  assert.notEqual(start, -1, "the handbook has the repair-loop rule");
  return text.slice(start, text.indexOf("\n\n", start)).replace(/\s+/g, " ");
}

test("the compiled handbook stops a republish after two rejections that name no new defect", () => {
  const r = rule(engineer());
  assert.match(r, /the AI reviewer rejects the same change twice in a row/, "two rejections of the same change");
  assert.match(r, /neither note names a new, specific defect/, "no new specific defect in either note");
  assert.match(r, /the run stops republishing that change/, "the republish stops");
});

test("the compiled handbook asks the delegator to clarify or accept, naming both rejection ids", () => {
  const r = rule(engineer());
  assert.match(r, /it comments on the task with both rejection ids/, "both rejection ids go on the task");
  assert.match(r, /`task_wait`s \(`for` the delegator\)/, "the wait is the task tool");
  assert.match(r, /asks whoever delegated the task to clarify what the change must do or to accept it as it stands/, "the question is clarify or accept");
  assert.match(r, /It publishes the next head once that answer arrives/, "no third head before the answer");
});

test("a rejection that names a new defect is still answered by a changed branch", () => {
  assert.match(rule(engineer()), /A rejection that names a new defect is work to fix, so it is answered by a changed branch\./);
});
