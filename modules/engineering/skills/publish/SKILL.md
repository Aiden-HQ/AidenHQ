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

A publish opens or updates a PR; it never files a merge. A merge exists only as the `github.merge` card `aidenhq merge` filed on the task, and it is done only when that card's outcome is a `merged-prs` line naming the PR at its head. Before a run ends waiting on a merge, check the task's approvals for that card: with no merge card the PR is only open and nothing will wake the task — file the merge, then wait.
