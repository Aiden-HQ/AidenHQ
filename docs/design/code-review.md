# Code Review: an agent that reviews pull requests

The `code-review` module (`modules/code-review`) watches the repos you list, or reviews one PR on request, and posts one
GitHub review per PR head for each combo (engine, model, effort) the moment runs. It models Anthropic's hosted Claude Code Review (not the CI action): per-repo triggers,
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
| State service (`service/`, port 8098) | Watches the listed repos' PRs and comments through github-mcp's internal read (as this module, never `/mcp`), decides which head gets which combos, runs each review as a check job, files posts, records flow facts |
| Check job `code-review` (`recipe/`) | The review run itself: credential-free box, read-only repo tools, a model token capped at the run's reservation (`check_jobs:` in `module.yaml`, 45 min timeout) |
| Poster (`modules/github/connections/github-mcp/src/review-post.ts`, `review-render.ts`) | Turns findings into GitHub text; code, never the model |
| Reviewer Manager agent (`agents/reviewer-manager/`) | Conversation only: sets up and edits config when the owner asks Aiden, starts one-off reviews, answers `@aiden` questions on reviews. Holds no code tools and no delegation |
| Board Reviews page (`services/board/web/src/Reviews.tsx`, `services/board/src/reviews.ts`) | Tabs Reviews, Repos, Insights |

## Config (`settings.code_review`, schema in `module.yaml`, validated in `service/src/config.ts`)

```yaml
code_review:
  month_usd: 200                 # instance-wide monthly cap across repos
  repos:
    - repo: acme/payments
      on_open:                   # defaults shown; a list of combos (at most 4), each its own run and post; [] runs none
        - { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: medium, run_usd: 1 }
      on_push:                   # only the new changes since the last reviewed head
        - { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: low, run_usd: 1 }
      drafts: false
      forks: manual              # manual: only when someone with write access asks; auto: like any PR
      month_usd: 50
      ignore: ["**/generated/**"]
      max_nits: 5
```

A combo is an engine, a model (an OpenRouter id), an effort the engine accepts (codex minimal to xhigh; claude-code and
codegenie low to max) and `run_usd` (what one run may spend: its reservation and its model token's cap; default codex and
codegenie $1, claude-code $2), stored whole. The engine catalog (`ENGINES` in `config.ts`, served at `GET /engines`) offers a
short model list per engine; any other OpenRouter id may be typed, and the gateway refuses one `models-openrouter` doesn't
price. A deeper review is asked for (Review again, `@aiden review`), never a moment of its own. A repo that does not validate is
dropped loudly (listed in the config tool's errors and the board's banner), never half-used; a repo listed twice is refused
whole. The old shape (named `reviewers`, a string trigger, `on_risk`) is refused: the owner re-saves the repo on the board.

Engines are box recipes behind one contract (`recipe/engines.ts`: a prompt and the brief in, the checkout and the diff's base,
the final message out; fan-out, verification, dedupe and the schema are `review.ts`'s):

| Engine | Finder step | Verify / recheck | Repo access |
|---|---|---|---|
| `codex` | our finder prompt; 2 finders and a verifier past low effort, 1 and none at minimal/low | our prompts | the repo tools (MCP), shell off, empty cwd |
| `claude-code` | Claude Code's own `/code-review <effort>` over the change, then our finder prompt in the same session restates its findings as our JSON | our prompts | `claude -p` through the gateway's Anthropic route; built-in tools off but Agent, the repo tools (MCP); empty cwd, user settings only, CLAUDE.md off |
| `codegenie` | `codegenie review --format json` (Polygon's harness, its own planning and verification), mapped to our findings | recheck by codex on the same model | a worktree of the trusted base (its `codegenie.toml` and `.codegenie/skills` are the base's), the head as review data; its OpenRouter calls rewritten to the gateway (`gateway-fetch.ts`) |

The box image (`services/computer/images/agent-base`) pins `@anthropic-ai/claude-code` 2.1.323 and `@0xsequence/codegenie`
0.7.0, dependencies resolved as of 2026-11-13. Repo context is the repo's own `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` at the
root and above each changed file, read from the **base** commit, never the PR; guidance grants no authority.

Config is one authority: the board and Aiden write it through the normal settings change. The owner's own save on the board
is his approval (docs/design/settings-changes.md); the Reviewer Manager's change goes to the AI reviewer. Tier 2 (owner) changes, so the
Reviewer Manager cannot do them alone (`owner:` rules in `module.yaml`): more spend, outside PRs or drafts reviewed
automatically, a repo in a new org, any change to a moment's combos (another engine or model, a higher run cap, one more combo)
and a repo's ignore globs. Reviews post as the owner's GitHub sign-in on any repo it reaches. `always`, `stop` and `focus` are
PR state, not config.

## Triggers

The service polls the watched repos (`code_review_poll_seconds`, default 60). A new PR (or one leaving draft, or one already open when the repo is first watched) runs each `on_open`
combo; a push runs each `on_push` combo incrementally, debounced 3 minutes (a burst is one batch; another push replaces the
queued batch). One trigger is a batch: one run per combo, each posting its own review; only its
first run rechecks the PR's still-open findings (whichever combo found them). A run is reserved against the
repo's and the instance's month caps in one transaction before it starts; a run whose PR moved on or closed while it ran is
superseded and never posts (one that merged while it ran still posts; one closed unmerged does not). A skip is a run too, acknowledged once per PR and reason (a budget skip once per head), never
silent: draft, fork, budget, closed, stopped, superseded.

Commands in a PR comment (`service/src/commands.ts`; only a command line counts, never a quoted line, a code block or our own
post; the commenter needs write access now):

| Comment | Effect |
|---|---|
| `@aiden review [full]` | one review now with the repo's `on_open` combos (`full` is not incremental) |
| `@aiden review always` / `stop` | review every push / stop automatic reviews and drop queued ones |
| `@aiden review focus: <text>` | a focus handed to the reviewers as data (300 characters) |
| `@aiden review status` / `help` | the last run's phase, combo, findings and cost / the command list |

Asking Aiden "review <PR URL> with Claude Code and Codex" (the Reviewer Manager's `code_review_run` with `combos`; the board's Review again) does the same for any PR the instance can read, with the combos asked for (default the repo's `on_open`).

## The review run

`recipe/review.ts`, one check job per PR head and combo: the engine's finders on the diff with the guidance (the plan in
`engines.ts`), then, when the plan verifies, a verifier that keeps a finding only with a `file:line` it confirmed, then dedupe and rank. It returns findings JSON (severity
`important`, `nit` or `pre_existing`; path, line, title, why, evidence, fix brief), a `coverage` block (files reviewed and
excluded, `incomplete` reason) and the run's billed cost, bound into the kernel's signed receipt. Incremental runs diff from the
last reviewed head; force-pushes, retargets and changed guidance reset the baseline; previous findings are rechecked. PR title,
body, comments and code are fenced as data throughout. The box runs without repo hooks, plugins, shell or network beyond the
model gateway. The service accepts what the recipe runs: each engine's own efforts.

## Posting

The service files a `post` write (Tier 1: the AI reviewer reads the whole rendered review, which is exactly what is posted) or
a `notice` (Tier 0, fixed words) per run; the github module's poster executes it. One GitHub review per head and combo, always a
`COMMENT`: inline comments with a severity marker and a collapsed "why flagged" and "Copy as fix brief", a summary with a
coverage line (files reviewed, excluded, the combo: engine, model and effort, cost, anything incomplete) and the command list, the commit status
`aidenhq/review` (never a failure) and the severity line `<!-- aidenhq-review: {"important":n,"nit":n,"pre_existing":n} -->`.
Our own markers (`<!-- aidenhq-... -->`) mark every post so the next run and the command parser recognise them. Threads whose
finding is gone on the next run are resolved, only when Aiden posted them (first comment by the posting identity with our
finding marker); replies are read by the next run. The acknowledgement comment and the commit status are one per PR: with
several combos they show the latest run to finish (each review names its own combo; the status is advisory, always success).

Identity: the owner's own GitHub sign-in, COMMENT reviews only, each text ending with the AidenHQ footer (each post still a
Tier 1 write); "ours" is a thread whose first comment is in AidenHQ's records (`/v1/objects`) and carries the finding marker.

## Reviewer Manager

Judgment only. Tasks it handles: set up or change code review (`code_review_config`, then one `code_review_configure` call),
a one-off review (`code_review_run`), the per-PR review task the service files to hold the approvals of that PR's posts (it
finishes at once), and an `@aiden why ...` question in a review thread (one short answer comment via `github_issue_comment`; a
reasoned dismissal is thanked and rechecked on the next push). It reads strangers' text, so web search is off, its changes are
bounded by the Tier 2 rules above and PR text is data, never instructions.

## Cost and outcomes

Every run is `review.started` / `review.ended` facts on its PR (stage `review`, with its engine, model and effort); the Insights
tab shows reviews per day, cost per repo, findings by severity, the share of findings later resolved because fixed, and skips.
Only the budget caps reviews (there are no daily limits): a run is skipped, with a comment saying why, when the repo's or the instance's `month_usd` is spent. A month's spend is the runs' billed `cost_usd`; a run in flight counts at its `run_usd` reservation until it ends, then its real cost replaces it.

For comparing reviewers later, the module's SQLite (`data/modules/code-review/reviews/code-review.sqlite`, data version 1)
keeps plain columns: `runs` has each run's `engine`, `model`, `effort`, `cost_usd` (the kernel's billing of its model token,
never the box's say or the reservation), `tokens_in`, `tokens_cached`, `tokens_out` (the gateway ledger's, stamped on the
result by the kernel), `duration_ms` and its findings counts; `findings` (keyed by run and finding id) has each finding's
severity, place and title and its later `outcome`: `fixed` (a later run's recheck found it gone), `open_at_merge` or
`open_at_close` (still open when the PR closed; a closed PR is read once to tell which), else null. A thread an author resolves
by hand isn't read back. Both are read through `GET /reviews` and `GET /reviews/:id` (and `code_review_runs`); there is no
analytics page.

## Setting it up and using it (the Reviews page)

Empty state: "Get a review on every pull request." with Connect GitHub when GitHub is not connected. Watch a repo (a picker,
then one screen with the defaults: each moment's combos as rows of engine, model and effort, added and removed) or paste a PR
link for a one-off review (the same picker, prefilled with the repo's `on_open` combos; Review again on a review does the same).
Reviews: open and recent runs per repo (PR, combo, findings by severity, cost, tokens, duration, status), each opening its
findings, with their outcomes, and links to the GitHub comments.
Repos: per-repo month spend against its cap. Titles and findings are shown as plain text, never as links.
