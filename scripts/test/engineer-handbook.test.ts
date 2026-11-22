// The Engineer's repair-loop rule: a second review rejection of the same change that names nothing still wrong with the
// current head stops the republish, and the run asks whoever delegated the task to clarify. The mission handbook states
// the rule and points at the skill; its steps live in the write-code skill (CLAUDE.md: a handbook links the skill).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { readInstructions } from "../handbook.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(import.meta.dirname, "../..");
let instance: string | undefined;
after(() => instance && rmSync(instance, { recursive: true, force: true }));

/** The Engineer's compiled handbook: the product compiled with the default bundle, once per run. */
function engineer() {
  if (!instance) {
    instance = mkdtempSync(join(tmpdir(), "engineer-"));
    mkdirSync(join(instance, "agents"));
    writeFileSync(join(instance, "instance.yaml"), YAML.stringify({
      product: "0".repeat(40),
      modules: BUNDLE,
      settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" },
    }));
  }
  const r = compile(product, instance);
  return readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: instance });
}

test("the compiled handbook carries the repair-loop rule and leaves its steps to write-code", () => {
  const text = engineer();
  const start = text.indexOf("**A repair loop stops at two rejections.**");
  assert.notEqual(start, -1, "the handbook has the repair-loop rule");
  const end = text.indexOf("\n\n", start);
  const rule = text.slice(start, end === -1 ? text.length : end);
  assert.match(rule, /AI reviewer's second rejection[\s\S]*names nothing still wrong with the current head/, "the stop is judged against the current head");
  assert.match(rule, /asks whoever delegated the task to clarify/, "the delegator is asked to clarify");
  assert.match(rule, /`write-code` holds the steps/, "the steps are the skill's, not the handbook's");
  assert.match(rule, /A rejection that names a defect still present is work to fix/, "a real defect is still fixed");
});

test("the write-code skill holds the stop steps, including the wait for the delegator", () => {
  const skill = readFileSync(join(product, "modules/engineering/skills/write-code/SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /second rejection names nothing still wrong at the current head, stop publishing/, "the stop is judged against the current head");
  assert.match(skill, /`task_wait` with `for` the delegator \(the owner when none\)/, "the run waits on the delegator, or the owner");
  assert.match(skill, /both rejection ids/, "both rejection ids go in the question");
  assert.match(skill, /final reply repeats the ids and question/, "the reply records the ids, since the Engineer cannot comment");
  assert.match(skill, /Publish again once a reply says what the change must do; meet any other reply with the same question/, "no new head before a resolving answer");
});
