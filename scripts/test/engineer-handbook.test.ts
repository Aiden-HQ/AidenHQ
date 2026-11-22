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
  const skill = readFileSync(join(product, "modules/engineering/skills/write-code/SKILL.md"), "utf8");
  const start = skill.indexOf("- A rejection of a change names a defect");
  assert.notEqual(start, -1, "the skill holds the repair-loop steps");
  const steps = skill.slice(start, skill.indexOf("\n- ", start + 1)).replace(/\s+/g, " ");
  assert.match(steps, /both rejection ids/, "both rejection ids go on the task");
  assert.match(steps, /`task_wait`s with `for` the delegator \(the owner when nobody delegated the task\)/, "the run waits on the delegator, or the owner when there is none");
  assert.match(steps, /both rejection ids, what the two notes said, what it would change, and what the change must do/, "the question carries the ids and the clarification");
  assert.match(steps, /the final reply repeats the two ids and the question onto the task/, "the reply records the ids, since the Engineer cannot comment");
  assert.match(steps, /publishes the next head only once a reply resolves the\s+question/, "no third head before a resolving answer");
  assert.match(steps, /an answer that asks something back, declines, or names no requirement is met\s+with the same question again/, "a non-answer gets the question, not a new head");
  assert.match(steps, /Only the AI reviewer's own rejection of the change counts toward the stop/, "only AI reviewer rejections count");
  assert.match(steps, /when its reason names something to change \(instance details to take out, a diff that no longer matches the head\), that is a defect to fix first/, "a Not reviewed refusal names a fix, not a refile");
  assert.match(steps, /When its reason names none \(the reviewer failed, so nothing was reviewed\), file the same change once more/, "reviewer silence is refiled once");
  assert.match(steps, /even though the rejection's own notice still ends "Fix that and file it\s+again": that tail states the\s+general case/, "the live notice is reconciled with the stop");
  assert.doesNotMatch(steps, /accept it as it stands/, "the delegator is asked to clarify, not to accept the change as it is");
});
