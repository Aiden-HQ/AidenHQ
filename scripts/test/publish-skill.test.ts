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
  assert.match(publish, /A card merges only the head it names: once the PR's head has moved it cannot land it/, "a card is matched by head, not only by PR");
  assert.match(publish, /Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` \(no `issue`\), and decide on the newest card for this PR at this head/, "the check comes before the wait, on the newest attempt, with the call the Engineer makes");
  assert.match(publish, /a merge card's own outcome already names this PR at this head \(`merged-prs`\), so it has landed and there is nothing to wait for \(only a merge card's outcome is evidence/, "a landed merge is not filed again, and only a merge card's outcome counts");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` true, so its outcome is posted to the task: end the run with `task_wait` on that card, and give the wait an `until`/, "a card that wakes the task is a durable wait with a fallback");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` false and still waits on the reviewer or the owner: end the run with `task_wait` on that decision/, "a pending decision is a durable wait, never an in-run poll");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` false because it is already executing \(the run filed it, or the kernel filed it for a local change\): follow it up as below/, "an executing merge that wakes nobody is followed up by the run");
  assert.match(publish, /a `live` card names this PR only at an earlier head: it cannot land this head, and the watcher treats the PR as merging, so end the run with `task_wait` on that card \(bounded\) and, once it ends, check this head again and file its merge if nothing did/, "a card at an older head is waited on, then this head is checked again");
  assert.match(publish, /otherwise, with no card at this head, in the product repo/, "a missing card is named as its own case");
  assert.match(publish, /a `rejected` card names this PR at this head and is no longer `live`: that is a decision, not a failure, so stop there and refile only once what the decision asks for \(the owner's condition\) is met or the owner changes it/, "an explicit rejection is its own case, before any retry");
  assert.match(publish, /a card names this PR at this head, is no longer `live`, and carries no `merged-prs` naming this head because it failed, was `unknown` after a restart, was closed as stale or expired, or ended without landing the PR/, "a terminal card without evidence is its own case");
  assert.match(publish, /read its outcome, then check the PR's real state; when it is still open, fix what the outcome names and file the merge again at that green head, and when it is already merged, there is nothing left to do/, "the PR's real state decides whether to refile");
  assert.match(publish, /a Dependabot PR or a notice on the task asking you to merge by hand is filed with `aidenhq merge <PR link> <head sha>`, wherever it is/, "a Dependabot or handoff PR is filed by the run, ahead of the repo defaults");
  assert.match(publish, /in the product repo and this instance's agents org the watcher files it once the checks are green at the head you published, so end the run with `task_wait` for its \*\*Done\*\* notice \(with an `until` fallback/, "the watched repos file the merge, and the wait is bounded");
  assert.match(publish, /on a repository on this server the kernel files it once the checks are green, so end the run the same way and file nothing/, "a local merge is filed for the run, never before its checks");
  assert.match(publish, /anywhere else the fleet merges \(a maintained repo\), call `aidenhq merge <PR link> <head sha>` first, then wait/, "the run files where nothing else does");
  assert.match(publish, /A merge the run files itself at Tier 0 wakes nobody and sends no Done notice/, "a self-filed Tier 0 merge has no notice to wait for");
  assert.match(publish, /read its state with `task_approvals`, wait, and read it again/, "a still-running merge is followed up to its end by the run");
  assert.match(publish, /A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet/, "a repo the fleet can't merge is reported open, not waited on");
  assert.match(publish, /`codehost-local\.merge` for a repository on this server/, "the kind is named for both code hosts");
  assert.doesNotMatch(publish, /with no merge card the PR is only open/, "the unconditional filing sentence is gone");
  assert.doesNotMatch(publish, /unless the task has several open PRs there, and then the code host wakes the task/, "the watcher's several-PR handoff is a notice case, not an exception to check");
});
