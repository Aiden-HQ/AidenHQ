# maintainer

## What it does

Looks after the GitHub repos you list in `maintainer_repos`. It validates each issue labelled for a fix (default
`agent-fix`), hands the fix to an engineer and sees it through to a merged PR that closes the issue. Per repo it can also label feature requests and build those you mark `agent-build`, and nudge then close quiet
contributor PRs.

## Connect

Needs the `github` module with the owner signed in to GitHub, and the owner's account able to reach each listed repo. The Fleet page (Maintainer) shows each repo as a card with a one-line summary of what the Maintainer does there, and its settings in plain sections: Issues (fix labelled issues, triage, feature requests), When triage finds (a duplicate, not a bug or request, already fixed: comment, label or close), Cleanup (no reply, inactive issues, inactive contributor PRs), Pull requests (Dependabot) and Advanced (fix label, trusted roles, never-close labels). Edits go into one draft saved from the board's bar. It is a module view the `maintainer` connection serves (`maintainer_config`, `maintainer_configure`, the owner's own calls, never an agent's).

## What agents get

The `maintainer` agent holds the roles `maintainer` and `product-issues` and uses `github` tools to read, label, comment
and set state on issues, list PRs and read repo files. A watcher service reads the github change feed's issue events from the kernel's log and files a task for each newly
labelled issue within about a minute of its label.

Every setting is per repo, a field of its `maintainer_repos` entry (`fixes`, `triage`, `features`, `dependabot`, `quiet_pr_days`, `actions` { duplicate, invalid, fixed }, `no_reply_days`, `inactive_issue_days`, `fix_label`, `trusted`, `protected_labels`; the github module's manifest documents each, and `kernel/sdk/src/maintained-repos.ts` defaults them); the agent reads each repo's through `github_issue_list`. New-issue triage runs are capped at 5 invalid issues a day per outside author; members and collaborators have no limit (a fix-labelled or feature-request issue doesn't count).

## New installs

Not in the default bundle. Once added, its heartbeat (4 hours) and two routines, the daily triage and the Monday
improvement pass, start off under quiet start. With no repos listed it watches nothing.
