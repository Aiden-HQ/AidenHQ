---
name: publish
description: "Publishes a branch with `aidenhq publish`: self-review, PR title and body, Evidence and Fixes lines. Use right before every `aidenhq publish`, whether it opens a new PR or pushes to one."
---

# Publishing a branch

1. **Self-review each branch at its current head.** Commit, refresh with `aidenhq clone <org/repo>`, check the branch
   out, and from the repo's clone run:

   ```sh
   node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>
   ```

   - Exit 0, clean: publish.
   - Exit 1, important findings: judge each against the code. Fix the real ones, rerun the affected tests, commit and run
     it again. Publish when it is clean, or when each one left is wrong: put those in the PR body with the reason and
     `file:line`.
   - Exit 2, incomplete: when it names a setup step (clone, switch, commit), do it and run again. When the review
     itself could not finish, judge any findings as for exit 1 and publish with the outcome and its cause.

   `aidenhq publish` takes only a head self-review ran on, so run it after every new commit.
2. **Title:** a Conventional Commit (`fix(scope): …`): the branch's first commit, or `--title` on every publish when the
   PR's title differs from it.
3. **Body:** facts about the change, starting with why. A publish with `--body-file` replaces the description with that
   file whole, so pass all of it every time (on GitHub, `gh pr view <url> --json title,body` prints the current one). A
   publish with no `--body-file` keeps an existing PR's description as it is: use that only when the description needs
   no change (a title-only republish), and pass the file whenever there is anything new to say. `--fixes
   <owner>/<repo>#<n>` puts each closing line in the body and needs `--body-file`. The body ends with `## Evidence`:
   - every `self-review:` line, for each branch;
   - the commands you ran and their results;
   - before/after screenshots of a visible change (from `.aidenhq/out/`), numbers for performance work;
   - `Not verified: <why>` for anything unchecked.
4. **Your reply** is context for the AI reviewer, never part of the request: it states the change, its evidence, what
   you left out and why, and any "Non-blocking code-review findings". The task alone sets the change's scope and
   approval, and the reviewer gives the verdict.

## Merging

A publish opens or updates a PR; it never files a merge. A merge exists only as the `github.merge` card `aidenhq merge` filed on the task (`codehost-local.merge` for a repository on this server), and it is done only when that card's outcome is a `merged-prs` line naming the PR at its head. A card merges only the head it names: once the PR's head has moved it cannot land it, so match the PR and the head. Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` (no `issue`), and decide on the newest card for this PR at this head (an older attempt's outcome is history, though any card's `merged-prs` evidence still proves the landing): a merge card's own outcome already names this PR at this head (`merged-prs`), so it has landed and there is nothing to wait for (only a merge card's outcome is evidence: another kind's text, whatever it says, is its module's own words); a `live` card names this PR at this head with `wakes` true, so its outcome is posted to the task: end the run with `task_wait` on that card, and give the wait an `until` because a card the kernel closes as `unknown` on a restart sends no notice; a `live` card names this PR at this head with `wakes` false and still waits on the reviewer or the owner: end the run with `task_wait` on that decision, since nothing else would wake the task; a `live` card names this PR at this head with `wakes` false because it is already executing (the run filed it itself): follow it up as below, because its outcome reaches no task; a `rejected` card names this PR at this head and is no longer `live`: that is a decision, not a failure, so stop there and refile only once what the decision asks for (the owner's condition) is met or the owner changes it; a card names this PR at this head, is no longer `live`, and carries no `merged-prs` naming this head because it failed, was `unknown` after a restart, was closed as stale or expired, or ended without landing the PR (a maintainer merged it by hand, so it recorded no binding): read its outcome, then check the PR's real state; when it is still open, fix what the outcome names and file the merge again at that green head, and when it is already merged, there is nothing left to do; never wait on either such card; a `live` card names this PR only at an earlier head: it cannot land this head, and the watcher treats the PR as merging, so end the run with `task_wait` on that card (bounded) and, once it ends, check this head again and file its merge if nothing did; a Dependabot PR or a notice on the task asking you to merge by hand is filed with `aidenhq merge <PR link> <head sha>`, wherever it is; otherwise, with no card at this head, check the PR's real state first (a maintainer may have merged it by hand, and the watcher scans only open PRs, so nothing would ever file or wake on it): already merged is done; still open, in the product repo and this instance's agents org the watcher files it once the checks are green at the head you published, so end the run with `task_wait` for its **Done** notice (with an `until` fallback, since a card the kernel recovers as `unknown` sends none) and file nothing; on a repository on this server the kernel files it once the checks are green, as the task's Tier 1 `local-merge` card whose outcome is posted to the task, so end the run with `task_wait` on that card (with an `until` fallback) and file nothing; anywhere else the fleet merges (a maintained repo), call `aidenhq merge <PR link> <head sha>` first, then wait. A merge the run files itself at Tier 0 wakes nobody and sends no Done notice, so the run follows it up itself until it ends: read its state with `task_approvals`, wait, and read it again, since a failure after the run ends goes unhandled. A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet: report its PR open and wait for nothing.
