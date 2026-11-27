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

## How it runs

App repos' CI (`modules/ci/template`: jobs `tests` and `code-review`; `code-review` skips the review and passes on a
change under 20 added plus deleted lines with no sensitive path; `package-lock.json`, which the supply-chain job validates, is not counted, but a change that adds a package, changes a version or source, or adds an install script is sensitive, while other lockfiles are counted and always sensitive; an agent's screenshots under `.aidenhq/out/` are not counted, its json and txt reports are; a head whose patch is unchanged since a green review of the same branch and base ref, on a base that only moved forward, reuses that verdict) runs on our own GitHub Actions runners,
`runs-on: [self-hosted, aidenhq]`, registered to the fleet org (`github_fleet_org`). The product repo's CI
(`.github/workflows/`) runs on the same kind of runner, registered to the product repo's org (below). Each
`aidenhq-ci-runner@<n>` user unit (fleet org) or `aidenhq-ci-runner@<org>-<n>` unit (another org) runs
`ops/ci-runner.sh`: it asks the kernel for a one-hour registration token (`ops/ci-runner-token.ts [org]`: `POST
/v1/codehost/runner_token` with the ci module's `ci_token`; the code host mints it as the owner, whose sign-in needs
`admin:org`, and answers only that token), then
`docker compose run --rm ci-runner`: a new container that registers ephemerally, takes one job, exits and is removed;
the unit then starts the next, at once (`Restart=always`, `RestartSec=1`). A refused token (the sign-in missing
`admin:org`, GitHub unreachable) backs off instead: `ops/ci-runner.sh` writes that unit's delay (1 second, doubling to a
minute) and exits, and the unit's `ExecStartPre` (`ops/ci-runner-backoff.sh`) waits it out before the next attempt. The
minute is a hard cap: a longer `ExecStartPre` wait would outlast systemd's 90-second timeout. The next token that mints
clears the delay, and a marker more than 15 minutes old (a drain, an outage) is dropped rather than served, so a
persistent refusal retries slowly rather than hot-looping while a clean job exit still starts the next runner
immediately. Because the wait runs before `ExecStart`, a unit backing off is `activating` rather than `active`. The
marker sits under the host's data dir, which `ops/lib/data-dir.sh` resolves from the unit environment alone -- the apply
writes each unit's `EnvironmentFile=` (`~/.config/aidenhq-ci-runner.env`, `~/.config/aidenhq-host-metrics.env`) from the
host's own `.env`, so the runner and the exporter never read a settings file themselves. A relative value is the
checkout's and a leading `~` is the home directory, with a trailing slash dropped but a lone `/` kept, so the marker is
the same file `ops/host-metrics.sh` exports its backoff series from. The marker is written beside itself and renamed
into place, so the exporter never reads a half-written file, and the exporter only reports a marker for a runner unit
systemd still has enabled or still has running: a runner retired at the cap (disabled and stopped) does not keep the alert
pending, while one disabled with `systemctl --user disable` but left running still retries under its restart policy and
keeps its series. The missing permission also
reaches the owner: a codehost op's `needs_owner` answer is recorded
as connection state, so it lands in the owner's digest (the GitHub card's own row comes from the sign-in's granted
scopes), a 2xx op clears a full cause, and two warnings in `modules/monitoring/prometheus/rules.yml` cover the loop:
`CiRunnerRestartLooping` on a unit that keeps restarting, and `CiRunnerBackoff` on a unit whose persisted wait has sat
at the one-minute cap for ten minutes, which the host-metrics timer writes as `aidenhq_unit_backoff` from the runner's
own marker (the wait itself, so a scrape that misses the brief active intervals between backoffs still alerts; the rule
holds while the wait is at the cap and its `for` is the ten minutes, so a wait that has since cleared raises nothing).

Nothing carries between jobs. The container has no host mounts, no docker socket and none of the instance's secrets; it
sits on `aidenhq-ci` (system unit `aidenhq-ci-net`: the public Internet and, on the host, only the model gateway's CI
listener `10.231.4.1:8201`; no LAN, tailnet, other host ports or other containers). Limits per runner: 4 CPUs, 8 GB.

**Code review spend (the model gateway).** The template's `code-review` job needs no model key: on our runners
(`AIDENHQ_GATEWAY_URL`, set on the runner container) it asks GitHub for its OIDC token (`id-token: write`, that job only)
and trades it at the gateway's `POST /ci/token` for an opaque CI token that lives 2 hours. The gateway
(`kernel/src/gateway/ci.ts`) checks GitHub's signature and that the job is a `pull_request` run of the repo's own
`.github/workflows/ci.yml` for that PR, on a self-hosted runner in the fleet org; each run attempt trades its token
once. The repo and PR come from that signed token, and the answer names the review model and effort
(`settings.ci_review_model`) and the repo's risk tier rules (its `code_review` entry's `rules` and `repo_class`, or none: the template's
default rules) with the instance App's bot login, so the job classifies the PR as code review does (below). The CI token works only on the CI listener, only for `responses` (and `chat/completions`
for repos on the older template) with `settings.ci_review_model` or `settings.ci_review_models`, no fallbacks, plugins,
server tools or stored responses, zero data retention forced, under the install's spend limit (a refusal fails the review, no retry). Each call goes out while the limit is not used up
and settles at what was billed (a Responses stream at its `response.completed`); a cut stream keeps its input estimate.
Every call lands in the ledger as kind `ci-code-review` with `<owner>/<repo>#<pr>` and the head the job sent (advisory):
the Costs tab's "App CI code review" line. Revoke: removing the `ci` module refuses every CI token at once.
The reviewer is codex with codex review's guidelines (`.github/code-review.ts`, pinned `@openai/codex`), at the effort the PR's risk tier
chooses: the job classifies the whole PR first (`.github/tiers.ts`, `.github/codegenie-tier.ts`: the same classifier and rules as code
review, no labels), `skip` and `trivial` PRs are not reviewed (a delta still runs), `standard` at the model's effort, `sensitive` one higher
(xhigh at high); text addressed to a reviewer also runs one higher. A green review carries to a later head (reuse or delta) only at the same tier
and model and an effort at least as high; its commit status records them. codex runs with its shell off: the
runner container can't give it its sandbox (bubblewrap needs user namespaces, which Docker and the host's AppArmor refuse
there), so its only tools are `.github/review-tools.ts`, a stdio MCP server that reads the PR's tree and git history
(diff, log, show, blame, read a file, list files, search; for TypeScript and JavaScript definition, references and
diagnostics from a pinned typescript-language-server, with no dependencies installed and type acquisition off) and
nothing else: nothing of the PR runs, writes or connects, and its
environment holds only the CI token (never the job's GitHub tokens). It runs from an empty directory with a config the
job writes (hooks, plugins and apps off), so nothing in the PR is loaded as codex config or instructions; a PR that adds
`.codex/`, `codex.toml` or `AGENTS.override.md` fails the check (before any tier shortcut), and AGENTS.md is a sensitive path. Its answer must match
an output schema: anything else is no verdict, which passes the check with a comment saying so ("Code review: no verdict on
`abc1234` (not blocking)"; the system fails open rather than stalls). A run without a verdict (a provider error, a timeout, an answer that isn't a review) gets one
retry when time is left (an incomplete review is not retried); a gateway refusal (bad token, our spend cap) isn't retried. The review target of 2,000 counted lines is
advisory: past it, a run without a verdict says the change is large and suggests stacked PRs. Findings that did come out still
decide (high or critical block). A run without a verdict records no baseline for the next push's delta review, so the next
push reviews the whole PR. Any lockfile change is a sensitive path (a bot's manifest-and-lockfile-only PR is standard), and the reviewer gets a summary of a
package-lock.json change. Its scripts and the house rules (the repo's `REVIEW.md`) come
from the base commit. Its brief: the house rules, the PR's tier and its AGENTS.md (base commit), and the PR's
title and description fenced as data, so it judges scope. P0 and P1 findings block (critical, high); P2 and P3 are listed.
A same-repo PR can edit the workflow and spend up to the install's spend limit on the allowed models: the limit and scope are the
boundary, not the job name. Instances without the gateway (no `AIDENHQ_GATEWAY_URL`) use the repo secret
`OPENROUTER_API_KEY` instead; where the gateway is on, delete that secret from the app repos (an edited workflow could
read it).

**Register (once).**
1. GitHub: with `ci` in `modules:` (step 3), the GitHub card on the board asks for `admin:org`: press **Reconnect** and
   allow it. You must be an owner of each org the runners register in.
2. Fleet org → Settings → Actions → Runner groups → Default: allow private repositories (and public if any). No model
   secret: code review spends through the gateway (above), whose `settings.ci_review_model` (default
   `~deepseek/deepseek-flash-latest:high`) picks the model and effort. Off the gateway: the variable `CI_REVIEW_MODEL`.
3. Instance repo: add `ci` to `modules:` in `instance.yaml`; deploy (`aidenhq-apply --wait`).
4. On the VM (sudo, once): `sudo install -m0755 ops/vm/computer-net.sh /usr/local/sbin/aidenhq-computer-net && sudo install
   -m0644 ops/units/aidenhq-ci-net.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable
   --now aidenhq-ci-net` (`ops/vm/setup.sh` does this on new hosts).
5. A run of `ops/setup.sh` with `CI_RUNNERS=2` (its config or the environment) starts that many; or by hand:
   `cp ops/units/aidenhq-ci-runner@.service ~/.config/systemd/user/ && systemctl --user daemon-reload &&
   systemctl --user enable --now aidenhq-ci-runner@1 aidenhq-ci-runner@2`. Check: the org's Settings → Actions →
   Runners lists `aidenhq-<container id>` idle; `journalctl --user -u aidenhq-ci-runner@1`.

CI health on demand (queue time, red rate, slow and failing jobs, merged-PR flakes, both repos): `node scripts/ci-report.ts [--hours 24]`.

**The product repo's org.** The product workflows' heavy jobs can overflow to `[self-hosted, aidenhq]` (below).
`image-scan` builds nothing (a build would run a PR's RUN steps on our runner, and the runner has no Docker): the grype
baked into the runner image scans each changed image's directory (lock files) and the digest-pinned base images its
Dockerfile names (`scripts/supply-chain/image-scan.ts` reads the Dockerfile as text), so packages RUN steps install are
not covered there; the security module's scans of deployed images cover them. A base image's files a Dockerfile replaces
or never copies out (node's bundled npm, the Alpine packages of a stage only partly copied) are owner-approved entries in
`.github/image-scan-exceptions.yaml`, read from the base commit. A PR from a fork is routed to `ubuntu-latest` instead of
our runners (where image-scan fails: no grype). That routing lives in the workflow file the PR itself carries, so it is
not the boundary: the org's runner group is. To serve the product org:
1. You are an owner of that org, and AidenHQ's sign-in is allowed there (an org that restricts OAuth apps shows it on the
   GitHub card).
2. The org → Settings → Actions → Runner groups: a group limited to the repos the runners serve (the `ci_runner_repos`
   setting), named in the instance's `settings.ci_org_runner_group`. Another org's units register only into that group
   and refuse to start without the setting, so they never land in the org's Default group (all repositories). Allow
   public repositories on it only for repos that require approval for all outside collaborators (below).
3. On the VM: `systemctl --user enable --now aidenhq-ci-runner@<org>-1 aidenhq-ci-runner@<org>-2` (the org's login as
   in its URL, e.g. `aidenhq-ci-runner@acme-1`). Check: the group's runners list them idle.

**The public Aiden-HQ repos (AidenHQ, aidenhq-distro).** Their CI runs on GitHub-hosted runners first.
In the product's ci.yml the first job (`checks`) counts the hosted jobs this repo's other runs hold (queued or running) and
sends the heavy jobs (the packages shards and board) to `[self-hosted, aidenhq]` only when that count is 12 or
more (the free plan runs ~20 at once), the repository variable `CI_SELF_HOSTED` is `true`, and the run is a push to main or
a same-repo PR (never a merge train: it holds PRs that may come from forks); any API error keeps them hosted. That routing
lives in the workflow file the run carries, so it is no boundary. The boundaries are: *Require approval for all outside
collaborators* (a fork's workflow runs only after a maintainer approves it), the org runner group (only these repos), and
the runner's job-started hook (modules/ci/runner/job-started.*, baked into the image read-only, run under `env -i`): it
fails any job, before checkout, whose repository is not in the fleet org or the `ci_runner_repos` setting, or whose event
is not a push or workflow_dispatch on the default branch, a schedule, or a pull_request from the same repository (no fork
PRs, merge trains, merge_group, pull_request_target, issue_comment, workflow_run, release or repository_dispatch). The
runner starts the hook with an environment of its own (the github and runner contexts), never the job's `env:`, so a
job-level `BASH_ENV` or `NODE_OPTIONS` does not reach it. To enable: the owner's sign-in with `admin:org` on the
Aiden-HQ org; a runner group there limited to the two repos with *Allow public repositories* on, named in
`settings.ci_org_runner_group`; a product at or after the hook; on the VM `systemctl --user enable --now
aidenhq-ci-runner@Aiden-HQ-1 … aidenhq-ci-runner@Aiden-HQ-4` (four on the reference host); then the repo variables
(Settings -> Secrets and variables -> Actions -> Variables): `CI_SELF_HOSTED` and `CI_SELF_HOSTED_RUNNERS` (the number of runners, 4). Unset it to go back to hosted only.
To scale down, `systemctl --user disable --now` each instance above the new count (and `reset-failed` it): a unit that is
only stopped stays enabled, so `ops/ci-runner-units.sh` restarts it and a failed one keeps alerting.
aidenhq-distro can adopt the same routing in its ci.yml later.

A push runs about 21 jobs (the test matrix is 18), each in a fresh container that installs Node and its packages: roughly
10 minutes on two runners. Jobs for one org never take another org's runners.

**Rotate.** Nothing long-lived on the runner: each job's registration token is minted fresh by the code host (revoking
the GitHub sign-in stops new ones; Reconnect restores them). Upgrade the runner by bumping the base image in `modules/ci/runner/Dockerfile`; GitHub stops accepting
runners some weeks after a newer release, so bump when the org's runners page warns.

**Scale.** One unit per concurrent job: `systemctl --user enable --now aidenhq-ci-runner@3`, or `disable --now` one to
shrink. Every unit is up to 4 CPUs and 8 GB while it runs a job, whichever org it serves: keep the total at 2-4 on a VM of
the size docs/setup.md suggests (e.g. 2 for the product org, 1-2 for the fleet org). The enabled instances are what the config
declares runs, and an apply starts every declared one that systemd reports failed: `Restart=always` alone reaches systemd's
start limit and leaves a unit failed with nothing to clear it, so `ops/ci-runner-units.sh` resets and starts those (and the
ones a drain record names) after everything else. A drain (`node scripts/fleet-pause.ts pause`) stops them without
cancelling a job under it, and its resume -- or an apply, or `ops/ci-runner-units.sh` on its own -- clears each unit's
start limit before starting it, so a stopped unit never stays start-limited and failed. Stop all: `systemctl --user stop 'aidenhq-ci-runner@*'` (a running job
is cancelled; GitHub retries nothing, so re-run it).
