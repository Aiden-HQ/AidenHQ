# maintainer

## What it does

Looks after the GitHub repos you list in `maintainer_repos`. It validates each issue labelled for a fix (default
`agent-fix`), hands the fix to an engineer and sees it through to a merged PR and whatever the repo's `after_merge` says
follows. Per repo it can also label feature requests and build those you mark `agent-build`, and nudge then close quiet
contributor PRs.

## Connect

Needs the `github` module with the GitHub App installed on each listed repo. Add repos in the `maintainer_repos` setting.

## What agents get

The `maintainer` agent holds the roles `maintainer` and `product-issues` and uses `github` tools to read, label, comment
and set state on issues, list PRs and read repo files. A watcher service looks for newly labelled issues every
`maintainer_poll_minutes` (default 5).

Settings: `external_triage`, `triage_invalid_per_author_day` (5, invalid issues only: a fix-labelled or feature-request issue doesn't count) bounds new-issue triage runs a day (per repo they are unlimited).

## New installs

Not in the default bundle. Once added, its heartbeat (4 hours) and two routines, the daily triage and the Monday
improvement pass, start off under quiet start. With no repos listed it watches nothing.
