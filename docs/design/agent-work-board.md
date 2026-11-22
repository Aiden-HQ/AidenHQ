# Agent work board (Tasks page, second layout and saved views)

Status: design, owner-approved direction (extend the Tasks page, no separate board). Nothing built.

## Why

Tasks is "my day": the owner's time buckets (Triage, Today, Tomorrow, Later, Backlog). It cannot answer "what is the fleet
doing, what waits on me, what is stuck". The kernel already knows (`kernel/src/task-state.ts`); the board shows it only as
a chip per card. This adds a read-only layout over the same cards, filters, group-by, and saved views.

## Scope

In: a layout switch (My day | Agent work); a filter bar and an optional swimlane group-by; saved views (table in board
SQLite); Paperclip projects as a filterable category; three card additions.

Out, deliberately: custom statuses; table or Gantt layouts; drag between state lanes (state is the kernel's, never set by a
drag); drag inside Agent work (placement stays My day's); server-side filtering or paging; shared or multi-user views;
a project-management UI (create/rename/archive projects in Paperclip's console); per-view notifications.

## The one rule

The board never derives state. A lane is a lookup on the kernel's `reason` and `attention` (below), the same kind of
presentation table as `REASON` in `web/src/ui/TaskState.tsx`. Kind, reason, question and `wait_since` are shown as the
kernel sent them.

## Lanes

`lane(state)` is one function in `web/src/lanes.ts`: owner attention wins, otherwise the reason decides. Owner attention
is `needsOwner(state)` (`web/src/ui/TaskState.tsx`, true for `card_owner`, `owner_wait`, `handback`; it can also sit on a
`job_running` task, which is why it is checked first and matches the kernel's `counts.needs_you`).

| Lane | Reasons (kernel `Reason`) |
| --- | --- |
| Needs you | any state with `attention.who === "owner"` (`card_owner`, `owner_wait`, `handback`, whatever the reason) |
| Working | `job_running` |
| Waiting | `job_queued`, `job_held`, `card_review`, `delegator_wait`, `agent_wait`, `module_wait` |
| Blocked | `blocked`, `failed`, `unpolled`, `orphaned`, `unknown`, `history_expired` |
| Idle | `scheduled`, `backlog`, `owner_task`, `chat_turn`, and a card the kernel has no state for |
| Done (48h) | `closed`, `cancelled` |

All 22 reasons appear exactly once (`closed`, `cancelled`, `job_running`, `job_queued`, `job_held`, `card_review`,
`card_owner`, `owner_wait`, `delegator_wait`, `handback`, `owner_task`, `blocked`, `agent_wait`, `module_wait`, `scheduled`,
`chat_turn`, `backlog`, `failed`, `unpolled`, `orphaned`, `unknown`, `history_expired`). `card_owner`, `owner_wait` and
`handback` are listed under Needs you through their attention. Type-level: `Record<Reason, Lane>` makes a new kernel
reason a compile error, so the table cannot go stale. "Blocked" holds everything an agent must unstick (named blocker,
failed run, nothing will wake it); the card chip says which. "Waiting" is agent or reviewer waits; the chip names the
reviewer or module. Done is not collapsible: it is the board's existing 48-hour window (`RECENT_MS` in `src/app.ts`) and
disappears by itself.

## Data flow

No new data endpoint. `GET /api/board` (`src/app.ts`) already returns every open card with its kernel state: it
collects open tasks (`pc.openIssues()`), then `stateRows(ids)` reads state through `statesOf` (`src/task-state.ts`).
`statesOf` splits ids into batches of `MAX_IDS` (200, the kernel's `/v1/tasks/state?ids=` limit in
`kernel/src/backplane.ts`) and reads them side by side, so any number of tasks gets a state. `GET /api/needs-you` instead
uses `open: true` (`?open=1`, no id limit) because it wants every open task, including agents' sub-tasks the board
folds into parents; Agent work wants cards, so it keeps the board's path.

Changes to `/api/board`:

- `stateRows` is also read for `board.done` (today only open and recurring cards get a state), so Done cards have a lane
  and a grade. Same batching, one more read in parallel.
- Each card gains `projectId` (from `Issue.projectId`, `src/paperclip.ts`) and `cost` (below). The payload gains
  `projects: {id, name}[]` next to `labels`.
- Filtering, grouping and lanes run in the browser over this payload (open tasks plus 48 hours of done: hundreds, not
  thousands). One way: a filter is a pure function in `web/src/filters.ts`; free-text `matches()` in `web/src/util.ts`
  becomes one of its terms.

The page already refreshes on the live events (`web/src/events.ts`), so lanes update without new wiring.

## Filters and group-by

One bar above the lanes (page tools live in the page, `docs/design/board-ui.md`), shown for both layouts:

| Filter | Source on the card |
| --- | --- |
| Agent | `assignee`, or any `crew[].agent` |
| State / reason | the kernel `state.reason` (multi-select by lane, then reason) |
| Label | `labels[].name` |
| Priority | `priority` |
| Project | `projectId` |
| Updated | `activityAt` (today, 7 days, 30 days) |
| Text | existing `matches()` |

Filters AND together; values within one filter OR. Group-by: none (default) or agent. Agent swimlanes group by the
card's `assignee` only, so a card sits in exactly one row; the Agent filter is how you see work an agent has in a
sub-task. The kernel's `holder` is not used: it is an id or key with no name map on the board and can be null.
My day keeps filters but never swimlanes (drag order is per bucket).

## Saved views ("boards")

A view is `{name, layout, filters, groupBy}`. Two built-ins are constants in `web/src/lanes.ts`, never rows, so a fresh
install has them with no setup: **My day** (layout `day`, no filters) and **Agent work** (layout `work`, no filters).
Saved views follow as tabs (`Tabs` from `web/src/ui/Tabs.tsx`; over about six, the rest go in a `Menu`). Editing
filters on any view marks it changed; "Save view" creates one (name required), and on a saved view "Update" overwrites
it and "Delete" removes it. The route carries the view id (`Route` in `web/src/App.tsx` gets an optional view), so Back
and reload keep it.

Table in `services/board/src/store.ts` (same `CREATE TABLE IF NOT EXISTS` block as `placements`):

```
views(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
      spec TEXT NOT NULL,            -- JSON {layout, filters, groupBy}, validated by one zod schema on write
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
```

Single owner now: reads and writes use the signed-in admin's `session.accountId` (the same one `authored` stores), so
each account sees its own views. The extension path is one additive `scope` column (`ALTER TABLE`, the pattern at
`store.ts:180`) that makes a row visible to a workspace; no sharing code now. Unknown filter values in a stored spec
(a label or project since deleted) simply match nothing and show in the bar as removable chips.

API (all behind the board's admin session, like every `/api/*` route):

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/views` | | `{views: [{id, name, spec}]}` for the account |
| `POST /api/views` | `{name, spec}` | the view |
| `PUT /api/views/:id` | `{name?, spec?}` | the view |
| `DELETE /api/views/:id` | | `{ok: true}` |

The list is read with the board (one extra small query), not a separate fetch, so tabs paint with the page.

## Projects

Paperclip issues already carry `projectId`; the board ignores it today. Use it as is:

- Read: `pc.projects()` (new, `GET /api/companies/:id/projects`; probe the live shape before building, as the CLAUDE.md
  rule for vendor APIs says) feeds `projects` in the board payload. A card without a project is "No project".
- Set: by agents, not by UI. `task_create` in `modules/tasks/connections/tasks-mcp/src/tools.ts` takes an optional
  `project` (a name): it resolves to an existing project or creates it, and sets `projectId`. A delegated sub-task
  inherits its parent's project in the same place it inherits priority (`assignTask`). Skills that file work name a project
  when the owner has one (one line in `delegate-work`, not in handbooks).
- The owner says "put these under Launch" to Aiden. There is no create/rename UI on the board; the Paperclip console
  covers rename and archive.
- New installs: no projects, so the Project filter hides itself (empty state: the filter is absent, no empty menu).

## Card additions (both layouts)

- **Needs you line.** When `state.reason === "owner_wait"`, the card shows one line under the title: `needs you:
  <question>` (first line of `state.question`, clipped, already handled by `stateWords`; the card shows it as its own line
  instead of inside the chip). For `card_owner` the chip's existing "your approval: <card sentence>" is shown the same way.
  No new data: the kernel's `question` and `refLabel`.
- **Run trace link.** `#/r/<id>` (`Route` kind `run`) for the task's newest job. The id comes from the kernel activity
  the board already reads once per 3 seconds (`cachedActivity`, `src/runs.ts`: `running` and `recent` jobs carry
  `task`): the card gets `lastRun` for tasks with a job in that window. Older runs are one click away in the drawer
  (`runLinks`). No per-card kernel call.
- **Run cost.** One grouped read of the usage ledger, `store.ledgerBy("issue", ...)`, gives `usd` per issue for all
  cards in a single query (the ledger already stamps calls with `issue_id`); the card shows the task's own spend
  (`$0.42`). Sub-task spend is not summed here; the drawer's feature cost (`/api/issues/:id/feature-cost`) stays the
  place for a total. A task with no billed calls shows nothing.

## UI sketch

```
Tasks   [My day] [Agent work] [Needs review: Aiden] [+ Save view]            search…
Filters: Agent ▾  State ▾  Label ▾  Priority ▾  Project ▾  Updated ▾   Group: none | agent

Needs you (2)        Working (3)         Waiting (4)        Blocked (1)     Idle (6)      Done 48h (9)
┌────────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────┐
│ WOR-7812       │   │ WOR-7790      │   │ WOR-7801     │   │ WOR-7744  │
│ Pick a vendor  │   │ Fix CI flake  │   │ Release 0.9  │   │ Refund API│
│ needs you:     │   │ ● Working     │   │ ● Waiting    │   │ ⚠ failed: │
│  keep v1?      │   │  Engineer     │   │  AI review   │   │  run failed│
│ Aiden · $0.42  │   │ · job running │   │ #/r/j-ab12…  │   │ #/r/j-…   │
└────────────────┘   └───────────────┘   └──────────────┘   └───────────┘
```

With group-by agent, each agent is a row (`StatusDot` + name + count) and the six lanes run across it; empty lanes in a row
collapse to a hairline. Lane headers use the existing `.col-head` style; cards are the existing `CardView`
(`web/src/components.tsx`) without drag handles. Phone: lanes become the same tab strip My day uses on a phone; a
swimlane row collapses into a header with a count. Light/dark and 1512/1920/2560 widths per the design guide.

## Build order (one PR)

1. `lanes.ts`, `filters.ts`, the Agent work layout and filter bar (web only, payload gains `state` on done cards).
2. `views` table, `/api/views`, tabs.
3. `projectId` and `projects` on the payload, `pc.projects()`, tasks-mcp `project` param.
4. Card lines: needs-you, run link, cost.

## New installs

A fresh install sees My day (unchanged), Agent work with empty lanes ("Nothing running yet" `EmptyState`), no saved
views, no Project filter. Nothing depends on an optional module: lanes read kernel state only. Another owner's modules
plug in through the kernel's `Reason`/`stage` vocabulary, not through the board: a module wait already arrives as
`module_wait` with its `ref`, and shows in Waiting with its own words.
