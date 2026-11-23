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
claude-code and codegenie low to max), and `mandatory` (default false; written only when on), stored whole. A repo with a mandatory combo has one in `on_open`, else it is refused (the service, the board and the compile all say so); a mandatory `on_push` combo is optional: without one, the PR's opening review stands for every later head (no push is reviewed for the gate), open gating findings still hold the merge and a `fixed` claim is still rechecked, at the pushed head, by the first mandatory `on_open` combo at low effort; a repo-level `mandatory` is refused. The engine catalog (`ENGINES` in `config.ts`, served at `GET /engines`) offers a
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
and a repo's ignore globs. Reviews post as the owner's GitHub sign-in on any repo it reaches, or, where the owner's optional
GitHub App is installed on the PR's base repo, as that App (one review writer, its own write limit:
`docs/superpowers/specs/2026-11-22-github-app-review-writer-design.md`). `always`, `stop` and `focus` are
PR state, not config.

## Triggers

The service reads the watched repos every `code_review_poll_seconds` (default 60); finished checks, filed posts, due runs and the status mirror move every 10 seconds (only the kernel is asked), so a review posts within seconds of its check ending. A new PR (or one leaving draft, or one already open when the repo is first watched) runs each `on_open`
combo; a push runs each `on_push` combo incrementally, debounced 1 minute (a burst is one batch; another push replaces the
queued batch). One trigger is a batch: one run per combo, each posting its own review; its first mandatory run (else its first)
rechecks the PR's still-open findings (whichever combo found them). A new head is a push once any review of the PR (but a one-off)
completed, whole or partial, whatever became of its post; a PR pushed to before that gets its first review (`on_open`)
at the newest head. A skipped or superseded run never counts, so the opening batch never runs twice for one PR. A failed run
retries by itself a minute later (a mandatory one up to three times, any other once); a check that
failed before it got a computer spent nothing. A run's model calls count against the install's spend limit like any call (the
gateway's 402 past it: the run waits 30 minutes, its attempt not counted, and a mandatory run waiting on it shows "install spend
limit reached" in the verdict); a run whose PR moved on or closed while it ran is
superseded and never posts (one that merged while it ran still posts; one closed unmerged does not). A skip is a run too, acknowledged once per PR and reason, never
silent: draft, fork, closed, stopped, superseded.

Commands in a PR comment (`service/src/commands.ts`): a comment whose first word is `aiden` (an `@` before it is accepted, never
written by us: it would ping a GitHub user). Only the first line counts, and only as a whole command from the table (prose
that starts "aiden review is ..." is no command), never a later line, a quote, a code block or our own post; the commenter needs write access now:

| Comment | Effect |
|---|---|
| `aiden review [full]` | one review now with the repo's `on_open` combos (`full` is not incremental) |
| `aiden recheck` | one recheck-only run at the current head: every answered finding and every gating open one is checked again, each judged on its own (no new findings) |
| `aiden review always` / `stop` | review every push / stop automatic reviews and drop queued ones (on a gated repo the mandatory combos still review each push: anyone posting as the owner can write a command) |
| `aiden review focus: <text>` | a focus handed to the reviewers as data (300 characters) |
| `aiden review status` / `help` | the last run's phase, combo, findings and cost / the command list |

Asking Aiden "review <PR URL> with Claude Code and Codex" (the Reviewer Manager's `code_review_run` with `combos`; the board's Review again) does the same for any PR the instance can read, with the combos asked for (default the repo's `on_open`).

## The review run

`recipe/review.ts`, one check job per PR head and combo: the engine's finders on the diff with the guidance (the plan in
`engines.ts`), then, when the plan verifies, a verifier that keeps a finding only with a `file:line` it confirmed, then dedupe and rank. It returns findings JSON (severity
`important` or `nit`, `pre_existing` kept only as a stored kind; path, line, title, why, evidence, fix brief), a `coverage` block (files reviewed and
excluded, `incomplete` reason), `downgraded` (importants made nits, below) and the run's billed cost, bound into the kernel's signed receipt. Incremental runs diff from the
last reviewed head (only the PR's own files: main merged in is not the change); a force-push or rebase that drops it from the head's ancestry makes the run full; previous findings are rechecked. PR title,
body (`spec.intent`, none for a fork), comments and code are fenced as data throughout.

**What "important" means (owner, 2026-11-22).** One rubric, in the brief (codex, Claude Code and codex review read it; codegenie and deepsec map their own fields): an important finding is a realistic
failure with a concrete scenario (a specific input or state and the wrong result), old code and new alike; behaviour the PR's
description states as intended is a design choice, not a finding, unless it fails concretely. The finder schema's
`failure_scenario` is required for an important finding (codex review, which answers in its own format, writes a
"Failure scenario:" line in its body; codegenie's `failureMode` and deepsec's revalidated description are theirs). Code, never the
model, makes an important finding without one a nit, and one in a file the PR doesn't change a nit too (GitHub gives it no thread
to fix or answer on); the scenario leads the finding's why on GitHub. Nits never gate. The box runs without repo hooks, plugins, shell or network beyond the
model gateway. The service accepts what the recipe runs: each engine's own efforts.

## Posting

The service files a `post` write (Tier 0: no AI reviewer reads it; the `instance-details` write.filed check refuses a host, home path or address in a post's or reply's comment text; the service removes them first) or
a `notice` (Tier 0, fixed words) per run and a `status` (Tier 0, fixed words) per verdict change; the github module's poster executes it. One GitHub review per head and combo, always a `COMMENT` on the
commit it reviewed: a review that finished before the PR moved on still posts (its comments show as outdated where lines
changed; the acknowledgement is left to the newer head), while a run whose PR moved on while it ran is superseded (Triggers):

- **Every important (and pre-existing) finding gets one thread; a nit gets none** (every inline comment is a GitHub write, and the
  secondary rate limit on those blocked the fleet; owner, 2026-11-22): a nit is one line of the summary, `file:line` and its title.
  A thread sits on its lines when they are on the reviewed diff, else on the nearest diff line of its file
  (saying where it really is), else a file comment (a file GitHub shows no patch for). Only a finding in no changed file has no
  thread; it is a collapsed block in the summary instead. A finding an earlier review already opened a thread for isn't posted
  again. Each comment has a severity marker, a collapsed "why flagged" and "Copy as fix brief".
- **The summary scans at a glance**: the title `Aiden review · Haiku 5.5 (medium)` (the model's short name and effort), one line
  of counts (on a gated repo's mandatory review, whether it blocks the merge), the important findings as a table (severity,
  title linking to its thread, `file:line`), pre-existing ones in a collapsed table, nits as a short list of `file:line` and title, the commands as one
  collapsed line, and one muted line with the commit, the scope (whole PR or changes since a commit), the engine and the cost. A
  clean review is one line. Each finding appears once. Partial coverage says so (`coverage_note`, codex-native's "which parts
  it read isn't tracked", is never shown: it isn't a gap).
- The severity line `<!-- aidenhq-review: {"important":n,"nit":n,"pre_existing":n} -->`.
- **A post that fails for anything but a decision** (stale: a restart between its approval and its run; a failed GitHub call,
  such as a secondary rate limit) is filed once more two minutes later; a rejection stands.
- **A post that is still refused is never silent**: when its approval record ends refused (stale, rejected, or failed in the
  executor), the run row keeps the reason and the acknowledgement says, in fixed words, that the review of that head was not
  posted and to ask again with `@aiden review`. A per-push run has no author to tell, so the pull request is where it is said;
  the PR's approval task stays quiet.
- **The notice is not given up on**: if the kernel or GitHub can't take it now, it is asked again with backoff (a minute,
  doubling to fifteen) for as long as the pull request is open; waiting is not failing, so only a pull request that closes
  first ends it (`failed` on the run row).
- **A post is bound to its head alone**: the kind declares `binds` (`repo`, `ref`, `commit`), so redeploying this module or the
  pull request's base moving never stales a review of a head that still stands. Every other write keeps the full revalidation.

Our own markers (`<!-- aidenhq-... -->`) mark every post so the next run and the command parser recognise them: each inline
comment carries its run's and its finding's, which is how a review whose comment list GitHub can't answer is still recorded as
Aiden's own from its threads. A notice carries the acknowledgement marker, so a create whose answer was lost is found and edited
rather than made again. Threads whose
finding is gone on the next run are resolved, only when Aiden posted them. The acknowledgement comment is one per PR: with
several combos it shows the latest run to finish (each review names its own combo). An automatic review makes none (its summary
says the same); a command's queued notice is updated once with the outcome. Writes are cut to what changes: a notice, status or
summary already as it would be writes nothing, and a post's thread resolves are one request.

Identity: the owner's own GitHub sign-in, COMMENT reviews only, each review, file comment and notice ending with the
AidenHQ footer (a review's inline comments carry it once, in its summary; each post still a kernel write record). Every fleet write posts as
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
rulesets) knowing that; the merge queue's gate is the verdict. Such a required status must accept any source: the App and the
owner both write it (a ruleset's check with no `integration_id`; classic protection's `app_id: -1`). Adding it in GitHub's UI
after the App has posted it can pin it to the App, and then a repo without the App never passes.

An infrastructure refusal of a post is a connection problem, not a verdict. github-mcp's review route carries an owner-fixable
`GitHubNeed` (an org that restricts OAuth apps, an expired sign-in, a missing scope, org SSO) out as the kernel's `needs_owner`
shape rather than a bare 502, and the executor records that need on the run; the run ends `failed` with its post `refused`, and
its askers' summary names the one link (the Grant link for `restricted`, Reconnect for `expired`) that unblocks the next post.

## Mandatory reviewers (the merge gate)

A combo marked `mandatory` gates its repo's merges (the compile lists the gated repos for the github module and the kernel's
`ai_review_code: unless_code_review_mandatory`). The parts:

- **What reviewed a head.** The verdict and coverage read the mandatory runs that reviewed the head (the latest per combo and
  moment there), never the setting now: a settings change or a deploy applies from each PR's next head and never re-reviews open
  heads (2026-11-21 20:06Z: #1243 added columns read against the setting, and the first poll after it re-ran a whole opening
  review on every open PR). A head with no mandatory run at all (a PR open when its repo became gated) gets its trigger.
- **Coverage (baselines).** A head is covered once every mandatory reviewer that reviewed it has its review stored whole (no
  `coverage.incomplete`, no important finding withheld), each over a range that starts at the merge base or at a covered head.
  On a gated repo an incremental run starts from the last covered head while it is an ancestor of the head (main moving on never
  resets it; a retry is incremental too), else it is full, so a partial or failed review or a force-push is followed by a whole
  review.
- **Bare rebase (owner, 2026-11-22).** When a push's PR diff (GitHub's compare from its merge base, every file's patch) is the
  baseline head's own (from the merge base its review recorded), the run ends done at no cost with nothing posted ("carried: a
  bare rebase"): the head is covered and the PR's open findings stay as they are. Anything GitHub can't fingerprint (a file
  without a patch, 300 files) is reviewed as usual. A non-mandatory combo never holds anything; its findings are
  advice.
- **Posted first.** A finding gates only once a mandatory run that found it posted (its GitHub thread exists, so it can be fixed
  or answered). While a head's mandatory review is still being posted the verdict waits on the post; a post refused by something
  other than a decision (a rate limit, a restart, a failed call) is filed again 2, 4, 8, 16, then every 32 minutes while the PR is
  open; one rejected never gates. A module's own write (the post, filed on the PR's review task) runs even when that task has
  closed meanwhile: the kernel's closed-task rule ends an agent's leftover request only.
- **Findings.** A finding stays open (`findings.outcome` null) until a mandatory run's recheck confirms it fixed, it is answered
  on its thread, or the owner dismisses it on the board. Old and new findings gate alike. Every new head's first mandatory run gets
  every open gating finding with its evidence (whatever the change touched; `spec.previous` fits 16 KB by shrinking texts first)
  and the finders get the open findings as already reported: one that restates an open one on the same file at no higher severity
  is dropped (a mandatory review's important one only by a gating one). A result for a head the PR moved on from is discarded. Each
  change is a row in `dispositions` (finding, head, state, reason, evidence, who decided).
- **Answers (owner, 2026-11-21).** A reply on Aiden's own thread (the service's record) for an open gating finding, from the PR's
  author (not a fork's) or someone with write access now, whose first word is `fixed`, `disputed`, `by design` or `won't fix`
  followed by a reason, closes it (`fixed`, else `dismissed`, keeping the answer as `claim`). An agent records the same answer with the
  `code_review_resolve` tool (engine `resolve`, the same `answer` path, no GitHub write: a GitHub refusal never holds a merge);
  an important finding's answer is then replied on its thread by the service (the `code-review.reply` write, Tier 0, queued in
  the `replies` table and filed again later when refused; it never holds the outcome), a nit's is not. A human's thread reply
  still works. Any other reply is conversation.
  The next mandatory recheck reads each answered finding with its claim and opens it again only when it read the code and finds
  the fix or the reason unsafe (`unsafe`: it hides a real problem or adds one). Each `unsafe` entry carries the finding's id, the
  reason the answer is unsafe and the defect still present at the head (and, when given, its line there); an id alone or an entry
  without a reason is silence, so unsure, still present or silent never reopens one, and a finding answered and reported again stays
  answered. A reopened finding's `why` leads with that reason (the original note after it), and the same reason at the same evidence
  never reopens it twice. It goes in that run's post, titled as reopened, its row linking its earlier thread. Answers are rechecked
  at every new head, one that changes only lockfiles or ignored files included. There is no judge.
- **Verdict.** `GET /v1/verdict?repo=&pr=&head=` (only the github module's own token, which the service checks with the kernel's
  `/v1/whoami`: no shared secret): `pass` once each mandatory reviewer that reviewed the head has a run there that is done
  (whole, partial or carried) or failed past its retries, and no gating finding is open; else `wait` with each reason and how it unblocks
  (not started, the PR moved, queued or running, skipped, findings open). There is no fail.
- **Merge gate.** `modules/github/service/src/review-gate.ts`: before the merge call at the bound head, a gated repo's PR asks
  the verdict; a wait waits with no time limit, until it passes or the PR moves or closes. Infrastructure never stalls it: code
  review unreachable (or answering 5xx) continuously for over 10 minutes (any answer, or two minutes with no attempt,
  starts the count over) lets the merge go, recorded as the Flow fact `pr.review_bypassed`
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

The requester of a one-off review hears its outcome. A one-off ask (`POST /reviews`, or the Reviewer Manager's
`code_review_run`) records its asker — the agent and task from the kernel's signed caller on the request, never a body field, and
the board's own calls carry none — and the runs that request was answered with. Once each of those runs has settled the asker
gets one summary, never one message per run: the PR, how many runs posted, were refused, were held by the install's spend limit or
failed, and the one action that fixes it (the Grant link for `restricted`, the spend limit's reset, or a re-run). With a task it is
a wake notice on that task (its agent hears it and can act); an ask with no task (the board's) goes to the owner as one alert, and so
does an asker whose task has closed since (one alert naming every such asker). Two askers of the same ask share one run set — the
second ask is the run already waiting or running — and each hears the summary of only the runs its own request queued (a later ask,
by that asker or another, for another combo or with another focus is another run set and another summary), written only once
nothing it names is still on its way: a queued or running run, or a post filed again. A run the spend limit holds is the
exception: it can wait for days, so the summary goes now and names the limit, and a second asker that reuses such a held run is told at once
too (no later end will ever tell it). Each ask is stored as its own row, keyed by its run set, so two asks of one task keep their own
summaries rather than the second rewriting the first's runs (its run set is ordered, so the same runs asked for in another combo order are one ask). The summary is stored unsent before it goes and
retried each tick until the kernel takes it, so a restart never drops it: a send in flight is marked, and a restart clears the
mark so the summary is tried again instead of being lost. A closed ask's row is marked only once the owner's fallback notice has landed, so
a crash between the task's answer and that notice tells the owner rather than losing the summary. The same summary is never sent twice, and each notice carries its own
dedupe key (per asker, or per closed ask's run set, and per summary) so two notices of one batch never collapse into one — two closed asks
whose runs happened to render the same words are still two alerts. A wake notice passes its key as the wake's own `id`, which the kernel
reads back from the task's thread, so a summary sent again after a crash between the send and its stamp wakes the agent once.

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
