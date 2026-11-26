# Flow: where the fleet's time goes

For every piece of work: how long each step took from the request to the change running in production, who handled it,
and every period it sat idle and why. The purpose is to decide what to fix next in the system (a gate, a handbook rule, a
tier, capacity), not to grade agents or people (owner). Agents read the same data (Fleet Steward, Aiden) and raise a slow
or regressing stage themselves. The analytics tabs and the PR timeline are in [flow-insights.md](flow-insights.md).

Rules that bind (owner):

- A gap with no recorded cause shows as `unknown`; a reason is never guessed.
- Writing a fact never blocks or fails the action it describes.
- Owner wait is one thing: "owner wait" (not split into waking and off hours).
- Flow's log is the one place timing is read from. Slices by actor exist to find system causes, never to rank.
- Tool-call records stay out of the log; cost is on `job.ended`.

## 1. The fact log (kernel)

The `facts` table in `kernel/src/facts.ts` (`kernel.db`) is the log; it replaced the old `events` table (migrated once at
open). Kernel writers insert a fact in the same transaction as the state change (`noteFact` never fails the change);
`/v1/flow` reads on its own read-only connection. Facts are pruned after 400 days (the kernel's daily sweep).

| column | meaning |
|---|---|
| `seq` | ingestion order, for incremental readers |
| `id` | `<type>:<subject>:<version>`; a duplicate delivery, a poll seeing the same change, or a re-run backfill records once |
| `type` | namespaced, past tense: `task.*`, `wake.*`, `job.*`, `record.*`, `check.ended`, `deploy.applied`, `pr.*`, `grade.*`, `work.waiting`, ... |
| `subject` | `task:<uuid>`, `job:<id>`, `record:<id>`, `pr:<owner/repo>#<n>` (CI per head `...@<head>`), `issue:<owner/repo>#<n>`, `deploy:<generation>`; PR and issue subjects lowercase |
| `task` | the Paperclip task uuid, the main join key |
| `at` / `seen_at` | when it happened at the source (UTC `Z`) / when the kernel recorded it |
| `actor` | `agent:<key>`, `account:<id>`, `module:<name>`, `kernel`, `github:<login>`, or `unknown` |
| `source` | `live`, `poll` or `backfill` |
| `data` | JSON payload: links (`job`, `record`, `pr`, `head`, `sha`, `generation`, `parent`), `reason` and `blocked_on` for waits, cost and tokens on `job.ended` |

Only records with tier 1 or higher become facts (tier 0 ran at once and carries no wait).

**Actors are set by the kernel; callers never pass one.** A job's facts: the job's agent. A module's fact
(`POST /v1/facts`): `module:<name>`, or an agent only for that module's own work (the agent of `data.job` when the job is
the calling module's, or, for a `pr:` subject, the requester of the module's own code-host PR record on the fact's task).
The module's name is part of the version, so two modules declaring one type never pre-empt each other and a reader can
tell who wrote a fact. The owner or another person: the board or channel account. `actor` (who did it) is separate from
`data.assignee` (who holds the task).

## 2. Who writes which facts

Kernel:

- `wakes.ts`: `task.created`, `task.status_changed`, `task.assignee_changed`, `task.blocked_changed` from the diff against
  `wake_tasks` in both the event path and the poll backstop (same ids from the same fields, so one change counts once; a
  change the poll never saw is lost and shows as `unknown`), and the wake lifecycle (`wake.opened`, `wake.bound`,
  `wake.dropped`).
- `admission.ts` / `jobs.ts`: `job.queued` (with `wake_at`), `job.held` (`reason`: capacity, max_parallel, spend_cap, paused, no_computer,
  launcher_unavailable), `job.started`, `job.ended` (state, exit, cost and tokens summed from the gateway's calls for the job).
- `records.ts`: `record.filed`, `record.decided` (decider: reviewer, owner or code), `record.held`, `record.claimed`,
  `record.landed` / `record.failed`. `checks.ts`: `gate.would_block`, `finish.verdict` (kernel-only). `checkjobs.ts`:
  `check.ended`.
- `generations.ts`: `deploy.applied` (generation, product sha, health, `revert_of`) and `pr.deployed` for each product PR the
  generation ships (the first generation whose product sha has the merge sha as an ancestor; checked at apply time). It
  trusts `pr.merged` only from the code host that owns the product repo (`hostOf`, by the module name in the version).
  App repos deploy through `apps-platform.deploy` records; a repo with no deploy step counts merge as deploy.
- `POST /v1/tasks`: `task.created` carries `parent` and the source marker (for example a GitHub issue URL).

Modules emit through `factEmitter(...).emit(fact)` in `kernel/sdk/src/kernel-client.ts` (`POST /v1/facts`, role
`kernel.facts`). The module declares every type in `module.yaml` `facts:` with a subject kind and, for waits, the allowed
`reasons`. The kernel refuses a whole batch (4xx naming the bad fact) when a type is undeclared, a subject has the wrong
kind, a reason is undeclared, `data` exceeds 4,096 bytes or `at` is more than a day ahead; at most 500 facts a batch, and
facts older than 400 days are skipped. The SDK emitter retries a batch on 5xx or network failure and drops, with one log
line, a batch the kernel refused. Current emitters:

| Module | Facts |
|---|---|
| `github` (`service/src/flow.ts`; task from `pr-tasks.json`) | `pr.opened`, `pr.pushed`, `pr.closed`, `pr.checks_started`, `pr.checks_completed`, `pr.merged`, `pr.reverted`, `issue.opened`, `issue.labeled`, `work.waiting` / `work.resumed` for merge-queue waits (reasons: checks, eval, retry, conflict), `code.added`, `code.rewritten` |
| `codehost-local` | the same `pr.*`, `work.*` (reason checks) and `code.*` facts, written by the kernel itself (`kernel/src/codehost.ts` `localFacts`) |
| `grading` | `grade.requested`, `grade.verdict`, `work.waiting` / `work.resumed` (reason `grade_retry`) |
| `maintainer` | `issue.triaged` (the stage starts at the issue's creation) |
| `code-review` | `review.started`, `review.ended` per review run |

`pr.opened` and `issue.opened` carry `author` and `author_kind` (`agent` = in AidenHQ's records, or carrying the AidenHQ footer or trailer; `owner` = the owner's login without them; `outside`);
`pr.opened` carries `title`.

## 3. Declaring stages (the generic part)

Each module lists `facts:`, `stages:` and optionally `journeys:` in `module.yaml`:

```yaml
facts:
  work.waiting: { subject: pr, reasons: [checks, eval, retry, conflict] }
stages:
  - { name: merge_queue, label: Merge queue, from: work.waiting, to: work.resumed }
```

The compiler (`scripts/modules.ts`) validates them (a stage naming an undeclared fact fails at apply; a module may name
the kernel's own fact types in a stage but never declare them) and writes `config/kernel/modules.json`; the kernel loads
them. A stage is an interval from a `from` fact to the next `to` fact on the same subject (`kernel/src/flow-stages.ts`).
`where` filters the `to` fact's data; `start` takes the real start from a data field; `from === to` makes one fact the whole
interval. Stages may overlap and repeat (each occurrence is a row). The kernel's own stages: queued, working, review (AI
reviewer's decision), owner (owner's decision), deploy (merge to `pr.deployed`). Another owner's module joins the waterfall
and bottleneck chart by declaring facts and stages and calling `emit`; no kernel change.

## 4. Work items and fan-in

The work item is the root of a task tree (follow `task.created.parent` up). A GitHub issue links to the task the maintainer
filed for it, so the item's clock starts at the issue's creation; an owner request starts at its chat or task creation. Item
lead time runs to the last `deploy.applied` that shipped any of its PRs (or to the root's completion when nothing deploys).
Fan-in is stored once and linked: one `pr.merged` names its PR, one `deploy.applied` its product sha. Deployments are counted
distinctly for DORA.

## 5. Derived views: `GET /v1/flow`

Served by `kernel/src/flow.ts` (stage pairing, idle reasoner) and `kernel/src/journeys.ts`, readable by the board and by
modules with a role (`kernel.flow-read`):

- `?task=<id>` / `?item=<id>`: the waterfall (stage occurrences with actor, every fact, every idle period with its reason).
- `?since=&to=&by=stage|agent|module|repo|model&scope=all|<module>`: per stage count, median and p75 of work and wait, wait
  split by reason, DORA, churn, fleet metrics and the insights of flow-insights.md. A stage with fewer than 5 items carries
  raw samples, not percentiles.
- `?journeys=1`, `?journey=<name>&...`: see flow-insights.md.

**Idle and its reason.** A task is idle while a task fact shows it open, no job of its own is queued or running, and no stage
of it is open (other than a wait). A stage a module's fact opened counts as work for 24 hours; after that the task is idle as
`stage_open:<name>`. The reason, in order: the latest unexpired `work.waiting` (an agent's own `task_wait` wait also ends when
the task's next job starts); an open record (`owner`, else `reviewer`); a `blocked_by` task not done (`blocked_on: WOR-n`); an
open child task (`delegated`); a future scheduled wake (`scheduled`); then, with nothing running, filed or waiting and no wake
pending, `orphaned`; otherwise `unknown`. A wake the kernel knows of counts as pending until bound or dropped, until a job on
the task is queued after it, or until it ages out (2.5 hours past its due time, unless admission holds it with `job.held`).
Reasons are evaluated at every fact inside a gap, so a gap splits where its cause changes.

**DORA.** Deploy frequency: distinct healthy `deploy.applied` per day. Lead time: the PR's `pr.opened` to its `pr.deployed`.
Change failure rate: deploys followed by a revert PR of something they shipped, a rollback generation (`revert_of`), failed
health, or a linked incident (the linker in `kernel/sdk/src/quality.ts`, shared with the board), over all deploys. An incident
is the Fleet Steward detector's check task for something newly tripped (`task.created` carries the module-filed task's
origin); it always counts for time to restore and counts toward failure rate only when the linker finds a PR or commit. Time to
restore: incident task created to the deploy of a PR from it or a task under it, or failed generation to the next healthy one.
Rework rate is the fifth figure (flow-insights.md).

**Bounds.** Views run on the kernel's thread: a waterfall reads at most 5,000 facts, a summary or idle read at most 50,000
(newest first, `truncated: true` when cut); a summary is reused for 60 s per minute-rounded window.

**Churn.** A pass over each repo's default branch (incremental from a stored cursor; `kernel/sdk/src/churn.ts`) tracks each
added line by identity across later merged diffs, following renames, and emits `code.added` per merged PR and `code.rewritten`
(`{pr, by_pr, lines, days}`) when a later PR deletes or replaces its lines within 30 days. Views show the 30-day rewrite
share only for PRs older than 30 days, plus the count of lines rewritten three or more times. Generated and vendored paths
are excluded by a list (`DEFAULT_CHURN_EXCLUDE`). It is "rewritten", not "defect": rewrites include planned refactors.
`github` runs it every 15 minutes in its cache clone; `codehost-local` runs it after each merge on the kernel's thread (first
pass reads the last 500 commits).

## 6. Surfaces

- **Board Flow page** (`services/board/web/src/Flow.tsx`, reads via `services/board/src/flow.ts`): tabs Overview, PRs, Stages,
  Rework, Queue, Cost with a period control (7d, 30d, 90d); see flow-insights.md. Each item opens its waterfall with actors
  and idle reasons.
- **Agents.** Fleet Steward's read-only tool (`modules/fleet-steward/service/src/mcp.ts`) serves the same numbers to the agents
  granted it. The Fleet Steward detector reads Flow: Flow's idle list is its one stuck-work rule (an `orphaned` item idle over
  2 hours), and a stage whose p75 or wait share rose more than 50% over the week before (at least 10 items in both weeks) is
  logged as what it would file, in observe mode; nothing is filed until promoted (`detector.ts`). A held task no enabled
  dispatcher runs is `unpolled`, not `orphaned`: the idle sweep skips it and the detector raises it at once, not critical.
- `/v1/work` keeps jobs and records for the run page; `/v1/work/metrics` (Prometheus) and the board's `fleet-stats` count
  tasks, records and cost and stay.

## 7. Backfill

Both parts write `source: backfill` facts automatically; deterministic ids make a re-run harmless, and gaps before Flow show
as `unknown`. The kernel backfills its own history (`records`, `jobs`, `wakes`, `provenance`, approval events,
`generations.jsonl`) at every start (`facts.backfillLocal()`, never blocking boot). `github` backfills GitHub once, on its
first pass (issues, labels, PRs, pushes, check runs per head, reviews, merges; no button or route; it stops when the App's
hourly budget runs low and continues on a later pass; `BACKFILL_VERSION` reruns it when the shape grows).

## 8. Retention

Facts are small (about 100 a task). The kernel's daily sweep prunes facts older than 400 days; `job.ended` carries the job's cost, so cost per outcome survives the gateway's 40-day `calls` pruning.

## New installs and other owners

Flow is on in every install; it uses no model. The log starts empty and the page says it fills in as work happens. Stages,
reasons and tiles come from the installed modules' declarations: without `github` there are no GitHub issue or CI stages
(`codehost-local` emits the same `pr.*` and churn facts for the repos it hosts), and without deploys the DORA tiles are
hidden rather than zero. Flow schedules nothing of its own. Day buckets use the instance timezone; actors are accounts and
agent keys, so a second admin's taps show as theirs. Nothing names an instance's repos, agents or people.
