# code-review

## What it does

Reviews pull requests on the repos you list, or one PR on request, and a whole repository at a commit on request. Each moment (a PR opens, each push) runs a list of
combos, each an engine (Codex, Claude Code or Codegenie), a model and an effort, in a credential-free box; each combo posts
its own GitHub review, a write the AI reviewer approves. Every run keeps its engine, model, effort, billed cost, tokens,
duration and findings (with their later outcome) in the module's SQLite, read through `code_review_overview`, `code_review_run_detail` and `code_review_runs`.

The review computer is the only boundary, as for Engineers; nothing is jailed inside it. Claude Code runs with its own sandbox off
(gVisor can't give it a network namespace); Codex keeps its read-only sandbox. Threat model and why: `docs/design/code-review.md`.

## Connect

Needs the `github` module. Add repos by asking Aiden (the Reviewer Manager changes `code_review`) or in the module's
settings. It hears what changes on watched repos from the github module's change feed (within about a minute), so nothing
polls GitHub.

## What agents get

- The `code_review` connection. Read: `code_review_config`, `code_review_runs`, `code_review_findings`,
  `code_review_overview`, `code_review_run_detail`, `code_review_report`, `code_review_catalog`,
  `code_review_available`. Write: `code_review_run`, `code_review_configure`, `code_review_resolve` (answer a finding),
  `code_review_dismiss`.
- The `reviewer-manager` agent is conversation only: it reads review threads, holds no code tools and no delegation, and
  also gets `github_pr_threads` and `github_issue_comment`.

## New installs

In the default bundle. Idle until a repo is added: nothing runs or spends by itself, and the Reviewer Manager has no
heartbeat or schedule.
