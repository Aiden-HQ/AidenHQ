---
name: publish
description: Load right before every `aidenhq publish` (a new PR or a push to one) - self-review, PR title and body, Evidence, Fixes.
---

# Publishing a branch

1. **Self-review each branch at its current head.** Commit everything, refresh with `aidenhq clone <org/repo>`, check the
   branch out, and from the repo's clone run:

   ```sh
   node /opt/aidenhq/code-review/self-review.ts <base-branch> <branch>
   ```

   - Exit 0, clean: publish.
   - Exit 1, important findings: judge each against the code. Fix the real ones, run the tests, commit and run it
     again. Publish when it is clean, or when each important finding left is one you judge wrong: put it in the PR body
     with the reason and `file:line`.
   - Exit 2, incomplete: when it names a setup step (clone, switch, commit), do it and run again. When the review itself
     could not finish, or fixes make no progress, publish with the outcome and its cause.

   `aidenhq publish` takes only a head self-review ran on, so run it after every new commit.
2. **Title:** a Conventional Commit (`fix(scope): …`), from the branch's first commit or `--title`.
3. **Body:** plain facts for the repository's reviewers: why, and what changed. Pass `--fixes <owner>/<repo>#<n>` for
   each issue it fixes, on every publish. It ends with `## Evidence`:
   - every `self-review:` line, for each branch;
   - the commands you ran and their results;
   - before/after screenshots of a visible change (from `.aidenhq/out/`, each named), numbers for performance work;
   - `Not verified: <why>` for anything unchecked.
4. **Your reply** states the change, its evidence, what you left out and why, and any "Non-blocking code-review
   findings". The AI reviewer reads it as context.
