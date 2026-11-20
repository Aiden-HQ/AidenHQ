# Flow insights: the PR timeline and the analytics tabs

Extends [flow.md](flow.md) (facts, stages, idle reasons, `/v1/flow`). The kernel computes everything from facts (generic,
declared journeys) and serves it on `/v1/flow`; the board only draws, with small hand-written SVG components (no chart
dependency); Aiden reads the same endpoint. Nothing is drawn from data the log does not record (no fake zero). DORA's
figures are compared against the instance's own previous period, not tiers. Not built: team rankings, per-person scoring.

## 1. Data capture

The charts are only as true as these facts:

- Code host facts: `pr.pushed {head, before, forced, author}` on `pr:<repo>#<n>`, CI per head on `pr:<repo>#<n>@<head>`,
  `pr.closed {merged: false}`, `pr.opened` and `issue.opened` with `author` and `author_kind` (`agent` = the instance's
  GitHub App bot, `owner`, `outside`), `pr.opened` with `title`, `issue.labeled` with `label` and `by`.
- `pr.deployed` is written by the kernel's deploy poller (`kernel/src/generations.ts`), which re-derives missed PRs from
  generations it has not marked.
- One shape: `at` always UTC `Z` (the SDK emitter normalises; `facts.ts` normalises older rows at open), PR and issue
  subjects and `data.pr` / `data.repo` lowercase, `task` always the Paperclip uuid. A PR links to its task through the
  `record.filed` data `pr: "<repo>#<n>"` the kernel adds for PR, push and merge kinds.

## 2. Journeys (generic)

A journey is an ordered list of phases a module declares in `module.yaml` `journeys:`; the kernel knows none by name
(`kernel/src/journeys.ts`). The `github` and `codehost-local` modules declare the same `pr` journey (the compiler checks they
agree; a phase a host never records is absent):

```yaml
journeys:
  - name: pr
    label: Pull requests
    subject: pr          # one row per pr:<repo>#<n>
    phases:
      - { name: triage, label: Triage,       from: [issue.opened] }
      - { name: pickup, label: Pickup,       from: [issue.labeled, task.created] }
      - { name: coding, label: Coding,       from: [job.started] }
      - { name: review, label: AI review,    from: [record.filed], where: { kind: [github.pr, github.push, codehost-local.pr, ...] } }
      - { name: open,   label: PR open,      from: [pr.opened] }
      - { name: ci,     label: CI,           from: [pr.checks_started, pr.pushed] }
      - { name: merge,  label: Merge review, from: [record.filed], where: { kind: [github.merge, codehost-local.merge, ...] } }
      - { name: deploy, label: Deploy,       from: [pr.merged] }
    end: [pr.deployed, pr.closed]
```

Rules:

- Items are one per subject `<subject>:<key>`, with the facts of its task (a `record.filed` whose data names the subject, or
  the subject's own `task`) and of the issue that task came from (its source marker ends in `:<owner>/<repo>#<n>`).
- A phase starts at its first fact after the previous present phase began; a phase with no fact is absent (an owner-authored
  PR starts at `open`). The last phase runs to the end fact, or now if open.
- **Loops fold into one block.** A fact type repeating later in the current round, or an earlier phase's fact after the round
  saw the phase's own (a refile after a rejection, a push during merge review), starts a new round (shown as rounds, never
  reorders the bar). A push and the CI run it starts are one round.
- Each block carries `idle_s` and its idle reasons from flow.md's reasoner.

## 3. API (`GET /v1/flow`, same auth and roles)

- `?journeys=1`: the declared journeys.
- `?journey=pr&since&to&author=agent,owner,outside&sort=recent|slowest|rounds&limit=1..1000` returns `{ phases, items, truncated }`.
  Each item: `subject, repo, number, url, title, author, author_kind, task, identifier, state (open|merged|closed|deployed),
  start, end, total_s, blocks: { phase, start, end, rounds, idle_s, idle: Record<reason, s> }[]`.
- The summary (`?since&to&by&scope`) also carries the insights: per phase p50/p85/p95 and weekly series, scatter points,
  rounds histogram per phase, rejection reasons (the reviewer's reason codes), first-pass rate per week, open items with age
  and current phase, daily count per phase (cumulative flow), a funnel (issue, PR, CI pass, review pass, merged, deployed),
  cost per merged PR by agent and model (failed attempts included), and DORA's five (deploy frequency, lead time, change
  fail rate, recovery time, rework rate) with weekly series and the previous period. The top bottlenecks are given in words
  (the phase with the most idle, the most rounds, the slowest p85).

## 4. The page (`services/board/web/src/Flow.tsx`)

Tabs: Overview, PRs, Stages, Rework, Queue, Cost; one period control (7d / 30d / 90d) for all.

- **PRs (owner spec):** one row per PR: `#<n>` linking to the PR (title on hover), one bar split into phase blocks (own colour,
  legend above; hover shows phase, duration, rounds and idle share; idle inside a block is hatched), and the total end to end.
  Every bar is the full width: each block is its share of that PR's own total (no shared time scale, no log toggle; owner),
  with a few pixels' minimum so short blocks stay hoverable. PRs show only the phases they have. Filter chips Agent / Owner /
  Outside (all on); sort Newest merged (default) / Slowest / Most rounds. A row opens the item's waterfall. A Bars | Table
  toggle (Bars default, kept in the URL hash): the table has PR number, author kind, one column per phase (duration, rounds
  when more than 1, heat-tinted, "-" when absent) and Total; every header sorts; sticky header and first column.
- **Overview:** DORA tiles with sparkline and change against the previous period; top bottlenecks in words; throughput per day.
- **Stages:** weekly stacked phase breakdown; p50/p85/p95 per phase; cycle-time scatter (a dot opens the PR).
- **Rework:** rounds histogram per phase; first-pass trend; rejection reasons; code churn.
- **Queue:** open items by age and current phase (aging chart, p85 line); cumulative flow; the idle-now list.
- **Cost:** cost per merged PR trend; by agent and by model; spend on attempts that never merged.

Look and feel (owner): polished, professional, on the board's design system (Stripe polish, Linear crispness, more colour,
moderate radius, dense, no pills); checked in a browser at 1512/1920/2560 and mobile, light and dark.

## 5. New installs

A fresh install has no facts: each tab shows "Flow fills in as work happens." An instance without GitHub uses
`codehost-local`, which declares the same `pr` journey. A module adding a journey gets a list like PRs for free (the tab
picks the journey when more than one exists).
