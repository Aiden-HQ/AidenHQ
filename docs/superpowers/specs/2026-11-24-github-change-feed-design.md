# GitHub change feed: one reader instead of per-module polling

Status: design for the owner's review (direction agreed by the owner 2026-11-24; reviewed by Codex). Docs only; nothing is
built yet.

## Why

Five loops read GitHub on their own timers. Each one re-reads the same repos whether or not anything changed:

| Loop | Where | Cadence | What it reads every tick |
| --- | --- | --- | --- |
| Code review's watcher | `modules/code-review/service/src/main.ts` (`setInterval(tick(true))`, `CODE_REVIEW_POLL_SECONDS`) → `engine.ts` `tickWork` → `poll(cfg)` and, on gated repos, `claims(cfg)` | 60 s | each configured repo's open PRs (`/internal/code-review/prs`), its conversation comments since a cursor (`/internal/code-review/comments`), one `GET /pulls/:n` per PR that left the open list, and the review threads of every open PR with findings (`/internal/review/threads`) |
| The PR watch | `modules/github/service/src/pr-watch.ts` (`EVERY_MS` 60 s, backing off to `IDLE_MAX_MS` 30 min with nothing open); moves to `modules/ship/service/src/loop.ts` in #1680 | 1 min | per watched repo one GraphQL `OPEN_PRS_QUERY` (50 PRs with check rollups), then per PR `compare`, Actions job probes (up to `PROBES_PER_PASS` 10), `pulls/:n` for PRs that left the list, and the kernel's state of each PR's task |
| The merge queue | `modules/github/service/src/merges.ts` `start()` | 30 s | per in-flight PR: GraphQL `PR_QUERY`, check runs and statuses, the branch's required checks |
| The Maintainer's watcher | `modules/maintainer/service/src/watcher.ts` (`maintainer_poll_minutes`, 5) → github-mcp `maintainer.ts` `issuesSince` | 5 min | per maintained repo: labelled issues since a cursor (plus a timeline per updated one), agent-build issues, feature-request issues of the last day (plus a timeline each), new unlabelled issues; hourly the contributor-PR pass (`prTick`, moving to ship in #1680) |
| The github service's 15-minute pass | `modules/github/service/src/flow.ts` `startChurn` → `churnPass` | 15 min | `issuesRepo` (issues since a cursor and the repo's issue events: Flow's `issue.opened` / `issue.labeled`) and `eventsPass` (each subscribed repo's `/events` feed: routines' events) |

The warehouse writer `src_github` is a sixth timer: github-mcp `sources.ts` `startSync`, which runs an org-scoped search
every 15 minutes and reads Projects boards hourly. It is not in `flow.ts`.

**Why this is costly.** Apart from `eventsRepo`'s first page, nothing sends `If-None-Match`, so a quiet repo costs the same as
a busy one. The PR watch's read is GraphQL, which has no conditional requests. Every 200 response takes from the owner
account's shared budgets: 5,000 REST an hour, 5,000 GraphQL points an hour, and the secondary limits that stalled everything
on 2026-11-22.

## Goal

The github module's code service becomes the only timer-driven reader of GitHub. That is the one `github` process
(`modules/github/module.yaml` `services.run.github`), which already hosts github-mcp, the code host and the warehouse
writer.

- It reads with conditional requests: ETags, and a `304` is free of the primary limit for an authenticated request.
- Its cadence follows activity.
- It keeps writing `src_github`.
- It posts typed change events, each with a small structured `data` payload, to the kernel's event router
  (`POST /v1/events`): the path slack-live uses (`modules/slack/connections/slack-live/src/main.ts`).
- Routines, code review, ship and the Maintainer subscribe, and their GitHub timers are deleted.
- The only timer left on GitHub elsewhere is the merge queue's read of a PR it is merging.

**Poller, defined.** A poller is a timer that sweeps GitHub repos or lists. Two kinds of read stay:
- **Event-triggered reads through the github service.** Examples: code review reading a merge base when it starts a review,
  the Maintainer reading one issue's label timeline to judge trust, ship's GraphQL read of the one PR an event named.
- **One-object deadlines.** A consumer may read one object once at a deadline it set itself, e.g. "re-check this head's stuck
  check in 20 minutes". This is never a sweep.

Nothing here uses Intake or agents: agents never feed the warehouse.

## Non-goals

- **Webhooks now.** They come later as an optional trigger of the same reader (§10).
- **What consumers decide.** Code review's triggers, ship's rounds and the Maintainer's trust rules stay as they are. Only
  where their input comes from changes.
- **Writes.** Pushes, PRs, merges, comments and statuses keep their current paths and gates.
- **codehost-local.** It keeps its own loop (`kernel/src/localmerge.ts`).

## 1. The reader

`modules/github/service/src/feed.ts` runs in the `github` process. It is the one scheduler for GitHub reads: the change feed,
the `src_github` sync (`sources.ts`, unchanged in what it reads: org search, Projects, scopes) and the Flow backfill
(`flow.ts` `backfill`).

Each is a job with its own due time on one queue, through the process's one GitHub client
(`connections/github-mcp/src/client.ts`, `background: true`, `etag`). `startSync`'s own `setTimeout` and `startChurn`'s
backfill trigger are deleted. Churn stays a 15-minute job on the same scheduler: it reads the cache clone with `git`, not the
API.

### Watched repos

The watched set is the union of two things:
- **The repos the code host manages.** These are the fleet org's repos, `product_repo`, the instance repo and
  `maintainer_repos`. The reader always watches them, because Flow's facts need them.
- **Every subscriber's resources.** These come from `GET /v1/events/sources?connection=github` (kernel `events.ts`
  `resources()`), which §3 extends to module subscribers.

The set is re-read each pass. A repo that leaves it stops being read and loses its state.

### What it reads

Every read is REST and conditional. Each kind of event has exactly one source read, and each list is read to a durable
boundary, oldest first, so nothing hides behind a page.

**Every pass, for each repo:**
1. **Open PRs.** `GET /repos/:r/pulls?state=open&per_page=100`, all pages. The snapshot is number, head sha, base sha and
   ref, draft, title and labels.
2. **New issues and PRs.** `GET /repos/:r/issues?state=all&sort=created&direction=desc&per_page=100`. Pages are read back to
   the highest number already seen. This list is the boundary for `issues.opened`.
3. **Issue events.** `GET /repos/:r/issues/events?per_page=100`. Pages are read back to the cursor, the newest event id
   sent. Labels, issue closes and reopens come from here, each with its actor.
4. **Conversation comments.** `GET /repos/:r/issues/comments?sort=created&direction=desc&per_page=100`, back to its cursor.
5. **Review comments** (inline and thread replies). `GET /repos/:r/pulls/comments?sort=created&direction=desc&per_page=100`,
   back to its cursor.
6. **The default branch.** `GET /repos/:r/branches/:default`. Its head joins the heads below.

**Heads, every pass while unsettled and every 5 minutes once settled.** These are each open PR's head and the default
branch's head.
7. **Check runs.** `GET /repos/:r/commits/:sha/check-runs?filter=all&per_page=100`, all pages. `filter=all` is needed
   because GitHub's default, `latest`, hides re-runs.
8. **Statuses.** `GET /repos/:r/commits/:sha/statuses?per_page=100`. This list carries each status's own id, where the
   combined status does not.
9. **Reviews.** `GET /repos/:r/pulls/:n/reviews?per_page=100` for open PRs. They are chronological, so pages are read to
   the last.

**When a head is unsettled.** It is unsettled while any of its check runs is not completed, or its newest status in any
context is pending, or the head is under 10 minutes old. A write the `github` process makes to a head unsettles it at once.
Such writes include:
- a status (code review's `aidenhq/review`, the design review);
- a re-run;
- an update-branch.

A re-run a human starts in GitHub's UI is seen within 5 minutes.

**First page first.** Each list's first page is conditional. On a `304` that list has nothing new and later pages aren't
read. Pages after the first are plain reads, needed only when more than 100 things changed between passes.

**More than 10 pages back to a boundary.** Past 10 pages the pass stops at page 10 for that list. It emits what it read and
records the pass failed with "gap" (§7). That can't happen at this instance's volume, so it fails loudly rather than being
handled.

### The outbox: diff, save, then send

A pass turns what changed into events and makes them durable before sending anything:
1. **Read** the lists above.
2. **Diff** each against its saved snapshot or cursor.
3. **Save** the new snapshots, ETags, cursors and the new events (appended to an outbox) in one atomic write of
   `/cache/feed.json` (tmp + rename).
4. **Send** the outbox oldest first, removing each event the kernel accepted.

This settles what happens when GitHub moves on before a send is accepted. Say a PR goes A → B, the send of "B" fails, and
the PR then moves to C:
- the "B" event already sits in the outbox;
- the next diff is B → C;
- no transition is lost and none is invented.

**Kernel answers.**
- **Accepted, or a repeated id.** Removed from the outbox.
- **No answer, `5xx` or `429`.** The send stops and is retried next pass, oldest first.
- **Any other `4xx`, or `skipped: "invalid"`.** The kernel refused it for good: the event breaks the schema or the module
  isn't the connection's owner. A resend can't help. The event is dropped and logged, and the pass is recorded with that
  error (§7) so the Fleet Steward sees it.

**State.**
- A repo read for the first time records its snapshots and emits nothing: a subscription starts from now, as `eventsRepo`
  does.
- A repo whose state was lost (the file missing or unreadable while the kernel still has events from this connection) does
  the same and also emits `github.resync` for that repo. Every subscriber treats `resync` as a bootstrap of that repo (§4).
- In both cases the pass is recorded with "baseline", so a lost state file is visible, never silent.

### Cadence

Each repo has one cadence:
- **15 s** after a pass that emitted anything, a write by the `github` process to that repo, or a merge queued there;
- **doubling** each quiet pass;
- **at most 60 s.**

So no consumer is slower than today's fastest (code review and ship read every 60 s). Settled heads are read every 5
minutes. One scheduler runs all jobs, oldest due first.

### Rate limits

The client today waits out its 20% background reserve before it sends anything (`client.ts:287–297`). For the feed, a read
that carries an ETag skips that wait:
- a `304` costs nothing;
- under the reserve, only the 200s spend the remaining budget, and those are changes the consumers need.

Every other background job (the sync, the backfill) keeps the reserve.

A secondary-limit answer (`403`/`429` with `retry-after`) pauses the whole scheduler until that time. The scheduler acts on
GitHub's answer itself: the client's `writeBlockedUntil` holds back writes only (`client.ts:247–255`).

## 2. Event types and payloads

Kinds are GitHub's webhook names (`<event>.<action>`), so webhooks map one to one later.

**The envelope** is the kernel's `SourceEvent` (`kernel/src/events.ts`):
- `connection: "github"`;
- `resource`: `owner/name`, lower case;
- `id`, `kind`, `author`, `text`, `labels`, `bot` and `url`.

It gains one optional field, **`data`**:
- a flat object of at most 20 keys;
- each value a string of at most 200 characters, a number, a boolean or null;
- 2 KB of JSON at most.

`envelope()` validates `data` as it validates `labels`.

**`text`** holds a stranger's words (a title and body, or a comment), clipped at 2,000 characters with `truncated`, as today.
Everything a consumer keys on is in `data`.

**Ids** name one occurrence and are built from GitHub's own ids where they exist. Where they don't, the id is built from a
per-object transition counter kept in the reader's state. A re-read, a restart, a resend or a later webhook gives the same id.

| Kind | Source | `id` | `data` (besides `number`) | `text` |
| --- | --- | --- | --- | --- |
| `pull_request.opened` | open PRs: a new number | `<repo>#<n>:opened` | `head`, `base`, `base_ref`, `head_ref`, `draft`, `fork`, `author_kind` | title, blank line, body |
| `pull_request.synchronize` | open PRs: the head changed | `<repo>#<n>:head:<sha>` | `head`, `before`, `base` | none |
| `pull_request.ready_for_review` / `.converted_to_draft` | open PRs: `draft` flipped | `<repo>#<n>:draft:<k>` (k = the PR's draft-flip count) | `head` | none |
| `pull_request.edited` | open PRs: the title changed | `<repo>#<n>:title:<k>` | `head` | the title |
| `pull_request.closed` | open PRs: the number left; one `GET /pulls/:n` | `<repo>#<n>:closed:<closed_at>` | `head`, `merged`, `merge_sha` | none |
| `pull_request.reopened` | open PRs: a closed number is back | `<repo>#<n>:reopened:<k>` | `head` | none |
| `issues.opened` | new issues (non-PR) | `<repo>#<n>:opened` | `author_kind`, `created_at`, `labels` | title, blank line, body |
| `issues.labeled` / `.unlabeled`, `pull_request.labeled` / `.unlabeled` | issue events | `ev:<event id>` | `label`, `actor` | none |
| `issues.closed` / `.reopened` | issue events (non-PR) | `ev:<event id>` | `actor`, `state_reason` | none |
| `issue_comment.created` | conversation comments | `comment:<id>` | `pr` (bool), `author_kind`, `created_at` | the comment |
| `pull_request_review_comment.created` | review comments | `review_comment:<id>` | `in_reply_to`, `author_kind` | the comment |
| `pull_request_review.submitted` | reviews | `review:<id>` | `state`, `head` (`commit_id`) | none |
| `check_run.completed` | check runs of a head | `check:<check run id>` | `head`, `name`, `conclusion`, `prs` (open PR numbers on that head), `branch` (default branch only) | none |
| `status` | statuses of a head | `status:<status id>` | `head`, `context`, `state`, `prs` | none |
| `push` | the default branch moved | `<repo>:push:<sha>` | `ref`, `before`, `after` | none |
| `github.resync` | the reader's state was lost (§1) | `<repo>:resync:<time>` | none | none |

**Field rules:**
- **`author_kind`.** It uses the rule `flow.ts` `kindOf` already applies (`agent`, `owner`, `outside`), computed once here so
  consumers stop re-deriving it.
- **`author`.** The login.
- **`bot`.** True for a `[bot]` login.
- **`url`.** The object's `html_url`.

**Routines.** No routine subscribes to GitHub events today (the product and the instance repo hold no
`event: { connection: github }`). The three existing kind names keep their meaning. `modules/github/module.yaml`
`connections.github.events.kinds` lists all of the kinds above, and routines filter them with `kind`, `author` and `contains`
as today.

## 3. Kernel: module subscribers beside routines

**Why routines aren't enough.** Today the router (`kernel/src/events.ts`) only fans out to Paperclip routines: 60 s batch
windows, at most 12 runs per routine and 120 in all per hour, a run through `/run`. That suits waking an agent. For code
services it is wrong:
- A cap drops a batch in `drain()` after `ingest` already answered 2xx.
- `ingest` answers 2xx even for `skipped: "invalid"` (`backplane.ts:800`).

**What code services get instead.** A plain, generic second delivery: an append-only log they read with their own committed
cursor. It is keyed only by connection, and one `POST /v1/events` feeds both kinds of subscriber.

### Ingest

`ingest` becomes one transaction. It inserts the event into the log (`event_log`) and enqueues its routine targets
(`event_queue`) together.

**The log table.** `event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, connection, resource, id, kind, body, at, UNIQUE(connection, id))`.

**Answers:**
- `{ accepted: true, seq }` when the event is new;
- `{ accepted: true, duplicate: true }` for an id the log already holds. Nothing is appended and nothing is fanned out again.
- An invalid envelope gets **`422`**, not 2xx, so an emitter can tell a refusal from an acceptance. slack-live already
  treats any 4xx as final (`main.ts:206`).
- A caller that isn't the connection's module still gets `403` (`events.ts` `ownerOf`).

**What isn't logged.** A kind that no module subscribes to is not appended; it still reaches routines as today.

**Routines are unchanged.** Their caps still apply in `drain()`. Routines wake agents, and dropping a batch under a cap is
their existing, deliberate behaviour.

**Retention.** 3 days, in `drain()` with the other expiries.

### Subscribing

A module declares what it reads in `module.yaml`:

```yaml
subscribes:
  github: [ pull_request.opened, pull_request.synchronize, issue_comment.created ]
```

Compile checks each kind against that connection's `events.kinds` and writes the result to `config/modules.json`. The
declaration is the grant. The new routes check it on their own path in `backplane.ts`, beside the existing
`kernel.events` role, which stays the producer's.

`PUT /v1/events/watch { connection, resources }` (module token) replaces that module's resource list:
- **When.** At start and whenever its settings change.
- **What each module sends.** Code review its configured repos, ship `*`, and the Maintainer its `maintainer_repos`.
- **Effect.** `resources()` then returns the union of routines' and modules' resources.

### Reading

`GET /v1/events/log?connection=github&after=<seq>&limit=200` (module token) answers
`{ events: [{ seq, resource, id, kind, author?, text?, labels?, bot?, url?, data?, at }], next, gap }`.

**Filtering.** The answer is limited to the kinds the module subscribes to and to its registered resources (`*`: all), so a
module configured for one repo never reads another repo's text.

**Special answers:**
- With no `after`, the answer is `{ events: [], next: <current max seq> }`: the watermark a fresh consumer starts from.
- `gap: true` means `after` is older than the oldest row kept.

**The committed cursor.** A consumer sends `after` = the last seq it **committed**, never one it has only read. The kernel
records `(module, connection, after, at)` in `event_readers`, so a handler that keeps crashing shows as a cursor that never
moves (§7).

### Delivery semantics

**At least once.**
- The reader resends from its outbox until the kernel accepts.
- The kernel keeps each id once.
- A consumer commits its cursor only after its handlers' effects are committed, so a crash redelivers. Each handler is
  idempotent (§4).

**Latency.** A consumer reads the log every 5 s. That is a local call, with no GitHub cost. It adds at most 5 s to the
reader's 15–60 s.

## 4. How each consumer switches

Every consumer gets the same five pieces:
- `subscribes:`;
- a cursor in its own store;
- a 5 s log read;
- handlers that call the code its poller called, with events coalesced per object within one read;
- **a bootstrap**: its existing read, run once, at start, on `gap`, on `github.resync` for a repo, and when its settings
  change.

**Bootstrap order.** A bootstrap first takes the watermark (`GET /v1/events/log` with no `after`), then reads, then handles
events from the watermark. Events that overlap the read are handled idempotently. This is catch-up, not a second path: the
timers are deleted.

### Routines and Flow (lane 1, with the reader)

**Routines.** Routines get their events from the reader. Deleted: `flow.ts` `eventsPass`, `eventsRepo` and `sourceEvent`,
and `/cache/events.json`. Latency goes from 15 minutes (best effort; GitHub's `/events` feed can lag for hours) to at most 60 s.

**Issue facts.** Deleted: `flow.ts` `issuesRepo` and `/cache/issues.json`. Flow's `issue.opened` and `issue.labeled` come
from the reader's diff through an in-process hook in `feed.ts`, with the same fact ids (`OPENED_VERSION`,
`${OPENED_VERSION}:<event id>`).

**PR facts.** The same hook emits `pr.opened`, `pr.pushed`, `pr.closed`, `pr.merged`, `pr.reverted`, `pr.checks_started` and
`pr.checks_completed`, from the PR and head diffs. That replaces pr-watch's Flow observation (`pr-watch.ts` ~700–760; ship's
`/internal/ship/flow` route in #1680). A fact's id is type, subject and version, so the code host's own emissions
(`service.ts`, `merges.ts`) still record once.

### The Maintainer (lane 2)

**Subscribes to** `issues.opened`, `issues.labeled`, `issues.closed` and `github.resync`, plus the PR kinds for
`contributor_prs` until #1680 moves that pass to ship.

**Handlers.**
- **A fix label or `agent-build` on `issues.labeled`.** One trust read for that issue: github-mcp's existing
  `latestOrError`, which reads the label timeline and the actor's role. If trusted, the task is filed as today under source
  `maintainer-issue:<repo>#<n>`, so the kernel keeps one task per issue.
- **`feature-request` on `issues.labeled`.** The same trust read, then the issue joins the `featured` set.
- **`issues.opened`** whose `author_kind` isn't `agent` and that carries none of the three labels. It goes through
  `triageRepo`'s per-author limit, then the triage task is filed (`maintainer-triage:<repo>#<n>`).
- **Held triage issues.** They are re-checked when a slot frees: a filing, or the oldest `recent` entry turning a day old.
  That is a deadline, not a sweep.

**Bootstrap.** For each maintained repo, the existing `issueList` for the fix label and, with `features` on, for
`agent-build`. Each open, trusted, labelled issue is filed under its source key; the kernel dedupes. Labelled issues are
reconciled from the start, as `repoSince` does today. Unlabelled triage starts at the watermark, as `untriaged` does today:
issues already open are the daily triage's.

**Deleted.**
- `watcher.ts`'s timer;
- the `cursor`, `triage_cursor` and `build_cursor` fields;
- `maintainer_poll_minutes` and `MAINTAINER_POLL_MINUTES`;
- github-mcp `maintainer.ts`'s `issuesSince`, `repoSince`, `untriaged` and `recentFeatureRequests`, and their route.

`issueList` and the trust read stay.

### Code review (lane 3)

**Subscribes to:**
- `pull_request.opened`, `.synchronize`, `.ready_for_review`, `.converted_to_draft`, `.closed` and `.reopened`;
- `issue_comment.created`;
- `pull_request_review_comment.created`;
- `github.resync`.

**Handlers.** These are the bodies of today's `poll(cfg)` and `claims(cfg)` in `engine.ts`:
- **opened, synchronize, ready, reopened.** `upsertPr` from `data` and `text` (the title and body, as stored today). Then the
  same `trigger` and `missing` decisions, keyed on `(repo, number, head)`.
- **converted_to_draft.** Updates the row.
- **closed.** `data.merged` decides the findings' outcome (`open_at_merge` or `open_at_close`). Queued runs are skipped, and
  `close_due` is set; that replaces the extra `GET /pulls/:n`. `closeTasks` runs on the fast tick for every `close_due` row.
- **issue_comment.created** on a PR. Runs `command(cfg, c)`. Commands sit in the comment's first line, well inside the 2,000
  characters carried. The `seen` row is now inserted in the same SQLite transaction as the command's local effects (a run
  queued, a focus set), closing today's window where a crash after `command()` repeats it.
- **pull_request_review_comment.created** on a gated repo. Runs `claims` for that one PR. Its existing `seen` (`reply:<id>`)
  keeps each reply once. A reply that `claims` leaves unread on purpose (its finding's mandatory post hasn't settled) is read
  again when that post settles: a local trigger inside code review, no GitHub event.

**Settings changes.** A changed gate, a repo added, a combo made mandatory: each runs the bootstrap for the affected repos.
That is how `missing()` today reaches open heads with no new GitHub activity.

**Bootstrap.** One `source.open(repo)` call: "the first look reviews what is open", which is today's behaviour, kept. Then
`source.comments(repo, since)` from the newest comment already handled, so commands posted during a gap or resync are not lost.

**Deleted.**
- `main.ts`'s GitHub `setInterval` and `CODE_REVIEW_POLL_SECONDS`;
- `tick({ github })` and `wantGithub`: the 10 s tick is the only tick, and it reads the log;
- the timer-driven calls of `poll` and `claims` (their bodies become the handlers).

The `prs`, `comments` and `threads` routes stay, for the bootstrap and the per-PR `claims` read.

### Ship (lane 4, after #1680 lands `modules/ship/service/src/loop.ts`)

**Subscribes to:**
- every `pull_request.*` kind;
- `pull_request_review.submitted`, `check_run.completed`, `status` and `issue_comment.created`;
- `push`;
- `github.resync`.

**Handlers.**
- **Per PR.** Each PR named in one read of the log, by `number` or by a head's `prs`, is evaluated once. The evaluation is
  today's per-PR body of `scan()`, with its GraphQL read narrowed from the repo's open list to that one PR. Mergeability and
  the rollup stay GraphQL.
- **On `push`.** A push to the default branch evaluates the repo's open fleet PRs once.
- **Task state.** Every minute ship asks the kernel for the state of its open PRs' tasks. That is a kernel read, not a GitHub
  one, and today's scan already does it (`pr-watch.ts:759–763`). A PR whose task was cancelled, or is done, is evaluated even
  when GitHub is quiet.

| pr-watch / loop duty | After |
| --- | --- |
| Agent PR green at a mergeable head → merge filed | on `check_run.completed` / `status` for its head |
| Agent PR red on its own head → wake; the CI breaker | on `check_run.completed` |
| Conflict, or red while behind main → update-branch or wake | on `push`, `synchronize` |
| Update-branch retry (5 min) and lost update (`UPDATE_OK_WAIT_MIN`) | a one-PR deadline in ship's state |
| Never-started check → re-run once | on `check_run.completed` with a failure conclusion (the Actions job read is triggered by it) |
| Wedged check (run not completed while its job finished; 3 min grace, report at 20 min) | a one-head deadline at 3 and 20 min after the head went unsettled |
| Title gate (`policy` red, title now valid) | on `pull_request.edited` (a title-only edit starts no workflow, so no check event follows) |
| Dependabot task when checks finish; closed on merge or close | on `check_run.completed`, `pull_request.closed` |
| Close a cancelled task's PR | the task-state read above |
| Close a done task's unmerged PR after 30 min | a one-PR deadline set by the task-state read |
| Review-findings wake | on `status` (`aidenhq/review`) for the head |
| Half-hour ask cooldown | unchanged state, checked when the PR is next evaluated |
| Contributor-PR nudge and close (`stale_days`) | a one-PR deadline at last activity + `stale_days`; activity = any event on the PR |
| Adopted PRs' rounds (`adopted.ts`) | the same events; the round runs on its PR's evaluation |
| Flow observation | the reader (above) |

**Bootstrap.** One full `scan()` of each repo, which is today's tick, run once.

**Deleted.**
- the loop's `next()` timer, `EVERY_MS` and `IDLE_MAX_MS`;
- the every-minute full scan;
- the contributor pass's hourly gate (`PR_EVERY`);
- `/internal/ship/flow`.

### The merge queue (unchanged)

`merges.ts` keeps its 30 s read of each in-flight PR, as the owner decided. While a PR is queued, its repo's feed cadence
is 15 s.

## 5. API budget, before and after

**Symbols:** `R` is the watched repos, `P` the open PRs, `Q` the PRs in the merge queue. Today `R ≈ 8`:
`Aiden-HQ/AidenHQ`, `aidenhq-distro`, the instance repo and 5 `aidenhq-alpha` repos. Code review watches 1, the PR watch 6,
the Maintainer 2, and `P ≈ 7`.

These are estimates from the code paths above. Lane 1 adds a per-caller counter (by caller and status, logged hourly), and
its first day replaces them.

### Before: the floor of timer reads, paid every hour, quiet or not

| Loop | REST calls/h | GraphQL queries/h |
| --- | --- | --- |
| Code review: 1 repo; 2 list reads/min, plus threads per PR with findings | ~120–300 | 0 (threads go through github-mcp; GraphQL there) |
| PR watch: 6 repos, 1 query/min each while any PR is open, plus compares and probes | ~30–100 | ~360 (≈1 point each) |
| Maintainer: 2 repos; ~4 lists plus timelines per tick, 12 ticks | ~100–150 | 0 |
| flow.ts `issuesRepo`: ~7 repos × 2 × 4/h | ~56 | 0 |
| **Floor** | **~300–600** | **~360** |

The merge queue (about 5 calls per 30 s per in-flight PR, roughly 600/h per PR while it merges) and the `src_github` sync
are the same before and after, so they are left out.

For context only: one `rate_limit` read of the owner's account on 2026-11-24 showed 1,320 core and 224 GraphQL used in
that window. That reading is account-wide, including writes and the owner's own `gh`.

### After

**Quiet hour.**
- **Counted against the primary limit:** about 0. Every read is a `304`.
- **Sent**, which matters only for the secondary limit:
  - `R × 6` lists at 60 s: 8 × 360 = 2,880;
  - settled heads `(P + R) × 3` at 5 min: 15 × 36 = 540.

  That is about **3,400 conditional requests an hour, about 57 a minute**, against a REST secondary limit of 900 points a
  minute.

**Busy hour.** Each 200 costs 1:
- **A new head:** 1 (open PRs) + about 10–15 (check-run lists changing during CI, sampled at 15–60 s) + about 2 (statuses)
  + 1 (reviews).
- **A comment or label:** 1–2.
- **A close:** 2.

For example, 10 heads, 30 comments, 20 labels or closes and 5 PRs opened or closed come to about 170 + 30 + 30 + 10 ≈
**240 REST**. Event-triggered consumer reads add about 30 for code review (merge base, patch id, threads per review) and about
**40–60 GraphQL** for ship (one per evaluated PR).

| | REST/h | GraphQL queries/h |
| --- | --- | --- |
| Quiet: before → after | ~300–600 → ~0 | ~360 → 0 |
| Busy: before → after | ~400–800 → ~270 | ~360–420 → ~40–60 |

**Savings.** About the whole floor when quiet, and in a busy hour about half the REST and 85–90% of the GraphQL.

**Latency.**
- Routines: 15 min → 60 s or less.
- The Maintainer: 5 min → 60 s or less.
- Code review and ship: 60 s → 15–60 s (15 s right after a change).
- A human re-run of a settled head: up to 5 min.

## 6. Failure modes

| Failure | What happens |
| --- | --- |
| GitHub `5xx`, a timeout, or a `404` on one repo | That repo's pass fails before its save, and the next pass retries. The pass is recorded failed (§7). A repo deleted or renamed fails until it leaves the watched set. |
| Primary limit under the reserve | Conditional reads go on (a 304 is free), and other background jobs wait. Only changes spend budget. |
| Secondary limit (`403`/`429` + `retry-after`) | The whole scheduler pauses until then. |
| The kernel down, `5xx` or `429` | Events wait in the outbox, and reads go on (state still advances, because events are durable). Sent oldest first once it answers. |
| The kernel refuses an event for good (`422`, `403`) | Dropped, logged, and the pass recorded with the error. It can only be a bug, and the Steward sees it. |
| The `github` process restarts | The state file is written whole, and passes resume from it. The outbox is sent first. |
| The state file is lost | Baseline, plus `github.resync` per repo. Consumers bootstrap. Recorded "baseline". |
| A consumer down or crashing mid-batch | Its committed cursor didn't move, so the batch is redelivered. Idempotent on keys it already has: code review's `(repo, number, head)` runs and `seen`; ship's per-head state (`greened`, `reded`, `pinged`); the Maintainer's task sources; routines' `UNIQUE(routine, id)`. |
| A consumer behind by over 3 days | `gap: true`, then a bootstrap. |
| More than 10 pages to a boundary in one pass | The pass sends what it read and is recorded failed with "gap". Fails loudly. |
| A flip that reverses inside one interval (draft → ready → draft) | Not seen. The object ends where it started. |
| A reply left unread by `claims` until its post settles | Re-read on code review's local post-settled trigger. |
| ETags that change with no content change | They cost 200s and nothing else, and the per-caller counter shows it. |
| GitHub signed out | Passes are recorded failed ("GitHub isn't connected"). The merge queue already waits on `connected()`. |
| Stranger text in events | Data, as today. Routines get it fenced through `routine_events`. Code services never copy it into task text (the Maintainer's tasks name only repo and number). |

## 7. Health signal for the Fleet Steward

This reuses what the Steward already reads: `src_meta.ingest_run`, through apps-mcp `/internal/sources`, into
`fleet-steward/service/src/detector.ts` `source()`.

**Reader passes.**
- The reader records one `ingest_run` per repo every 5 minutes, through github-mcp's `SourceStore.run` (same process). The
  source is `github_feed` and the scope `repo:<owner/name>`.
- A run is `ok` if any pass in the window completed. Otherwise it carries the last error ("gap", "baseline", a refused event,
  GitHub's error), and rows = the events sent.
- One run per 5 minutes rather than per pass keeps the table at `R × 288` rows a day.

**Staleness.**
- `detector.ts` `STALE_FOR` gets `github_feed: 15 min`, so no good pass on any repo for 15 minutes is raised, instead of the
  60-minute default.
- One repo failing every pass for a day falls under the existing `failingScopes`.
- The outbox size also rides on the run (`rows` pending), so a kernel that keeps refusing to accept shows as a growing number.

**Delivery lag.**
- A new kernel read, `GET /v1/events/readers` (the Fleet Steward's module token), lists for each subscribed module its
  committed cursor, when it last read, and how many of its subscribed events are newer.
- A new detector check, `feedLag`, raises a module more than 10 minutes behind with events waiting, by name. For example:
  "code-review hasn't committed GitHub events for 12 min (34 waiting)".

## 8. Rollout

Each lane is one PR. It switches its consumer and deletes that consumer's poller in the same PR, so nothing ever runs both
ways. Lane 1 lands first. Lanes 2 and 3 follow side by side. Lane 4 waits on #1680.

**Lane 1: the kernel, the reader, routines and Flow.**
- **Kernel** (`events.ts`): `data`, the transactional `ingest` with `422`, `event_log`, `event_readers`,
  `GET /v1/events/log`, `PUT /v1/events/watch`, `GET /v1/events/readers`, and the `resources()` union.
- **Compile:** `subscribes:` → `config/modules.json`, plus its `docs/configuration.md` row.
- **The github service:**
  - `feed.ts`, with its outbox and the one scheduler;
  - the `sources.ts` sync and the backfill moved onto it;
  - the Flow hook;
  - a client change (ETag reads skip the reserve);
  - the per-caller counter.
- **Steward:** the `github_feed` runs, `STALE_FOR` and `feedLag`.
- **Deletes:**
  - in `flow.ts`: `eventsPass`, `eventsRepo`, `sourceEvent` and `issuesRepo`, with their state files;
  - `startSync`'s timer;
  - `modules/github/test/events-poll.test.ts`.

**Lane 2: the Maintainer.** Its subscription, handlers and bootstrap. Deletes its timer, cursors,
`maintainer_poll_minutes` and the `issuesSince` family.

**Lane 3: code review.** Its subscription, handlers, bootstrap and settings trigger, plus the transactional `seen`. Deletes
the GitHub tick and `CODE_REVIEW_POLL_SECONDS`.

**Lane 4: ship.** Its subscription, handlers, task-state read, deadlines and bootstrap. Deletes the loop timer, the
per-minute scan, `PR_EVERY` and `/internal/ship/flow`.

**Each lane is checked by hand, end to end, once.** A TEST PR on a fleet repo goes through open, push, a red check, a green
check, a comment, a review reply, a label and a close. The consumer must act within about 60 s of each, with no GitHub timer
of its own left.

## 9. What gets deleted

| Where | What |
| --- | --- |
| `modules/github/service/src/flow.ts` | `sourceEvent`, `EVENT_REPOS`, `eventsPass`, `eventsRepo`, `/cache/events.json`; `issuesRepo`, `/cache/issues.json`; the backfill and issue and events calls in `churnPass` (churn moves to the scheduler) |
| `modules/github/connections/github-mcp/src/sources.ts` | `startSync`'s own `setTimeout` loop (`syncOrg` and `retireOrg` stay, scheduled by the reader) |
| `modules/github/test/events-poll.test.ts` | the whole file |
| `modules/github/module.yaml` | the `events` comment "polled from each subscribed repo's events feed on the code host's churn pass"; `kinds` grows to §2's list |
| `modules/code-review/service/src/main.ts` | the GitHub `setInterval`, `CODE_REVIEW_POLL_SECONDS`, `wantGithub` |
| `modules/code-review/service/src/engine.ts` | the timer-driven calls of `poll` and `claims` in `tickWork` |
| `modules/maintainer/service/src/watcher.ts`, `modules/maintainer/module.yaml` | the timer, the three cursors, `maintainer_poll_minutes`, `MAINTAINER_POLL_MINUTES` |
| `modules/github/connections/github-mcp/src/maintainer.ts` | `issuesSince`, `repoSince`, `untriaged`, `recentFeatureRequests` and their route |
| `modules/github/service/src/pr-watch.ts` → `modules/ship/service/src/loop.ts` | the `next()` timer, `EVERY_MS`, `IDLE_MAX_MS`, the per-minute full scan, Flow observation |
| `modules/ship/service/src/contributor.ts` (#1680) | the hourly `PR_EVERY` gate |
| `modules/github/service/src/ship-routes.ts` (#1680) | the `flow` route |
| `kernel/src/events.ts` | 2xx for an invalid event; the comment that GitHub's slugs come "from its poller" |

**What stays:**
- the merge queue's in-flight read;
- what `src_github` reads;
- churn (git);
- reads an event triggers;
- one-object deadlines;
- the routes the bootstraps use (`/internal/code-review/prs`, `comments`, `threads`; github-mcp `issueList` and the trust
  read).

## 10. Webhooks, later

**What would be added.** In the `public` and `cloudflare` exposure modes, GitHub could call `POST /github/webhook` on the
`github` service, verified by HMAC with a generated secret.

**One emission path.** A webhook never emits an event. It marks the named repo, and for `check_run` / `status` the named
head, due now, and §1's conditional reads produce every event with the same ids. So:
- there is still one emission path;
- a lost or forged webhook costs at most one early read.

**In `tailscale` and `local` modes** the reader works exactly as above.

## Open questions for the owner

1. **One-object deadlines.** Ship keeps a few one-PR deadline reads: a wedged check at 3 and 20 minutes, update-branch
   retries, the 30-minute close of a done task's PR, and contributor-PR staleness. Each reads one PR once when its time
   comes, never a sweep, so this design counts them as not polling. If "only the merge queue" means none at all, those
   duties have to go.
2. **A 60 s cap even when quiet.** This keeps every consumer at least as fast as today, at about 3,400 free conditional
   requests an hour (about 6% of the REST secondary limit). A 5-minute quiet cap would cut that to about 700, but a quiet
   repo's first PR or issue would then wait up to 5 minutes for code review and ship.
