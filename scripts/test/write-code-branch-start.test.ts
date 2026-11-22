// The write-code skill's branch start: refresh the code host before the first commit and build on the branch's remote
// head, never on a replay of the workspace's own history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../../modules/engineering/skills/write-code/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");

test("the branch start refreshes the code host and begins from the task's remote head", () => {
  assert.match(skill, /Before your first commit, refresh with `aidenhq clone <org\/repo>`/);
  assert.match(skill, /a remote branch exists only if an `origin\/<branch> is at …` line names it/, "a deleted branch's stale ref doesn't count");
  assert.match(skill, /`git switch --create <branch> --track origin\/<branch>`/);
  assert.match(skill, /`git merge --ff-only origin\/<branch>`/, "a local branch fast-forwards, keeping its commits");
  assert.match(skill, /A failed clone or fast-forward: stop and report. Build on the branch's existing commits \(rebasing is fine\)/);
});
