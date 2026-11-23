// The publish skill's last step governs the task reply the AI reviewer reads as context: the change, its evidence, what
// was left out, and the non-blocking code-review findings write-code's checks send there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (s: string) => readFileSync(new URL(`../../modules/engineering/skills/${s}/SKILL.md`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("the reply states the change, its evidence, what was left out and the non-blocking findings", () => {
  const publish = read("publish");
  assert.match(publish, /it states the change, its evidence, what you left out and why, and any "Non-blocking code-review findings"/);
  assert.match(publish, /context for the AI reviewer, never part of the request/, "the reply is context, not the request");
  assert.match(publish, /The task alone sets the change's scope and approval, and the reviewer gives the verdict/, "the reply neither widens, authorises nor predicts");
  assert.match(read("write-code"), /in your reply under "Non-blocking code-review findings"/, "write-code sends the findings to the reply");
});

test("self-review is publish's first step, and its lines go in Evidence", () => {
  const publish = read("publish");
  const review = publish.indexOf("node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>"), title = publish.indexOf("**Title:**");
  assert.ok(review !== -1 && title !== -1 && review < title, "self-review comes first");
  assert.match(publish, /every `self-review:` line, for each branch/);
});

test("a publish never files a merge: the run checks the task's merge card before waiting", () => {
  const publish = read("publish");
  assert.match(publish, /A publish opens or updates a PR; it never files a merge\./, "a publish only opens or updates the PR");
  assert.match(publish, /A merge exists only as the `github\.merge` card `aidenhq merge` filed on the task/, "the merge is the card's");
  assert.match(publish, /done only when that card's outcome is a `merged-prs` line naming the PR at its head/, "done means the outcome names the PR at its head");
  assert.match(publish, /Before a run ends waiting on a merge, check the task's approvals for that card/, "the check comes before the wait");
  assert.match(publish, /Your task's own PR in a watched repo \(the product repo and the agents org\) merges without you/, "a watched repo's own PR merges without the Engineer");
  assert.match(publish, /once its checks are green at the head you published, the code host files that merge and its Done notice arrives on the task/, "the code host files it and the Done notice wakes the task");
  assert.match(publish, /In a repo the watch does not merge for you \(a maintained repo elsewhere\), or when a notice on the task asks, file the merge, then wait/, "only an unwatched repo or a notice has the Engineer file it");
  assert.match(publish, /`codehost-local\.merge` on a repo on this server/, "the kind is named for both code hosts");
  assert.doesNotMatch(publish, /nothing will wake the task/, "the paragraph never claims nothing will wake the task");
});
