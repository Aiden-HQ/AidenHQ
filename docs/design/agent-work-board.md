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

The board never derives state. A lane is a lookup on the kernel's `attention`, `reason` and `kind`; kind, reason, question
and `wait_since` are shown as the kernel sent them. A card the kernel has no state for is shown in Idle with a quiet
"No reported state" line, never a guessed one.

## Lanes

`lane(state)` is one function in `web/src/lanes.ts`, four steps in this order, so every state lands in exactly one lane:

1. Owner attention (`needsOwner`, `web/src/ui/TaskState.tsx`: `attention.who === "owner"`) is **Needs you**. It is checked
   first because a running task can carry an owner question, and it matches the kernel's `counts.needs_you`.
2. **Blocked**: reason `blocked` or `failed`, or an agent-attention `why` of `stalled_wait`, `unpolled`, `orphaned`, `unknown`
   or `history_expired` (the kernel raises these only after a 15-minute grace, so a fresh quiet task is not Blocked).
3. **Idle**: `kind` is `idle`, or the reason is `scheduled`, `backlog`, `owner_task` or `chat_turn` (the kernel gives these
   four `kind: "waiting"`, so they are listed explicitly).
4. Otherwise by `kind`: `working` is **Working**, `waiting` is **Waiting** (`job_queued`, `job_held`, `card_review`,
   `delegator_wait`, `agent_wait`, `module_wait`), `done` is **Done** (`closed`, `cancelled`). A reason the kernel adds later
   lands by its kind.

The State filter, its counts and the lane use this one function, so a card shown in a lane always matches that lane's filter.

Every one of the 22 `Reason`s: `card_owner`, `owner_wait`, `handback` (owner attention) go to Needs you; `blocked`, `failed`,
`unpolled`, `orphaned`, `unknown`, `history_expired` to Blocked once flagged (Idle during the grace); `job_running` to Working; `job_queued`, `job_held`,
`card_review`, `delegator_wait`, `agent_wait`, `module_wait` to Waiting; `scheduled`, `backlog`, `owner_task`, `chat_turn`
to Idle; `closed`, `cancelled` to Done. A stalled `module_wait` goes to Blocked. The web's `Reason` union is a copy of the kernel's (`web/src/types.ts`, "change them together"), so the
kind fallback, not a type check, is what keeps new reasons safe.
Done is the board's existing 48-hour window (`RECENT_MS`, `src/app.ts`) and disappears by itself; a task the owner settled
stays off, as everywhere. Lane counts are the length of the rendered, filtered lane, labelled as cards (not the kernel's
fleet counts, which include sub-tasks); the Attention strip above Tasks (`web/src/Attention.tsx`, fed by `/api/needs-you`)
stays the fleet-wide source for "what needs me" and is labelled "Fleet attention" (the lane count reads "matching cards").

Known limit: agents' sub-tasks fold into their parent's card (`foldedChildren`, `src/board.ts`) and the kernel never makes a
parent wait for its children, so a parent can sit in Working or Idle while a child waits on the owner. The card's crew line
shows the child's state and the Attention strip lists it; the lane stays the parent's own. Paperclip's list caps (500 open,
100 recently closed, `src/paperclip.ts`) bound the board the same way they bound My day.

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
- Each card gains `projectId` (from `Issue.projectId`, `src/paperclip.ts`) and `lastRun` (below). The payload gains
  `projects: {id, name}[]` next to `labels`.
- Filtering, grouping and lanes run in the browser over this payload (open tasks plus 48 hours of done: hundreds, not
  thousands). One way: a filter is a pure function in `web/src/filters.ts`; free-text `matches()` in `web/src/util.ts`
  becomes one of its terms.

Freshness is the board's own: `App.tsx` reloads `/api/board` about every ten seconds while Tasks is visible and on
focus, so lanes are a snapshot of the latest successful response, never of the drag-held My day copy. Agent work renders
straight from that response (no second store), so a lane, its count and a card's chip can never disagree.

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

Paperclip issues already carry `projectId`; the board ignores it today. Use it as is, in a second step (the kernel proxy must
learn projects first):

- Read: `pc.projects()` (new, `GET /api/companies/:id/projects`; probe the live shape before building) feeds `projects` in
  the board payload. The kernel's board read paths (`BOARD_READ_PATHS`, `kernel/src/cp.ts`) get the projects route. A card
  without a project is "No project".
- Set: by agents, not UI. `kernel/src/cp.ts` today allows neither a projects route nor `projectId` in `CREATE`/`PATCH`; add
  `projectId` to both lists and the agent read path. Then `task_create` and `task_update`
  (`modules/tasks/connections/tasks-mcp/src/tools.ts`) take an optional `project` name, resolved to an existing project, and
  a delegated sub-task inherits its parent's project where it inherits priority (`assignTask`). One line in the
  `delegate-work` skill, not in handbooks. Creating a project by name stays an owner or Paperclip action; an unknown name is an
  error that lists the projects, so agents never fan out near-duplicates.
- The owner says "put these under Launch" to Aiden. No create/rename UI on the board.
- New installs: no projects, so the Project filter is absent (no empty menu). Until this step ships, labels carry the same
  filter.

## Card additions (both layouts)

- **Needs you line.** For any state with owner attention the card shows a callout under the title, resolved from each
  `attention` entry (`why`, `ref`), not from the primary reason (a running job can hold an approval): the first line of
  `state.question` for `owner_wait`, "Your approval: <card sentence>" for a `card` entry (`shown()` today attaches the sentence only
  when the card is the primary reason; resolve it from the entry's `ref` the same way), "Handed to you" for `handback`.
- **Run trace link.** `#/r/<id>` (Route kind `run`) for the task's newest job, from the kernel activity the board already
  reads (`cachedActivity`, `src/runs.ts`: running and recent jobs carry `task`) as `lastRun`. A task with no job in that
  window has no link; older runs stay in the drawer (`runLinks`). No per-card kernel call.
- **Run cost is not on the card.** `ledgerBy("issue")` (`src/store.ts`) ranks and caps its groups (default 5000, ordered by
  spend), so an absent card would wrongly read as "no spend", and sub-task spend would be missing. Cost stays in the drawer's
  feature cost (`/api/issues/:id/feature-cost`), which is exact.

## UX

The reference is `agent-work-board.html` with screenshots `agent-work-board-1512.png`, `-1920.png`, `-full-1512.png` (every
state below), `-mobile.png`, `-mobile-working.png`. The mockup links the board's real `tokens.css` and `ui.css`, so colour,
radius and type are the shipped ones. Builders get these files; the rules below are what the screenshots do. Taste is
`docs/design/board-ui.md`: Stripe polish, Linear crispness, more colour; radius 5/8/10/14 and never a pill; dense; fluid.

```
Tasks   [My day|Agent work]  All agents  Needs review  Launch  + Save board          ⌕ Filter tasks  /
        Agent: Engineer ✕  Project: Launch ✕  + Filter  Clear all        Group by [None|Agent]  Update board
 ┌ Needs you 2 ┐ ┌ Working 3 ┐ ┌ Waiting 3 ┐ ┌ Blocked 2 ┐ ┌ Idle 3 ┐ ┌ Done, last 48h 3 ┐
```

**Layout switch.** The layout and the saved filters have separate jobs: the `Segmented` picks how tasks are drawn; the tabs next to it are saved
filters only (no built-in tab, "Update board" appears only on a saved one; the unsaved default is "All"). A `Segmented` (`My day | Agent work`) at the left of the page-tools row, not a tab: it changes how the
same tasks are drawn, while the board tabs next to it are saved filters. The choice is remembered per board (stored in the
board's spec; built-ins keep it in `localStorage`). My day is untouched, including drag.

**Lanes.** Six columns share the whole width (the My day `.column` rule: `flex: 1 1 0`, no narrow strip on a big screen);
Idle and Done run a little narrower because they are the quiet ones. Lane header: a dot in the lane's colour (Needs you amber
`--warn`, Working green `--working`, Waiting `--accent`, Blocked `--urgent`, Idle `--later`, Done a hollow ring, all from
`tokens.css`) and a card count; the Needs you column carries a faint amber wash so the eye lands there first. Below 1400px
wide the row scrolls horizontally with the lane header sticky; it never wraps to a second row.

**Card anatomy** (the existing `.card` surface, 10px radius, priority stripe on the left edge from `prio-*`). Top to bottom:
identifier (tabular, faint) and project name in its hue at the right; title (13.5px/560, two lines, ellipsis, wraps any
unbroken string); then the one line that matters for its lane; then a footer: agent monogram (`avatar.ts` tones) and name,
spend is not shown, age, run link (the arrow, labelled "Open the run trace"). The lane line is:

| Lane | Line under the title |
| --- | --- |
| Needs you | amber callout "Needs you" with the question (3 lines), the approval sentence, or "Handed to you" |
| Working | green breathing dot and the live step (what the agent last said, two lines); the footer age becomes elapsed time |
| Waiting | blue dot and the kernel's words (`stateWords`: "AI review: reviewer is reading the diff", "CI checks") |
| Blocked | red callout "Failed" with how the job ended, or "Blocked by WOR-7744" with its `refLabel` |
| Idle | grey dot and why ("Backlog", "Scheduled for tomorrow 08:00", "Your task", "No reported state") |
| Done | quiet title, "Done, graded pass" or "Stopped" |

Crew: a card with other agents on it shows "+1" after the name; hover lists them (`crewLine`). One card, one accent: the
callout colour is the only saturated area on a card, so a column scans by colour.

**Filter bar.** Always visible under the layout row. `+ Filter` opens a menu of the six filters (Agent, State, Label,
Priority, Project, Updated) with a type-to-find field; picking one opens its value list (multi-select with counts, agent
rows with monograms). A chosen filter is one chip: `name | values | ✕`; ✕ removes it, "Clear all" appears with two or more.
A value that no longer exists (a deleted label) stays as a struck-through chip and matches nothing. Text search is the
field at the right (`/` focuses it). Filters apply to both layouts. On My day a filter hides the carried-over bulk action (it moves every carried task, not the
visible ones), and the page's keyboard handlers (`App.tsx`: `r` toggles Recurring) are scoped by layout, so the new keys exist only
in Agent work. Group by is a `Segmented` (`None | Agent`), shown only in
Agent work.

**Group by agent.** Each agent is a row on a `--col` surface: collapse chevron, monogram, name, and per-lane counts as
coloured dots. The six lanes run across it as a grid (equal columns); a lane with nothing in it shrinks to a hairline, so a
quiet agent costs one thin line. Rows sort by most owner attention, then most working. Collapsed state is remembered per
board.

**Saved boards.** Tabs after the layout switch (`All agents` is the built-in, then saved ones), the selected tab on
`--accent-soft`. Editing any filter puts a dot on the tab and shows "Update board" (and "Save as new" in its menu).
`+ Save board` opens a small `Dialog` with a name field and a primary "Save board". Rename, Duplicate and Delete are in a
`Menu` on the selected tab (also right-click); Delete confirms in a `Dialog` ("Delete 'Launch'? The tasks stay.").
Over six boards the rest sit behind a "More" `Menu`.

**Empty, loading, errors.** On phone the first lane shown is the first populated one, and a "Filters (3)" button replaces the chip row
(chips open in a sheet, with Clear and Update board). Loading: lane headers draw at once, cards are skeletons (`Skeleton.tsx`), never a spinner. Filters
match nothing: "No tasks match these filters" with a "Clear all" button. Nothing running (fresh install): "Nothing is
running yet. Ask Aiden to take a task and it shows up here, lane by lane." A lane with nothing: a dashed box, "No tasks in <lane>". A failed read keeps the last good board and shows the existing offline `Banner`.

**Long and busy.** Titles clamp to two lines and wrap long unbroken strings. A lane scrolls inside itself (max-height from the
viewport) and renders 25 cards, then "Show 38 more"; header counts always show the true number.

**Phone (390px).** The bottom bar is unchanged; lanes become a scrolling strip of lane buttons (dot, name, count) above a
single full-width lane, the lane header dropped because the strip names it. The layout switch and board tabs sit in two rows,
the search field takes a row, and the chips scroll in one row. Swimlanes are off on a phone (the Group by control is
hidden). Tap targets are 36px or more; inputs are 16px.

**Keyboard.** `/` filter field, `f` add a filter, `g d` My day, `g w` Agent work, `[` `]` previous or next board, `j` `k`
between cards, `Enter` opens the task, `r` its latest run. ⌘K (`Palette`) gains "Agent work", every saved board by name, and
"Save board" from cached data only. Every control is a real button or link with `--ring` focus; state is a word as well as a
colour; the live dot is a small breathing dot only and stops under reduced motion.

## Build order (one PR)

1. `lanes.ts`, `filters.ts`, the Agent work layout and filter bar (web only, payload gains `state` on done cards).
2. `views` table, `/api/views`, tabs.
3. Projects: kernel `cp.ts` routes and fields, `pc.projects()`, `projectId`/`projects` on the payload, tasks-mcp `project`.
4. Card lines: needs-you callout, run link.
5. Swimlanes (last, and the first thing to cut if the build runs long: lanes and filters are the core).

## New installs

A fresh install sees My day (unchanged), Agent work with empty lanes ("Nothing running yet" `EmptyState`), no saved
views, no Project filter. Nothing depends on an optional module: lanes read kernel state only. Another owner's modules
plug in through the kernel's `Reason`/`stage` vocabulary, not through the board: a module wait already arrives as
`module_wait` with its `ref`, and shows in Waiting with its own words.
