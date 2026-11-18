# codehost-github

The duplicate-card guard: a push or PR whose branches are already on (or file-identical to) the repo's current default branch, or a merge of PRs all already merged, files no card; the task gets the evidence, reason `already_applied`. It refreshes the workspace's origin/main from GitHub first, so a card is always bound to GitHub's own main.
