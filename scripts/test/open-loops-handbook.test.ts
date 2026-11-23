// Intake's skills and handbooks mark a source task answered and leave it open: its tasks belong to the owner, so a
// `task_finish` with `issue` on one is refused ("only this job's own task is finished here").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");

const FILES = [
  "agents/inbox-agent/AGENTS.md",
  "agents/open-loops/AGENTS.md",
  "skills/scan-slack/SKILL.md",
  "skills/triage-email/SKILL.md",
  "skills/triage-slack/SKILL.md",
];

function text(file: string) {
  return readFileSync(join(product, "modules/open-loops", file), "utf8");
}

test("no open-loops skill or handbook finishes another task", () => {
  for (const file of FILES) {
    assert.doesNotMatch(
      text(file),
      /task_finish`?\s*\(\s*`?issue/i,
      `${file}: use \`task_comment\` and leave the owner's task open; \`task_finish\` (\`issue\`) on another task is refused`,
    );
  }
});

test("scan-slack marks an answered task and leaves it open", () => {
  const skill = text("skills/scan-slack/SKILL.md");
  assert.match(skill, /task_comment/, "the answered task gets a comment");
  assert.match(skill, /Answered in Slack/, "the comment says it was answered in Slack");
  assert.match(skill, /left open for the owner/, "the task stays open for the owner");
});
