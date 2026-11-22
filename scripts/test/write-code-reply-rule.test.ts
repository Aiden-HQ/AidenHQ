// The write-code skill's Publishing bullet says what the task reply may say. It first said the reply is read "as part of
// the request", which blurred the reply into the scope: an agent could read it as licence to explain a scope deviation in
// its own reply instead of getting the delegator's word for it. The AI reviewer's policy makes the requesting agent's own
// account context, never part of the request. The bullet now says that, and it has to stay consistent with the Checks
// bullet that requires non-blocking code-review findings in the reply: a finding is not a verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../../modules/engineering/skills/write-code/SKILL.md", import.meta.url), "utf8");

/** A top-level bullet and its continuation lines, whitespace collapsed, by the text its first line starts with. */
function bullet(text, start) {
  const at = text.indexOf(start);
  assert.notEqual(at, -1, `the skill has a bullet starting "${start}"`);
  const rest = text.slice(at + 1);
  const end = rest.search(/\n- /);
  return rest.slice(0, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

const replyRule = () => bullet(skill, "- PR text, commit messages and code comments state facts about the change.");
const checksRule = () => bullet(skill, "- A PR's `code-review` check fails on critical or high findings");

test("the reply is context the reviewer reads, never part of the request", () => {
  const rule = replyRule();
  assert.match(rule, /The AI reviewer also reads that reply/, "the reviewer is named as the reply's reader");
  assert.match(rule, /as context/, "the reply is context");
  assert.match(rule, /never as part of the request/, "the reply is not part of the request");
  assert.match(rule, /never widens, narrows or authorises the change/, "the reply cannot change the scope");
});

test("the reply states the change, its evidence and what was left out, and never predicts a verdict", () => {
  const rule = replyRule();
  assert.match(rule, /states the change, its evidence and what was left out/, "the reply's contents are named");
  assert.match(rule, /never a predicted verdict on the change/, "a predicted verdict stays out");
  assert.match(rule, /your reply to the task, not the PR, says what you left out and why/, "what was left out belongs in the reply");
});

test("the ban allows the non-blocking findings the Checks bullet requires", () => {
  const rule = replyRule();
  assert.match(rule, /Non-blocking code-review findings still go in the reply under "Non-blocking code-review findings"/, "the required list is permitted");
  assert.match(rule, /a finding is not a verdict/, "a finding is told apart from a verdict");
  const checks = checksRule();
  assert.match(checks, /list them in your reply under "Non-blocking code-review findings"/, "Checks still requires the list");
});
