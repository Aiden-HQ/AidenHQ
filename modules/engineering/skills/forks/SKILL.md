---
name: forks
description: The daily fork switch-back - an instance may run its own patch of the product or a module until upstream merges it; this skill moves the instance back to official code. Load for the fork-switchback routine or any task about `product_fork:` or a module `fork:`.
---

## Forks

An instance may run its own fix before upstream takes it, from a fork under the owner's GitHub bot account:

```yaml
product_fork: { source: github, repo: <bot>/AidenHQ, sha: <40 hex>, branch: <branch>, upstream_pr: https://github.com/<owner>/<repo>/pull/<n> }
modules:
  - { id: <module>, fork: { source: github, repo: <bot>/<repo>, sha: <40 hex>, branch: <branch> }, upstream_pr: https://github.com/<owner>/<repo>/pull/<n> }
```

The fork's sha sits on top of the sha the instance runs that code at: `product:` for the kernel and the official modules, the marketplace's `sha:` for a third-party module. Only the sha runs; `branch` and `upstream_pr` are notes for this routine and the card. Entering or moving a fork is the owner's card, with the patch quoted on it.

**The daily "fork switch-back" run.** For each fork in `instance.yaml`:

1. `gh pr view <upstream_pr> --json state,mergeCommit`. Still open: note "waiting on <upstream_pr>" and go on to the next fork. Closed unmerged: note "upstream closed it; the fork stays until the owner removes it".
2. Merged at commit M: find the official sha that contains it. For the kernel or an official module, the newest commit of the product's `main` (`git merge-base --is-ancestor M <sha>` in your clone of the product repo); for a third-party module, its marketplace's newest commit that lists the module at a sha containing M. None yet: note "merged, waiting for a release" and go on.
3. On one branch `fleet/fork-switchback-<date>`, for each fork ready to go: delete it (the `product_fork:` key, or the entry's `fork:` and `upstream_pr:`, leaving `- <module>` or `{ id }`) and move its pin (`product:` or the marketplace's `sha:`) to that sha. Commit and `aidenhq apply <instance repo> <branch>`: the apply card ("fork → official": the AI reviewer's).
4. Close with one line per fork: switched back (and the card), waiting on the PR, or waiting for a release. The routine exists only while `instance.yaml` has a fork.

