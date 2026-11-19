# Code Review: an agent that reviews pull requests

Status: design (2026-11-19).

## Why

A Polygon colleague wants to point an agent at a repo's open PRs, have it triage them, and run a dedicated review on the
high-value ones. Today AidenHQ reviews code only in CI (the `code-review` job, which a repo must carry and which skips
fork PRs); the AI reviewer is a write-authority gate, not a code reviewer. The owner's direction: model it on Anthropic's
hosted Claude Code Review (not the CI action), configurable per repo or per PR, the default cheap, a deep review with a
chosen engine, model, effort and repo context for production PRs, all set up by telling Aiden.

## What we take from hosted Claude Code Review (docs, 2026-11)

- Per-repo triggers: once after open, after every push, or manual; `@claude review [always|stop]` on any PR; drafts and
  fork PRs skipped unless someone with write access asks.
- Several finder agents in parallel, then a **verification pass** that re-checks each finding against the code, then
  dedupe and rank: the main false-positive control.
- Prose config only: `REVIEW.md` (root and per folder) and `CLAUDE.md`, read from the **base branch**, never the PR.
- Levels Quick / Standard / Deep (we generalise them to named reviewers); severities 🔴 Important, 🟡 Nit, 🟣 Pre-existing; a neutral check run; a
  machine-readable severity line; incremental re-review; threads auto-resolve when fixed; replies read next time.
- Spend cap with a skip comment; analytics: reviews per day, cost per repo, findings by severity, auto-resolved rate.
- Peers add: a risk label and summary (Bugbot, CodeRabbit), learning from dismissals, adaptive depth (Copilot).

## Goals, non-goals

- Goals: watch repos or review one PR on request; outside PRs safe; one updating review per PR head; any number of named
  reviewers, each its own engine, model, effort and context; setup by asking Aiden; cost visible and capped.
- Non-goals: approving or blocking merges (the review is advice; a repo may gate on the severity line in its own CI),
  pushing fixes, replacing CI's code-review job (it stays for repos that carry it).
- Anti-goals: an outside PR's text steering the reviewer; a reviewer box that holds credentials; noise (nits, lint CI
  already catches, re-reviewing unchanged diffs).

## Design

### Config (module settings, per repo; Aiden edits them through the normal config write)

```yaml
code_review:
  reviewers:                                # named profiles; three ship, add as many as you like
    quick:    { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: low, finders: 1, verify: false }
    standard: { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: high, finders: 2, verify: true }
    deep:     { engine: codex, model: "~openai/gpt-sol-latest", effort: high, finders: 4, verify: true, verifier: "~anthropic/claude-latest" }
    # e.g. prod-security: { engine: claude-code, model: "~anthropic/claude-latest", effort: max, context: "docs/threat-model.md", focus: security }
    # e.g. genie:         { engine: codegenie, ... }
  repos:
    - repo: acme/payments
      on_open: standard                      # default
      on_push: quick                         # default; incremental
      on_risk: deep                          # the manager escalates high-risk PRs to this reviewer
      drafts: false
      forks: manual                          # write-access commenter must ask
      month_usd: 50
      ignore: ["**/generated/**", "*.lock"]
      max_nits: 5
```

A **reviewer** is a whole profile, not a strength setting: engine, model, effort, finders, verification (and its model),
extra context files and a focus. Engines are pluggable box recipes behind one contract (diff + context in, findings JSON
out): `codex` first; `claude-code` and `codegenie` as further recipes. Any number of reviewers; the three defaults are
just shipped examples. Repo context is the repo's own `REVIEW.md` (root and per folder) plus `AGENTS.md`/`CLAUDE.md`, read
from the base commit.

### Triggers

A watcher (the Maintainer's watcher generalised to PRs: repo list, per-author and per-repo daily caps) files one review
per PR head per the repo's trigger. On any watched PR, a write-access commenter may say `@aiden review` (once, standard),
`@aiden review <reviewer>` (e.g. `deep`), `@aiden review always`, `@aiden review stop`, or `@aiden review focus: <text>`. Asking Aiden
"review <PR URL> deep" does the same for any PR the instance can read.

### The review run (credential-free)

One check-job recipe per PR head, in the existing sandbox box (no credentials, no tools beyond read-only repo reads, a
capped model token): N finders in parallel on the diff with the repo context, then (if `verify`) a verifier that keeps a
finding only with a `file:line` it confirmed, then dedupe and rank. It returns findings JSON (severity, path, line,
title, why, evidence) and a signed receipt. Incremental runs diff since the last reviewed head and say how many findings
were withheld. PR title, body, comments and code are fenced as data throughout.

### Posting

Code, never the model, turns findings into one GitHub review per head: inline comments with severity markers and a
collapsed "why flagged", a summary, a commit status `aidenhq/review`, and the severity line
`<!-- aidenhq-review: {"important":n,"nit":n,"pre_existing":n} -->`. Threads whose finding is gone on the next run are
resolved; replies are read by the next run.

Identity (per instance): the instance's own GitHub App bot where installed with PR write; otherwise the instance owner's
own GitHub sign-in (connections-simple.md), each post a Tier 1 write the AI reviewer approves. Never another person's
account.

### The Reviewer Manager (one agent)

Judgment only: triages new PRs (summary and a risk label: trivial, normal, high-risk), escalates a high-risk PR to a stronger reviewer (the repo's `on_risk`, default `deep`),
answers `@aiden` replies, and configures `code_review` when the owner asks Aiden ("watch acme/payments, deep for
anything under src/billing"). It sees findings and metadata, never runs the review itself.

### Cost and learning

Every run's spend is a flow fact; the Reviews page's Insights tab shows reviews per day, cost per repo and per PR, findings
by severity, auto-resolved rate. Over `month_usd` a run is skipped with a comment saying why. A finding the author
dismisses with a reason becomes a planted case for the review eval.

## Setting it up and using it (UX)

- **Default module for new installs** (in the bundle), idle until a repo is added: nothing runs or spends by itself.
- **Empty state** on its board page: "Get a review on every pull request. Pick a repo to watch, or paste a PR link for
  a one-off review." With GitHub not connected yet, the first button is Connect GitHub (sign-in, connections-simple.md).
- **Watch a repo:** a picker of repos the GitHub sign-in can read (search), then one screen with the defaults filled in
  (Standard on open, Quick on push, drafts off, forks on request, $/month) and Save. Or ask Aiden in words.
- **One-off review:** paste a PR URL, pick a reviewer, Run. Same from chat ("review <url> with deep").
- **Reviewers page:** the three defaults as cards (what each costs on average per PR, from real runs); "New reviewer"
  opens a form (engine, model, effort, finders, verify, context, focus) with a "try on a recent PR" button that runs it
  once and shows the findings before saving.
- **Reviews page** (board nav; tabs Reviews · Repos · Reviewers · Insights): open and recent reviews per repo (PR, reviewer, findings by severity, cost, status), each opening the
  findings with links to the GitHub comments; per-repo month spend against its cap.
- **On GitHub:** the summary comment lists the commands (`@aiden review`, `… <reviewer>`, `always`, `stop`, `focus:`),
  and a skip says why (draft, fork, budget) instead of staying silent.
- **First run guidance:** after the first review lands, a one-line tip offers adding a `REVIEW.md` with a starter
  template generated from the repo (what to always check, what not to report).

## Simplifications (Codex review, 2026-11-19; all features kept)

- **One watcher:** the Maintainer's watcher gains a PR event kind (own cursor, dedupe key, handler); watching a repo
  for reviews never authorises fixes.
- **One recipe, small engine adapters:** reviewers are data; fan-out, verifier, dedupe, schema check and ranking are
  shared; an engine adapter only invokes and parses. Engine, model and effort are validated together before saving.
- **One source for the review code:** CI's `code-review.mjs`, `review-tools.mjs`, `codegenie-gate.mjs`,
  `codegenie-prior.mjs` and `review-checklist.mjs` move to one shared source synced into the CI template and this
  module (`scripts/sync-shared.mjs`); CI keeps blocking, this stays advisory.
- **No new publisher:** `github_pr_review` grows inline comment batches, thread reads and resolution, and an explicit
  identity; the AI reviewer approves the write as today; code renders the findings.
- **One status, any identity:** a commit status (works with a user sign-in and the App) instead of a check run (App
  only); the severity line goes in the summary.
- **One config authority:** `settings.code_review` in instance.yaml (schema and defaults in the module); the board and
  Aiden write it through the normal settings write. `always`/`stop`/`focus` are PR state, not config.
- **One page:** the board's **Reviews** page (Reviews · Repos · Reviewers · Insights); Insights reads flow facts.
- **Triage is a reviewer too:** the manager's summary and risk label come from a cheap `triage` profile on the same
  runner; the Reviewer Manager agent stays thin (conversation, setup, escalation, replies).
- **Own eval set:** review fixtures separate from the write-gate cases; a reasoned dismissal becomes a candidate
  fixture, promoted after its expected answer is checked.

## Cheap additions

- `@aiden review full` (not incremental) and a coverage line on every review: files reviewed and excluded, reviewer,
  cost, anything incomplete. Partial coverage is never presented as clean.
- `@aiden review status` / `help`, and one updating acknowledgement (queued, running, done, skipped and why).
- Effective config per PR (which reviewer, which `REVIEW.md` sections applied), useful in monorepos.
- Flag guidance (REVIEW.md, AGENTS.md) the change makes stale.
- "Copy as fix brief" on a finding: location, evidence and the wanted outcome, for the author's coding agent.

## Risks handled

- **Check jobs:** gain a generic model token for review recipes, a bounded findings artifact bound into the receipt
  (repo, base, head, reviewer, context and recipe hashes, incremental baseline), and history for base diffs.
- **Forks and access:** fork heads, private forks, deleted branches, revoked access and SSO; commands are authorised
  against the commenter's current repo permission.
- **Injection and privacy:** every engine runs without repo hooks, plugins, shell or network beyond the model gateway;
  replies and context are fenced; base guidance grants no authority; posted evidence is redacted.
- **Incremental:** force-pushes, retargets and changed guidance or reviewers reset the baseline; a missing finding
  doesn't prove a fix: previous findings are rechecked before Aiden resolves only its own threads.
- **Spam and loops:** pushes are debounced, stale runs superseded, command IDs deduped, escalation and reply loops
  bounded, skip notices updated in place.
- **Scale and cost:** pagination, rate-limit backoff, huge, binary and generated files, submodules; budget reserved
  atomically across finders, verifier, triage and retries, under the instance-wide cap.

## Build lanes (after approval)

1. Watcher + triggers + `@aiden` commands (generalise the Maintainer watcher; PR head tracking).
2. Review recipe (finders, verifier, dedupe; lift CI's code-review tools and rules; reviewer profiles and engine recipes; incremental).
3. Posting (review, inline comments, check, severity line, thread resolve; App or owner identity) and the write kind.
4. Reviewer Manager agent, config tool for Aiden, Flow Review tab, eval cases.

## Left to the builder

The finder and verifier prompts, the exact JSON schema, App permission bump (`pull_requests: write`) for bot posting.
