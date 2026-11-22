# Agent work board (Tasks page, second layout and saved views)

Status: design, owner-approved direction (extend the Tasks page, no separate board). Nothing built.

## Why

Tasks is "my day": the owner's time buckets (Triage, Today, Tomorrow, Later, Backlog). It cannot answer "what is the fleet
doing, what waits on me, what is stuck". The kernel already knows (`kernel/src/task-state.ts`); the board shows it only as a
chip per card. This adds a read-only layout over the same tasks, with filters, group-by, and saved views.

## Scope

In: a layout switch (My day | Agent work); a filter bar and optional agent swimlanes; saved views (one table in board
SQLite); Paperclip projects as a read-only filter; two card additions.

Out, deliberately: custom statuses; table or Gantt layouts; drag between state lanes (state is the kernel's); drag or
mutation shortcuts in Agent work; server-side filtering; shared or multi-user views; any project UI; agent project assignment
and inheritance (follow-up, below); a new keyboard suite; per-view notifications; run cost on the card (drawer only).

## The one rule

The board never derives state. The kernel emits the lane; the board renders it.

## Lanes (emitted by the kernel)

`kernel/src/task-state.ts` gains one field on `TaskState`, `lane: "needs_you" | "working" | "waiting" | "blocked" | "idle" |
"done"`, set once in the reducer from all of a task's obligations (`open`, `attention`, `fail`), so no client re-derives it
from the primary `reason` (which a running job or a higher-ranked wait can mask). Precedence, first match wins:

1. `kind` done: **done** (`closed`, `cancelled`).
2. any `attention.who === "owner"`: **needs_you** (`card_owner`, `owner_wait`, `handback`; a running task can carry one).
3. a running job: **working** (`job_running`).
4. any open `blocked` obligation or a `fail` (tested over all obligations, not the primary reason, which `job_queued` or another wait can outrank), or agent attention `stalled_wait`, `unpolled`, `orphaned`, `unknown`, `history_expired`
   (the kernel raises each after its own grace: 15 minutes, six hours for a module wait, none for expired history): **blocked**.
5. reason `scheduled`, `backlog`, `owner_task`, `chat_turn`, or `kind` idle: **idle** (the first four are `kind: "waiting"`).
6. otherwise **waiting** (`job_queued`, `job_held`, `card_review`, `delegator_wait`, `agent_wait`, `module_wait`).

All 22 reasons land in exactly one lane. `lane` is part of the shared wire type: the board's copy (`services/board/src/task-state.ts`,
`web/src/types.ts`, "change them together") gains it, and the filter, the lane, the swimlane and every count read it. A task with no
kernel row shows in Idle with "No reported state". `web/src/lanes.ts` does not exist.

## Data flow

One kernel snapshot per board response. Today `statesOf` (`src/task-state.ts`) merges independent 200-id reads, each its own
transaction and `as_of`. Extend the kernel's bulk read (`kernel/src/task-state-read.ts`, route `/v1/tasks/state` in
`kernel/src/backplane.ts`) with `closed_since=<iso>`: `?open=1&closed_since=` returns every open task plus tasks closed after that
instant in one transaction, one `as_of`, no id limit (the 200-id limit stays for `ids=` callers). `/api/board` carries `as_of`.
The kernel row alone decides lane membership and Done expiry: a task is in Done for 48 hours after its close fact, by kernel
time, so an old task edited later cannot reappear. Paperclip supplies title, labels, priority, assignee, project.

Both layouts are built from one issue inventory (`inventory()` in `src/app.ts`: open + recently closed issues, the kernel snapshot,
labels, agents), built before My day's own filters (`mine()` drops unassigned issues, `unsettled()` hides settled ones); each layout applies its visibility rules to its projection, and Agent work excludes only the brief and settings tasks (`isBrief`, `isSettings`). My day folds agents' sub-tasks into the parent card (`foldedChildren`, `src/crew.ts`) as today. Agent work does
not fold: every issue is its own card, placed once under its assignee, with a "part of WOR-7790" parent link (kernel state of its
own, so a child waiting on the owner shows in Needs you). The crew line on My day cards reads the child's kernel state, never
unread activity alone (`crew.ts` `issueState` today can say "needs" from unread activity).

Bounds: Paperclip list reads cap at 500 open and 100 closed (`src/paperclip.ts`). The inventory pages them (offset until a short
page, hard limit 2000) and sets `incomplete: true` if a bound is hit; the page then shows "Showing the newest 2,000 tasks" in a
`Banner`. Closed issues are hydrated by id from the kernel's recent-close ids (not listed by `updatedSince`, which cannot order by close time). "No reported state" applies to open issues only.

On failure the page keeps the last good snapshot and shows its age ("As of 10:42, 3 min ago") with the existing offline banner. The
page reloads about every ten seconds while visible (`App.tsx`), so lanes are the latest successful response, never My day's
drag-held copy. Filtering and grouping run in the browser (`web/src/filters.ts`, a pure function; `matches()` in `web/src/util.ts` is
its text term). Counts are the lengths of the rendered, filtered arrays, labelled "matching cards". The Attention strip
(`web/src/Attention.tsx`, `/api/needs-you`) stays the fleet-wide "what needs me", labelled "Fleet attention".

Read-only is structural. `GET /api/board` today writes: `closeLeftoverParts` (`src/app.ts`) closes crew parts via
`pc.updateIssue` on every refresh. It moves, with `store.unsettle()` and `store.placeNew()` (also called from that handler), into one sweep run by the live watch
(`src/watch.ts`) and once at start-up as catch-up (the watch restarts its cursor near now), so a GET never mutates. My day's drag, move and complete handlers and keyboard actions (`App.tsx`: `r` toggles Recurring, keys move or close the
selected card) are scoped to My day; Agent work binds none. A filtered My day hides the carried-over bulk action (it moves every
carried task, not the visible ones).

## Filters and group-by

One bar above the lanes, in both layouts (page tools live in the page, `docs/design/board-ui.md`).

| Filter | Source (stable ids, names resolved from catalogs) |
| --- | --- |
| Agent | assignee (agent id); the Agent filter also matches a card's crew |
| State | the six lanes (no nested reasons; the reason shows on the card) |
| Label | `labelIds` (carried through `toCard`, which strips them today) |
| Priority | `priority` |
| Project | `projectId` (read-only, below) |
| Updated | `lastActivityAt` (today, 7 days, 30 days) |
| Text | `matches()` |

Filters AND; values within one filter OR. Group by: none, or agent (Agent work only). Each issue sits once under its assignee;
rows are the agents plus **You** and **Unassigned**, sorted by most owner attention then most working. A saved id that no longer
exists (a deleted label) stays as a removable struck-through chip and matches nothing; a failed catalog read shows the filter as
"unavailable", never as "No project" (that means `projectId` null).

## Saved views

A view is `{name, spec: {layout, filters, groupBy}}`; the layout switch is separate and lives in the spec. The unsaved default
is "All tasks", the first tab (no row; it cannot be renamed or deleted). Edits are a draft until "Save"; the draft survives a conflict.

```
views(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
      spec TEXT NOT NULL,       -- JSON, one zod schema used on read and on write (ids, not names)
      rev INTEGER NOT NULL,     -- bumped on every write
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
```

Beside `placements` in `src/store.ts` (`CREATE TABLE IF NOT EXISTS`). Single owner now: rows are scoped to the session's
`accountId` (as `authored`); the extension path is one additive `scope` column (`ALTER TABLE`, pattern at `store.ts:180`).

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/views` | | `{views: [{id, name, spec, rev}]}` for the account |
| `POST /api/views` | `{name, spec}` | the view |
| `PUT /api/views/:id` | `{name?, spec?, rev}` | the view, or 409 |
| `DELETE /api/views/:id?rev=` | | `{ok: true}`, or 409 |

Update and delete are one SQL statement `WHERE account_id = ? AND id = ? AND rev = ?`; no row changed is a 409, the page keeps
the draft and reloads the saved row; if the row is gone (deleted elsewhere) the page offers "Save as new". Tabs render only after the session is confirmed (the board cache can paint before that,
`App.tsx`). The route is `#/board?view=<id>`, parsed explicitly in `Route`; an unknown id falls back to All tasks with a toast.

## Projects (read-only filter now)

Paperclip issues carry `projectId`; pass it through on the card. A company project catalog read goes through the kernel: add the
projects route to `BOARD_READ_PATHS` (`kernel/src/cp.ts`), `pc.projects()` in `src/paperclip.ts`, `projects: {id, name}[]` in
the payload. Probe the deployed response before enabling the filter. New installs: no projects, so the Project filter is absent.
Follow-up (not in this build): agents assign projects. It touches the `task_create`/`task_update` schemas
(`modules/tasks/connections/tasks-mcp/src/tools.ts`), `CREATE`/`PATCH` in `cp.ts`, and the Paperclip plugin's validators
(`services/paperclip-events/post.js`); until then projects are set in Paperclip's console and labels carry the same filter.

## Card additions (both layouts)

- **What the card is waiting on, with a link to it.** For each `attention` entry the callout reads its `why`/`ref`, not the primary
  reason: the question for `owner_wait` (opens the task's answer form), "Your approval: <sentence>" for a card (opens the
  approval, `ref` `k-…`), "Blocked by WOR-7744" (opens that task, `task:` ref), "Failed: how the job ended" (opens the run,
  `job:` ref, `#/r/<id>`). `shown()` (`src/task-state.ts`) attaches the card sentence only for a primary-reason card; it resolves
  from the entry's ref instead. The footer's arrow opens the run for the task's job ref.
- **Working cards** show the kernel's `stage` (the module's label) and elapsed time from `since`; a live "what the agent said" line is not
  in the state read (the activity feed caps at 50 running and 200 recent jobs and omits progress), so it is shown only on the run page.

## UX

The reference is `agent-work-board.html` with screenshots `agent-work-board-1512.png`, `-1920.png`, `-full-1512.png` (every
state below), `-mobile.png`, `-mobile-working.png`. The mockup links the board's real `tokens.css` and `ui.css`, so colour,
radius and type are the shipped ones. Builders get these files; the rules below are what the screenshots do. Taste is
`docs/design/board-ui.md`: Stripe polish, Linear crispness, more colour; radius 5/8/10/14 and never a pill; dense; fluid.

```
Tasks   [My day|Agent work]  All tasks  Needs review  Engineering●  + Save board     As of 10:42  ⌕ Filter  /
        Agent: Engineer ✕  Updated: 7 days ✕  + Filter  Clear all        Group by [None|Agent]  Update board
 ┌ Needs you 2 ┐ ┌ Working 3 ┐ ┌ Waiting 3 ┐ ┌ Blocked 2 ┐ ┌ Idle 3 ┐ ┌ Done, last 48h 3 ┐
```

**Layout switch.** The layout and the saved filters have separate jobs: the `Segmented` picks how tasks are drawn; the tabs next to it are saved
filters only (no built-in tab, "Update board" appears only on a saved one; the unsaved default is "All"). A `Segmented` (`My day | Agent work`) at the left of the page-tools row, not a tab: it changes how the
same tasks are drawn, while the board tabs next to it are saved filters. The choice is part of a saved board's spec; the unsaved default remembers it in `localStorage`. My day is untouched, including drag.

**Lanes.** Six columns share the whole width (the My day `.column` rule: `flex: 1 1 0`, no narrow strip on a big screen);
Idle and Done run a little narrower because they are the quiet ones. Lane header: a dot in the lane's colour (Needs you amber
`--warn`, Working green `--working`, Waiting `--accent`, Blocked `--urgent`, Idle `--later`, Done a hollow ring, all from
`tokens.css`) and a card count; the Needs you column carries a faint amber wash so the eye lands there first. Below 1400px
wide the row scrolls horizontally with the lane header sticky; it never wraps to a second row.

**Card anatomy** (the existing `.card` surface, 10px radius, priority stripe on the left edge from `prio-*`). Top to bottom:
identifier (tabular, faint) and project name in its hue at the right; title (13.5px/560, two lines, ellipsis, wraps any unbroken
string); a "part of WOR-7790" link when it is a delegated sub-task (Agent work); the one line that matters for its lane; then the
footer: agent monogram and name, age (elapsed on a working card), and the run arrow. Spend is not shown. The lane line, each
resolved from the `attention` entry or the state, and each a link to what it names:

| Lane | Line under the title |
| --- | --- |
| Needs you | amber callout "Needs you": the question (3 lines, opens the answer form), or "Your approval: <sentence>" (opens the approval) |
| Working | green breathing dot, the kernel stage, elapsed time |
| Waiting | blue dot and the kernel's words (`stateWords`: "AI review", "CI checks", "an answer from Research Lead") |
| Blocked | red callout "Failed: <how the job ended>" (opens the run), or "Blocked by WOR-7744" (opens that task) |
| Idle | grey dot and why ("Backlog", "Scheduled for tomorrow 08:00", "Your task", "No reported state") |
| Done | quiet title, "Done, graded pass" or "Stopped" |

One card, one accent: the callout colour is the only saturated area on a card, so a column scans by colour.

**Filter bar.** Always visible under the layout row. `+ Filter` opens a menu of the six filters (Agent, State, Label,
Priority, Project, Updated) with a type-to-find field; picking one opens its value list (multi-select with counts, agent
rows with monograms). A chosen filter is one chip: `name | values | ✕`; ✕ removes it, "Clear all" appears with two or more.
A value that no longer exists (a deleted label) stays as a struck-through chip and matches nothing. Text search is the
field at the right (`/` focuses it). Filters apply to both layouts. On My day a filter hides the carried-over bulk action (it moves every carried task, not the
visible ones), and the page's keyboard handlers (`App.tsx`: `r` toggles Recurring) are scoped by layout, so the new keys exist only
in Agent work. Group by is a `Segmented` (`None | Agent`), shown only in
Agent work. State is a six-value menu (the lanes), no counts in the menu.

**Group by agent.** Each agent is a row on a `--col` surface: chevron (open or closed for the session only), monogram, name, and per-lane
counts as coloured dots. Rows are the agents plus You and Unassigned. The six lanes run across as a grid; a lane with nothing in it
shrinks to a hairline, so a quiet agent costs one thin line.

**Saved boards.** After the layout switch: "All tasks" (the unsaved default, first tab), then saved boards as tabs, the selected one on
`--accent-soft`. Editing any filter makes a draft: a dot on the tab and "Save" (on a saved board "Update board" and "Save as new").
`+ Save board` opens a small `Dialog` with a name field and a primary "Save board". Rename and Delete are in a `Menu` on the selected
tab; Delete confirms ("Delete 'Engineering'? The tasks stay."). A conflict keeps the draft and says "This board changed elsewhere;
your edits are kept" with "Reload". Over six boards the rest sit behind "More". The header shows "As of 10:42" and, on a failed
read, the age of the last good snapshot.

**Empty, loading, errors.** On phone the first lane shown is the first populated one, and a "Filters (3)" button replaces the chip row
(chips open in a sheet, with Clear and Update board). Loading: lane headers draw at once, cards are skeletons (`Skeleton.tsx`), never a spinner. Filters
match nothing: "No tasks match these filters" with a "Clear all" button. Nothing running (fresh install): "Nothing is
running yet. Ask Aiden to take a task and it shows up here, lane by lane." A lane with nothing: a dashed box, "No tasks in <lane>". A failed read keeps the last good board and shows the existing offline `Banner`.

**Long and busy.** Titles clamp to two lines and wrap long unbroken strings. A lane scrolls inside itself (max-height from the
viewport) and renders 25 cards, then "Show 38 more"; header counts always show the true number.

**Phone (390px).** The bottom bar is unchanged; lanes become a scrolling strip of lane buttons (dot, name, count) above a
single full-width lane, the lane header dropped because the strip names it. The layout switch and board tabs sit in two rows,
the search field takes a row, and the chips collapse into the "Filters (n)" button. Swimlanes are off on a phone (the Group by control is
hidden). Tap targets are 36px or more; inputs are 16px.

**Keyboard.** No new shortcuts, and none of My day's act in Agent work (`/` already focuses the search field of the page). ⌘K (`Palette`)
gains "Agent work", every saved board by name and "Save board", from cached data only. Every control is a real button or link
with `--ring` focus; state is a word as well as a colour; the live dot is a small breathing dot and stops under reduced motion.

## Build order (one PR, kernel first)

1. Kernel: `lane` on `TaskState` and `closed_since` on the bulk read; board copies of the wire type.
2. Board: the issue inventory with paging and `incomplete`, one snapshot, `closeLeftoverParts` moved to the watch, My day's
   handlers scoped.
3. Web: Agent work layout, filter bar, per-issue cards, swimlanes (last, first thing to cut if the build runs long).
4. Views: table, routes, tabs after the session.
5. Projects read-only filter.

## New installs

A fresh install sees My day unchanged, Agent work with empty lanes ("No tasks yet"), no saved views, no Project filter. Nothing
depends on an optional module: lanes read the kernel only. Another owner's modules plug in through the kernel's reasons and
stages: a module wait arrives as `module_wait` with its `ref` and shows in Waiting with its own words.
