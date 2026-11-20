# code-review

## What it does

Reviews pull requests on the repos you list, or one PR on request. Named reviewers (engine, model, effort, finders,
verification, context) run in a credential-free box, and findings are posted as one GitHub review per head. Each post is
a write the AI reviewer approves.

## Connect

Needs the `github` module. Add repos by asking Aiden (the Reviewer Manager changes `code_review`, within the caps you set
under `code_review.owner`) or in the module's settings. `code_review_poll_seconds` (default 60) sets how often it looks
at watched repos.

## What agents get

- The `code_review` connection. Read: `code_review_config`, `code_review_runs`. Write: `code_review_run`,
  `code_review_configure`.
- The `reviewer-manager` agent is conversation only: it reads review threads, holds no code tools and no delegation, and
  also gets `github_pr_threads` and `github_issue_comment`.

## New installs

In the default bundle. Idle until a repo is added: nothing runs or spends by itself, and the Reviewer Manager has no
heartbeat or schedule.
