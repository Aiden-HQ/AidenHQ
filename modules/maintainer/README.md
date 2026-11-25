# maintainer

## What it does

Looks after the GitHub repos you list in `maintainer_repos`. It validates each issue labelled for a fix (default
`agent-fix`), hands the fix to an engineer and sees it through to a merged PR that closes the issue. Per repo it can also label feature requests and build those you mark `agent-build`, and nudge then close quiet
contributor PRs.

## Connect

Needs the `github` module with the owner signed in to GitHub, and the owner's account able to reach each listed repo. The Fleet page (Maintainer) shows each repo with a preset (quiet, triage, full) and every setting in a drawer: fix label and trusted roles, triage (off, new, new+backlog) with its per-author cap, labels and closes, days waiting on a reporter, quiet issues, the resolved-check limit, Dependabot and contributor PRs; it is a module view the `maintainer` connection serves (`maintainer_config`, `maintainer_configure`, the owner's own calls, never an agent's).

## What agents get

The `maintainer` agent holds the roles `maintainer` and `product-issues` and uses `github` tools to read, label, comment
and set state on issues, list PRs and read repo files. A watcher service reads the github change feed's issue events from the kernel's log and files a task for each newly
labelled issue within about a minute of its label.

Every setting is per repo, a field of its `maintainer_repos` entry (`preset`, `triage`, `triage_cap_per_author_day`, `triage_labels`, `close`, `needs_info_close_days`, `stale_issues`, `resolved_check`, beside `fix_label`, `trusted`, `fixes`, `features`, `dependabot`, `contributor_prs`, `stale_days`); the agent reads each repo's through `github_issue_list`. The cap bounds invalid new-issue triage runs a day per outside author (a fix-labelled or feature-request issue doesn't count); the fleet's own issues and the owner's are always triaged, never capped.

## New installs

Not in the default bundle. Once added, its heartbeat (4 hours) and two routines, the daily triage and the Monday
improvement pass, start off under quiet start. With no repos listed it watches nothing.
