# maintainer

## What it does

Looks after the GitHub repos you list in `maintainer_repos`. It validates each issue labelled for a fix (default
`agent-fix`), hands the fix to an engineer and sees it through to a merged PR that closes the issue. Per repo it can also label feature requests and build those you mark `agent-build`, and nudge then close quiet
contributor PRs.

## Connect

Needs the `github` module with the owner signed in to GitHub, and the owner's account able to reach each listed repo. The Fleet page (Maintainer) lists the repos with their duties (issues, features, dependabot, contributor PRs) and the `external_triage` switch; it is a module view the `maintainer` connection serves (`maintainer_config`, `maintainer_configure`, the owner's own calls, never an agent's).

## What agents get

The `maintainer` agent holds the roles `maintainer` and `product-issues` and uses `github` tools to read, label, comment
and set state on issues, list PRs and read repo files. A watcher service reads the github change feed's issue events from the kernel's log and files a task for each newly
labelled issue within about a minute of its label.

Settings: `external_triage`, `triage_invalid_per_author_day` (5, invalid issues only: a fix-labelled or feature-request issue doesn't count) bounds new-issue triage runs a day (per repo they are unlimited).

## New installs

Not in the default bundle. Once added, its heartbeat (4 hours) and two routines, the daily triage and the Monday
improvement pass, start off under quiet start. With no repos listed it watches nothing.
