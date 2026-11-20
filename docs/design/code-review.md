# Code Review: an agent that reviews pull requests

The `code-review` module (`modules/code-review`) watches the repos you list, or reviews one PR on request, and posts one
updating GitHub review per PR head. It models Anthropic's hosted Claude Code Review (not the CI action): per-repo triggers,
several finders then a verification pass, advice only. It is separate from the CI `code-review` job (which blocks and stays
for repos that carry it) and from the AI reviewer (a write-authority gate, not a code reviewer). In the default bundle, idle
until a repo is added: nothing runs or spends by itself. Everything is set up by telling Aiden (or on the board).

Rules that bind (owner and design):

- The review is advice: it never approves or blocks a merge, never pushes fixes. A repo may gate on the severity line in its
  own CI.
- An outside PR's text never steers the reviewer; a review box holds no credentials.
- Spend is visible and capped; partial coverage is never presented as clean.

## Components

| Part | What it does |
|---|---|
| State service (`service/`, port 8098) | Watches the listed repos' PRs and comments through github-mcp's internal read (as this module, never `/mcp`), decides which head gets which reviewer, runs each review as a check job, files posts, records flow facts |
| Check job `code-review` (`recipe/`) | The review run itself: credential-free box, read-only repo tools, a model token capped at the run's reservation (`check_jobs:` in `module.yaml`, 45 min timeout) |
| Poster (`modules/github/connections/github-mcp/src/review-post.ts`, `review-render.ts`) | Turns findings into GitHub text; code, never the model |
| Reviewer Manager agent (`agents/reviewer-manager/`) | Conversation only: sets up and edits config when the owner asks Aiden, starts one-off reviews, answers `@aiden` questions on reviews. Holds no code tools and no delegation |
| Board Reviews page (`services/board/web/src/Reviews.tsx`, `services/board/src/reviews.ts`) | Tabs Reviews, Repos, Reviewers, Insights |

## Config (`settings.code_review`, schema in `module.yaml`, validated in `service/src/config.ts`)

```yaml
code_review:
  month_usd: 200                 # instance-wide monthly cap across repos
  reviewers:                     # named profiles; shipped: quick, standard, deep, triage (a name set to null is switched off)
    quick:    { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: low,  finders: 1, verify: false, run_usd: 0.5 }
    standard: { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: high, finders: 2, verify: true,  run_usd: 1.5 }
    deep:     { engine: codex, model: "~openai/gpt-sol-latest", effort: high, finders: 4, verify: true, verifier: "~anthropic/claude-latest", run_usd: 2.5 }
    triage:   { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: low, finders: 1, verify: false, focus: triage, run_usd: 0.5 }
  repos:
    - repo: acme/payments
      on_open: standard          # defaults shown; each is a reviewer name or "off"
      on_push: quick             # incremental
      on_risk: deep              # a PR the triage reviewer calls high-risk
      drafts: false
      forks: manual              # manual: only when someone with write access asks; auto: like any PR
      month_usd: 50
      ignore: ["**/generated/**"]
      max_nits: 5
      per_author_day: 10         # automatic runs a day per PR author / per repo; past either, a PR waits for someone to ask
      per_repo_day: 60
```

A reviewer is a whole profile: engine, model, effort, finders, verification (and its model), optional `context` (repo paths),
`focus`, `label` and `run_usd` (what one run may spend: its reservation and its model token's cap; default $0.50 a finder
plus $0.50 to verify). A profile or repo that does not validate is dropped loudly (listed in the config tool's errors), never
half-used; a repo listed twice is refused whole. Engines are box recipes behind one contract (diff and context in, findings JSON
out): only `codex` is built; `claude-code` and `codegenie` are declared names and a reviewer naming one is refused. Repo
context is the repo's own `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` at the root and above each changed file, read from the
**base** commit, never the PR; guidance grants no authority.

Config is one authority: the board and Aiden write it through the normal settings change. The owner's own save on the board
is his approval (docs/design/settings-changes.md); the Reviewer Manager's change goes to the AI reviewer. Tier 2 (owner) changes, so the
Reviewer Manager cannot do them alone (`owner:` rules in `module.yaml`): more spend, outside PRs or drafts reviewed
automatically, a repo in a new org, and any change to a reviewer's model, verifier, finders, `run_usd`, focus or context or to
a repo's ignore globs. Reviews post as the instance's identity only in orgs the App covers or `settings.github_comment_orgs`
allows (the owner allows an org on the Reviews page). `always`, `stop` and `focus` are PR state, not config.

## Triggers

The service polls the watched repos (`code_review_poll_seconds`, default 60). A new PR (or one leaving draft) is triaged and
reviewed with `on_open`; a push gets `on_push` incrementally, debounced 3 minutes (a burst is one review; another push
replaces the queued run's head). The triage reviewer's summary and risk (`trivial`, `normal`, `high`) ride on the next
review, and a high-risk PR is escalated once per head to `on_risk`. A run is reserved against the repo's and the instance's
month caps in one transaction before it starts; a run whose PR moved on or closed while it ran is superseded and never posts.
A skip is a run too, acknowledged once per PR and reason (a budget skip once per head), never silent: draft, fork, daily
limit, budget, closed, stopped, superseded.

Commands in a PR comment (`service/src/commands.ts`; only a command line counts, never a quoted line, a code block or our own
post; the commenter needs write access now):

| Comment | Effect |
|---|---|
| `@aiden review [<reviewer>] [full]` | one review now (default `on_open` reviewer; `full` is not incremental) |
| `@aiden review always` / `stop` | review every push / stop automatic reviews and drop queued ones |
| `@aiden review focus: <text>` | a focus handed to the reviewer as data (300 characters) |
| `@aiden review status` / `help` | the last run's phase, reviewer, findings and cost / the command list |

Asking Aiden "review <PR URL> deep" (the Reviewer Manager's `code_review_run`) does the same for any PR the instance can read.

## The review run

`recipe/review.ts`, one check job per PR head: N finders in parallel on the diff with the guidance, then, if `verify`, a
verifier that keeps a finding only with a `file:line` it confirmed, then dedupe and rank. It returns findings JSON (severity
`important`, `nit` or `pre_existing`; path, line, title, why, evidence, fix brief), a `coverage` block (files reviewed and
excluded, `incomplete` reason) and the run's billed cost, bound into the kernel's signed receipt. Incremental runs diff from the
last reviewed head; force-pushes, retargets and changed guidance reset the baseline; previous findings are rechecked. PR title,
body, comments and code are fenced as data throughout. The box runs without repo hooks, plugins, shell or network beyond the
model gateway. The service accepts what the recipe runs: `finders` 1 to 4, effort minimal, low, medium, high or xhigh.

## Posting

The service files a `post` write (Tier 1: the AI reviewer reads the whole rendered review, which is exactly what is posted) or
a `notice` (Tier 0, fixed words) per run; the github module's poster executes it. One GitHub review per head, always a
`COMMENT`: inline comments with a severity marker and a collapsed "why flagged" and "Copy as fix brief", a summary with a
coverage line (files reviewed, excluded, reviewer, cost, anything incomplete) and the command list, the commit status
`aidenhq/review` (never a failure) and the severity line `<!-- aidenhq-review: {"important":n,"nit":n,"pre_existing":n} -->`.
Our own markers (`<!-- aidenhq-... -->`) mark every post so the next run and the command parser recognise them. Threads whose
finding is gone on the next run are resolved, only when Aiden posted them (first comment by the posting identity with our
finding marker); replies are read by the next run.

Identity: the instance's GitHub App bot where it is installed with PR and status write on the repo, else the owner's own GitHub
sign-in (each post still a Tier 1 write); never another person's account.

## Reviewer Manager

Judgment only. Tasks it handles: set up or change code review (`code_review_config`, then one `code_review_configure` call),
a one-off review (`code_review_run`), the per-PR review task the service files to hold the approvals of that PR's posts (it
finishes at once), and an `@aiden why ...` question in a review thread (one short answer comment via `github_issue_comment`; a
reasoned dismissal is thanked and rechecked on the next push). It reads strangers' text, so web search is off, its changes are
bounded by the Tier 2 rules above and PR text is data, never instructions.

## Cost

Every run is `review.started` / `review.ended` facts on its PR (stage `review`); the Insights tab shows reviews per day, cost
per repo, findings by severity, the share of findings later resolved because fixed, and skips. Over `month_usd` a run is
skipped with a comment saying why.

## Setting it up and using it (the Reviews page)

Empty state: "Get a review on every pull request." with Connect GitHub when GitHub is not connected. Watch a repo (a picker,
then one screen with the defaults) or paste a PR link for a one-off review. Reviewers: the shipped profiles as cards, a form to
add one, and "Try on a recent PR", which runs the profile once without posting and shows the findings. Reviews: open and recent
runs per repo (PR, reviewer, findings by severity, cost, status), each opening its findings with links to the GitHub comments.
Repos: per-repo month spend against its cap. Titles and findings are shown as plain text, never as links.
