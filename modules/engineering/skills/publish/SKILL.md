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

A publish opens or updates a PR; it never files a merge. A merge exists only as the `github.merge` card `aidenhq merge` filed on the task (`codehost-local.merge` for a repository on this server), and it is done only when that card's outcome is a `merged-prs` line naming the PR at its head. A card whose head moved is closed and filed again for the current head, so match the PR, and before a run ends waiting on a merge check this run's approval cards with `task_approvals` (no `issue`): a merge card for this PR that is still open or running and whose `wakes` is true wakes the task when it ends, so wait for it and file nothing; with no such card, call `aidenhq merge <PR link> <head sha>` and wait. In the product repo and on this server a green PR's merge is normally filed for you, unless the task has several open PRs there, and then the code host wakes the task to merge the one you mean. A merge the run files itself sends no Done notice where it runs at Tier 0 (`wakes: false`), so the run follows it up itself until it ends: read its state with `task_approvals`, wait, and read it again, since a failure after the run ends goes unhandled. A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet: report its PR open and wait for nothing.
