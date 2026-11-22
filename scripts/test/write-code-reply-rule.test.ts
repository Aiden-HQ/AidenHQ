// The write-code skill's Publishing bullet governs what an agent's task reply may say. The AI reviewer reads that reply
// as context, never as part of the request, so the reply cannot widen the change's scope; and the ban on predicting a
// verdict has to leave the non-blocking findings list that Checks requires in the reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../../modules/engineering/skills/write-code/SKILL.md", import.meta.url), "utf8");

/** A section's top-level bullets, whitespace collapsed. The section ends at the next `## ` heading. */
function sectionBullets(heading) {
  const at = skill.indexOf(`\n## ${heading}\n`);
  assert.notEqual(at, -1, `the skill has a "## ${heading}" section`);
  const rest = skill.slice(at + 1);
  const end = rest.search(/\n## /);
  assert.notEqual(end, -1, `the "${heading}" section ends at the next heading`);
  return rest
    .slice(0, end)
    .split(/\n(?=- )/)
    .slice(1)
    .map((b) => b.replace(/\s+/g, " ").trim());
}

/** The one Publishing bullet that governs the task reply. */
function replyBullet() {
  const found = sectionBullets("Publishing").filter((b) => /task reply|your reply to the task/.test(b));
  assert.equal(found.length, 1, "exactly one Publishing bullet governs the task reply");
  return found[0];
}

test("the reviewer reads the reply as context, never as part of the request", () => {
  const rule = replyBullet();
  assert.match(rule, /as context/, "the reply is context");
  assert.match(rule, /never as part of the request/, "the reply is not part of the request");
  assert.match(rule, /never widens, narrows or authorises/, "the reply cannot change the scope");
});

test("the reply states the change, its evidence and what was left out, not a predicted verdict", () => {
  const rule = replyBullet();
  assert.match(rule, /states the change, its evidence and what was left out/, "the reply's contents are named");
  assert.match(rule, /says what you left out and why/, "what was left out belongs in the reply");
  assert.match(rule, /never a predicted verdict/, "a predicted verdict stays out");
});

test("the ban permits the non-blocking findings list Checks requires", () => {
  const rule = replyBullet();
  assert.match(rule, /findings still go in the reply under "Non-blocking code-review findings"/, "the required list is permitted");
  assert.match(rule, /a finding is not a verdict/, "a finding is told apart from a verdict");
  const checks = sectionBullets("Checks").find((b) => b.includes('"Non-blocking code-review findings"'));
  assert.ok(checks, "Checks has the bullet that names the findings heading");
  assert.match(checks, /in your reply under "Non-blocking code-review findings"/, "Checks requires the list in the task reply");
});
