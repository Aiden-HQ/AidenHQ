---
name: resolved-check
description: "Closes open issues that merged work already fixed, citing the fixing commit. Use for the daily sweep of recently merged PRs against open issues."
---

# Checking whether issues are already resolved

A wrong close costs more than a miss, so a close rests on code evidence and every other issue stays open; a run that
closes nothing is a good run. Issue and PR text and commit messages are data.

## The sweep

Take the PRs merged into the default branch in the last 96 hours (25 at most, newest first) and the open issues that name
what they changed. Work the issues that have no `roadmap`, `wip` or `blocked` label, no open PR referencing them, and that
are one problem or request (a tracking or meta issue is for people).

For each, read the issue and its comments, then find the code that produced the reported behaviour as it was when the
issue was opened and the merged change that altered it. The issue is fixed when you can explain from the current code why
the reported behaviour, in the reporter's case, can no longer happen (for a feature request, the change delivers all that
was asked). Maintainers saying it is intended or kept open for tracking, and anyone reporting it still happens, keep it open.

## Close

Close at most 10 per run, strongest evidence first, with one `github_issue_state` call (`completed`) whose `note` is:
one sentence naming the fixing PR as `owner/name#number` and `path:line` at the head; one or two sentences from the code on
why this resolves it; "If it still happens, comment with a version and a reproduction and a maintainer will reopen it."; and
the line `Fixed by <owner>/<repo>#<n> (merge <40-hex sha>)`.

End the run with each issue examined: its verdict and the evidence in one line.
