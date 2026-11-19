#!/usr/bin/env bash
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED, set in the Dockerfile): it runs before any step of every
# job, and a non-zero exit fails the job before checkout. Defence in depth for public repos (a fork PR can edit the
# workflow that routes jobs here; the repos also require approval for outside collaborators). The decision is
# job-started.mjs, run under `env -i` with only the three GITHUB_* values it needs, so a workflow's `env:` (NODE_OPTIONS,
# an allow list) can't reach it. The allow list is /opt/aidenhq/allowed, written by the entrypoint before the runner starts.
exec env -i GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-}" GITHUB_EVENT_PATH="${GITHUB_EVENT_PATH:-}" \
  /opt/hostedtoolcache/node/24.22.3/x64/bin/node /opt/aidenhq/job-started.mjs
