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
  assert.match(publish, /Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` \(no `issue`\), and take the first case that fits/, "the check comes before the wait, with the call the Engineer makes");
  assert.match(publish, /an outcome already names this PR at this head \(`merged-prs`\), so it has landed and there is nothing to wait for/, "a landed merge is not filed again");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` true, so its outcome is posted to the task: end the run with `task_wait` on that card, and give the wait an `until`/, "a card that wakes the task is a durable wait with a fallback");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` false and still waits on the reviewer or the owner: end the run with `task_wait` on that decision/, "a pending decision is a durable wait, never an in-run poll");
  assert.match(publish, /a `live` card names this PR at this head with `wakes` false because it is already executing \(the run filed it, or the kernel filed it for a local change\): follow it up as below/, "an executing merge that wakes nobody is followed up by the run");
  assert.match(publish, /no card names this PR at this head \(none filed yet, or one bound to an earlier head, which cannot land this one\)/, "a missing or stale card is named as its own case");
  assert.match(publish, /a card names this PR at this head, is no longer `live`, and did not land it \(failed, `unknown` after a restart, rejected, stale or expired\): read its outcome, fix what it names, and file the merge again at the head that is green; never wait on that card/, "a terminal card that did not land is handled, not waited on");
  assert.match(publish, /a Dependabot PR, or a case a notice on the task asks you to merge by hand, is filed with `aidenhq merge <PR link> <head sha>`/, "a Dependabot or handoff PR is filed by the run, ahead of the repo defaults");
  assert.match(publish, /in the product repo and this instance's agents org the watcher files it once the checks are green at the head you published, so wait for its \*\*Done\*\* notice and file nothing/, "the watched repos file the merge and its notice");
  assert.match(publish, /on a repository on this server the kernel files it once the checks are green, so wait for that card and file nothing/, "a local merge is filed for the run, never before its checks");
  assert.match(publish, /anywhere else the fleet merges \(a maintained repo\), call `aidenhq merge <PR link> <head sha>` first, then wait/, "the run files where nothing else does");
  assert.match(publish, /A merge the run files itself at Tier 0 wakes nobody and sends no Done notice/, "a self-filed Tier 0 merge has no notice to wait for");
  assert.match(publish, /read its state with `task_approvals`, wait, and read it again/, "a still-running merge is followed up to its end by the run");
  assert.match(publish, /A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet/, "a repo the fleet can't merge is reported open, not waited on");
  assert.match(publish, /`codehost-local\.merge` for a repository on this server/, "the kind is named for both code hosts");
  assert.doesNotMatch(publish, /with no merge card the PR is only open/, "the unconditional filing sentence is gone");
  assert.doesNotMatch(publish, /unless the task has several open PRs there, and then the code host wakes the task/, "the watcher's several-PR handoff is a notice case, not an exception to check");
});
