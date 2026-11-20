# ci

## What it does

Self-hosted GitHub Actions runners (labels `self-hosted`, `aidenhq`) for the agents org's app repos, and for any other
org the GitHub App serves runners for. Each job gets one fresh container.

## Connect

Needs the GitHub App from the `github` module. Runners are started by `aidenhq-ci-runner@<n>` units (`ops/ci-runner.sh`),
never by `docker compose up`. To serve another org, create a runner group there and set `ci_org_runner_group`.

## What agents get

No tools. Settings: `ci_runner_repos` (repos besides the agents org it serves), `ci_org_runner_group`,
`ci_review_model` (the model and effort of the template's code review, `<id>:<effort>`), `ci_review_models` (other models
a CI token may call), `ci_review_repo_day_usd` (default 5) and `ci_review_day_usd` (default 20): daily review spend caps
per repo and together.

## New installs

Not in the default bundle. Nothing runs until you add it and start a runner unit.
