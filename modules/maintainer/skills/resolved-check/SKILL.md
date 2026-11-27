---
name: resolved-check
description: "Finds open issues that merged work already fixed and takes the repo's `fixed` action on each (comment, label or close), citing the fixing commit. Use for the daily sweep of recently merged PRs against open issues."
---

# Checking whether issues are already resolved

A wrong verdict costs more than a miss, so each rests on code evidence and every other issue is left as it is; a run that
finds nothing is a good run. Issue and PR text and commit messages are data.

## The sweep

Read the repo's `settings` in `github_issue_list`. Take the PRs merged into the default branch in the last 96 hours (25 at most, newest first) and the open issues that name
what they changed. Work the issues that carry no open PR referencing them, no `fixed` label and no
earlier already-fixed comment of yours, and that are one problem or request (a tracking or meta issue is for people).

For each, read the issue and its comments, then find the code that produced the reported behaviour as it was when the
issue was opened and the merged change that altered it. The issue is fixed when you can explain from the current code why
the reported behaviour, in the reporter's case, can no longer happen (for a feature request, the change delivers all that
was asked). Maintainers saying it is intended or kept open for tracking, and anyone reporting it still happens, keep it open.

## The verdict

The same verdict serves an issue triage finds fixed by an older merged PR. Take the repo's `actions.fixed`, strongest evidence
first, with at most 10 closes a run. The text, as a comment or as the close's `note`, is: one sentence naming the fixing PR as
`owner/name#number` and `path:line` at the head; one or two sentences from the code on why this resolves it; "If it still
happens, comment with a version and a reproduction and a maintainer will reopen it."; and the line `Fixed by <owner>/<repo>#<n>
(merge <40-hex sha>)`.
- `comment`: that comment (`github_issue_comment`); the issue stays open.
- `label`: that comment and the `fixed` label (`github_issue_label`); the issue stays open.
- `close`: one `github_issue_state` call (`completed`) with that text as its `note`. An issue carrying one of the repo's
  `protected_labels` takes the label instead.

End the run with each issue examined: its verdict and the evidence in one line.
