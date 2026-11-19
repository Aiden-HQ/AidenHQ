# Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One kernel fact log that the kernel and modules write as work moves, and views over it that show each
item's timeline with actors and idle reasons, per-stage bottlenecks, DORA, churn and fleet metrics, on a board page
and to agents.

**Architecture:** A `facts` table in `kernel.db` (replacing `events`), written in the same transaction as kernel state
changes and by modules through `POST /v1/facts`. Stages are declared (kernel file plus `module.yaml` `stages:`) and
derived in SQL by `kernel/src/flow.ts`, served by `GET /v1/flow`. The board, Fleet Steward and Aiden read only that.

**Tech Stack:** Node 24, TypeScript, `node:sqlite`, `node --test` (kernel), vitest (board), the existing module SDK.

**Spec:** `docs/design/flow.md` (read it first; this plan argues from it).

## Global Constraints

- CLAUDE.md "Conventions" is the full rule set: one way, minimal tests, no owner data in the product, Conventional Commit PR titles, squash-merge, every PR green on CI.
- A fact write never fails or blocks the action it describes: kernel writers insert in the same transaction, and a module's emit error is logged and retried, never thrown into its own work.
- No guessed reasons: a gap with no recorded cause is `unknown`.
- Fact id is `<type>:<subject>:<version>`; inserts are `INSERT OR IGNORE`, so duplicates and re-runs are harmless.
- `actor` is set by the kernel, never trusted from a caller: `agent:<key>`, `account:<id>`, `module:<name>`, `kernel`, `github:<login>`, `unknown`.
- Tool-call records (`conn.tool`) never become facts.
- Retention 400 days, in the kernel's existing sweep.
- Changes to `kernel/src/records.ts` and `kernel/src/kinds.ts` need the paid reviewer eval (`node modules/ai-reviewer/scripts/reviewer-eval.mjs`, ≥95%, no approved attack): keep them in one PR of their own (Task 2).
- After editing `kernel/sdk/src/kernel-client.ts`, run `node scripts/sync-shared.mjs`.
- Board changes: `npx tsc -p tsconfig.build.json --noEmit` as well as vitest.
- A stage with fewer than 5 items shows count and raw durations, not median and p75. DORA tiles hidden when there are no `deploy.applied` facts.

## Review Focus

- A Paperclip change seen by both the event path and the poll: one fact, not two (`wakes.test.mjs`, Task 4).
- A task assigned to an agent the dispatcher doesn't poll, or unassigned: its status/assignee facts are still recorded (`scan` returns early today) (Task 4).
- A kernel restart between a job's admission and start: `job.queued` survives and queue time is still measurable (Task 3).
- A module emitting an undeclared type, or another module's subject: 403 with a clear message, and its own work goes on (Task 8).
- An empty log (new install): `/v1/flow` answers empty, the board page shows its empty state, nothing throws (Tasks 6, 12).

---

## Phase 1: the log and kernel facts

### Task 1: The fact store

**Files:**
- Create: `kernel/src/facts.ts`
- Test: `kernel/test/facts.test.mjs`
- Modify: `kernel/src/main.ts` (open it on `records.db`, pass it to the writers below)

**Interfaces:**
- Produces:
  ```ts
  export type Fact = { type: string; subject: string; version: string; at: string; actor: string;
    task?: string | null; source?: "live" | "poll" | "backfill"; data?: Record<string, unknown> };
  export function openFacts(db: DatabaseSync, now?: () => Date): {
    record(f: Fact): boolean;                       // true when new; INSERT OR IGNORE on id
    since(seq: number, limit?: number): (Fact & { seq: number; id: string; seen_at: string })[];
    forTask(task: string): (Fact & { seq: number; id: string; seen_at: string })[];
    prune(days?: number): number;                   // default 400
  };
  export type Facts = ReturnType<typeof openFacts>;
  ```
- DDL: `facts(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, subject TEXT NOT NULL, task TEXT, at TEXT NOT NULL, seen_at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live', data TEXT NOT NULL DEFAULT '{}')`, indexes on `(task, at)`, `(type, at)`, `(subject)`.
- Migration in `openFacts`: when an `events` table exists, copy its rows as facts (`approval.filed`→`record.filed`, `approval.decided`→`record.decided`, `approval.held`→`record.held`, `write.outcome`→`record.landed` or `record.failed` by `data.ok`, `gate.would_block` unchanged; subject `record:<data.record>` or `task:<data.task>`; version = the old id; source `backfill`; actor from `data.by` when present, else `unknown`), then `DROP TABLE events`, in one transaction.

- [ ] **Step 1: Write the failing tests** in `kernel/test/facts.test.mjs`:
  - `record dedupes on type, subject and version`: recording the same fact twice returns `true` then `false`; `forTask` has 1 row.
  - `migrates and drops events`: a db with `events` rows of all five old types yields facts with the new types, `source: "backfill"`, and `events` no longer exists.
  - `prune keeps 400 days`: a fact at now−401 d is removed, one at now−399 d kept.
- [ ] **Step 2: Run** `cd kernel && node --test test/facts.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `openFacts`** as above; `data` stored as JSON; `seen_at` from `now()`.
- [ ] **Step 4: Run** the test. Expected: PASS. Then `npm test && npm run typecheck` in `kernel/`.
- [ ] **Step 5: Wire** `openFacts(records.db)` in `main.ts` and call `facts.prune()` from the kernel's daily sweep. Commit `feat(kernel): a fact log for flow timing`.

### Task 2: Records and gate facts (reviewer-eval PR)

**Files:**
- Modify: `kernel/src/records.ts` (replace the `event()` closure), `kernel/src/checks.ts:141`, `kernel/src/kinds.ts:66`
- Test: `kernel/test/writes.test.mjs` (extend)

**Interfaces:**
- Consumes: `Facts.record` (Task 1). `openRecords(file, now, facts?)` gains the facts store; records stay usable without it in tests.
- Produces fact types: `record.filed {kind, tier, panel, requester}`, `record.decided {decision, decider: "reviewer"|"owner"|"code", via}`, `record.held {why}`, `record.claimed`, `record.landed {kind}`, `record.failed {kind, text}`; subject `record:<id>`, task = the record's task, version = the new state. Actor: requester's agent for `filed`, `account:<id>` or `module:ai-reviewer` for `decided`, `kernel` otherwise.
- `gate.would_block` keeps its data; subject `task:<identifier>`; version = its old random id.
- `KERNEL_ROLES` gains `"kernel.facts"` (emit) and `"kernel.flow-read"` (read); describe both in `scripts/compiler/authority.ts`.

- [ ] **Step 1: Failing test** `records write facts in the same transaction`: filing then deciding a record yields `record.filed` and `record.decided` facts with the record's task; a `move` that loses the race writes no fact.
- [ ] **Step 2: Run** `node --test test/writes.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**: the fact insert goes inside the `BEGIN IMMEDIATE … COMMIT` in `file`, and inside `move` only when `changes === 1` (wrap `move`+fact in one transaction). Add `record.claimed` where the state becomes `claimed`.
- [ ] **Step 4: Run** kernel `npm test && npm run typecheck`, then the reviewer eval on the VM per CLAUDE.local.md. Expected: PASS, eval ≥95% with every miss a false block.
- [ ] **Step 5: Commit** `feat(kernel): records and gate decisions write flow facts`; open this as its own PR.

### Task 3: Job facts

**Files:**
- Modify: `kernel/src/admission.ts:124-175`, `kernel/src/jobs.ts:241-244, 282, 313`
- Test: `kernel/test/admission.test.mjs`, `kernel/test/jobs.test.mjs` (extend)

**Interfaces:**
- Produces: `job.queued {wake, agent}` (at admission insert), `job.held {reason: "capacity"|"spend_cap"|"paused"|"no_computer"}` (each time admission defers or refuses; version = reason + minute bucket so a long hold is one fact per minute at most), `job.started`, `job.ended {state, exit, why, cost_usd, input, cached, output}`; subject `job:<id>`, task = the job's task, actor `agent:<key>`.
- Cost: sum `calls.cost_usd` and tokens for the job. First check whether gateway `calls.run_id` equals the job id; if not, add the job id to the gateway run identity (`kernel/src/gateway/lib.ts` `RunIdentity`) and record it.

- [ ] **Step 1: Failing tests**: `admitted then started yields queued and started facts with distinct times`; `a lost job ends with job.ended state lost`; `a held admission records job.held once per reason and minute`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** at the existing state writes (insert inside each write's statement group).
- [ ] **Step 4: Run** kernel tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): jobs write queued, held, started and ended facts`.

### Task 4: Task facts from the wake scan

**Files:**
- Modify: `kernel/src/wakes.ts:96-127` (and the poll entry that calls `scan`)
- Test: `kernel/test/wakes.test.mjs` (extend)

**Interfaces:**
- Produces: `task.created {parent, origin, source_marker}` (first sight), `task.status_changed {from, to}` (version `statusVersion`, else `updatedAt`), `task.assignee_changed {from, to}` (version `updatedAt`), `task.blocked_changed {blocked_by: string[]}` (version = sorted ids joined); subject `task:<id>`, task = id. Actor: `agent:<key>` when Paperclip names the changing agent, `account:<id>` for a user, else `unknown`. Source `live` from the event path, `poll` from the poll.
- Record the facts **before** the early `return` for unassigned or unpolled agents; keep a `wake_tasks` row (agent may be null) so the diff works for every task.

- [ ] **Step 1: Failing tests**: `one change seen by event and poll is one fact`; `an unassigned task's status change is recorded`; `reassignment records from and to`.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** the diff against `wake_tasks` (add `blocked` column, additive `ALTER`).
- [ ] **Step 4: Run** kernel tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): task status, assignee and blocker changes become facts`.

### Task 5: Checks, deploys and task lineage

**Files:**
- Modify: `kernel/src/checkjobs.ts` (on `ended`), `kernel/src/apply.ts` / `kernel/src/generations.ts` (on each generation), `kernel/src/modtasks.ts` and `kernel/src/provenance.ts` (task parent)
- Test: `kernel/test/checkjobs.test.mjs`, `kernel/test/apply.test.mjs` (extend)

**Interfaces:**
- Produces: `check.ended {kind, repo, head, verdict}` (subject `check:<id>`); `deploy.applied {generation, product, health, revert_of}` (subject `deploy:<n>`, actor `kernel`); `pr.deployed {pr, generation}` for each PR whose merge sha is an ancestor of the generation's product sha and was not deployed before (`git merge-base --is-ancestor` in the product checkout; PRs from `pr.merged` facts and, until phase 2, from `record.landed` merge outcomes' `merged-prs:` line); `task.created.parent` filled from provenance `created_by_job` → that job's task, or the filing module's `parent`.

- [ ] **Step 1: Failing tests**: `a generation writes deploy.applied and pr.deployed for the merges it contains`; `a second generation does not re-deploy a PR`.
- [ ] **Step 2–4:** run, implement, run kernel tests.
- [ ] **Step 5: Commit** `feat(kernel): checks, deploys and task lineage become facts`.

### Task 6: Stages and the task waterfall

**Files:**
- Create: `kernel/src/flow.ts`, `kernel/src/flow-stages.ts`
- Modify: `kernel/src/backplane.ts` (route `GET /v1/flow`, auth `module|board`, role `kernel.flow-read`), `kernel/src/main.ts`
- Test: `kernel/test/flow.test.mjs`

**Interfaces:**
- `flow-stages.ts`: `export type Stage = { name: string; label: string; from: string; to: string; where?: Record<string, string>; module: string }` and `KERNEL_STAGES: Stage[]`: `queued` (job.queued→job.started), `working` (job.started→job.ended), `review` (record.filed→record.decided where decider=reviewer), `owner` (record.filed→record.decided where decider=owner), `check` (record.decided→check.ended), `deploy` (pr.merged→pr.deployed).
- `flow.ts`: `export function createFlow({ db, stages }: { db: DatabaseSync; stages: () => Stage[] })` returning `{ task(id: string): Waterfall; item(id: string): Waterfall }` where `Waterfall = { task: string; root: string; facts: FactRow[]; stages: { name: string; label: string; start: string; end: string | null; actor: string; task: string }[]; idle: { start: string; end: string | null; reason: string; blocked_on?: string; holder: string }[] }`. `item` walks `task.created.parent` to the root and includes all descendants.
- Idle rule and reason order exactly as spec §5. Opens a read-only `DatabaseSync(file, { readOnly: true })` connection.

- [ ] **Step 1: Failing tests** from a fixture fact list modelled on WOR-8567 (assigned 10:02:03, job 10:02:32–10:33:56, reassigned 10:34:10, job 10:35:06–10:37:27, comment wake 12:21:20): `waterfall has queued 29s, two working stages with their agents, and one idle gap 10:37:27–12:21:20 with reason unknown`; `an open owner record makes the gap's reason owner`; `empty log gives an empty waterfall`.
- [ ] **Step 2–4:** run, implement, run kernel tests.
- [ ] **Step 5: Commit** `feat(kernel): GET /v1/flow gives a task's waterfall`.

**Phase 1 exit:** merge Tasks 1–6 (Task 2 its own PR), deploy, create a TEST task, and confirm `GET /v1/flow?task=` shows queue time, the working stages with agents and any idle gap.

## Phase 2: module facts

### Task 7: `facts:` and `stages:` in module.yaml

**Files:**
- Modify: `scripts/modules.mjs` (near the `checks` handling, ~line 1221, and `kernelModules` at ~1124), `kernel/src/channels.ts` (`ModuleInfo` gains `facts?: Record<string, { subject?: string; reasons?: string[] }>; stages?: Stage[]`), `kernel/src/main.ts` (stages = `KERNEL_STAGES` + every enabled module's)
- Test: `scripts/test/` compiler test (the file that covers `checks:`)

**Interfaces:**
- Compile fails with `module <m>: stage <s> names undeclared fact <t>` when `from`/`to` is neither a kernel fact type nor declared by an enabled module; fact types must start with a lowercase namespace and a dot.
- Requires role `kernel.facts` when `facts:` is present (added to the module's roles automatically).

- [ ] **Steps:** failing compiler tests (`valid declarations reach kernel/modules.json`, `undeclared stage fact fails compile`), implement, `cd scripts && npm test`, commit `feat(modules): modules declare their flow facts and stages`.

### Task 8: `POST /v1/facts` and the SDK emitter

**Files:**
- Modify: `kernel/src/backplane.ts` (route, auth `module`, role `kernel.facts`), `kernel/sdk/src/kernel-client.ts`, then `node scripts/sync-shared.mjs`
- Test: `kernel/test/flow.test.mjs` (extend)

**Interfaces:**
- Body: `{ facts: { type, subject, version, at, task?, data?, source?: "live" | "backfill" }[] }` (≤ 500 per call). The kernel checks each type against the caller module's declared `facts`, sets `actor` (`module:<name>`, or `agent:<key>` resolved from `data.job` or, for `pr:` subjects, from the `codehost-*.pr` record's requester), and records. Answers `{ recorded: number }`; 403 names the undeclared type.
- SDK: `kernelClient(...).emitFacts(facts: FactIn[]): Promise<number>` plus `export function factEmitter(client, log)` returning `emit(f: FactIn): void` that queues in memory and flushes every 5 s with retry (never throws into the caller).

- [ ] **Steps:** failing tests (`undeclared type is 403`, `actor is resolved from the job, not the body`, `same fact twice records once`), implement, kernel tests + sync-shared, commit `feat(kernel): modules emit flow facts`.

### Task 9: Code host facts

**Files:**
- Modify: `modules/codehost-github/module.yaml` (declare), `modules/codehost-github/service/src/{service.ts,pr-watch.ts,merges.ts}`, `kernel/src/codehost.ts` (codehost-local, in process: write facts directly through `Facts`)
- Test: the code host's existing merges/pr-watch tests (extend)

**Interfaces:**
- Declares: `pr.opened {repo, number, head, branch}`, `pr.check_completed {name, conclusion, started_at}` (version = check run id + attempt), `pr.merged {sha, head}`, `work.waiting {reason: checks|design_review|eval|retry|conflict, until?}` and `work.resumed {reason}` (subject `pr:<repo>#<n>`, task from `pr-tasks.json`). Stages: `ci` (pr.opened→pr.check_completed), `merge_queue` (work.waiting→work.resumed).
- After this task, Task 5's `merged-prs:` text parsing is deleted (one way).

- [ ] **Steps:** failing test (`a merge-queue wait and its end become waiting and resumed facts with the reason`), implement, module tests, commit `feat(codehost): PRs, checks and merge waits become flow facts`.

### Task 10: Grading and maintainer facts

**Files:**
- Modify: `modules/grading/module.yaml`, `modules/grading/service/src/{grades.ts,loop.mjs}`; `modules/maintainer/module.yaml`, `modules/maintainer/service/src/watcher.ts`
- Test: each module's existing tests (extend one each)

**Interfaces:**
- Grading: `grade.verdict {pass, attempt, reason_code}` (version = attempt), `work.waiting/resumed {reason: grade_retry}`; stage `grade` (job.ended→grade.verdict).
- Maintainer: `issue.triaged {issue_url, issue_created_at, labels, trusted}` (subject `issue:<repo>#<n>`, task = the filed task, `at` = label time from `labelEvents`); stage `triage` (from the issue's creation, carried as `data.issue_created_at`, to `issue.triaged`). `flow.ts` treats `issue_created_at` as the item start when present.

- [ ] **Steps:** one failing test per module, implement, module tests, commit `feat(grading,maintainer): grades and triage become flow facts`.

**Phase 2 exit:** deploy; one GitHub issue's item shows triage → … → deploy in `GET /v1/flow?item=`.

## Phase 3: views and surfaces

### Task 11: Bottlenecks, DORA, fleet metrics, idle now

**Files:**
- Modify: `kernel/src/flow.ts`, `kernel/src/backplane.ts`
- Test: `kernel/test/flow.test.mjs`

**Interfaces:**
- `flow.summary({ since, to, by?: "stage"|"agent"|"module"|"repo"|"model", scope?: string })` → `{ stages: { name, label, n, work_p50?, work_p75?, wait_p50?, wait_p75?, waits: Record<reason, seconds>, samples?: number[] }[], dora: { deploys_per_day, lead_p50, failure_rate, restore_p50 } | null, churn: { rewritten_30d, hot_lines } | null, fleet: { oldest_by_stage, arrivals, completions, retries_per_outcome, no_action_wakes, no_action_cost, held_seconds_by_reason, first_pass_grade, first_pass_review, handoffs, time_to_first_action_p50, owner_interventions_per_outcome, cost_per_outcome, wasted_cost } }`. `n < 5` → percentiles omitted, `samples` given. `dora: null` without deploys; `churn: null` without churn facts.
- `flow.idleNow()` → open items idle now, oldest first, `{ task, identifier, since, reason, holder }`.
- Routes: `GET /v1/flow?since=&to=&by=&scope=`, `GET /v1/flow?idle=1`.
- Definitions exactly as spec §5 (DORA failure: revert PR of a shipped change, rollback generation, failed health, or a linked `incident` task).

- [ ] **Steps:** failing tests on a fixture week (`p50/p75 per stage`, `fewer than 5 gives samples`, `no deploys gives dora null`, `idle now lists an orphaned task`), implement, tests, commit `feat(kernel): flow summaries, DORA and idle now`.

### Task 12: The board Flow page

**Files:**
- Create: `services/board/src/flow.ts` (server read through the kernel, like `runs.ts:103`), the page in the board's web UI following `docs/design/board-ui.md` and the existing pages' structure
- Modify: board nav; Test: one vitest for the server read and one render test of the empty state

**Interfaces:** the "bottlenecks first" layout of spec §6: stage bars (median, p75 marker, dominant wait reason), the tiles row, idle-now list; filters period (7d/30d/90d) and scope; item → waterfall (stages, actors, idle with reasons); stage → items behind its p75. Empty state text: "Flow fills in as work happens." plus the backfill button when a code host is enabled. Check at 1512/1920/2560 and mobile.

- [ ] **Steps:** failing vitest, implement, `npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build`, commit `feat(board): the Flow page`.

### Task 13: Agents read Flow; Fleet Steward moves onto it

**Files:**
- Modify: `modules/fleet-steward/service/src/{mcp.ts,scorecard.ts,detector.ts,alerts.ts}`, `modules/fleet-steward/module.yaml` (role `kernel.flow-read`), the chief-of-staff agent's grants in its module (`fleet-steward: [flow_report]`), `services/board/src/fleet-stats.ts`
- Test: fleet-steward's existing scorecard/detector tests

**Interfaces:**
- Tool `flow_report({ since?, by?, task? })` → the summary or a waterfall, read-only.
- Scorecard timing comes from `GET /v1/flow`; its own timing code is deleted. Board `fleet-stats.ts` reads the same and drops its own computation.
- Detector (observe mode, `mode: observe`): flags a stage whose p75 or wait share rose >50% week over week with n ≥ 10, and any orphaned item older than 2 h; logs `gate.would_block`-style entries, files nothing until promoted.
- `alerts.ts`: alert tasks get the `incident` label and name the suspected generation or PR.

- [ ] **Steps:** failing test (`scorecard numbers equal the flow summary's`), implement, tests, commit `feat(fleet-steward): read Flow; flag slow stages and orphaned work`.

## Phase 4: backfill and churn

### Task 14: Churn

**Files:**
- Create: `kernel/sdk/src/churn.ts` (pure: ordered diffs in, per-PR survival out), then sync-shared
- Modify: `modules/codehost-github/service/src/` (a pass inside the existing poll, cursor in its data dir), `kernel/src/codehost.ts` (codehost-local), both module.yaml (declare `code.added {pr, lines}`, `code.rewritten {pr, by_pr, lines, days}`)
- Test: `kernel/test/churn.test.mjs`

**Interfaces:** `export function churn(prs: { pr: string; mergedAt: string; diff: string }[], opts: { windowDays: number; exclude: string[] }): { added: Record<string, number>; rewritten: { pr: string; by_pr: string; lines: number; days: number }[] }`. Lines tracked by identity across hunks and renames; a line counts once; excluded paths from the code host setting `churn_exclude` (default `["**/package-lock.json", "**/dist/**", "**/vendor/**", "**/*.min.*"]`).

- [ ] **Steps:** failing tests (`a line rewritten on day 3 counts for its PR`, `a moved hunk is not a rewrite`, `rename keeps identity`, `excluded paths ignored`), implement, tests, commit `feat(codehost): churn facts`.

### Task 15: Backfill

**Files:**
- Modify: `kernel/src/facts.ts` (`backfillLocal(): number` over `records`, `jobs` (no `job.queued`: unknown), `wakes`, `provenance`, `generations.jsonl`), `modules/codehost-github/service/src/` (endpoint the board's button calls: issues, labels, PRs, checks, merges per managed repo via the App token, plus churn over full history, emitted with `source: "backfill"`)
- Test: `kernel/test/facts.test.mjs` (`backfillLocal twice records once`)

- [ ] **Steps:** failing test, implement, tests, commit `feat(flow): backfill from history`.

**Phase 4 exit:** run the backfill on the live instance; the Flow page shows 30 days of history with pre-Flow gaps as `unknown`.
