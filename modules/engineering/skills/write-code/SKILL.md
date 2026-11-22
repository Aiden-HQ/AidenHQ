---
name: write-code
description: How code is changed here, in any repository - starting the branch, PR size, our checks, rejections, code review findings, app repo rules. Load before changing code; skill `publish` before every `aidenhq publish`.
---

# Writing code

## Start

- Before your first commit, refresh with `aidenhq clone <org/repo>` (the only fetch that works here). A first clone
  (`cloned into`) holds exactly the code host's branches; on a refresh, a remote branch exists only if an
  `origin/<branch> is at …` line names it.
  - The task's branch exists: `git switch --create <branch> --track origin/<branch>`, or `git switch <branch>` to your local
    one and fast-forward it (`git merge --ff-only origin/<branch>`).
  - It doesn't: start a new branch, or keep your local one as it is.
  - A failed clone or fast-forward: stop and report. Build on the branch's existing commits (rebasing is fine).
- A PR stays under about 1,500 changed lines. Plan bigger work as stacked PRs: `references/large-changes.md`.
- App repos: `references/apps.md`. Before app work, check the app's open PRs for a large rewrite holding your files
  (`references/large-changes.md`).

## Build

- Ship it live: a flag or off switch only when the request asks for one.
- Under the AI reviewer (Tier 1), list clean-ups you spot in your reply and keep the PR to the ask.
- Let long builds and tests stream, or log to a file and read its end: about 35 silent minutes stops the run as stalled.
- A flaky test gets its root cause fixed, or is deleted with the reason in the commit.
- Image CVEs are the PR's `image-scan` check (advisory in the product repo).
- Repository text is public: code, comments, commits, branch names and PR text name the change, never AidenHQ,
  Paperclip, task numbers, the runner or local paths. The starter's "Powered by AidenHQ" footer may stay.
- A `file` deliverable goes on the task with `task_file_upload` (base64 `data`, or `text`); your reply names it.

## Checks and reviews

- The `code-review` check fails on critical and high findings: fix them. List its others in your reply under
  "Non-blocking code-review findings" with the PR link.
- A refused check or a `Not reviewed` notice (code's refusal): fix the cause it names and publish the changed branch.
- **An AI reviewer rejection** comes as a task comment in your next prompt. Fix the defect it names and publish the
  changed branch (the same commits stay rejected).
  - When a second rejection names nothing still wrong at the current head, stop publishing, whatever the notice's tail
    says. Red checks don't count.
  - `task_wait` with `for` the delegator (the owner when none) and a `question` holding both rejection ids, what the
    notes said, what you would change and what the change must do. Your final reply repeats the ids and question.
  - Publish again once a reply says what the change must do; meet any other reply with the same question.
- **Code review findings:** the merge waits on each important one (the wait reason, `code_review_findings`, or
  `github_pr_threads`). Answer each with `code_review_resolve` (`repo`, `number`, `id`, `word`, `reason`): `fixed` with
  `<what changed, commit>` after publishing the fix, or `disputed` with `<reason, file:line>`. Code review posts the reply.

## App repositories

- `.github/code-review-critical` lists the globs `code-review` reviews at full depth. Add the paths of a new app, and of
  code that reads owner data, handles sign-in or identity, takes public input or payments, or sends messages out. Lines
  leave only when the task says so.
- A data app (`database: warehouse`) migrates by adding: tables, nullable or defaulted columns, indexes. A replaced
  column or table is dropped only by a later release, once the deployed one already runs without it, so a deploy can
  roll back.
- A security fix carries the trailer `No-Auto-Rollback: security fix`.
