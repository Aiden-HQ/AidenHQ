# GitHub change feed: one reader instead of per-module polling

Status: design for the owner's review (direction agreed by the owner 2026-11-24). Docs only; nothing is built yet.

## Why

Five loops read GitHub on their own timers. Each one re-reads the same repos whether or not anything changed:

| Loop | Where | Cadence | What it reads every tick |
| --- | --- | --- | --- |
| Code review's watcher | `modules/code-review/service/src/main.ts` (`setInterval(tick(true))`, `CODE_REVIEW_POLL_SECONDS`, default 60 s) → `engine.ts` `poll(cfg)` | 60 s | each configured repo's open PRs (`/internal/code-review/prs` → `GET /repos/:r/pulls?state=open`) and its conversation comments since a cursor (`GET /repos/:r/issues/comments?since=`), plus one `GET /pulls/:n` for each PR that left the open list |
| The PR watch | `modules/github/service/src/pr-watch.ts` (`EVERY_MS` 60 s, backing off to `IDLE_MAX_MS` 30 min when nothing is open); moving to `modules/ship/service/src/loop.ts` in #1680 | 1 min | per watched repo one GraphQL `OPEN_PRS_QUERY` (50 PRs with their check rollups), then per PR `compare`, Actions job probes (up to `PROBES_PER_PASS` 10) and `pulls/:n` for PRs that left the list |
| The merge queue | `modules/github/service/src/merges.ts` `start()` | 30 s | per in-flight PR: GraphQL `PR_QUERY`, check runs and statuses, and the branch's required checks |
| The Maintainer's watcher | `modules/maintainer/service/src/watcher.ts` (`maintainer_poll_minutes`, default 5) → github-mcp `maintainer.ts` `issuesSince` | 5 min | per maintained repo: labelled issues (plus one timeline per updated labelled issue), agent-build issues, feature-request issues of the last day (plus one timeline each), new unlabelled issues; hourly, the contributor-PR pass (`prTick`, moving to ship in #1680) |
| The github service's 15-minute pass | `modules/github/service/src/flow.ts` `startChurn` → `churnPass` | 15 min | `issuesRepo` (issues since a cursor and the repo's issue events, for Flow's `issue.opened` / `issue.labeled` facts) and `eventsPass` (each subscribed repo's `/events` feed, for routines' events) |

The warehouse writer `src_github` is a sixth reader. It runs in
`modules/github/connections/github-mcp/src/sources.ts` `startSync`, not in `flow.ts`: org-scoped search every 15 minutes,
and Projects boards hourly.

None of these loops sends `If-None-Match`, except `eventsRepo`'s first page. So a quiet repo costs the same as a busy one.
The PR watch's read is GraphQL, which has no conditional requests at all. Every reply also takes a slot from the owner
account's shared budget: 5,000 REST calls an hour, 5,000 GraphQL points an hour, and the secondary limits that stalled
everything on 2026-11-22 (`project-github-rate-limit`).

## Goal

The github module's code service (the one `github` process, `modules/github/module.yaml` `services.run.github`) becomes
the only timer-driven reader of GitHub.
- **Cheap when quiet.** It reads with conditional requests (ETags; a `304` is free of the primary limit) at a cadence that
  follows activity.
- **The warehouse stays.** It keeps writing `src_github`.
- **Typed events.** It posts a typed event for each change to the kernel's event router (`POST /v1/events`, the path
  slack-live already uses), plus a small structured `data` payload.
- **Subscribers.** Routines, code review, ship and the Maintainer subscribe, and their GitHub timers are deleted.
- **The one exception.** The merge queue's read of a PR it is merging stays a timer.

**Poller, defined.** A poller is a timer-driven GitHub read that sweeps repos or lists. These stay:
- **Reads an event triggers.** For example, code review reading a PR's merge base when it starts a review, or the Maintainer
  reading one issue's label timeline to judge trust.
- **A deadline a consumer sets for one object.** For example, "re-check this PR's stuck check in 20 minutes". It is one
  read of one object, never a sweep.

Nothing in this design uses Intake or agents: agents never feed the warehouse.

## Non-goals

- **Webhooks now.** They come later as an optional input that only wakes the same reader (see "Webhooks, later").
- **Changing what a consumer decides.** Code review's triggers, ship's rounds and the Maintainer's trust rules stay as they
  are. Only where their input comes from changes.
- **Changing writes.** Pushes, PRs, merges, comments and statuses keep their current paths and gates.
- **`codehost-local`.** Its own loop in `kernel/src/localmerge.ts` stays.

## 1. The reader

A new file, `modules/github/service/src/feed.ts`, runs in the `github` process. It shares that process's one GitHub client:
- the client sets `background: true` and keeps the 20% reserve;
- it has the `etag` option (`connections/github-mcp/src/client.ts`, "a conditional read (If-None-Match)").

### Watched repos

The watched set is the union of every subscriber's resources. The reader reads it from `GET /v1/events/sources?connection=github`
(kernel `events.ts` `resources()`), which this design extends to include module subscribers as well as routines (§3).
- `*` means the repos the code host manages: the fleet org's repos, `product_repo`, the instance repo and `maintainer_repos`.
- The reader re-reads the set every pass. A repo that leaves the set stops being read, and its state is dropped.

### What it reads

Every read below is REST and conditional. The reader keeps one ETag and one snapshot per URL in its state file,
`/cache/feed.json`.

**Each repo, every pass:**
1. **The change probe.** `GET /repos/:r/issues?state=all&sort=updated&direction=desc&per_page=30`.
   - Anything that bumps an issue's or a PR's `updated_at` changes this page and its ETag: an issue or PR opened, a comment,
     a label, a close or reopen, a push to a PR, a review.
   - On a `304`, steps 3 to 6 are skipped.
2. **The default branch.** `GET /repos/:r/branches/:default`. It catches a push to the default branch, which never touches
   the probe.

**Only when the probe changed:**
3. **Open PRs.** `GET /repos/:r/pulls?state=open&sort=updated&direction=desc&per_page=100`, paginated.
4. **Issue events.** `GET /repos/:r/issues/events?per_page=100`, page 1, then back to the cursor (the newest event id sent),
   at most 3 pages. Labels and issue closes come from here, each with its actor.
5. **Comments.** `GET /repos/:r/issues/comments?sort=created&direction=desc&per_page=100`, back to the cursor the same way.
6. **Reviews.** `GET /repos/:r/pulls/:n/reviews` for each open PR whose `updated_at` moved in the probe while its head did
   not.

**Each head, on its own cadence (step 7):**
- Every open PR's head, plus the default branch's head, gets `GET /repos/:r/commits/:sha/check-runs?per_page=100` and
  `GET /repos/:r/commits/:sha/status`.
- A head is **unsettled** while either of these holds:
  - a check run is not completed, or a status is pending;
  - it is under 10 minutes old.
- Unsettled heads are read every pass. Settled heads are read every 5 minutes, which catches a re-run a human starts from
  GitHub's UI.
- A write the `github` process makes itself unsettles that head at once. That covers a status post (code review's
  `aidenhq/review`, the design review), a re-run and an update-branch.

**One source per kind.** Each event kind below has exactly one of these reads as its source. When steps 3 to 7 return
nothing new, the pass emits nothing.

**Verify once, while building.** The build proves against a scratch repo that the probe's ETag moves for each trigger in
step 1: a comment, a label, a push to a PR, a review and a close.
- A trigger the probe doesn't see gets its own conditional read in the pass, and the spec is amended.
- This is a decision made at build time, not a runtime fallback.

### First read and restarts

**A repo read for the first time is a baseline.**
- It records its snapshots, ETags and cursors and emits nothing: a subscription starts from now.
- `flow.ts` `eventsRepo` already does this. Consumers catch up on what was already open with their own one-off read
  (§4, bootstrap).

**State is saved only after every event of the pass was accepted** (any 2xx from the kernel):
- A crash, a kernel `5xx` or a timeout leaves the old ETags and snapshots in place, so the next read answers `200`, the same
  diff comes out, and the same events go out again.
- The kernel drops repeats by id (§3).
- `eventsRepo` keeps its ETag only once every event of the read was sent; this is the same rule.

### Cadence

There is one cadence per repo:
- **15 s** after a pass that saw a change, after a write by the `github` process to that repo, or after a merge is queued
  there;
- then it **doubles each quiet pass, up to 60 s**.

Nothing is ever read less often than today's fastest consumer (code review and ship, 60 s), so no consumer gets slower.
Unsettled heads ride their repo's pass, and settled heads are read every 5 minutes. Passes run one repo at a time,
oldest-due first, through the same client queue as every other call.

**Rate budget.**
- While the primary limit's remaining share is under the client's 20% background reserve, the cadence holds at 60 s, and the
  pass records "low budget".
- A `304` costs nothing, so the feed keeps working in a low-budget hour while the 200s slow down.
- A secondary-limit refusal (`403`/`429` with `retry-after`) pauses the whole feed until the time GitHub gives.

## 2. Event types and payloads

Kinds use GitHub's webhook names (`<event>.<action>`), so later webhooks map one to one.

**The envelope.**
- It is the kernel's `SourceEvent` (`kernel/src/events.ts`): `connection: "github"`, `resource` (`owner/name`, lower case),
  `id`, `kind`, `author`, `text`, `labels`, `bot`, `url`.
- It gains one optional field, **`data`**:
  - a flat object of at most 20 keys;
  - each value a string of at most 200 characters, a number, a boolean or null;
  - at most 2 KB as JSON.
- `envelope()` validates `data` the way it validates `labels` and drops an event that breaks the rule as `invalid`.

**What travels.** `text` is the stranger's words: a title and body, or a comment. As today, it is clipped at 2,000
characters with `truncated`. Everything a consumer keys on goes in `data`.

**Ids are deterministic** and built from GitHub's own ids or from state:
- a re-read, a restart or a later webhook yields the same id;
- the kernel keeps an id once per connection (§3).

| Kind | Source read | `id` | `data` (besides `number`) | `text` |
| --- | --- | --- | --- | --- |
| `pull_request.opened` | open-PR list: a number not in the snapshot | `<repo>#<n>:opened` | `head`, `base`, `base_ref`, `head_ref`, `draft`, `fork`, `author_kind` | title, blank line, body |
| `pull_request.synchronize` | open-PR list: the head changed | `<repo>#<n>:head:<sha>` | `head`, `before`, `base` | none |
| `pull_request.ready_for_review` / `pull_request.converted_to_draft` | open-PR list: `draft` flipped | `<repo>#<n>:ready:<head>` / `:draft:<head>` | `head` | none |
| `pull_request.closed` | open-PR list: the number left; one `GET /pulls/:n` | `<repo>#<n>:closed:<closed_at>` | `head`, `merged`, `merge_sha` | none |
| `pull_request.reopened` | open-PR list: a closed number came back | `<repo>#<n>:reopened:<updated_at>` | `head` | none |
| `pull_request.edited` | open-PR list: the title changed at the same head | `<repo>#<n>:title:<sha256(title)[0:12]>` | `head` | the title |
| `issues.opened` | probe: a new non-PR number above the highest seen | `<repo>#<n>:opened` | `author_kind`, `created_at` | title, blank line, body |
| `issues.labeled` / `issues.unlabeled`, `pull_request.labeled` / `.unlabeled` | issue events | `ev:<event id>` | `label`, `actor` | none |
| `issues.closed` / `issues.reopened` | issue events (non-PR) | `ev:<event id>` | `actor`, `state_reason` | none |
| `issue_comment.created` | comments | `comment:<id>` | `comment_id`, `pr` (bool), `author_kind`, `created_at` | the comment |
| `pull_request_review.submitted` | reviews | `review:<id>` | `review_id`, `state`, `head` (`commit_id`) | none |
| `check_run.completed` | check runs of a head | `check:<check run id>` | `head`, `name`, `conclusion`, `branch` (default branch only), `prs` (open PR numbers on that head, comma-separated) | none |
| `status` | the combined status of a head | `status:<sha>:<context>:<state>` | `head`, `context`, `state`, `prs` | none |
| `push` | default branch: its sha moved | `<repo>:push:<sha>` | `ref`, `before`, `after` | none |

**`author_kind`.** It uses the rule `flow.ts` `kindOf` already applies (`agent`, `owner` or `outside`), from the same
helpers. The reader computes it once, so consumers stop re-deriving it.

**`author`** is the GitHub login, and `bot` is true for a `[bot]` login. `url` is the object's `html_url`.

**One event per completed run.** A check re-run is a new check run id, so it makes a new event. Consumers coalesce per PR
inside one read of the log (§4).

**Routines.** No routine subscribes to GitHub events today: none in the product or the instance repo uses
`event: { connection: github }`. So the three existing kind names (`issues.opened`, `issue_comment.created`,
`pull_request.opened`) keep their meaning, and the rest are new. `modules/github/module.yaml` `connections.github.events.kinds`
lists them all, and routine filters (`kind`, `author`, `contains`) work on every kind.

## 3. Kernel: a module subscriber beside routines

Today the router (`kernel/src/events.ts`) delivers only to Paperclip routines:
- a 60 s batch window;
- at most 12 runs an hour per routine and 120 in all;
- a run through `/run`.

That suits waking an agent. It is wrong for code services: a cap would silently drop a "new head", and the kernel still
answers 2xx (`{ dropped, reason: "cap" }`), so the emitter's cursor moves on. Code services get a second, plain delivery
instead: **an append-only log they read with their own cursor.** It is generic, keyed by connection only, and the same
`POST /v1/events` feeds both kinds of subscriber.

### The log

- **Table.** `event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, connection, resource, id, kind, body, at, UNIQUE(connection, id))`
  in `kernel.db`, created in `createEvents`.
- **What `ingest` appends.** Each valid event whose `(connection, kind)` some module subscribes to, before the routine fan-out.
- **A repeated id.** `INSERT OR IGNORE`: it is neither appended again nor fanned out to routines again, and the answer
  says `duplicate`. Routines' own `UNIQUE(routine, id)` stays as it is.
- **Retention.** 3 days, cleaned in `drain()` with the other expiries.
- **Subscribing.** A module subscribes in `module.yaml`:
  ```yaml
  subscribes:
    github: [ pull_request.opened, pull_request.synchronize, issue_comment.created ]
  ```
  Compile checks each kind against that connection's `events.kinds` and writes the result to `config/modules.json`. The
  declaration is the grant: no new role is needed.

### Reading it

`GET /v1/events/log?connection=github&after=<seq>&limit=200` is a module route, called with the module's own token.
- **Answer.** `{ events: [{ seq, resource, id, kind, author?, text?, labels?, bot?, url?, data?, at }], next, gap }`, limited
  to the kinds this module subscribes to.
- **No `after`.** The answer is `{ events: [], next: <current max seq> }`: the starting point for a fresh consumer.
- **`gap: true`.** When `after` is older than the oldest row kept: the consumer bootstraps (§4).
- **Bookkeeping.** Each read records `(module, connection, next, at)` in `event_readers`, for the health signal (§7).

### Resources

`PUT /v1/events/watch { connection, resources }` is a module route that replaces that module's resource list. `resources()`
then returns the union of routines' and modules' resources, and the reader polls exactly that.
- **When a module calls it.** At start, and whenever its own settings change. Code review sends its configured repos, ship
  `*`, and the Maintainer its `maintainer_repos`.

### Delivery semantics

**At least once.** The reader re-sends until the kernel takes the event. The kernel keeps each id once. A consumer moves its
cursor only after it has handled the events it read, so a crash in between redelivers them. Every consumer is idempotent
on keys it already has (§4).

**Latency.** A consumer reads the log every 5 s. That is a local call costing nothing on GitHub. End to end it adds up to
about 5 s on top of the reader's 15 to 60 s.

A long-poll could replace the 5 s read later if that latency ever matters. It isn't built now.

## 4. How each consumer switches

Every consumer follows the same pattern:
- a cursor in its own state;
- a 5 s read of the log;
- handlers that call the code its poller called;
- a one-off **bootstrap** (its existing read, run once) at start, on `gap`, and when its settings add a repo.

The bootstrap is not a second path: it is the catch-up a subscription needs, and its timer is deleted.

### Routines (first, with the reader)

- **The routine path.** `flow.ts` `eventsPass` / `eventsRepo` / `sourceEvent` and `/cache/events.json` are deleted. Routines
  get their events from the reader through the same router path. Their latency goes from 15 minutes (best effort, and
  GitHub's `/events` feed can lag for hours) to at most 60 s.
- **Issue facts.** `flow.ts` `issuesRepo` and `/cache/issues.json` are deleted. The Flow facts `issue.opened` and
  `issue.labeled` come from the reader's diff, through an in-process hook on `feed.ts`, with the same fact ids
  (`OPENED_VERSION`, `${OPENED_VERSION}:<event id>`), so nothing is recorded twice.
- **PR facts.** These also come from the reader's hook:
  - from the open-PR diff and the head reads: `pr.opened`, `pr.pushed`, `pr.closed`, `pr.merged`, `pr.reverted`,
    `pr.checks_started` and `pr.checks_completed`;
  - they replace pr-watch's Flow observation (`pr-watch.ts` lines ~700–760; in #1680, ship's `/internal/ship/flow` route);
  - the facts' ids are type, subject and version, so the code host's own emissions in `service.ts` and `merges.ts` still
    record once.
- **What stays.** Churn and the one-time backfill stay on their timer, because they read the cache clone with `git`, not the
  API.

### The Maintainer

**Subscribes to** `issues.opened`, `issues.labeled`, `issues.closed`, and `pull_request.*` / `issue_comment.created` for
`contributor_prs`, until that moves to ship.

**Handlers:**
- **The repo's fix label or `agent-build` on `issues.labeled`.** A one-off trust read through github-mcp's existing
  `latestOrError` (the label timeline and the collaborator's role) for that one issue. A trusted label files the task as
  today. The source `maintainer-issue:<repo>#<n>` means the kernel keeps one task per issue.
- **`feature-request` on `issues.labeled`.** The trust read, then it joins the `featured` set.
- **`issues.opened`** with `author_kind` not `agent` and no fix, `feature-request` or `agent-build` label goes to
  `triageRepo`'s per-author limit, then files the triage task (`maintainer-triage:<repo>#<n>`).
- **Held triage issues.** Today they are re-checked every tick. Now they are re-checked when a slot frees (a filing, or the
  oldest `recent` entry turning a day old). That is a deadline, not a sweep.

**Deleted:**
- the `setInterval` in `watcher.ts` `startWatcher`;
- the `cursor`, `triage_cursor` and `build_cursor` fields;
- the `maintainer_poll_minutes` setting and `MAINTAINER_POLL_MINUTES`;
- github-mcp's cursor reads behind `/internal/maintainer/issues` (`issuesSince`, `repoSince`, `untriaged`,
  `recentFeatureRequests`). The trust read stays as a route for one issue.

**Bootstrap:** none. As today, the first look sets a cursor and issues already open are the daily triage's.

### Code review

**Subscribes to:**
- `pull_request.opened`, `.synchronize`, `.ready_for_review`, `.converted_to_draft`, `.closed` and `.reopened`;
- `issue_comment.created` (`pr: true`).

**Handlers** (`engine.ts`, the bodies of today's `poll(cfg)`):
- **opened, synchronize, ready or reopened.** `upsertPr` from `data` plus `text` (title and body, as stored today), then the
  same `trigger` / `missing` decisions keyed on `(repo, number, head)`.
- **converted to draft.** Updates the row.
- **closed.** Uses `data.merged` for the findings' outcome (`open_at_merge` / `open_at_close`), skips queued runs, and sets
  `close_due`. That replaces the extra `GET /pulls/:n`. `closeTasks` runs on the fast tick for every `close_due` row.
- **issue_comment.created.** Goes to `command(cfg, c)`. The `seen` table already makes it once per comment id. A
  `truncated` comment reads its full body through the existing route.

**Deleted:**
- `main.ts`'s `setInterval(() => void tick(true), CODE_REVIEW_POLL_SECONDS)` and that env var;
- `tick({ github })` and the `wantGithub` flag (the 10 s tick becomes the only tick, and it reads the log);
- the `cursors` table;
- github-mcp's `/internal/code-review/comments` route.

**Bootstrap.** `source.open(repo)` (`/internal/code-review/prs`) once per repo: "the first look reviews what is open", which
is today's behaviour, kept. That route stays for this one read. `get`, `compare`, `patch-id` and `merge-base` stay as reads
an event triggers.

### Ship (last; after #1680 lands `modules/ship/service/src/loop.ts`)

**Subscribes to:**
- every `pull_request.*` kind;
- `pull_request_review.submitted`, `check_run.completed`, `status`, `issue_comment.created`,
  `pull_request.labeled` / `.unlabeled`;
- `push` (default branch).

**Handlers.**
- **Per PR.** Every PR named by an event in a read of the log, coalesced to one evaluation per PR, runs today's per-PR body
  of `scan()`. Its one GraphQL read is narrowed from the repo's open list to that PR (mergeability and rollup are still
  GraphQL: they have no REST equivalent at that cost).
- **On `push`.** A push to the default branch re-evaluates the repo's open fleet PRs once. This is the "red while behind a
  green main" and update-branch path.

**What happens to each pr-watch / loop duty:**

| Duty | After |
| --- | --- |
| Agent PR green at a mergeable head → merge filed | on `check_run.completed` / `status` for its head |
| Agent PR red on its own head → wake (and the CI breaker) | on `check_run.completed` |
| Conflict, or red while behind main → update-branch or wake | on `push`, `synchronize` |
| Update-branch transient-failure retry (5 min), lost update (`UPDATE_OK_WAIT_MIN` 10) | a deadline per PR in ship's state |
| Never-started check → re-run once | on `check_run.completed` with `conclusion` in the failure set; the Actions job read is triggered by that event |
| Wedged check: run not completed while its job finished (3 min grace, report at 20 min) | a deadline per unsettled head: one Actions job read at 3 min, one at 20 min |
| Title gate (`policy` red, title now valid) | on `pull_request.edited` (see the note below) |
| Dependabot task when checks finish; closed when merged or closed | on `check_run.completed`, `pull_request.closed` |
| Close a cancelled task's PR; close a done task's unmerged PR after 30 min | the first on the kernel's task state when ship next evaluates the PR; the second as a deadline (head age + 30 min) |
| Review-findings wake (code review's verdict waits on findings) | on `status` (`aidenhq/review`) for the head |
| Half-hour ask cooldown (`HALF_HOUR`) | unchanged state; checked when the PR is next evaluated |
| Contributor-PR nudge and close (`contributor.ts`, `stale_days`) | a deadline per PR at last activity + `stale_days`; activity is any event on the PR |
| Flow observation | moves to the reader (above) |
| Adopted PRs' rounds (`adopted.ts`) | the same events; the round runs on its PR's evaluation |

**Deleted:**
- the `next()` / `setTimeout` loop (`EVERY_MS`, `IDLE_MAX_MS`);
- the every-minute full scan of each repo;
- the Maintainer's hourly `prTick` gate (`PR_EVERY`), in its new home;
- the `/internal/ship/flow` route.

**Bootstrap.** One full `scan()` of each repo at start and on `gap`: today's tick, run once.

**Note on the title gate.** A title-only edit starts no workflow, so the red `policy` check stays and no check event
follows. The reader therefore emits `pull_request.edited` (`data`: `head`) when the open-PR list shows a new title for the
same head (§2). It is the one kind that only ship takes.

### The merge queue (stays a poller)

`merges.ts` keeps its 30 s read of each in-flight PR, as the owner decided. Two small things change:
- **Nudge.** The reader calls `merges.step()` at once, in-process, when it emits `check_run.completed`, `status`,
  `synchronize` or `closed` for a PR that is in a queue, so a merge doesn't wait out the 30 s.
- **Cadence.** A queued PR's repo gets the 15 s cadence.

## 5. API budget, before and after

**Symbols:**
- `R`: watched repos;
- `P`: open PRs across them;
- `Q`: PRs in the merge queue;
- `H`: unsettled heads.

The instance today is `R ≈ 8`: `Aiden-HQ/AidenHQ`, `Aiden-HQ/aidenhq-distro`, the instance repo and the 5 `aidenhq-alpha`
repos. Code review watches 1 repo, the PR watch 6 and the Maintainer 2; `P ≈ 7` on `AidenHQ`.

These are estimates from the code paths above, not measurements. Lane 1 adds a per-caller counter (§8) that replaces them
within a day.

### Before: the timer floor, paid every hour whether anything changed or not

| Loop | REST calls/h | GraphQL queries/h |
| --- | --- | --- |
| Code review (1 repo, 2 reads/min) | 120 | 0 |
| PR watch (6 repos, 1 query/min each while any PR is open; plus probes and compares) | ~30–100 | 360 (≈1 point each, ≈360 points) |
| Maintainer (2 repos; `AidenHQ` with features: about 4 lists + timelines per tick, 12 ticks) | ~100–150 | 0 |
| flow.ts `issuesRepo` (~7 managed repos × 2 reads × 4/h) | 56 | 0 |
| flow.ts `eventsPass` (no routine subscribes today) | 0 | 0 |
| **Total floor** | **~300–425** | **~360** |

**On top of the floor:**
- the merge queue: about 5 calls per 30 s per in-flight PR, about 600/h per PR while it merges, which stays;
- `src_github` sync, which stays;
- event-driven reads.

For scale, one `rate_limit` read of the owner's account on 2026-11-24 showed 1,320 core and 224 GraphQL used in that
window. That is account-wide, writes and the owner's own `gh` included, so it is context, not the pollers' cost.

### After

**Idle hour.**
- Counted against the primary limit: about 0. Every read is a `304`.
- Sent, which matters only for the secondary limit: `R × 2 × 60` (the probe and the default branch at 60 s), plus the
  settled heads' `P × 2 × 12` (every 5 min):
  - `8 × 120 + 7 × 24` ≈ **1,130 conditional requests/h**, about 19 a minute;
  - against the REST secondary limit of 900 points a minute, that is about 2%.

**Busy hour, per change** (a 200 costs 1):
- a new head about 1 (open-PR list) + ~10–15 (check-run lists changing while CI runs, sampled at 15–60 s) + ~2 (status);
- a comment, a label or a close 1–2 (the probe plus its list);
- a review 2.

**Example busy hour.** 10 heads, 30 comments, 20 labels and closes, and 5 PRs opened or closed come to about
150 + 30 + 30 + 10 ≈ **220 REST**. Add the reads events trigger:
- code review's about 3 per reviewed head: about 30;
- ship's one GraphQL per evaluated PR: about **40–60 queries**.

**Summary:**

| | REST/h | GraphQL queries/h |
| --- | --- | --- |
| Idle, before → after | ~300–425 → ~0 | ~360 → 0 |
| Busy, before → after | ~400–600 → ~250 | ~360–420 → ~40–60 |

The merge queue and `src_github` are unchanged in both columns. The saving is about the whole floor when quiet, and about
half the REST and 85–90% of the GraphQL when busy. Latency is better too:
- routines go from 15 min to ≤60 s;
- the Maintainer from 5 min to ≤60 s;
- code review and ship from 60 s to 15–60 s, and 15 s right after a change.

## 6. Failure modes

| Failure | What happens |
| --- | --- |
| GitHub `5xx`, a timeout, or a `404` on one repo | That repo's pass fails, and its state is not saved. The next pass retries at its cadence, and the pass is recorded failed (§7). A repo deleted or renamed keeps failing until it leaves the watched set. |
| Primary limit low | Cadence holds at 60 s. `304`s stay free, so changes are still seen, only their 200s compete. Recorded "low budget". |
| Secondary limit (`403`/`429` + `retry-after`) | The whole feed pauses until then, through the client's existing pacing. |
| The kernel down or refusing (`5xx`, `429`, no answer) | The pass stops before saving. The next pass re-reads and re-sends, and the kernel's `UNIQUE(connection, id)` drops what it already had. |
| The kernel refuses one event (`4xx`) | Logged, and the pass goes on. The event is malformed, so a resend can't help; this is the same rule as `eventsRepo` today. |
| The `github` process restarts | Its state file is written whole (tmp + rename), and the next pass resumes from it. A missing or corrupt file is a new baseline: nothing is emitted, and consumers are unaffected. |
| A consumer down or crashing mid-batch | Its cursor didn't move, so it reads the same events again. Each handler is idempotent on keys it already has: code review on `(repo, number, head)` and `seen` comments; ship's per-head state (`greened`, `reded`, `pinged`); the Maintainer's task sources; routines' `UNIQUE(routine, id)`. |
| A consumer behind for more than 3 days | `gap: true`, then its bootstrap read. |
| More than 3 pages of new issue events or comments within one pass | The cursor isn't reached. The pass sends what it read, logs a gap and records the pass failed with "gap", so the Steward sees it. It can't happen at today's volume, so it fails loudly instead of being handled. |
| A state change that reverses inside one interval (draft → ready → draft) | Not seen. The PR is in the same state as before, and no consumer acts on the round trip. |
| A probe that misses a trigger | Excluded at build time by the one-off verification in §1. If GitHub changes behaviour later, the symptom is a consumer stall that the Steward's existing checks see (`reviewGateStalls`, `mergeDeadlocks`, `stalePrs`). |
| ETags that churn without a content change | Costs 200s and nothing else. The per-caller counter (§8) shows it. |
| GitHub signed out | The reader idles, and each pass is recorded failed "GitHub isn't connected". The merge queue already waits on `connected()`. |
| Event text from strangers | Unchanged rules: `text` is data. Routines get it fenced in `routine_events`, and code services never put it in task text (the Maintainer's tasks name only repo and number). |

## 7. Health signal for the Fleet Steward

The health signal reuses what the Steward already reads: `src_meta.ingest_run`, through apps-mcp `/internal/sources`, into
`fleet-steward/service/src/detector.ts` `source()`.

- **Reader passes.** The reader writes one `ingest_run` per repo every 5 minutes, through github-mcp's `SourceStore.run`
  (same process): source `github_feed`, scope `repo:<owner/name>`, `ok` when any pass in the window completed, otherwise
  the last error, and rows = events sent. Five minutes, not every pass, keeps the table small: `R × 288` rows a day.
- **Staleness.** `detector.ts` `STALE_FOR` gets `github_feed: 15 min`, so with no good pass on any repo for 15 minutes the
  Steward raises it, instead of the 60-minute default. A single repo failing every pass for a day falls under the existing
  `failingScopes`.
- **Delivery lag.** The kernel's `event_readers` gives each subscribed module's last read and how many subscribed events are
  newer than its cursor. A new read, `GET /v1/events/readers`, serves it to the Fleet Steward's module token. A new detector
  check, `feedLag`, raises a module more than 50 events or 10 minutes behind, by name ("code-review hasn't read GitHub
  events for 12 min").

## 8. Rollout

Each step is one PR that switches its consumer and deletes that consumer's poller in the same PR. Nothing runs both ways.
Lane 1 lands first, and lanes 2 to 4 after it, side by side, with ship last because it waits on #1680.

**Lane 1. Kernel, reader and routines.**
- `events.ts`: `data`, `event_log`, `event_readers`, `GET /v1/events/log`, `PUT /v1/events/watch`,
  `GET /v1/events/readers`, and the `resources()` union.
- Compile: `subscribes:` in `module.yaml` → `config/modules.json`, plus its `docs/configuration.md` row.
- `feed.ts` in the github service, the in-process Flow facts hook, and the `merges.step()` nudge.
- A per-caller GitHub call counter in the client, by caller and status, logged hourly. The first day's numbers replace §5's
  estimates.
- The `github_feed` ingest runs, and the Steward's `STALE_FOR` and `feedLag`.
- **Deletes** `flow.ts` `eventsPass` / `eventsRepo` / `sourceEvent` / `issuesRepo` and their state files, and
  `modules/github/test/events-poll.test.ts`. Routines switch here.

**Lane 2. The Maintainer.**
- `subscribes:`, the log read and the handlers.
- **Deletes** the watcher's timer, its cursors, `maintainer_poll_minutes`, and github-mcp's `issuesSince` family.

**Lane 3. Code review.**
- `subscribes:`, the log read, the handlers and the bootstrap.
- **Deletes** the 60 s GitHub tick, `CODE_REVIEW_POLL_SECONDS`, the `cursors` table and `/internal/code-review/comments`.

**Lane 4. Ship.** After #1680 merges.
- `subscribes:`, the log read, the handlers, the per-PR deadlines and the bootstrap.
- **Deletes** the loop timer, the full scan per minute, `PR_EVERY`, and `/internal/ship/flow`.

**End-to-end check per lane, by hand.** A TEST PR on a fleet repo: open, push, red check, green check, comment, label,
close. The consumer must act within about 60 s of each, with no timer of its own left.

## 9. What gets deleted

| Where | What |
| --- | --- |
| `modules/github/service/src/flow.ts` | `sourceEvent`, `EVENT_REPOS`, `eventsPass`, `eventsRepo`, `/cache/events.json`; `issuesRepo`, `/cache/issues.json`; the `issuesRepo` and `eventsPass` calls in `churnPass` |
| `modules/github/test/events-poll.test.ts` | the whole file (its behaviour is the reader's now) |
| `modules/github/module.yaml` | the `events` comment "polled from each subscribed repo's events feed on the code host's churn pass (best-effort…)"; `kinds` grows to §2's list |
| `modules/code-review/service/src/main.ts` | the GitHub `setInterval`, `CODE_REVIEW_POLL_SECONDS`, `wantGithub` |
| `modules/code-review/service/src/engine.ts` | the timer-driven call of `poll(cfg)` (its bodies become the handlers), the `cursors` table |
| `modules/github/connections/github-mcp/src/code-review-read.ts` | the `comments` op |
| `modules/maintainer/service/src/watcher.ts`, `module.yaml` | the `setInterval` / `setTimeout` in the watcher, the three cursors, `maintainer_poll_minutes`, `MAINTAINER_POLL_MINUTES` |
| `modules/github/connections/github-mcp/src/maintainer.ts` | `issuesSince`, `repoSince`, `untriaged`, `recentFeatureRequests` and their route |
| `modules/github/service/src/pr-watch.ts` → `modules/ship/service/src/loop.ts` | the `next()` timer, `EVERY_MS`, `IDLE_MAX_MS`, the per-minute full scan, Flow observation |
| `modules/ship/service/src/contributor.ts` (from #1680) | the hourly `PR_EVERY` gate |
| `modules/github/service/src/ship-routes.ts` (from #1680) | the `flow` route |
| `kernel/src/events.ts` | the comment "GitHub's repo slugs come lower-cased from its poller" (now from the reader) |

**What stays:**
- the merge queue's read of a PR it is merging;
- `src_github` (`sources.ts` `startSync`);
- churn and the one-time backfill (git, not the API);
- every read an event triggers.

## 10. Webhooks, later

**What they would add.** In the `public` and `cloudflare` exposure modes, GitHub could reach a webhook at the
`github` service: `POST /github/webhook`, HMAC-verified with a generated secret.

**One emission path.** A webhook never emits an event itself. It only makes the named repo, and the named head for
`check_run` / `status`, due now. The conditional reads in §1 still produce every event, with the same ids. So there is no
second path, and a lost or forged webhook can at most cause one early read.

**Without them** (`tailscale`, `local`) the reader works exactly as above.

## Open questions for the owner

None of these blocks lane 1. Each is a behaviour or authority call this design can't make alone.

1. **Deadline reads.** Ship keeps a few deadline reads of one object: a wedged check at 3 and 20 minutes, update-branch
   retries, and the 30-minute close of a done task's PR. These are one read of one PR when the deadline passes, not a sweep.
   They sit inside "the only poller left is the merge queue" because they are not timers over repos. If the owner wants
   none at all, those duties have to go.
2. **A 60 s cap even when idle.** It keeps every consumer at least as fast as today, at about 1,100 free conditional
   requests an hour. A 5-minute idle cap would cut that to about 250, but code review and ship would wait up to 5 minutes
   on a quiet repo's first PR.
