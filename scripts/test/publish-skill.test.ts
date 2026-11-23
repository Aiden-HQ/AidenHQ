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
  assert.match(publish, /Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` \(no `issue`\): a merge card for this PR/, "the check comes before the wait, with the call the Engineer makes");
  assert.match(publish, /a merge card for this PR at the head you published that is `live` and whose `wakes` is true wakes the task when it ends, so wait for it and file nothing/, "a live card at the published head that wakes the task is a wait");
  assert.match(publish, /with such a card but `wakes` false nothing wakes the task: when it still waits on the reviewer or the owner, end the run with `task_wait` on that decision and check again when it wakes/, "a pending decision is a durable wait, never an in-run poll");
  assert.match(publish, /a card's outcome that already names this PR at this head \(`merged-prs`\) means it has landed, so wait for nothing/, "a landed merge is not filed again");
  assert.match(publish, /In the product repo, this instance's agents org and a repository on this server, a green PR's merge is normally filed for you: wait for its \*\*Done\*\* notice and file nothing/, "only the watched repos have the merge filed for them");
  assert.match(publish, /a watched PR the code host woke you about because the task has several open there/, "the watcher's handoff to merge by hand is named");
  assert.match(publish, /A merge the run files itself sends no Done notice where it runs at Tier 0 \(`wakes: false`\)/, "a self-filed Tier 0 merge has no notice to wait for");
  assert.match(publish, /read its state with `task_approvals`, wait, and read it again/, "a still-running merge is followed up to its end by the run");
  assert.match(publish, /A card merges only the head it names: once the PR's head has moved it cannot land it/, "a card is matched by head, not only by PR");
  assert.match(publish, /A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet/, "a repo the fleet can't merge is reported open, not waited on");
  assert.match(publish, /`codehost-local\.merge` for a repository on this server/, "the kind is named for both code hosts");
  assert.doesNotMatch(publish, /with no merge card the PR is only open/, "the unconditional filing sentence is gone");
});
