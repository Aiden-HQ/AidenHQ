# Flow: where the fleet's time goes

Status: design, 2026-11-19. Owner decisions are marked (owner); everything else is the designer's call.

## Why

The owner wants to find bottlenecks: for every piece of work, how long each step took from the request to the change
running in production, who handled it, and every period it sat idle and why. The purpose is to decide what to fix next
in the system (a gate, a handbook rule, a tier, capacity), not to grade agents (owner). Agents read the same data and
raise a slow or regressing stage themselves, because dashboards the owner has to open decay.

Today nothing can answer this. Timestamps are spread over the kernel (`jobs`, `records`, `wakes`, `checks`), the code
host's `merges.json`, the grader's `grades`, Paperclip, GitHub and `generations.jsonl`. Several are overwritten
(`jobs.at` at start loses queue time; `records.updated_at` keeps only the last move; the merge queue clears
`wait.since`; Paperclip keeps no status or assignee history). The kernel `events` table holds five approval event types.
A live trace of WOR-8567 (2026-11-19) shows the gap: assigned 10:02, job 29 s later, handed to a second agent at 10:34,
then idle 10:37 to 12:21 with no record of why.

## Goals

- **Per item timeline (waterfall):** every stage of every task, with its actor (agent key or person) and every idle
  period with its reason, or `unknown` when nothing recorded one. Covers all tasks, not only engineering (owner);
  engineering (issue → triage → assign → job → PR → CI → grade → review/owner → merge → deploy) is the first fully
  instrumented pipeline.
- **Bottlenecks:** per stage, work time vs wait time (median and p75), wait split by reason, over 7/30/90 days, sliceable
  by agent, module, repo and model.
- **DORA:** deploy frequency, lead time for changes, change failure rate, time to restore.
- **Churn:** how much merged code is rewritten, and how soon, attributed to the writer and the rewriter (owner).
- **Fleet metrics:** aging WIP (oldest item per stage, arrivals vs completions), retries per accepted outcome, wakes that
  produced no action and their cost, admission friction (time held by capacity, spend cap, paused agent, no computer),
  first-pass acceptance (grader, reviewer), handoffs and time to the next actor's first action, owner interventions per
  outcome, cost and tokens per accepted outcome including spend on retried or abandoned work.
- **Generic:** any module adds its own facts and stages by declaration; another owner's instance gets Flow with the
  modules it runs.

## Non-goals

- Live alerting on single jobs (Prometheus `/v1/work/metrics` and the monitoring module keep that).
- A warehouse copy. Add one only when a real cross-source query needs it.
- Ranking or scoring individual agents or people. Slices by actor exist to find system causes.
- Splitting owner wait into waking and off hours (owner: "owner wait should just be marked as owner wait").
- Tracing inside a job (tool calls, model calls). The run page already shows that; tool-call records (`conn.tool`, ~2,600
  a day) stay out of the log.

## Anti-goals

- Guessed reasons. A gap with no recorded cause shows as `unknown`; it never borrows a plausible reason.
- A second source of truth. Flow's log becomes the one place timing is read from; the Fleet Steward scorecard and the
  board's `fleet-stats` move onto it and their own computations are deleted.
- Instrumentation that changes behaviour. Writing a fact never blocks or fails the action it describes.

## Approaches

Considered:

- **A. Kernel fact log that the kernel and modules write as things happen (chosen, owner, "A, plus GitHub backfill").**
  It captures queue time, transitions and wait reasons that are lost today, and adds one mechanism, not a stack.
- **B. A collector module rebuilding timelines from existing stores into the warehouse.** No core change, but the lost
  history stays lost (queue time, status history, wait reasons) and it breaks on every store format change.
- **C. OpenTelemetry spans to a collector, Tempo or ClickHouse and Grafana.** The standard, but built for second-long
  requests, not tasks that wait for days; adds 2-3 services; idle reasons fit badly. A's log can be exported as spans
  later if someone needs it.

Within A, a Codex review (2026-11-19) changed the first draft: typed facts per subject instead of a universal
`stage enter/exit/wait` taxonomy, stages derived in queries, kernel SQLite plus one HTTP read contract instead of a
warehouse copy, and central actor verification.

## Design

### 1. The fact log (kernel)

A new `facts` table in `kernel.db` is the log. It replaces the `events` table: its two writers (`records.ts` approval
events, `checks.ts` `gate.would_block`) write facts instead (`record.filed`, `record.decided`, `record.held`,
`record.landed`/`record.failed`, `gate.would_block`), the backfill copies the old rows across, and `events` is dropped.
Nothing reads `events` today. The table lives in `kernel.db` so kernel writers can insert a fact in the same transaction
as the state change; `/v1/flow` reads through its own read-only connection (WAL: reads never block the approval path),
with bounded windows.

| column | meaning |
|---|---|
| `seq` | ingestion order (INTEGER, for pagination and incremental readers) |
| `id` | deterministic: `<type>:<subject>:<source version>` (a Paperclip `statusVersion`, a job state, a PR head and check run id), so a duplicate delivery or a poll that sees the same change dedupes on insert |
| `type` | namespaced, past tense: `task.created`, `task.status_changed`, `task.assignee_changed`, `job.queued`, `job.started`, `job.ended`, `record.filed`, `record.decided`, `record.claimed`, `record.landed`, `check.ended`, `deploy.applied`, `pr.opened`, `pr.check_completed`, `pr.merged`, `grade.verdict`, `work.waiting`, ... |
| `subject` | what the fact is about: `task:<uuid>`, `job:<id>`, `record:<id>`, `pr:<owner/repo>#<n>`, `deploy:<generation>` |
| `task` | the Paperclip task it belongs to, when there is one (the main join key) |
| `at` | when it happened at the source |
| `seen_at` | when the kernel recorded it (differs for polls and backfill) |
| `actor` | who did it: `agent:<key>`, `account:<id>`, `module:<name>`, `kernel`, `github:<login>`; `unknown` when unverifiable |
| `source` | `live`, `poll` or `backfill` (backfill rows are labelled so views can show reduced certainty) |
| `data` | JSON payload, validated per type: links (`job`, `record`, `pr`, `head`, `sha`, `generation`, `parent`), `reason` and `blocked_on` for waits, `assignee` for transitions, `cost_usd` and tokens on `job.ended` |

Existing approval events keep working: their writers add the new columns. The current five types are renamed into the
`record.*` names in the same change (one way; no readers depend on the old names today).

**Atomicity.** Kernel writers insert the fact in the same transaction as the state change it describes (records filing
emits after commit today; that moves inside). Modules post facts to the kernel with the deterministic id and retry on
failure; the id makes retries safe.

**Actors, verified centrally.** The kernel sets `actor` itself; callers never pass it:

- a job's facts: the job's agent (`jobs.agent` → agent key);
- a module call: the verified caller assertion (`kernel/sdk/src/caller.ts`) gives `module:<name>`, or the agent when the
  module acts for an agent's job (the assertion's job);
- the owner or another person: the authenticated board or channel account (`account:<id>`, as records already use);
- GitHub-side facts: the GitHub login, mapped to an agent when the commit or PR came from a known job (the App's bot
  identity alone never names an agent).

The fact separates `actor` (who did this) from `data.assignee` (who holds the task), so a reassignment, a reviewer's
decision on an Engineer's PR, and the owner's tap are each attributed to the right party.

### 2. Who writes which facts

Kernel (owns most of the pipeline already):

- `wakes.ts`: `task.created`, `task.status_changed`, `task.assignee_changed`, `task.blocked_changed`, from the diff
  against `wake_tasks` in both the event path and the poll backstop (`source: poll` there). Both paths read the same
  issue fields (`statusVersion`, `updatedAt`, status, assignee, `blockedBy`), so both build the same id
  (`task.status_changed:<task>:<statusVersion>`, `task.assignee_changed:<task>:<updatedAt>`) and one change is counted
  once. A change the poll never saw between two reads is lost; that gap shows as `unknown`.
- `admission.ts` / `jobs.ts`: `job.queued` (with `wake`), `job.held` (`reason`: capacity, spend_cap, paused, no_computer;
  admission friction), `job.started`, `job.ended` (state, exit, `why`, cost and tokens summed from the gateway's `calls`
  for that job, so cost survives the gateway's 40-day pruning; the builder checks that `calls.run_id` is the job id, and
  if not, adds the job id to the gateway's run identity).
- `records.ts`: `record.filed`, `record.decided` (decider: reviewer, owner, code), `record.claimed`, `record.landed` /
  `record.failed`.
- `checkjobs.ts`: `check.ended` (kind, head, verdict).
- `apply.ts` / `generations.ts`: `deploy.applied` (generation, product sha, health, `revert_of`).
- `provenance.ts`, task creation via `POST /v1/tasks`: `task.created` carries `parent` (Paperclip `parentId` or the
  creating job's task) and the source marker (e.g. a GitHub issue URL), which define the work item (§4).

Modules, through one SDK call `facts.emit(type, subject, data)` in `kernel/sdk/src/kernel-client.ts` (`POST /v1/facts`).
Grading, dispatch and fleet-steward use the kernel client already; codehost-github and maintainer start to. The kernel
knows the caller's module from its verified caller assertion and checks the type against that module's declared facts.
A module fact's actor is `module:<name>`, unless it links a job (`data.job`) or a task with a known PR record, in which
case the kernel resolves the agent from that job. Every module fact names its `task` when it has one:

- `codehost-github` (task from the `codehost-github.pr` record that opened the PR, kept in `pr-tasks.json`): `pr.opened`, `pr.check_completed` (per check run: name, conclusion, started/completed),
  `pr.merged`, `work.waiting` for each merge-queue wait (`reason`: checks, design_review, eval, retry, conflict) and its
  end.
- `grading`: `grade.verdict` (pass/fail, attempt, `reasonCode`), `work.waiting` for its retry ladder.
- `maintainer` (its watcher service files the task, `modules/maintainer/service/src/watcher.ts`): `issue.triaged`
  (issue URL, created time, labels, trusted or not; at = the label time it reads through github-mcp `labelEvents`),
  with the `task` it filed.
- `ai-reviewer` needs nothing: the kernel's `record.decided` covers it.

A module may emit only the types it declares (§3); the kernel rejects others with a loud error. Emitting never fails the
module's own work: an emit error is logged and retried.

### 3. Declaring facts and stages (the generic part)

Each module lists, in `module.yaml`:

```yaml
facts:
  pr.check_completed: { subject: pr, reasons: [] }
  work.waiting: { reasons: [checks, design_review, eval, retry, conflict] }
stages:
  - { name: ci, from: pr.opened, to: pr.check_completed, label: CI }
  - { name: merge_queue, from: record.decided, to: pr.merged, where: { kind: merge } }
```

The compiler (`scripts/modules.mjs`) validates these and writes them into `config/modules.json`; the kernel loads them.
The kernel's own facts and stages (queued, working, review, owner, deploy) are declared the same way in a kernel file.
A stage is an interval from one fact to the next matching fact on the same task. Stages may overlap (CI, grading and
review run in parallel) and repeat (rework); each occurrence is a row. Reason codes are declared, not free text, because
agents read and group them.

Another owner's module gets onto the waterfall and the bottleneck chart by declaring its facts and stages and calling
`emit`. No kernel change.

### 4. Work items and fan-in

- The **work item** is the root of a task tree: follow `task.created.parent` up to a task with no parent. A GitHub issue
  links to the task the maintainer filed for it (`issue.triaged`), so the item's clock starts at the issue's creation.
  An owner request starts at its chat or task creation.
- Item lead time runs from the root's start to the last `deploy.applied` that shipped any of its PRs (or to the root
  task's completion when nothing deploys).
- **Fan-in** is stored once and linked: one `pr.merged` names its PR; one `deploy.applied` names its product sha. A PR is
  deployed by the first generation whose product sha has the merge sha as an ancestor (checked once, at apply time, by the
  kernel, which has the checkout; it writes `pr.deployed` facts for each PR it ships). App repos deploy through
  `apps-platform.deploy` records; repos with no deploy step count merge as deploy. Deployments are counted distinctly for
  DORA; per-item timing gives each item the shared timestamp; shared cost is split evenly across the items a job served
  only when a job served several (rare; stated in the view).

### 5. Derived views (one read contract)

Views over the log, in the kernel, served by `GET /v1/flow` (an extension of the `work.ts` read pattern, admin and agent
readable like `/v1/work`):

- `?task=<id>` or `?item=<id>`: the waterfall: every stage occurrence (start, end, actor), every fact, and every idle
  period with its reason.
- `?since=&to=&by=stage|agent|module|repo|model&scope=all|<module>`: the bottleneck table (count, median, p75 of work
  and of wait per stage, wait split by reason), DORA, churn, and the fleet metrics listed in Goals.
- `?idle=1`: items idle now, oldest first, with reason and holder.

**Idle and its reason.** A task is idle when it is open, no job of its own is running and no stage interval is open.
The reason is, in order: the latest unexpired `work.waiting` on it; an open record for the owner (`owner`) or the
reviewer (`reviewer`); a `blocked_by` task not done (from `task.blocked_changed`; `blocked_on: WOR-n`); an open child task (from
`task.created.parent`; `delegated`); a future
scheduled wake (`scheduled`); none of these and no wake pending (`orphaned`). Otherwise `unknown`. These come from facts
only, so a view change never needs re-instrumenting.

**DORA.** Deploy frequency: distinct `deploy.applied` with healthy status per day. Lead time for changes: first commit
of a PR (from GitHub) to its `pr.deployed`. Change failure rate: deploys followed by a revert PR of something they
shipped, a rollback generation (`revert_of`) or failed health, or an incident task linked to it. Incident tasks are new: Fleet
Steward files the tasks for monitoring alerts already and starts labelling them `incident`, with the generation or PR it
suspects; over all deploys. Time to restore: incident task created to
the deploy that fixes it, or failed generation to the next healthy one.

**Churn.** A code-host pass over each repo's default branch (incremental from a stored cursor) walks merged PRs in
order and tracks each added line by identity across later diffs, following renames. For each merged PR: lines added,
and how many of them a later PR deleted or replaced within 30 days (with the rewriting PR). It emits `code.rewritten`
facts (`{pr, by_pr, lines, days}`) and a `code.added` fact per PR. Views show the 30-day rewrite share only for PRs
older than 30 days (a mature cohort), plus a separate count of lines touched three or more times. Generated and vendored
files are excluded by a path list in the code host's settings. Writer and rewriter are the PRs' agents (§1), not the
git author. It is named "rewritten", not "defect": rewrites include planned refactors.

### 6. Surfaces

- **Board Flow page (owner pick: "bottlenecks first").** Top: where the time went for the period, one bar per stage with
  the median, a p75 marker and the dominant wait reason. Then DORA, churn, first-pass, $ per merged PR. Then idle items,
  oldest first. Filters: period (7d, 30d, 90d) and scope (all, or a module's pipeline). Each item opens its waterfall with
  actors and idle reasons; each stage opens the items behind its p75.

  ```
  Flow · last 7 days            [7d|30d|90d] [all|eng|chat]
  Where the time went (median per item, p75 marker)
   triage   ▇▏            12m
   queued   ▏             40s
   working  ▇▇▇▇          58m
   CI       ▇▇▏           18m
   grade    ▇▇▇▇▇▇▇▇▇▇▇▏  3h10  ← waiting: grader retry 62%
   review   ▇▏             6m
   owner    ▇▇▇▇▇▇▏       1h40
   merge q  ▇▇▏            22m  ← waiting: checks
   deploy   ▇▏             9m
  Deploys/day 6.1  Lead time p50 4h12  Fail 4%  MTTR 38m
  Churn 30d 11%    First-pass 71%      $/merged PR $1.84
  Idle now
   WOR-8567  1h44  unknown · Engineer B
   WOR-8402  6h10  blocked on WOR-8399 · Platform
  ```

- **Agents.** A read tool over `/v1/flow` for the agents granted it (Fleet Steward, Aiden). Fleet Steward's weekly
  scorecard reads Flow and opens a task when a stage's p75 or wait share regresses past a threshold, or an item is
  `orphaned` (this subsumes the planned stuck watcher's detection). That check ships in observe mode first.
- **Replaced:** the Fleet Steward scorecard's own timing (`scorecard.ts`) and the board's `fleet-stats` read Flow; their
  duplicate computations are deleted. `/v1/work` keeps jobs and records for the run page; `/v1/work/metrics` stays.

### 7. Backfill (owner)

A one-off command (`node scripts/flow-backfill.mjs`, run on the host) writes `source: backfill` facts from:

- GitHub, per repo the instance manages: issue created, labelled, PR opened, check runs, reviews, merged (timelines via
  the code host's App token), and churn over the full history.
- `generations.jsonl`: every apply.
- The kernel's existing `records`, `jobs` (`at` there is the start time; queue time is unknown before Flow), `wakes`,
  `provenance` and the five approval event types.

Deterministic ids make a re-run harmless. Gaps before Flow show as `unknown`, never inferred.

### 8. Retention and size

Facts are small (~100 a task); a year at the current pace is well under 1 GB. Keep 400 days, pruned with the kernel's
existing sweep. `job.ended` carries the job's cost, so cost per outcome survives the gateway's 40-day `calls` pruning.

## New installs and other owners

Flow is on in every install, because it uses no model and costs nothing to run. What a new owner sees:

- **Day one.** The log starts empty, and the Flow page explains that it fills in as work happens. It shows the first
  item's waterfall as soon as one task has run. Backfill is not run automatically. Its command is offered on the empty
  page only when the install has a code host with history, and it runs only when the owner starts it.
- **Only the modules they run.** Stages, wait reasons and tiles come from the installed modules' declarations. Without
  `codehost-github` there are no PR, CI or merge-queue stages. `codehost-local` emits the same `pr.*` and churn facts for
  the repos it hosts, so a GitHub-free install still gets them. Without any deploys, the DORA tiles are hidden instead of
  showing zeros. The default bundle alone (tasks, jobs, records, grading, Fleet Steward) still gives a useful page:
  queued, working, grade, review, owner and idle.
- **Small numbers.** A stage with fewer than 5 items shows its count and raw durations, not a median and p75, which would
  mislead at that size.
- **Quiet start.** Flow schedules nothing of its own. The churn pass runs inside the code host's existing pass. Fleet
  Steward's regression check runs only when Fleet Steward's schedule is on, and in observe mode first.
- **No owner specifics.** Day buckets use the instance timezone setting. Stage and reason labels come from module
  declarations. Nothing names this instance's repos, agents or people.
- **More than one person.** Actors are accounts and agent keys, so a second admin's taps and waits show as theirs (with
  the owner wait stage labelled per account). This keeps the later team version open without building for it now.
- **Another owner's own modules.** They join by declaring `facts:` and `stages:` and calling `emit`, as in section 3.
  The compiler rejects a stage that names an undeclared fact, so a typo fails at apply, not silently on the page.

## Phases

Each phase proves itself on the live instance before the next.

1. **Log and kernel facts.** Columns, deterministic ids, atomic writes, actor stamping; kernel-owned facts (tasks, jobs,
   records, checks, deploys); `GET /v1/flow?task=`. Exit: WOR-n's real waterfall from a new task shows queue time,
   reassignment and its idle gap. The `records.ts` change is its own small PR: it triggers the paid reviewer eval.
2. **Module facts and declarations.** `facts:` / `stages:` in `module.yaml`, the compiler check, `emit()`; code host,
   grading and maintainer facts. Exit: one GitHub issue's full item from issue to deploy.
3. **Views and surfaces.** Bottleneck, DORA, fleet metrics, idle; the board Flow page; the agent read tool; Fleet
   Steward on Flow (observe mode); delete the duplicate computations.
4. **Backfill and churn.** The backfill script and the code host's churn pass.

## Left to the builder

- Exact payload schemas per fact type, and the SQL of the views (recursive CTE for item roots is fine at this size).
- How the plugin carries status and assignee (payload fields, or the kernel fetches the issue once per event).
- The churn line-tracking algorithm's details within the rule above.
- Board component structure within the board's design system and the "bottlenecks first" layout.
- The Fleet Steward regression thresholds (start loose; observe mode shows what they would flag).

## Calls made by the designer

- No new module: facts live in the kernel, each module emits its own, the board renders, Fleet Steward reads.
- Kernel SQLite plus `/v1/flow`, no warehouse copy.
- Typed facts with stages derived from declarations, not a stage taxonomy.
- Tool-call records excluded. Cost captured on `job.ended`.
- Churn window 30 days, mature cohorts only, generated paths excluded.
- Incident = a task labelled `incident`; DORA failure includes reverts, rollbacks and failed health.
- Retention 400 days.
- `facts` replaces `events` in `kernel.db`; reads use a read-only connection.
- Task fact ids come from Paperclip's own versions; changes a poll missed show as `unknown`.
- Module facts: actor `module:<name>` unless linked to a job; PR facts get their task from the PR record.
- Incident tasks get an `incident` label from Fleet Steward (new).
- Only `records.ts` among the reviewer-eval files changes (phase 1, its own PR).
