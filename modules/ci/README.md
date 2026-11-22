# ci

## What it does

Self-hosted GitHub Actions runners (labels `self-hosted`, `aidenhq`) for the fleet org's app repos (`github_fleet_org`),
and for any other org the owner's GitHub sign-in can register runners in. Each job gets one fresh container.

## Connect

Needs the `github` module connected, with the `admin:org` permission: turning this module on makes the GitHub card ask
you to Reconnect once. Runners are started by `aidenhq-ci-runner@<n>` units (`ops/ci-runner.sh`), never by `docker
compose up`; each job's registration token comes from the code host's `runner_token` op. To serve another org, create a
runner group there and set `ci_org_runner_group`.

## What agents get

No tools. Settings: `ci_runner_repos` (repos besides the fleet org it serves), `ci_org_runner_group`,
`ci_review_model` (the model and effort of the template's code review, `<id>:<effort>`), `ci_review_models` (other models
a CI token may call). CI review spend counts against the install's spend limit.

## New installs

Not in the default bundle. Nothing runs until you add it and start a runner unit.
