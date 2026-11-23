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

A publish opens or updates a PR; it never files a merge. A merge exists only as the `github.merge` card `aidenhq merge` filed on the task (`codehost-local.merge` for a repository on this server), and it is done only when that card's outcome is a `merged-prs` line naming the PR at its head. A card merges only the head it names: once the PR's head has moved it cannot land it, so match the PR and the head. In the product repo and this instance's agents org a green PR's merge is filed for you and sends a **Done** notice; on a repository on this server the kernel files it too; read that card's `wakes` to know whether its outcome reaches you. Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` (no `issue`): a merge card for this PR at the head you published that is `live` and whose `wakes` is true posts its outcome to the task, so end the run with `task_wait` on that card, with a timed fallback (`until`) because a card the kernel closes as `unknown` on a restart sends no notice, and file nothing; with such a card but `wakes` false nothing wakes the task: when it still waits on the reviewer or the owner, end the run with `task_wait` on that decision and check again when it wakes; when it is already executing (the run filed it, or the kernel did for a local change), follow it up as below; with no live card at the published head (none yet, or one bound to an earlier head, which cannot land this one), file it with `aidenhq merge <PR link> <head sha>` and follow it up as below; a card's outcome that already names this PR at this head (`merged-prs`) means it has landed, so wait for nothing. Anywhere else (a maintained repo the watch does not merge for, a Dependabot PR, a watched PR the code host woke you about because the task has several open there, or when a notice on the task asks), call `aidenhq merge <PR link> <head sha>` first, then wait. A merge that runs at Tier 0 and wakes nobody (`wakes: false`) sends no Done notice, so the run follows it up itself until it ends: read its state with `task_approvals`, wait, and read it again, since a failure after the run ends goes unhandled. A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet: report its PR open and wait for nothing.
