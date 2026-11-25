# GitHub change feed: one reader instead of per-module polling

Status: design for the owner's review (direction agreed by the owner 2026-11-24; Codex reviewed it twice). Docs only; nothing is
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

Two more timers in the same `github` process read GitHub every minute:
- **The design review sweep.** `design-review.ts` `startDesignReviewSweep` reads `PR_QUERY` for each open design-review task.
- **The release train.** `train.ts` `start` reads the instance repo's `instance.yaml`, and the product repo's tip and whether
  it is green.

The warehouse writer `src_github` is one more timer: github-mcp `sources.ts` `startSync`, which runs an org-scoped search
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

**Scope of "only".** This covers the loops in the table below, all of the `github` process's own timers, and the
`src_github` sync. A sweep of `setInterval`/`setTimeout` across modules found a few more timers:
- **Not GitHub reads:** `tidy.ts` (local refs), `startHeld` (held writes), and the one-off `migrate.ts` retry, which is
  deleted after #1065.
- **GitHub reads through the code host:** apps-platform's 2-minute loops (`apps-mcp/src/loops.ts` `reconcileTick`, which
  reads `remoteHead` per auto-deploy app, and `previews.ts`, which lists open PRs per app repo). These serve
  codehost-local repos too. They are an owner question, below, not part of this design.

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

Every read is REST and conditional. Each kind of event has exactly one source read. A list is one of two shapes:
- **Snapshot lists** are read whole. Every page is conditional on its own ETag, so a change on page two is seen even when
  page one answers `304`.
- **Cursor lists** are read oldest first from a saved cursor with GitHub's `since`. Page one is conditional, because the URL
  only changes when the cursor moves. The cursor advances as each page's events are saved, so a pass that stops early (a cap,
  an error) resumes where it stopped next pass. Nothing is skipped.

**Every pass, for each repo:**
1. **Open PRs** (snapshot). `GET /repos/:r/pulls?state=open&per_page=100`, every page. The snapshot holds number, head sha,
   base sha and ref, draft, title and labels.
2. **Issues and PRs updated since the cursor** (cursor). `GET /repos/:r/issues?state=all&sort=updated&direction=asc&since=<cursor>&per_page=100`.
   - A non-PR item created after the repo's baseline and within the last 2 days is `issues.opened`. This list is ordered
     by update, not number, so "new" is decided by `created_at`, never by a highest-seen number. The reader keeps the ids
     it sent as `issues.opened` or `*.created` for 2 days, saved with its state, and skips one it reads again.
   - The cursor is the newest `updated_at` read. Items at exactly the cursor time are re-read, and their ids dedupe.
3. **Issue events.** `GET /repos/:r/issues/events?per_page=100`. GitHub serves this list newest first, with no `since`, so
   pages are read back to the newest event id already sent. Labels, issue closes and reopens come from here, each with its
   actor. More than 10 pages back is the one place a busy interval could lose events: the pass sends what it read and
   records the loss (§7). At this instance's volume (a few events a minute) that cannot happen, so it fails loudly.
4. **Conversation comments** (cursor). `GET /repos/:r/issues/comments?sort=updated&direction=asc&since=<cursor>&per_page=100`.
5. **Review comments** (inline and thread replies; cursor). `GET /repos/:r/pulls/comments?sort=updated&direction=asc&since=<cursor>&per_page=100`.

   Both are sorted by update, the field `since` filters on, so the cursor marks exactly what was read. As for issues, a
   comment is `*.created` when it was created after the baseline and within the last 2 days and its id isn't among those
   already sent; an edit emits nothing.

   A pass that starts with a cursor more than 2 days old (the reader was down that long) is recorded as a loss (§7), so a
   creation that ages past the window during catch-up is loud, never silently dropped.
6. **The default branch.** `GET /repos/:r/branches/:default`. Its head joins the heads below.

**Heads** (snapshots). These are each open PR's head and the default branch's head. Each is read every pass while unsettled
and every 5 minutes once settled.

7. **Check runs.** `GET /repos/:r/commits/:sha/check-runs?filter=all&per_page=100`. GitHub's default `latest` filter hides
   re-runs, so the read asks for `all`.
8. **Statuses.** `GET /repos/:r/commits/:sha/statuses?per_page=100`. This list carries each status's own id, which the
   combined status does not.
9. **Reviews.** `GET /repos/:r/pulls/:n/reviews?per_page=100` for each open PR. Every page is read, each conditional.

**Per-pass cap.** A cursor list reads at most 10 pages a pass and goes on next pass.

**Cursors.** Each cursor list's cursor holds the newest `updated_at` it read, because GitHub's `since` filters on
`updated_at`. Items at exactly that time are read again, and their ids dedupe.

**Assumptions about GitHub that lane 1 must check against a scratch repo before anything else is built.** If one fails, the
read that depends on it changes and the spec is amended. Nothing switches at run time.
- An authenticated `304` doesn't count against the primary limit.
- Each page of a list has its own stable ETag.
- `since` on `issues`, `issues/comments` and `pulls/comments` returns every item created or edited after it.
- `sort=updated&direction=asc` is honoured on `issues/comments` and `pulls/comments`.
- `check-runs?filter=all` lists re-runs.
- `statuses` lists carry an id per status.

**When a head is unsettled.** It is unsettled while any of its check runs is not completed, or its newest status in any
context is pending, or the head is under 10 minutes old. A write the `github` process makes to a head unsettles it at once.
Such writes include:
- a status (code review's `aidenhq/review`, the design review);
- a re-run;
- an update-branch.

A re-run a human starts in GitHub's UI is seen within 5 minutes.

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

**State.** A baseline is a repo's first read with no saved state: it records the snapshots and emits nothing but
`github.resync` for that repo. Every subscriber treats `resync` as a bootstrap of that repo (§4), and that bootstrap runs
after the baseline, so nothing that happened before it is lost. This one rule covers both cases:
- a repo read for the first time (newly watched, or the reader's first start);
- a repo whose state was lost (the file missing or unreadable).

A first read is an ordinary pass. A lost state file (missing or unreadable while the kernel still has events from this
connection) is recorded as "baseline", a loss (§7), so it is visible, never silent.

### Cadence

Each repo has one cadence:
- **15 s** after a pass that emitted anything, a write by the `github` process to that repo, or a merge queued there;
- **doubling** each quiet pass;
- **at most 60 s.**

So no consumer is slower than today's fastest (code review and ship read every 60 s). Settled heads are read every 5
minutes. One scheduler runs all jobs, oldest due first.

### Rate limits

**The reserve.** Today the client waits out its 20% background reserve before it sends anything (`client.ts:287–297`).
- **Feed reads.** A read that carries an ETag skips that wait. A `304` costs nothing, so under the reserve only the 200s
  spend what is left, and those are changes the consumers need.
- **Other background jobs** (the sync, the backfill) keep the reserve. When the reserve would make one wait, the scheduler
  doesn't sleep inside the job. The client answers "not before T" instead of sleeping, and the job is rescheduled for T, so
  it never holds up the feed reads due before then.

**Secondary limits.** A secondary-limit refusal pauses the whole scheduler: until GitHub's `retry-after` when it gives one,
otherwise until the client's own computed backoff (`SECONDARY_BASE_MS`, doubling; `client.ts:256`). The scheduler acts on
this itself, because the client's `writeBlockedUntil` holds back writes only (`client.ts:247–255`).

## 2. Event types and payloads

Kinds are GitHub's webhook names (`<event>.<action>`), so webhooks map one to one later.

**The envelope** is the kernel's `SourceEvent` (`kernel/src/events.ts`):
- `connection: "github"`;
- `resource`: `owner/name`, lower case;
- `id`, `kind`, `author`, `text`, `labels`, `bot` and `url`.

It gains one optional field, **`data`**:
- a flat object of at most 20 keys;
- each value one of: a string of at most 200 characters, a number, a boolean, null, or a list of at most 20 such strings or
  numbers;
- 2 KB of JSON at most.

`envelope()` validates `data` as it validates `labels`.

**`text`** holds a stranger's words (a title and body, or a comment), clipped at 2,000 characters with `truncated`, as today.
Everything a consumer keys on is in `data`.

**Ids** name one occurrence.
- **Where GitHub has an id** (comments, reviews, check runs, statuses, issue events), the event uses it.
- **For transitions the reader infers** (a new head, a draft flip, a title, a reopen, a push), the id is
  `<repo>#<n>:<what>:<gen>.<k>`.
  - `gen` is a random generation the state file is created with.
  - `k` is that object's occurrence counter, saved with the outbox.
  - So A→B→A→B is two distinct `synchronize` events for B, and a new state file never collides with ids sent before it.
- A resend from the outbox gives the same id.

| Kind | Source | `id` | `data` (besides `number`) | `text` |
| --- | --- | --- | --- | --- |
| `pull_request.opened` | open PRs: a new number | `<repo>#<n>:opened` | `head`, `base`, `base_ref`, `head_ref`, `draft`, `fork`, `author_kind` | title, blank line, body |
| `pull_request.synchronize` | open PRs: the head changed | `<repo>#<n>:head:<gen>.<k>` | `head`, `before`, `base` | the title |
| `pull_request.ready_for_review` / `.converted_to_draft` | open PRs: `draft` flipped | `<repo>#<n>:draft:<gen>.<k>` | `head` | the title |
| `pull_request.edited` | open PRs: the title changed | `<repo>#<n>:title:<gen>.<k>` | `head` | the title |
| `pull_request.closed` | open PRs: the number left; one `GET /pulls/:n` | `<repo>#<n>:closed:<closed_at>` | `head`, `merged`, `merge_sha` | the title |
| `pull_request.reopened` | open PRs: a closed number is back | `<repo>#<n>:reopened:<gen>.<k>` | `head` | the title |
| `issues.opened` | new issues (non-PR) | `<repo>#<n>:opened` | `author_kind`, `created_at`, `labels` | title, blank line, body |
| `issues.labeled` / `.unlabeled`, `pull_request.labeled` / `.unlabeled` | issue events | `ev:<event id>` | `label`, `actor` | none |
| `issues.closed` / `.reopened` | issue events (non-PR) | `ev:<event id>` | `actor`, `state_reason` | none |
| `issue_comment.created` | conversation comments | `comment:<id>` | `pr` (bool), `author_kind`, `created_at` | the comment |
| `pull_request_review_comment.created` | review comments | `review_comment:<id>` | `in_reply_to`, `author_kind` | the comment |
| `pull_request_review.submitted` | reviews | `review:<id>` | `state`, `head` (`commit_id`) | none |
| `check_run.completed` | check runs of a head | `check:<check run id>` | `head`, `name`, `conclusion`, `prs` (open PR numbers on that head), `branch` (default branch only) | none |
| `status` | statuses of a head | `status:<status id>` | `head`, `context`, `state`, `prs`, `branch` (default branch only) | none |
| `push` | the default branch moved | `<repo>:push:<gen>.<k>` | `ref`, `before`, `after` | none |
| `github.resync` | a baseline: first read or lost state (§1) | `<repo>:resync:<time>` | none | none |

**Field rules:**
- **The PR record.** Every `pull_request.*` event from the open-PR snapshot (all but `labeled` / `unlabeled`) carries the PR's whole record from the snapshot in `data` (`head`, `base`,
  `base_ref`, `head_ref`, `draft`, `fork`, `author_kind`) beside its own fields (`before`, `merged`, `merge_sha`), and its
  title in `text` (with the body on `opened`). A consumer never has to merge partial events to know a PR's fork or draft
  state; the table lists only each kind's own fields.
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

A module declares what it reads, and from which repos, in `module.yaml`:

```yaml
subscribes:
  github:
    kinds: [ pull_request.opened, pull_request.synchronize, issue_comment.created ]
    resources: { setting: code_review, path: "repos[].repo" }   # or "*"
```

- **Kinds.** Compile checks each kind against that connection's `events.kinds`.
- **Resources.** Compile resolves `resources` from the instance's settings, so the owner's settings decide which repos a
  module reads. A module can't widen that at run time.
- **`"*"`.** It means every repo the code host manages, and only product modules may use it, the same rule routines'
  `resource: "*"` follows (`docs/configuration.md`).
- **Where it lands.** The result goes to `config/modules.json`, and a settings change reaches it through the next apply.
- **The declaration is the grant.** The new routes check it on their own path in `backplane.ts`, beside the existing
  `kernel.events` role, which stays the producer's.
- **`resources()`** returns the union of routines' and modules' resources.

Code review resolves to its configured repos, the Maintainer to `maintainer_repos`, and ship to `*`.

### Reading

`GET /v1/events/log?connection=github&after=<seq>&limit=200` (module token) answers
`{ events: [{ seq, resource, id, kind, author?, text?, labels?, bot?, url?, data?, at }], next, gap }`.

**Filtering.** The answer is limited to the kinds the module subscribes to and to its compiled resources (`*`: all), so a
module configured for one repo never reads another repo's text.

**Special answers:**
- With no `after`, the answer is `{ events: [], next: <current max seq> }`: the watermark a fresh consumer starts from.
- `gap: true` means retention deleted rows newer than `after`. Retention records the highest seq it has deleted
  (`pruned_through`, one row beside the log); `gap` is `after < pruned_through`. An empty or young log never reports a gap.

**The committed cursor.** A consumer sends `after` = the last seq it **committed**, never one it has only read. The kernel
records `(module, connection, after, at)` in `event_readers`, so a handler that keeps crashing shows as a cursor that never
moves (§7).

### Delivery semantics

**At least once.**
- The reader resends from its outbox until the kernel accepts.
- The kernel keeps each id once.
- A consumer commits its cursor only after its handlers' effects are committed, so a crash redelivers. Each handler is
  idempotent (§4).

**A handler that can't succeed.** A transient failure (GitHub or the kernel briefly down) throws, and the redelivery is
the retry. A handler that fails every time is a bug: its cursor stops, `feedLag` names the module within 10 minutes (§7),
and once the bug is fixed the cursor resumes with nothing skipped. There is no skip or dead-letter path.

**Latency.** A consumer reads the log every 5 s. That is a local call, with no GitHub cost. It adds at most 5 s to the
reader's 15–60 s.

## 4. How each consumer switches

Every consumer gets the same five pieces:
- `subscribes:`;
- a cursor in its own store;
- a 5 s log read;
- handlers that call the code its poller called, with events coalesced per object within one read;
- **a bootstrap**: its existing read, run once, in the cases listed under "Bootstrap scope" below.

**Bootstrap scope.** A bootstrap covers only what was missed, and never throws away events already accepted.
- **First start (no cursor).** The consumer takes the watermark (`GET /v1/events/log` with no `after`), reads every repo, and
  handles events from the watermark.
- **Restart with a valid cursor.** No bootstrap. The consumer resumes from its committed cursor.
- **`gap: true`.** It bootstraps every repo, then goes on from `next`.
- **`github.resync` for a repo.** It bootstraps that repo only, as the event's handler. The cursor moves as for any other
  event.
- **A settings change.** Settings reach a consumer through an apply, which restarts it. So the consumer keeps a digest of
  its compiled subscription and its own settings beside its cursor. A start whose digest changed bootstraps only the repos
  the change touched (added, or with changed gate settings), then resumes from the cursor.

A newly watched repo's baseline emits `github.resync` (§1), so a consumer's own bootstrap of it is followed by one more
after the baseline. Both are idempotent, and anything opened in between is caught.

Events that overlap a bootstrap read are handled idempotently. This is catch-up, not a second path: the timers are deleted.

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

### The github service's other loops (lane 1)

These run in the same process as the reader, so they take its events in-process, through the same hook as Flow.

**The design review sweep.**
- Runs `sweep()` for a task when its PR gets `synchronize` or `closed`, or a `status` for the `design-review` context.
- Its `readPr` becomes the reader's snapshot of that PR.
- On `github.resync` it sweeps every open design-review task of that repo, reading each one's PR once, so a close or verdict
  missed while state was lost is still settled.
- `startDesignReviewSweep`'s timer stays, kernel-only: it retries closes the kernel didn't take (no answer, `5xx`), from the
  reason already in the task's row. It no longer reads GitHub.

**The release train.**
- Its GitHub inputs move to the reader's events: `push` on the instance repo (then one read of `instance.yaml`, kept in
  memory and read once at start), and `push`, `check_run.completed` or `status` on the product repo's default branch (tip and green come from the
  reader's snapshot of that head).
- `step()` stays on its 1-minute timer, over those cached inputs: `trainStep` still runs every minute, so a window that
  expires with no GitHub change still files its bump. Following a filed bump's record and sweeping its own task family stay
  there too. The timer reads only the kernel and the cache, never GitHub.

### The Maintainer (lane 2)

**Subscribes to** `issues.opened`, `issues.labeled`, `issues.closed` and `github.resync`, plus the PR kinds for
`contributor_prs` until #1680 moves that pass to ship.

**Handlers.** Each runs only for a duty that repo has on, as today: the fix label needs `issues`; `agent-build` and
`feature-request` need `features`. Other labels and duties are committed with no effect.
- **A fix label or `agent-build` on `issues.labeled`.** One trust read for that issue: github-mcp's existing
  `latestOrError`, which reads the label timeline and the actor's role. If trusted, the task is filed as today under source
  `maintainer-issue:<repo>#<n>`, so the kernel keeps one task per issue. If the read answers `error` (GitHub failed), the
  handler throws and the batch is redelivered; only a definite answer of untrusted commits the event with no task.
- **`feature-request` on `issues.labeled`.** The same trust read, then the issue joins the `featured` set.
- **`issues.opened`** that carries none of the three labels (the fleet's own issues included). It goes through
  `triageRepo`'s per-author limit, then the triage task is filed (`maintainer-triage:<repo>#<n>`).
- **Held triage issues.** They are re-checked when a slot frees: a filing, or the oldest `recent` entry turning a day old.
  That is a deadline, not a sweep.

**Bootstrap.** For each maintained repo, per duty it has on, the existing `repoSince(repo, undefined, label)`:
- the fix label for `issues`;
- `agent-build` and `feature-request` for `features`. Trusted open `feature-request` issues rebuild `featured`, so the
  author-cap exemption survives a first start, a gap or a resync.

`repoSince` reads every page and refuses incomplete coverage; `issueList` silently stops after 10 pages. A `repoSince`
answer with `skipped` entries (a timeline read failed) makes the bootstrap throw, so the event that started it is
redelivered and the bootstrap retried; it never commits over an unread issue. Each open, trusted, labelled issue is
filed under its source key, and the kernel dedupes. So labelled issues are reconciled from the start, as today. Unlabelled
triage starts at the watermark, as `untriaged` does today: issues already open are the daily triage's.

**Deleted.**
- `watcher.ts`'s timer;
- the `cursor`, `triage_cursor` and `build_cursor` fields;
- `maintainer_poll_minutes` and `MAINTAINER_POLL_MINUTES`;
- github-mcp `maintainer.ts`'s `issuesSince`, `untriaged` and `recentFeatureRequests`, and the cursor form of their route.

`repoSince` (for the bootstrap), `issueList` and the trust read stay.

### Code review (lane 3)

**Subscribes to:**
- `pull_request.opened`, `.synchronize`, `.ready_for_review`, `.converted_to_draft`, `.closed` and `.reopened`;
- `issue_comment.created`;
- `pull_request_review_comment.created`;
- `github.resync`.

**Handlers.** These are the bodies of today's `poll(cfg)` and `claims(cfg)` in `engine.ts`:
- **opened, synchronize, ready, reopened.** `upsertPr` from the event's full PR record in `data` (fork, draft, head, base)
  and the title in `text`; the stored body is replaced only by `opened`, which carries it. Then the same `trigger` and
  `missing` decisions, keyed on `(repo, number, head)`.
- **converted_to_draft.** Updates the row.
- **closed.** `data.merged` decides the findings' outcome (`open_at_merge` or `open_at_close`). Queued runs are skipped, and
  `close_due` is set; that replaces the extra `GET /pulls/:n`. `closeTasks` runs on the fast tick for every `close_due` row.
- **issue_comment.created** on a PR. Runs `command(cfg, c)`. Commands sit in the comment's first line, well inside the 2,000
  characters carried. The `seen` row is now inserted in the same SQLite transaction as the command's local effects (a run
  queued, a focus set), closing today's window where a crash after `command()` repeats it.
- **pull_request_review_comment.created** on a gated repo. Runs `claims` for that one PR. Its existing `seen` (`reply:<id>`)
  keeps each reply once.
  - A failed thread read throws, and the batch is not committed. Today it is swallowed (`engine.ts:1928`), because the next
    poll would retry; with no poll, the redelivery is the retry. A reply that `claims` leaves unread on purpose (its finding's mandatory post hasn't settled) is read
  again when that post settles: a local trigger inside code review, no GitHub event.

**Settings changes.** A changed gate, a repo added, a combo made mandatory: each changes the digest, so the next start
bootstraps the affected repos.
That is how `missing()` today reaches open heads with no new GitHub activity.

**Bootstrap.** Three reads, each an existing one:
1. `source.open(repo)`: "the first look reviews what is open", which is today's behaviour, kept.
2. `source.comments(repo, since)`, from the newest comment already handled, so commands posted during a gap or a resync are
   not lost.
3. `claims` for each open PR with findings, so inline replies posted meanwhile are read too.

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
- **Mergeability `UNKNOWN`.** GitHub computes it lazily and sends no event when it settles. An evaluation that reads
  `UNKNOWN` sets a one-PR deadline 1 minute out and evaluates that PR again, up to 5 times; still unknown after that is
  logged.
- **The default branch moves or its CI changes.** A `push` to the default branch, or a `check_run.completed` / `status`
  whose `branch` is the default (both carry it), evaluates the repo's open fleet PRs once. The "red while behind a green main" decision depends
  on main's CI as well as its head.
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
| Half-hour ask cooldown | a one-PR deadline at the cooldown's end, so a wake it held back is asked again |
| Mergeability `UNKNOWN` | a one-PR deadline, 1 min, at most 5 times (above) |
| Contributor-PR nudge and close (`stale_days`) | a one-PR deadline at the time today's `prDue` gives: `last_author_activity` + `stale_days` for the nudge, then the nudge's time + `stale_days` for the close, both doubled for drafts. Activity is the author's own, not checks. At each deadline ship reads that one PR, recomputes `last_author_activity` as today, acts only if it is still stale, and always sets the next deadline from `prDue` |
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
| A consumer behind by over 3 days | `gap: true` (rows newer than its cursor were pruned), then a bootstrap. |
| A handler that fails on every delivery | The cursor stops; `feedLag` names the module. Fixed at the bug, never skipped. |
| A cursor list longer than 10 pages in one pass | The pass goes on from the saved cursor next time. Nothing is lost. |
| Over 10 pages of new issue events in one pass | The pass sends what it read and is recorded as a loss ("gap"). Fails loudly. |
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
- **A run is a loss** if any pass in its window lost something: an issue-events gap, a "baseline" (a lost state file, not a
  repo's first read) or an event refused for good. A loss is recorded failed with that reason, even when later passes in the same window succeeded. A loss outranks
  ok.
- **Otherwise a run is ok** if any pass completed, or it carries GitHub's last error.
- **`rows`** is the number of events sent.
- One run per 5 minutes rather than per pass keeps the table at `R × 288` rows a day.

**Staleness.**
- `detector.ts` `STALE_FOR` gets `github_feed: 15 min`, so no good pass on any repo for 15 minutes is raised, instead of the
  60-minute default.
- One repo failing every pass for a day falls under the existing `failingScopes`.
- **The outbox's oldest pending event** rides on the run too. When it is older than 10 minutes, the run is failed
  ("outbox stalled: kernel not accepting"). A stalled outbox puts nothing in the log, so a consumer's lag alone would never
  show it.

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
  `GET /v1/events/log`, `GET /v1/events/readers`, and the `resources()` union.
- **Compile:** `subscribes:` → `config/modules.json`, plus its `docs/configuration.md` row.
- **The github service:**
  - `feed.ts`, with its outbox and the one scheduler;
  - the `sources.ts` sync and the backfill moved onto it;
  - the Flow hook, which also feeds the design review sweep and the release train;
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
| `modules/github/service/src/design-review.ts` | the GitHub read in `startDesignReviewSweep`'s timer (`sweep` runs on events; the timer only retries kernel closes) |
| `modules/github/service/src/train.ts` | the GitHub reads in `step` (`github.text` of `instance.yaml` and `github.tip` every minute); the kernel-only follow and sweep keep their timer |
| `modules/github/module.yaml` | the `events` comment "polled from each subscribed repo's events feed on the code host's churn pass"; `kinds` grows to §2's list |
| `modules/code-review/service/src/main.ts` | the GitHub `setInterval`, `CODE_REVIEW_POLL_SECONDS`, `wantGithub` |
| `modules/code-review/service/src/engine.ts` | the timer-driven calls of `poll` and `claims` in `tickWork` |
| `modules/maintainer/service/src/watcher.ts`, `modules/maintainer/module.yaml` | the timer, the three cursors, `maintainer_poll_minutes`, `MAINTAINER_POLL_MINUTES` |
| `modules/github/connections/github-mcp/src/maintainer.ts` | `issuesSince`, `untriaged`, `recentFeatureRequests` and the cursor form of their route (`repoSince` stays for the bootstrap) |
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
3. **Apps platform loops.** Its 2-minute deploy and preview loops read GitHub through the code host for GitHub-hosted app
   repos. Switch them as a lane 5 (subscribe to `push` and `pull_request.*` for GitHub app repos, keep the local loop for
   codehost-local repos), or leave them out of scope?
4. **Two behaviour changes to OK.**
   - A human re-run on a settled head is seen within 5 minutes (60 s today).
   - Feed reads with an ETag skip the 20% background reserve.
