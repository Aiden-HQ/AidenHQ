---
name: publish
description: Load right before every `aidenhq publish` (a new PR or a push to one) - self-review, PR title and body, Evidence, Fixes.
---

# Publishing a branch

1. **Self-review each branch at its current head.** Commit, refresh with `aidenhq clone <org/repo>`, check the branch
   out, and from the repo's clone run:

   ```sh
   node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>
   ```

   - Exit 0, clean: publish.
   - Exit 1, important findings: judge each against the code. Fix the real ones, rerun the affected tests, commit and run
     it again. Publish when
     it is clean, or when each one left is wrong: put those in the PR body with the reason and `file:line`.
   - Exit 2, incomplete: when it names a setup step (clone, switch, commit), do it and run again. When the review
     itself could not finish, judge any findings as for exit 1 and publish with the outcome and its cause.

   `aidenhq publish` takes only a head self-review ran on, so run it after every new commit.
2. **Title:** a Conventional Commit (`fix(scope): …`): the branch's first commit, or `--title` on every publish when the
   PR's title differs from it.
3. **Body:** facts about the change, starting with why. Each publish replaces the description, so keep your body file and
   pass all of it with `--body-file` every time (on GitHub, `gh pr view <url> --json title,body` prints the current
   one), and `--fixes
   <owner>/<repo>#<n>` for each issue it fixes. It ends with `## Evidence`:
   - every `self-review:` line, for each branch;
   - the commands you ran and their results;
   - before/after screenshots of a visible change (from `.aidenhq/out/`), numbers for performance work;
   - `Not verified: <why>` for anything unchecked.
4. **Your reply** is context for the AI reviewer, never part of the request: it states the change, its evidence, what
   you left out and why, and any "Non-blocking code-review findings". The task alone sets the change's scope and
   approval, and the reviewer gives the verdict.
