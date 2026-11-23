# code-review

## What it does

Reviews pull requests on the repos you list, or one PR on request. Each moment (a PR opens, each push) runs a list of
combos, each an engine (Codex, Claude Code or Codegenie), a model and an effort, in a credential-free box; each combo posts
its own GitHub review, a write the AI reviewer approves. Every run keeps its engine, model, effort, billed cost, tokens,
duration and findings (with their later outcome) in the module's SQLite, read through `GET /reviews` and `code_review_runs`.

Claude Code runs with its own sandbox off, because gVisor can't give that sandbox its network namespace and with it on every shell
command failed. The recipe jails the whole `claude` process instead (read-only but its own run directories). Codex keeps its
read-only sandbox, which works there. Why: `docs/design/code-review.md`.

## Connect

Needs the `github` module. Add repos by asking Aiden (the Reviewer Manager changes `code_review`) or in the module's
settings. `code_review_poll_seconds` (default 60) sets how often it looks
at watched repos.

## What agents get

- The `code_review` connection. Read: `code_review_config`, `code_review_runs`. Write: `code_review_run`,
  `code_review_configure`.
- The `reviewer-manager` agent is conversation only: it reads review threads, holds no code tools and no delegation, and
  also gets `github_pr_threads` and `github_issue_comment`.

## New installs

In the default bundle. Idle until a repo is added: nothing runs or spends by itself, and the Reviewer Manager has no
heartbeat or schedule.
