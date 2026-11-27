# Flow insights: the timeline and the analytics tabs

Extends [flow.md](flow.md) (facts, stages, idle reasons, `/v1/flow`). The kernel computes everything from facts (generic,
declared journeys) and serves it on `/v1/flow`; the board only draws, with small hand-written SVG components (no chart
dependency); Aiden reads the same endpoint. Nothing is drawn from data the log does not record (no fake zero). DORA's
figures are compared against the instance's own previous period, not tiers. Not built: team rankings, per-person scoring.

## 1. Data capture

The charts are only as true as these facts:

- Code host facts: `pr.pushed {head, before, forced, author}` on `pr:<repo>#<n>`, CI per head on `pr:<repo>#<n>@<head>`,
  `pr.closed {merged: false}`, `pr.opened` and `issue.opened` with `author` and `author_kind` (`agent` = an object
  in AidenHQ's records or marked by its footer or trailer, `owner`, `outside`), `pr.opened` with `title`, `issue.labeled` with `label` and `by`.
- `pr.deployed` is written by the kernel's deploy poller (`kernel/src/generations.ts`), which re-derives missed PRs from
  generations it has not marked.
- One shape: `at` always UTC `Z` (the SDK emitter normalises; `facts.ts` normalises older rows at open), PR and issue
  subjects and `data.pr` / `data.repo` lowercase, `task` always the Paperclip uuid (a writer may name the task by its
  identifier, as a code host's workspace does: `facts.ts` stores the uuid the records know for it, and turned older rows once).
  A PR links to its task through the `record.filed` data `pr: "<repo>#<n>"` the kernel adds for PR, push and merge kinds.

## 2. Journeys (generic)

A journey is an ordered list of phases a module declares in `module.yaml` `journeys:`; the kernel knows none by name
(`kernel/src/journeys.ts`). A phase may name facts of a module that isn't enabled (that phase is then absent); the end names
declared facts. Two ship:

- **`work`** (the `tasks` module): one row per piece of work, from its issue to its deploy. The page's default.
- **`pr`** (the `github` and `codehost-local` modules declare the same one; the compiler checks they agree): one row per PR.

```yaml
journeys:
  - name: work
    label: Work
    subject: task        # one row per root task, its subtasks and their PRs folded in
    phases:
      - { name: triage,  label: Triage,       from: [issue.opened] }
      - { name: queued,  label: Queued,       from: [issue.labeled, task.created] }
      - { name: working, label: Working,      from: [job.started] }
      - { name: review,  label: AI review,    from: [record.filed], where: { kind: [github.pr, github.push, codehost-local.pr, ...] } }
      - { name: open,    label: PR open,      from: [pr.opened] }
      - { name: ci,      label: CI,           from: [pr.checks_started, pr.pushed] }
      - { name: merge,   label: Merge review, from: [record.filed], where: { kind: [github.merge, codehost-local.merge] } }
      - { name: deploy,  label: Deploy,       from: [pr.merged] }
      - { name: finish,  label: Finishing,    from: [pr.deployed] }
    end: [task.status_changed]
    end_where: { to: [done, cancelled] }
  - name: pr
    label: Pull requests
    subject: pr          # one row per pr:<repo>#<n>
    phases: [triage (issue.opened), pickup (issue.labeled, task.created), coding (job.started), review, open, ci, merge, deploy (pr.merged)]
    end: [pr.deployed, pr.closed]
```

Rules:

- **A PR** (`subject: pr`): one item per `pr:<repo>#<n>`, with the facts of its tasks (a `record.filed` whose data names the
  PR, the PR's own task, the records' links) and of the issue a task came from (its source marker ends in `:<owner>/<repo>#<n>`).
- **A piece of work** (`subject: task`): one item per root task, the topmost ancestor the log knows that isn't a chat (an
  issue's task, an owner's request, a routine run). A chat (`chat` on `task.created`, or its newest `task.labeled`) is a
  conversation, not work: it is no item, and each task it delegated is a root. The item holds every descendant's facts, every
  subject they touch (jobs, wakes, records, PRs, the PR a merge record names, the records' links) and the source issue. Facts
  before the root was created count only for its issue (a PR another task opened earlier starts no phase here). Its title is
  the root task's: the board reads it from Paperclip (no fact carries it).
- A phase starts at its first fact after the previous present phase began; a phase with no fact is absent (an owner-authored
  PR starts at `open`; an owner's request with no PR goes queued, working, done). The last phase runs to the end, or now if open.
- **Loops fold into one block.** A fact type repeating later in the current round, or an earlier phase's fact after the round
  saw the phase's own (a refile after a rejection, a push during merge review, a subtask delegated while working), starts a new
  round (shown as rounds, never reorders the bar). A push and the CI run it starts are one round. Phases never go back, so a
  second PR in one piece of work, after the first merged, counts as rounds of the phase the item is in.
- **The end** is the item's own newest `end` fact when it matches `end_where` (a root reopened after done is open again), once
  every merged PR in the item of a repo the log has seen deploy (`pr.deployed`) is deployed: the later of the two. A piece of
  work done while its PR waits for the deploy stays open in Deploy; a PR of a repo that never deploys doesn't hold it. States: a
  PR's `open | merged | closed | deployed`, a piece of work's `open | done | cancelled`.
- Each block carries `idle_s` and its idle reasons from flow.md's reasoner: a slice is idle where the subject waits (its own
  `work.waiting`) or where every one of the item's tasks open then is idle (a parent waiting on its subtask while the subtask
  works is not idle); its reason is the wait's, else the first task's that isn't `delegated` or `blocked`.

## 3. API (`GET /v1/flow`, same auth and roles)

- `?journeys=1`: the declared journeys, a piece of work's first.
- `?journey=<name>&since&to&author=agent,owner,outside&sort=recent|slowest|rounds&limit=1..1000` returns `{ phases, items, truncated }`.
  Each item: `subject, title, task, identifier, url, repo, number, author, author_kind` (a PR's own; null for a piece of work),
  `links: { subject, url }[]` (the PRs and issue it holds), `state, start, end, total_s, blocks: { phase, start, end, rounds,
  idle_s, idle: Record<reason, s> }[]`.
- The summary (`?since&to&by&scope&insights=<journey>`; without `insights`, the first declared journey with items) carries the
  insights over that journey: per phase p50/p85/p95 and weekly series, scatter points, rounds histogram per phase, rejection
  reasons (the reviewer's reason codes), first-pass rate per week, open items with age and current phase, daily count per phase
  (cumulative flow), a funnel (items started, how many had each phase, how many ended delivered), throughput (delivered and
  started per day), cost per delivered item (a PR merged, a piece of work done) by agent and model (failed attempts included)
  and on items closed or cancelled, and DORA's five (deploy frequency, lead time, change fail rate, recovery time, rework rate)
  with weekly series and the previous period. The top bottlenecks are given in words (the phase with the most idle, the most
  rounds, the slowest p85).

## 4. The page (`services/board/web/src/Flow.tsx`)

Tabs: Overview, Timeline, Stages, Rework, Queue, Cost; one period control (7d / 30d / 90d) and one journey picker (Work by
default, Pull requests) in the header for all: every tab draws the picked journey.

- **Timeline (owner spec):** one row per item: a piece of work's identifier, its title and links to its PRs and issue; a PR's
  `#<n>` linking to the PR (title on hover). One bar split into phase blocks (own colour, legend above; hover shows phase,
  duration, rounds and idle share; idle inside a block is hatched), and the total end to end. Every bar is the full width: each
  block is its share of that item's own total (no shared time scale, no log toggle; owner), with a few pixels' minimum so short
  blocks stay hoverable. Items show only the phases they have. Filter chips Agent / Owner / Outside (all on) for items with an
  author (PRs); sort Newest (default) / Slowest / Most rounds. A row opens the item's waterfall. A Bars | Table toggle (Bars
  default, kept in the URL hash): the table has the item, its author kind (PRs) or its PRs and issue (work), one column per phase
  (duration, rounds when more than 1, heat-tinted, "-" when absent) and Total; every header sorts; sticky header and first column.
- **Overview:** DORA tiles with sparkline and change against the previous period; top bottlenecks in words; the funnel;
  throughput per day.
- **Stages:** weekly stacked phase breakdown; p50/p85/p95 per phase; cycle-time scatter (a dot opens the item).
- **Rework:** rounds histogram per phase; first-pass trend; rejection reasons; code churn.
- **Queue:** open items by age and current phase (aging chart, p85 line); cumulative flow; the idle-now list.
- **Cost:** cost per delivered item trend; by agent and by model; spend on attempts that never landed.

Look and feel (owner): polished, professional, on the board's design system (Stripe polish, Linear crispness, more colour,
moderate radius, dense, no pills); checked in a browser at 1512/1920/2560 and mobile, light and dark.

## 5. New installs

A fresh install has no facts: each tab shows "Flow fills in as work happens." An instance without GitHub uses
`codehost-local`, which declares the same `pr` journey; without a code host the `work` journey simply has no PR phases. A
module adding a journey gets a timeline and the insights for free (the picker shows when more than one exists).
