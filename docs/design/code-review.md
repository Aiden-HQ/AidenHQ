# Code Review: an agent that reviews pull requests

The `code-review` module (`modules/code-review`) watches the repos you list, or reviews one PR on request, and posts one
GitHub review per PR head for each combo (engine, model, effort) the moment runs. It models Anthropic's hosted Claude Code Review (not the CI action): per-repo triggers,
several finders then a verification pass. A combo may be mandatory: its review then gates the repo's merges (below). It is separate from the CI `code-review` job (which blocks and stays
for repos that carry it) and from the AI reviewer (a write-authority gate, not a code reviewer). In the default bundle, idle
until a repo is added: nothing runs or spends by itself. Everything is set up by telling Aiden (or on the board).

Rules that bind (owner and design):

- A review never approves on GitHub and never pushes fixes. On a gated repo (a mandatory combo) the merge queue merges a PR only
  once code review's verdict for its head is pass: its mandatory combos reviewed the head whole and none of their important
  findings is open. Elsewhere a review is advice. Nits and pre-existing findings never gate.
- An outside PR's text never steers the reviewer; a review box holds no credentials.
- Spend is visible and limited by the install's spend limit (`spend_day_usd`, `spend_month_usd`); partial coverage is never presented as clean.

## Components

| Part | What it does |
|---|---|
| State service (`service/`, port 8098) | Watches the listed repos' PRs and comments through github-mcp's internal read (as this module, never `/mcp`), decides which head gets which combos, runs each review as a check job, files posts, records flow facts |
| Check job `code-review` (`recipe/`) | The review run itself: credential-free box, read-only repo tools, a model token (`check_jobs:` in `module.yaml`, 45 min timeout) |
| Poster (`modules/github/connections/github-mcp/src/review-post.ts`, `review-render.ts`) | Turns findings into GitHub text; code, never the model |
| Reviewer Manager agent (`agents/reviewer-manager/`) | Conversation only: sets up and edits config when the owner asks Aiden, starts one-off reviews, answers `aiden` questions on reviews. Holds no code tools and no delegation |
| Board Reviews page (`services/board/web/src/Reviews.tsx`, `services/board/src/reviews.ts`) | Tabs Reviews, Repos, Insights |

## Config (`settings.code_review`, schema in `module.yaml`, validated in `service/src/config.ts`)

```yaml
code_review:
  repos:
    - repo: acme/payments
      on_open:                   # defaults shown; a list of combos (at most 4), each its own run and post; [] runs none
        - { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: medium }
      on_push:                   # only the new changes since the last reviewed head
        - { engine: codex, model: "~deepseek/deepseek-flash-latest", effort: low }   # mandatory: true gates merges
      drafts: false
      forks: manual              # manual: only when someone with write access asks; auto: like any PR
      ignore: ["**/generated/**"]
      max_nits: 5
```

A combo is an engine, a model (an OpenRouter id), an effort the engine accepts (codex and codex-native minimal to xhigh;
claude-code and codegenie low to max), and `mandatory` (default false; written only when on), stored whole. A repo with a mandatory combo has one at both moments, else it is refused (the service, the board and the compile all say so); a repo-level `mandatory` is refused. The engine catalog (`ENGINES` in `config.ts`, served at `GET /engines`) offers a
short model list per engine; any other OpenRouter id may be typed, and the gateway refuses one `models-openrouter` doesn't
price. A deeper review is asked for (Review again, `aiden review`), never a moment of its own. A repo that does not validate is
dropped loudly (listed in the config tool's errors and the board's banner), never half-used; a repo listed twice is refused
whole. The old shape (named `reviewers`, a string trigger, `on_risk`) is refused: the owner re-saves the repo on the board.

Engines are box recipes behind one contract (`recipe/engines.ts`: a prompt and the brief in, the checkout and the diff's base,
the final message out; fan-out, verification, dedupe and the schema are `review.ts`'s):

| Engine | Finder step | Verify / recheck | Repo access |
|---|---|---|---|
| `codex` | our finder prompt; 2 finders and a verifier past low effort, 1 and none at minimal/low | our prompts | the repo tools (MCP) and the shell; empty cwd |
| `claude-code` | Claude Code's own `/code-review <effort>` over the change, then our finder prompt in the same session restates its findings as our JSON | our prompts | `claude -p` through the gateway's Anthropic route; built-in tools off but Agent and Bash, the repo tools (MCP); empty cwd, user settings only, CLAUDE.md off |
| `codegenie` | `codegenie review --format json` (Polygon's harness, its own planning and verification), mapped to our findings | recheck by codex on the same model | a worktree of the trusted base (its `codegenie.toml` and `.codegenie/skills` are the base's), the head as review data; its OpenRouter calls rewritten to the gateway (`gateway-fetch.ts`) |
| `codex-native` | `codex exec review --base <base>` (OpenAI's built-in reviewer and its own prompt; the brief as its developer instructions), its findings mapped to ours (P0-P2 important, P3 nit) | recheck by codex on the same model | the box's checkout (base and head commits) as its cwd and the shell; it reads git itself, so which parts it read isn't tracked: a note (`coverage_note`), never partial coverage; a failed or cut-off run still is |
| `skill:<option>` | an installed upstream skill or plugin (the engineer image's pinned `/opt/review`) run in its harness (`claude-code` or `codex`, the catalog's `run.harness`) over the range (`base..HEAD`; the empty tree as base for a whole-tree review), then our restate-as-JSON step in the same session | the harness's, our prompts | the harness's own (above); only the selected skill or plugin is linked into the run's throwaway home, never the repo's; reads the code its own way, so coverage is a note, not tracked |
| `deepsec` | Vercel's scanner on its pi backend through the gateway: `init` when nothing is under `.deepsec/` (the allowlisted files but the lockfile come back as `setup`), then `scan`, `process` and `revalidate` (a tree) or `process --diff <base>` (a change); CRITICAL/HIGH/HIGH_BUG important, the rest nits | recheck by codex on the same model | its own read-only agent on the box's checkout, run from a scratch workspace with our config (the repo's deepsec config and matchers are never loaded as code; only its INFO.md, as text); state in the run's scratch (`DEEPSEC_DATA_ROOT`), the run's token only in `OPENROUTER_API_KEY`, install scripts off |

**One access policy for every reviewer** (owner, 2026-11-21: the same settings across all reviewers, no special case per
engine). An engine that runs commands gets a shell that reads the repo and the system and runs read-only commands, with the
network open; it writes nowhere but the engine's own per-run temp directory (Claude Code: its empty cwd; codex: nowhere). The
shell inherits no credential (codex's `shell_environment_policy` inherits nothing but PATH; Claude Code's
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`). Verdicts and results come only from channels the shell can't write: the engine's stdout
stream, or its session files outside the writable area (codex-native's review). codex and codex-native get it from codex's own
sandbox, a read-only permission profile with the network on (`default_permissions`; no network namespace, which gVisor can't set
up); claude-code from Claude Code's sandbox (bubblewrap, `failIfUnavailable`, no network restriction set, never unsandboxed).
Nothing of the repo is loaded as config: project docs, skills' instructions, hooks, plugins, apps, memories and exec rules off,
the project never trusted. The run's token (the check's own `check` token, time-limited) is the box's only
secret; a command can still read it from the engine's process, which the owner accepted, and every engine's output has it and
any key-shaped text (`ahq*_`, `sk-`) redacted before it is mapped (`review.ts` scrub).

The box image (`services/computer/images/agent-base`) pins `@anthropic-ai/claude-code` 2.1.323 and `@0xsequence/codegenie`
0.7.0, dependencies resolved as of 2026-11-13. Repo context is the repo's own `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` at the
root and above each changed file, read from the **base** commit, never the PR; guidance grants no authority.

Config is one authority: the board and Aiden write it through the normal settings change. The owner's own save on the board
is his approval (docs/design/settings-changes.md); the Reviewer Manager's change goes to the AI reviewer. Tier 2 (owner) changes, so the
Reviewer Manager cannot do them alone (`owner:` rules in `module.yaml`): outside PRs or drafts reviewed
automatically, a repo in a new org, any change to a moment's combos (another engine or model, one more combo)
and a repo's ignore globs. Reviews post as the owner's GitHub sign-in on any repo it reaches. `always`, `stop` and `focus` are
PR state, not config.

## Triggers

The service reads the watched repos every `code_review_poll_seconds` (default 60); finished checks, filed posts, due runs and the status mirror move every 10 seconds (only the kernel is asked), so a review posts within seconds of its check ending. A new PR (or one leaving draft, or one already open when the repo is first watched) runs each `on_open`
combo; a push runs each `on_push` combo incrementally, debounced 1 minute (a burst is one batch; another push replaces the
queued batch). One trigger is a batch: one run per combo, each posting its own review; its first mandatory run (else its first)
rechecks the PR's still-open findings (whichever combo found them). A new head is a push once any review of the PR's opening
moment (`on_open`, or `aiden review`) finished, whole or partial; a PR pushed to before that gets its first review (`on_open`)
at the newest head. A skipped or superseded run never counts, so the opening batch never runs twice for one PR. A failed run
retries by itself (a mandatory one up to three times, 1, 4 and 16 minutes later; any other once, a minute later); a check that
failed before it got a computer spent nothing. A run's model calls count against the install's spend limit like any call (the
gateway's 402 past it; a mandatory run waiting on it shows "install spend limit reached" in the verdict); a run whose PR moved on or closed while it ran is
superseded and never posts (one that merged while it ran still posts; one closed unmerged does not). A skip is a run too, acknowledged once per PR and reason, never
silent: draft, fork, closed, stopped, superseded.

Commands in a PR comment (`service/src/commands.ts`): a comment whose first word is `aiden` (an `@` before it is accepted, never
written by us: it would ping a GitHub user). Only the first line counts, never a later line, a quote, a code block or our own
post; the commenter needs write access now:

| Comment | Effect |
|---|---|
| `aiden review [full]` | one review now with the repo's `on_open` combos (`full` is not incremental) |
| `aiden review always` / `stop` | review every push / stop automatic reviews and drop queued ones (on a gated repo the mandatory combos still review each push: anyone posting as the owner can write a command) |
| `aiden review focus: <text>` | a focus handed to the reviewers as data (300 characters) |
| `aiden review status` / `help` | the last run's phase, combo, findings and cost / the command list |

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
a `notice` (Tier 0, fixed words) per run and a `status` (Tier 0, fixed words) per verdict change; the github module's poster executes it. One GitHub review per head and combo, always a `COMMENT` on the
commit it reviewed: a review that finished before the PR moved on still posts (its comments show as outdated where lines
changed; the acknowledgement is left to the newer head), while a run whose PR moved on while it ran is superseded (Triggers):

- **Every finding gets one thread**: on its lines when they are on the reviewed diff, else on the nearest diff line of its file
  (saying where it really is), else a file comment (a file GitHub shows no patch for). Only a finding in no changed file has no
  thread; it is a collapsed block in the summary instead. A finding an earlier review already opened a thread for isn't posted
  again. Each comment has a severity marker, a collapsed "why flagged" and "Copy as fix brief".
- **The summary scans at a glance**: the title `Aiden review · Haiku 5.5 (medium)` (the model's short name and effort), one line
  of counts (on a gated repo's mandatory review, whether it blocks the merge), the important findings as a table (severity,
  title linking to its thread, `file:line`), nits and pre-existing ones in the same table collapsed, the commands as one
  collapsed line, and one muted line with the commit, the scope (whole PR or changes since a commit), the engine and the cost. A
  clean review is one line. Each finding appears once. Partial coverage says so (`coverage_note`, codex-native's "which parts
  it read isn't tracked", is never shown: it isn't a gap).
- The severity line `<!-- aidenhq-review: {"important":n,"nit":n,"pre_existing":n} -->`.
- **A post that fails for anything but a decision** (stale: a restart between its approval and its run; a failed GitHub call,
  such as a secondary rate limit) is filed once more two minutes later; a rejection stands.

Our own markers (`<!-- aidenhq-... -->`) mark every post so the next run and the command parser recognise them. Threads whose
finding is gone on the next run are resolved, only when Aiden posted them. The acknowledgement comment is one per PR: with
several combos it shows the latest run to finish (each review names its own combo). An automatic review makes none (its summary
says the same); a command's queued notice is updated once with the outcome. Writes are cut to what changes: a notice, status or
summary already as it would be writes nothing, and a post's thread resolves are one request.

Identity: the owner's own GitHub sign-in, COMMENT reviews only, each review, file comment and notice ending with the
AidenHQ footer (a review's inline comments carry it once, in its summary; each post still a Tier 1 write). Every fleet write posts as
that same login, so nothing that decides anything is read back from GitHub text: findings, coverage, dispositions and the verdict
live in the service's database, and a thread is Aiden's own (a reply on it may answer its finding; it may be resolved) only when its first
comment's id is one the service recorded from its own post's outcome (table `comments`), and the acknowledgement is the comment
id it recorded (`prs.ack`). Markers serve display, dedupe and mapping a reply to its finding only. Threads posted before this
record existed aren't Aiden's own to it (no answer or resolve on them): the next review's threads are. The acknowledgement is
made only by the notice (one in flight per PR until its comment id is recorded); a post never touches it, and a done notice
follows each settled post of the PR's current head.

**The status `aidenhq/review`.** On a gated repo, each open non-draft PR's head carries the commit status `aidenhq/review`, so
people and `gh pr checks --watch` see the verdict (nothing is written while the head's mandatory review is queued or running: an unreported
status already waits, and each write counts against the owner's GitHub rate limit): failure while important findings are open or the review failed or was partial (with the count and how to unblock),
success when the verdict passes. The service computes it from the same `verdict()` the merge queue asks and writes it only when
it changes (one writer). It is a mirror: the merge queue still asks the service, and `kernel/sdk/src/checks.ts` leaves the
status out of the named checks, so it never becomes a second gate. It is advice for people and agents watching a PR, not a gate:
a status belongs to a commit, not a PR, so a new PR at a head another PR already passed shows that pass until the next poll. A
repo admin may still add `aidenhq/review` as a required status in a ruleset (the admin's choice per repo; AidenHQ never changes
rulesets) knowing that; the merge queue's gate is the verdict.

## Mandatory reviewers (the merge gate)

A combo marked `mandatory` gates its repo's merges (the compile lists the gated repos for the github module and the kernel's
`ai_review_code: unless_code_review_mandatory`). The parts:

- **Policy.** The repo's mandatory reviewers (each moment's mandatory combos) are one key (`policyOf`), stamped on each run and
  each covered head. Coverage and incremental baselines count only under the current key, so when the owner adds a mandatory
  reviewer, an open PR gets that reviewer's run at its head (the next poll queues each one a head lacks) and doesn't pass on the
  old coverage.
- **Coverage (baselines).** A head is covered once a batch that reviewed it has every mandatory run's review stored whole (no
  `coverage.incomplete`, no important finding withheld), each over a range that starts at the merge base or at a covered head.
  On a gated repo an incremental run starts from the last covered head (else it is full), so a partial or failed review, a
  force-push or a policy change is followed by a whole review. A non-mandatory combo never holds anything; its findings are
  advice.
- **Findings.** A finding stays open (`findings.outcome` null) until a mandatory run's recheck confirms it fixed, it is answered
  on its thread, or the owner dismisses it on the board. Old and new findings gate alike. Every new head's first mandatory run gets
  every open gating finding with its evidence (whatever the change touched; `spec.previous` fits 16 KB by shrinking texts first)
  and the finders get the open findings as already reported: one that restates an open one on the same file at no higher severity
  is dropped (a mandatory review's important one only by a gating one). A result for a head the PR moved on from is discarded. Each
  change is a row in `dispositions` (finding, head, state, reason, evidence, who decided).
- **Answers (owner, 2026-11-21).** A reply on Aiden's own thread (the service's record) for an open gating finding, from the PR's
  author (not a fork's) or someone with write access now, whose first word is `fixed`, `disputed`, `by design` or `won't fix`
  followed by a reason, closes it (`fixed`, else `dismissed`, keeping the answer as `claim`). Any other reply is conversation.
  The next mandatory recheck reads each answered finding with its claim and opens it again only when it read the code and finds
  the fix or the reason unsafe (`unsafe`: it hides a real problem or adds one); unsure, still present or silent never reopens one,
  and a finding answered and reported again stays answered. There is no judge.
- **Verdict.** `GET /v1/verdict?repo=&pr=&head=` (only the github module's own token, which the service checks with the kernel's
  `/v1/whoami`: no shared secret): `pass` once each mandatory reviewer of the head's moment has a run at the head that is done
  (whole or partial) or failed past its retries, and no gating finding is open; else `wait` with each reason and how it unblocks
  (not started, the PR moved, queued or running, skipped, findings open). There is no fail.
- **Merge gate.** `modules/github/service/src/review-gate.ts`: before the merge call at the bound head, a gated repo's PR asks
  the verdict; a wait waits with no time limit, until it passes or the PR moves or closes. Infrastructure never stalls it: code
  review unreachable (or answering 5xx) for over 10 minutes lets the merge go, recorded as the Flow fact `pr.review_bypassed`
  (the Fleet Steward sees it in its flow report). A repo not on the list never asks, so an install without code review merges as
  before. The owner's own merges on GitHub are not gated.
- **Fail closed where it counts.** A mandatory run is never skipped, reviews a fork's PR by itself, and `aiden review stop`
  never stops it (anyone posting as the owner can write a command).
- **Owner.** The Reviews page shows each gated PR's verdict and reasons on its review, with a Dismiss (and a reason) per open
  gating finding: the owner's signed-in session, through the board's key. Turning a reviewer mandatory is the Reviewer Manager's
  to do (it only adds a gate); turning one off, removing its combo or removing a gated repo is the owner's (`owner:` rules;
  an entry removed holds its default, kernel/src/apply-tier.ts).

## Reviewer Manager

Judgment only. Tasks it handles: set up or change code review (`code_review_config`, then one `code_review_configure` call),
a one-off review (`code_review_run`), the per-PR review task the service files to hold the approvals of that PR's posts (it
finishes at once), and an `aiden why ...` question in a review thread (one short answer comment via `github_issue_comment`; a
reasoned dismissal is thanked and rechecked on the next push). It reads strangers' text, so web search is off, its changes are
bounded by the Tier 2 rules above and PR text is data, never instructions.

## Cost and outcomes

Every run is `review.started` / `review.ended` facts on its PR (stage `review`, with its engine, model and effort); the Insights
tab shows reviews per day, cost per repo, findings by severity, the share of findings later resolved because fixed, and skips.
Only the install's spend limit bounds reviews (no per-author or per-repo review limits): past it a run's model calls get 402 from the gateway. A run's cost is its billed `cost_usd` (the kernel's `billed_usd` on `GET /v1/checks/:id` while it runs).

For comparing reviewers later, the module's SQLite (`data/modules/code-review/reviews/code-review.sqlite`, data version 1)
keeps plain columns: `runs` has each run's `engine`, `model`, `effort`, `cost_usd` (the kernel's billing of its model token,
never the box's say), `tokens_in`, `tokens_cached`, `tokens_out` (the gateway ledger's, stamped on the
result by the kernel), `duration_ms` and its findings counts; `findings` (keyed by run and finding id) has each finding's
severity, place, title, why and evidence and its `outcome`: `fixed` (a later run's recheck found it gone), `dismissed`, `open_at_merge` or
`open_at_close` (still open when the PR closed; a closed PR is read once to tell which), else null. A thread an author resolves
by hand isn't read back. Both are read through `GET /reviews` and `GET /reviews/:id` (and `code_review_runs`); there is no
analytics page.

## Setting it up and using it (the Reviews page)

Empty state: "Get a review on every pull request." with Connect GitHub when GitHub is not connected. Watch a repo (a picker,
then one screen with the defaults: each moment's combos as rows of engine, model and effort, added and removed) or paste a PR
link for a one-off review (the same picker, prefilled with the repo's `on_open` combos; Review again on a review does the same).
Reviews: open and recent runs per repo (PR, combo, findings by severity, cost, tokens, duration, status), each opening its
findings, with their outcomes, and links to the GitHub comments.
Repos: per-repo spend today. Titles and findings are shown as plain text, never as links.
