// The publish skill's last step governs the task reply the AI reviewer reads as context: the change, its evidence, what
// was left out, and the non-blocking code-review findings write-code's checks send there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (s: string) => readFileSync(new URL(`../../modules/engineering/skills/${s}/SKILL.md`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("the reply states the change, its evidence, what was left out and the non-blocking findings", () => {
  const publish = read("publish");
  assert.match(publish, /Your reply\*\* states the change, its evidence, what you left out and why, and any "Non-blocking code-review findings"/);
  assert.match(publish, /The AI reviewer reads it as context/);
  assert.match(read("write-code"), /in your reply under "Non-blocking code-review findings"/, "write-code sends the findings to the reply");
});

test("self-review is publish's first step, and its lines go in Evidence", () => {
  const publish = read("publish");
  assert.ok(publish.indexOf("node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>") < publish.indexOf("**Title:**"), "self-review comes first");
  assert.match(publish, /every `self-review:` line, for each branch/);
});
