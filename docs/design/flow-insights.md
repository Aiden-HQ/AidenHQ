# Flow insights: the PR timeline and the analytics tabs

Extends [flow.md](flow.md) (facts, stages, idle reasons, `/v1/flow`). Owner, 2026-11-19: the first Flow page "is so basic,
doesn't give any useful insights"; he wants extensive visual tools to find bottlenecks, starting with a per-PR timeline.

## Why

To see where time goes between an issue and its deploy, per item and in aggregate, and so fix the system. Real data
(11-16..11-19) already shows the case: the AI reviewer rejected 245 of 507 agent pr/push filings and half of agent tasks
had at least one rejection, while CI is ~2 min and merge to deploy ~14 min (median). The first page hid this.

## Goals, non-goals

- Goals: a PR timeline list (owner spec below); tabs of charts the market converges on (research: LinearB, Swarmia,
  GitLab VSA, DevLake, DORA guidance, Flow Framework); data capture complete enough to draw them truthfully; Aiden reads
  the same numbers.
- Non-goals: team rankings, per-person scoring, SPACE surveys, tier badges as truth (DORA 2025 dropped the tiers; we
  compare against our own previous period).
- Anti-goals: a chart from data we don't record (a fake zero); a second analytics system next to `/v1/flow`.

## Approaches

- **A (picked):** the kernel computes everything from facts (generic, declared journeys) and serves it on `/v1/flow`;
  the board only draws, with small hand-written SVG components (no chart dependency). Aiden reads the same endpoint.
- B: the board computes from raw facts. Rejected: Aiden couldn't read it; logic in two places.
- C: Grafana / Apache DevLake. Rejected: an extra service and a second way to do it; no agent facts.

## 1. Data capture fixes (first; the charts are only as true as these)

Found in the live data (`docs` of the analysis are in this PR's description):

1. `pr.deployed` stopped on 11-18 02:28 (1 of 344 PRs merged since has one). Find the bug in the deploy poller
   (`kernel/src/generations.ts`) and fix it; the poller re-derives missed PRs from generations it hasn't marked.
2. Pushes are invisible: every PR has one head and one CI run. New codehost facts `pr.pushed {head, before, forced,
   author}` [`pr:<repo>#<n>`] live, and in the backfill from the timeline API (`committed`, `head_ref_force_pushed`);
   CI facts per head (`pr:<repo>#<n>@<head>`) in the backfill too (check suites per head).
3. `pr.closed {merged: false}` when a PR closes unmerged.
4. Authorship: `pr.opened` and `issue.opened` gain `author` (login) and `author_kind`: `agent` (the instance's GitHub App
   bot), `owner` (a login of an instance admin; the GitHub connection's signed-in account), `outside` (anyone else).
   `pr.opened` gains `title`. `issue.labeled` records every label with `label` and `by`.
5. `grade.*` and `check.ended` have zero rows: find why the writers never fire and fix them.
6. One shape: `at` always UTC `Z` (the SDK emitter normalises; one migration rewrites existing rows), repo lowercased
   in subjects, `task` always the Paperclip uuid (records already carry it; a PR links to its task through the
   `record.filed` data `pr: "<repo>#<n>"` the kernel adds for PR, push and merge kinds).

## 2. Journeys (the PR timeline's model, generic)

A journey is an ordered list of phases a module declares in `module.yaml` `journeys:`; the kernel knows none by name.

```yaml
journeys:
  - name: pr
    label: Pull requests
    subject: pr          # one row per pr:<repo>#<n>
    phases:              # in order; each starts at the first of its facts after the previous phase began
      - { name: triage,  label: Triage,       from: [issue.opened] }
      - { name: pickup,  label: Pickup,       from: [issue.labeled, task.created] }
      - { name: coding,  label: Coding,       from: [job.started] }
      - { name: review,  label: AI review,    from: [record.filed], where: { kind: [pr, push] } }
      - { name: open,    label: PR open,      from: [pr.opened] }
      - { name: ci,      label: CI,           from: [pr.checks_started, pr.pushed] }
      - { name: merge,   label: Merge review, from: [record.filed], where: { kind: [merge] } }
      - { name: deploy,  label: Deploy,       from: [pr.merged] }
    end: [pr.deployed, pr.closed]
```

(The `where.kind` names map to the real record kinds; the builder writes the exact ones.) Rules:

- A phase spans from its first fact to the next present phase's first fact; the last to the end fact, or now if open.
- **Loops fold into one block.** Every further `from` fact inside a phase's span is a **round** (refile after a
  rejection, a push that reruns CI, a rebase). A fact for an earlier phase after a later one began (a push after merge
  review started) counts as a round of the current phase, never reorders the bar.
- A phase with no fact is absent: an owner-authored PR starts at `open`. Facts reach the journey through the PR subject,
  its task (records, jobs, wakes) and the issue that task came from.
- Each block carries `idle_s` and its idle reasons from flow.md's reasoner (owner, capacity, reviewer, ...).

## 3. API (`GET /v1/flow`, same auth and roles)

- `?journey=pr&since&to&author=agent|owner|outside&sort=recent|slowest|rounds&limit` → `{ phases: {name,label}[],
  items: { subject, repo, number, url, title, author, author_kind, task, identifier, state: open|merged|closed|deployed,
  start, end, total_s, blocks: { phase, start, end, rounds, idle_s, idle: Record<reason, s> }[] }[], truncated }`.
- The summary (`?since&to&by&scope`) grows: per-phase p50/p85/p95 and weekly series; scatter points (end, total_s,
  subject); rounds histogram per phase; rejection reasons (reviewer `reason_code` counts); first-pass rate per week;
  open items with age and current phase (WIP aging); daily count per phase (cumulative flow); a funnel (issue → PR → CI
  pass → review pass → merged → deployed); cost per merged PR by agent and model (failed attempts included); DORA's five
  (deploy frequency, lead time, change fail rate, recovery time, rework rate) with weekly series and the previous
  period for comparison.

## 4. The page (owner picks: tabs; all PRs with an author filter; newest merged first)

Tabs: **Overview · PRs · Stages · Rework · Queue · Cost**, one period control (7d / 30d / 90d) for all.

- **PRs (owner spec):** one row per PR. Left: `#<n>` linking to the PR, title on hover. Middle: one bar split into
  phase blocks, each its own colour with a legend above; hover a block → phase name, its duration, rounds (↻3) and
  idle share. Idle inside a block is hatched. Right: total end to end. PRs show only the phases they have. Filter chips
  Agent / Owner / Outside (all on); sort Newest merged (default) / Slowest / Most rounds. Every bar is the full width:
  each block is its share of that PR's own total time (owner, 2026-11-19; no shared time scale, no log toggle), with a
  few pixels' minimum so short blocks stay hoverable; the total on the right carries the absolute time. A row opens the
  item's waterfall (flow.md). A view toggle Bars | Table (Bars default, kept in the URL hash): the table has one row per
  PR, columns PR # (title on hover), author kind, one per journey phase (duration, ↻n when rounds > 1, tinted by a
  per-column heat scale so slow cells stand out, "—" when absent) and Total; every header sorts; sticky header and first
  column, scrolling sideways on narrow screens. Both views share the filters and the row click.
- **Overview:** DORA five tiles with sparkline and change vs previous period; the top three bottlenecks in words (the
  phase with the most total idle, the highest rounds, the slowest p85); throughput per day.
- **Stages:** weekly stacked phase breakdown; p50/p85/p95 per phase; cycle-time scatter with percentile lines (a dot
  opens the PR).
- **Rework:** rounds histogram per phase; first-pass trend; rejection reasons; code churn (flow.md).
- **Queue:** open items by age and current phase (aging chart, p85 line); cumulative flow; the idle-now list.
- **Cost:** cost per merged PR trend; by agent and by model; spend on attempts that never merged.

Look and feel (owner): polished, professional, UX-focused; built with the frontend-design skill on the board's design
system (Stripe polish, Linear crispness, more colour; moderate radius, dense, no pills). Checked in a browser at
1512/1920/2560 and mobile, light and dark, before merge.

## 5. New installs

A fresh install has no facts: each tab shows "Flow fills in as work happens." An instance without GitHub uses
codehost-local, which declares the same `pr` journey with its own facts. A module adding a journey gets a list like PRs
for free (tab picks the journey when more than one exists).

## Left to the builder

Exact record kinds in `where`, chart component internals, colours (from the design system tokens), the backfill paging
for pushes within GitHub's API budget (stop under 400 remaining, as today).
