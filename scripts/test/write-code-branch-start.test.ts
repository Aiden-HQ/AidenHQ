// The write-code skill's branch-start step covers a task whose branch an earlier run already pushed. The run must
// refresh the code host before its first commit and add to that branch's remote head, never replay its own history.
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

/** The one Start from the repository bullet that governs the task's branch. */
function branchStartBullet() {
  const found = sectionBullets("Start from the repository").filter((b) => /Before your first commit/.test(b));
  assert.equal(found.length, 1, "exactly one Start from the repository bullet governs the branch start");
  return found[0];
}

test("the branch start refreshes the code host and begins from the task's remote head", () => {
  const rule = branchStartBullet();
  assert.match(rule, /Before your first commit[^.]*refresh the code host's branches with `aidenhq clone <org\/repo>`/, "the refresh comes before the first commit");
  assert.match(rule, /`git switch --create <branch> --track origin\/<branch>`/, "a new local branch starts at the remote tip");
  assert.match(rule, /A first clone prints\s+`cloned into` and holds exactly the code host's branches/, "a first clone has the code host's branches");
  assert.match(rule, /a refresh of an existing clone prints an\s+`origin\/<branch> is at …` line for each branch and keeps a deleted branch's old ref, so after a refresh treat\s+`origin\/<branch>` as present only when its line is in the output/, "a deleted branch's stale ref is absent after a refresh");
  assert.match(rule, /When it is absent, start a new branch unless a\s+local branch of that name already exists, in which case use it as it is/, "an absent remote branch starts fresh or keeps the local branch");
});

test("an existing local branch keeps its unpushed commits", () => {
  const rule = branchStartBullet();
  assert.match(rule, /fast-forward it \(`git merge --ff-only origin\/<branch>`\), which keeps its unpushed commits/, "the local branch advances without losing its commits");
  assert.match(rule, /If the local branch cannot be fast-forwarded, stop and report rather than reset or force it/, "a failed fast-forward stops the run");
});

test("the branch is never rebuilt from workspace history and forced over the remote", () => {
  const rule = branchStartBullet();
  assert.match(rule, /Never rebuild the branch's changes from your workspace history and force that copy over the remote/, "a parallel rewrite is forbidden");
  assert.match(rule, /rebasing the branch's existing commits is not rebuilding it/, "rebasing the existing branch stays allowed");
});
