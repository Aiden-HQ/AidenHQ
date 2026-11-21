# code-review

## What it does

Reviews pull requests on the repos you list, or one PR on request. Each moment (a PR opens, each push) runs a list of
combos, each an engine (Codex, Claude Code or Codegenie), a model and an effort, in a credential-free box; each combo posts
its own GitHub review, a write the AI reviewer approves. Every run keeps its engine, model, effort, billed cost, tokens,
duration and findings (with their later outcome) in the module's SQLite, read through `GET /reviews` and `code_review_runs`.

Repo reviews (off until `code_review.lenses` is on): a whole repository at a commit, reviewed with the options you pick from
`catalog.json` (token-free tools, upstream skills, deepsec and other engines; four lenses: correctness, security,
maintainability, performance) under one cap ($25 by default, at most $150; at most $100 a check, 180 minutes a check). The
report goes to Primer, private to you, one document per repo with a version per review, and to the board's Reviews page.
deepsec's set-up files come as a setup PR you merge. Design: `docs/design/code-review.md`.

## Connect

Needs the `github` module (repo reviews: also `primer` for the report). Add repos by asking Aiden (the Reviewer Manager changes `code_review`, within the caps you set
under `code_review.owner`) or in the module's settings. `code_review_poll_seconds` (default 60) sets how often it looks
at watched repos.

## What agents get

- The `code_review` connection. Read: `code_review_config`, `code_review_runs`. Write: `code_review_run`,
  `code_review_configure`.
- The `reviewer-manager` agent is conversation only: it reads review threads, holds no code tools and no delegation, and
  also gets `github_pr_threads` and `github_issue_comment`.

## New installs

In the default bundle. Idle until a repo is added or a review is asked for: nothing runs or spends by itself, and the Reviewer
Manager has no heartbeat or schedule. Repo reviews are off (`code_review.lenses: false`) until the owner turns them on;
without Primer a report stays on the board, saying why.
