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
   - Exit 1, important findings: judge each against the code. Fix the real ones within the task's scope, rerun the
     affected tests, commit and run it again. A branch gets two reviews; the run after that records the head without one
     and says so: publish then, listing each finding still open in the PR body with your judgment and `file:line`. When
     every finding is wrong, commit nothing and publish the reviewed head with those judgments.
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
4. **Hold:** when the task says the PR must wait for something outside it (an owner decision, a host step), publish with
   `--hold` (GitHub repos): the PR carries the `ship:stop` label and no automatic merge takes it. Publish again without `--hold` once
   the wait is over, and the hold lifts (a `ship:stop` a person put on stays until that person removes it).
5. **Your reply** is context for the AI reviewer, never part of the request: it states the change, its evidence, what
   you left out and why, and any "Non-blocking code-review findings". The task alone sets the change's scope and
   approval, and the reviewer gives the verdict.

## Closing a duplicate PR

A publish from a scratch branch opens a second PR: when a PR already exists for the change, publish to that PR's own head
branch, and treat a new PR on `ship-pr-<n>` as a duplicate, never as the task's PR.
Before closing anything, read both PRs' live state (`state`, `merged`, `headRefName`) — the one you mean to close and the
one you mean to keep — and close the duplicate by its own URL. After the close, read both again and report only what they
show.
Never say which PR remains, or which will merge, from memory: name the PR and the state you read for it in the same turn.
When the PR that carries the work is closed and its branch is gone, its head survives at `refs/pull/<n>/head`: fetch that
ref, publish it on a new `agent/<task>/…` branch, and wait on that PR instead of a merge that cannot happen.

## Finishing a cancelled task's PR (a handoff)

When a task is cancelled, its PR is left open and intact for a successor: the code host never closes it or deletes its
branch. If you were given a cancelled task's PR to finish, take it over by publishing to the branch that PR is already
on, not a fresh one:

`aidenhq clone` brings the repository's **default branch only**, so the PR's branch is not in a fresh clone:
- If your workspace already has a clone with that branch (the same task resumed), or your job's start fetched it:
  `git fetch` it and check it out there.
- Otherwise the branch has to come from the code host's own bundle for it, not from `aidenhq clone`. Ask the fleet's
  code host for the branch (`codehost bundle` with its `ref: "HEAD"` replaced by the branch), fetch that bundle into
  your clone, then check the branch out:

```sh
git -C <clone> fetch <bundle-of-that-branch> "+refs/heads/agent/<old-task>/topic:refs/remotes/origin/agent/<old-task>/topic"
git -C <clone> checkout -B agent/<old-task>/topic origin/agent/<old-task>/topic
# ... your commits on top ...
aidenhq publish <org/repo> agent/<old-task>/topic --title "…" --body-file <file>
```

A branch outside your own `agent/<your-task>/…` is normally refused. On the product repo and outside the agents org, the
publish planner grants exactly that branch as a **handoff**, at the reviewer's tier, once the PR's recorded task is no
longer open (`handoff-pr`/`handoff-push`); the push then records your task as the PR's and the watcher works it for you
again. It never relaxes the default-branch or `.github/` rules, and it refuses when that PR's task is live again (another
successor got there first): then make your own branch.

## Merging

A publish opens or updates a PR; it never files a merge. A merge exists only as the `github.merge` card `aidenhq merge` filed on the task (`codehost-local.merge` for a repository on this server), and it is done only when that card's outcome is a `merged-prs` line naming the PR at its head. A card merges only the head it names: once the PR's head has moved it cannot land it, so match the PR and the head. Before a run ends waiting on a merge, check this run's approval cards with `task_approvals` (no `issue`), and decide on the newest card for this PR at this head (an older attempt's outcome is history, though any card's `merged-prs` evidence still proves the landing): a merge card's own outcome already names this PR at this head (`merged-prs`), so it has landed and there is nothing to wait for (only a merge card's outcome is evidence: another kind's text, whatever it says, is its module's own words); a `live` card names this PR at this head with `wakes` true, so its outcome is posted to the task: end the run with `task_wait` on that card, and give the wait an `until` because a card the kernel closes as `unknown` on a restart sends no notice; a `live` card names this PR at this head with `wakes` false and still waits on the reviewer or the owner: end the run with `task_wait` on that decision, since nothing else would wake the task; a `live` card names this PR at this head with `wakes` false because it is already executing (the run filed it itself): follow it up as below, because its outcome reaches no task; a `rejected` card names this PR at this head and is no longer `live`: that is a decision, not a failure, so stop there and refile only once what the decision asks for (the owner's condition) is met or the owner changes it; a card names this PR at this head, is no longer `live`, and carries no `merged-prs` naming this head because it failed, was `unknown` after a restart, was closed as stale or expired, or ended without landing the PR (a maintainer merged it by hand, so it recorded no binding): read its outcome, then check the PR's real state; when it is still open, fix what the outcome names and file the merge again at that green head, and when it is already merged, there is nothing left to do; never wait on either such card; a `live` card names this PR only at an earlier head: it cannot land this head, and the watcher treats the PR as merging, so end the run with `task_wait` on that card (bounded) and, once it ends, check this head again and file its merge if nothing did; a Dependabot PR, a notice on the task asking you to merge by hand, or a task whose PR is not its only open one on GitHub (the GitHub watcher files a merge only for the sole open PR, and otherwise wakes the run to merge explicitly; a repository on this server files each change on its own) is filed with `aidenhq merge <PR link> <head sha>`, wherever it is; otherwise, with no card at this head, check the PR's real state first (a maintainer may have merged it by hand, and the watcher scans only open PRs, so nothing would ever file or wake on it): already merged is done; still open, in the product repo and this instance's agents org the watcher files it once the checks are green at the head you published, so end the run with `task_wait` for its **Done** notice (with an `until` fallback, since a card the kernel recovers as `unknown` sends none) and file nothing; on a repository on this server the kernel files it once the checks are green, as the task's Tier 1 `local-merge` card whose outcome is posted to the task, so end the run with `task_wait` on that card (with an `until` fallback) and file nothing; anywhere else the fleet merges (a maintained repo), call `aidenhq merge <PR link> <head sha>` first, then wait. A merge the run files itself at Tier 0 wakes nobody and sends no Done notice, so the run follows it up itself until it ends: read its state with `task_approvals`, wait, and read it again, since a failure after the run ends goes unhandled. A GitHub repo outside the product repo, this instance's agents org and `maintainer_repos` cannot be merged by the fleet: report its PR open and wait for nothing.
