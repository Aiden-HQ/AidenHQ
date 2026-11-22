---
name: forks
description: The daily fork switch-back - move an instance off its own product or module patch (`product_fork:` or a module `fork:`) once upstream merged it. Load for the fork-switchback routine or any task about `product_fork:` or a module `fork:`.
---

# Forks

An instance may run its own patch from the owner's bot account until upstream merges it:

```yaml
product_fork: { source: github, repo: <bot>/AidenHQ, sha: <40 hex>, branch: <branch>, upstream_pr: https://github.com/<owner>/<repo>/pull/<n> }
modules:
  - { id: <module>, fork: { source: github, repo: <bot>/<repo>, sha: <40 hex>, branch: <branch> }, upstream_pr: https://github.com/<owner>/<repo>/pull/<n> }
```

The fork's sha sits on top of the sha the instance runs that code at (`product:`, or the marketplace's `sha:` for a
third-party module). Only the sha runs. Entering or moving a fork is the owner's card, with the patch quoted.

**Daily switch-back run.** For each fork in `instance.yaml`:

1. `gh pr view <upstream_pr> --json state,mergeCommit`. Open: note "waiting on <upstream_pr>". Closed unmerged: note "upstream
   closed it; the fork stays until the owner removes it".
2. Merged at M: find the official revision containing it.
   - Kernel and official modules: the newest product `main` commit containing M (`git merge-base --is-ancestor M <sha>` in
     your product clone); M itself qualifies when it is that commit. It becomes `product:`.
   - Third-party module: a forked entry has no `sha` of its own; its base is the marketplace listing at the marketplace's
     `sha:`. Check in the module's own repo whether that listing's revision contains M; if not, walk the marketplace's commits after the
     pinned one, newest first: the first whose listing contains M is the card's new marketplace `sha:`; never an older or
     unrelated commit (it would roll other modules back). A marketplace has one pin: choose it jointly for every fork on it,
     remove only forks whose fix that pin contains, and leave the others in place.
   - None yet: note "merged, waiting for a release".
3. On `fleet/fork-switchback-<date>`, for each ready fork delete `product_fork:`, or the entry's `fork:` and `upstream_pr:`
   (keep the module's full id, e.g. `twin@acme`), and change only the pin from step 2, to a revision you verified in
   step 2 (never an unchecked M). Leave every other pin as it is. Commit and `aidenhq apply <instance repo> <branch>`
   (the "fork → official" card, the AI reviewer's); its reply names any other module whose revision a marketplace `sha:`
   change moves.
4. Close with one line per fork: switched back (card), waiting on the PR, or waiting for a release.
