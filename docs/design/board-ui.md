# The board's design guide

The board (`services/board/web`) is the owner's daily surface. It has one kit: tokens in `web/src/ui/tokens.css`,
components in `web/src/ui/` (import from `./ui`), their styles in `web/src/ui/ui.css`, the frame in `Shell.tsx` and
`shell.css`. Every part is on `#/design`, light and dark side by side. Agent-built apps have their own system
(shadcn on Radix palettes, MIT, synced into the starter): [design-system.md](design-system.md). The two share the taste
below, not tokens; change one without the other.

**The look:** Stripe's polish and Linear's crispness, with more colour. Moderate radius that shrinks with the element,
never a pill. Dense but calm, little wasted space. Fluid at every size (1512, 1920, 2560 and a phone): clamp() gutters
and type, grids that add columns, never a narrow column in the middle of a big screen.

## Priorities

1. **Home is the heart.** The board opens on it (`#/`), it gets the most care, and nothing in the frame crowds it.
2. **Teammates and their chats** next.
3. **Tasks**, then everything else.

## The frame

- **Top bar** (`TopNav`): Home (the Needs-you count) · Tasks · Apps · Team (a live dot while agents work) · Insight (today's
  spend, small), then Search ⌘K, **Ask Aiden** ⌘J and Settings. Brief and help live on their keys (`b`, `?`) and in ⌘K.
  No sidebar frame (owner rule).
- **A section of several pages lists them on its left** (`SubNav`): Tasks is Tasks and Sessions (only with the sessions
  module, [sessions.md](sessions.md)); Team is Teammates, All agents, Modules, then the modules' pages; Insight is Costs,
  Flow, Decisions; Apps lists its pinned app panels when there are some. A teammate's own page has no list.
- **Ask Aiden** (`AskAiden.tsx`): a non-modal side panel on the right, beside the page (the page narrows; it never covers
  it), with Aiden's current chat, its history (Active / Settled) and a composer; "@Max …" starts a chat with that teammate. ⌘J toggles it from anywhere, it stays open across
  pages, Escape closes it (when focus is in it, or nothing else is open) and focus goes back to what opened it. A full
  screen sheet below 1000px.
- **⌘K** (`Palette`) jumps to any page, teammate ("Name · Role"), agent, chat, app, module or setting from cached data.
- **Phone**: a bottom bar (Home · Tasks · Ask Aiden · Team · More); More holds Apps, Insight, Settings, module pages and
  app panels.
- **A page's own tools** go in the page (its header, or a `.page-tools` row like Tasks), never in the top bar.
- **Routes:** `#/` Home (`#/approvals/<id>` opens that card in Home's drawer), `#/tasks[?view=<id>]`,
  `#/tasks/sessions[/<ref>]`, `#/apps[/<name>]`, `#/team`, `#/team/<key>[/c/<chat>][?text=…]`, `#/team/agents[/<key>[/<tab>]]`,
  `#/team/modules[/<name>[/<tab>]]`, `#/team/m/<page>[/<sub>]`, `#/insight/{costs,flow,decisions}`, `#/settings[/<cat>]`;
  overlays `#/t/<task>`, `#/r/<run>`, `#/brief`, `#/help`, `#/setup/<module>` keep the page under them, and closing one
  goes back to it. An old address (`#/c/…`, `#/agents…`, `#/modules…`, `#/fleet/…`, `#/board`, `#/sessions…`,
  `#/costs`, `#/flow…`, `#/approvals`) is rewritten once by `parseRoute`'s `redirectOld`; its view is gone.

A new board page: add its view to `NavView`/`ITEMS` in `Shell.tsx` and to a section in `SECTIONS` (an existing one
unless it is daily work), its route in `App.tsx` (`parseRoute`, `viewOf`), and a `VIEW_CHUNKS` entry in `queries.ts` so
hover prefetches it.

## A page

```tsx
<Page>
  <PageHeader title="Apps" sub="What runs on your server." actions={<Button variant="primary">…</Button>} />
  <Section title="Running" count={n}>…</Section>
</Page>
```

Build only from `web/src/ui`: pages compose the kit, never restyle it (extend the kit when something is missing). Add
only the page's own layout, in its own small CSS file. An item's page (agent, module, app) adds `crumb`, `face`
and `status` to its `PageHeader`, puts `hueClass(name)` on the `Page`, `Tabs` under the header (each tab its own URL),
and `.ui-split` for the work on the left and a rail of `Card`s with `Facts` on the right.

| Need | Use |
| --- | --- |
| A state (working, connected, failed, waiting on you) | `StatusDot`: `working`, `ok`, `needs`, `failed`, `idle`, `done`, `info`, `busy`, `hue` |
| A fact (a count, a kind, a version) | `Tag` (`neutral`, `accent`, `ok`, `needs`, `failed`) |
| The parts of one page | `Tabs` |
| A filter or a choice of two to four values | `Segmented` |
| An action | `Button` / `LinkButton`: one `primary` per view, `quiet` for the least important, `danger` for removal |
| A list of tasks | `DigestRow` (`cols`: the same row as Home's, in columns), one card of sections as on Tasks |
| A collection (modules, apps, connections) | `TileGrid` + `Tile` (one target per tile, its action raised above it) |
| A number and its trend | `StatBlock` (with `bars`) or `BarChart`; a count or cost that changes: `Ticker` |
| A few label/value facts | `Card` + `Facts`; a usage bar: `Meter` |
| A form | `Field`, `Input`, `Select`, `Switch`, `Checks`; a setting: `FieldRow`; a model: `ModelPicker` (the one model picker, fed by `useModelCatalog`) |
| Something new or wrong above the content | `Banner` (`info`, `warn`, `danger`) with one action |
| Nothing to show | `EmptyState`, which says what to do |
| Loading | a skeleton shaped like the content (`Skeleton.tsx`), never a spinner |
| A short decision | `Dialog`; extra actions: `Menu`; an icon: `Icon` (`ui/icons.tsx`) |
| A teammate (an agent the owner talks to) | `TeammateChip` (face, "Name · Job"; `faceStateOf` for its state); a face alone: `Face` |
| A decision that needs the owner | `DecisionRow` (who, question, the draft as `detail`, inline buttons, a receipt with Undo once answered) |
| A block of Home | `SectionCard` (title, amber `count` of what needs the owner, `meta`, one `action`; `flush` for rows) |
| What happened while the owner was away | `DigestList` (top three, "All N →") |
| One item's detail beside its list | `DetailPane` (non-modal, Escape closes, full screen on a phone) |
| A conversation beside the page (Ask Aiden) | `SidePanel` (header face and actions, composer in `footer`) |
| Progress through a short flow | `Stepper` ("Step 1 of 3 · label") |
| A choice shown as cards | `OptionCard` (`radio` or `checkbox`, a real input) |
| Detail most people skip | `Disclosure` |
| A keyboard shortcut | `Kbd` |
| Cards that add columns as the screen grows | `.ui-grid` (`--grid-min`) |

**Layout:** a page's content caps at `--page-max` (1920px) and centres beyond it (the frame's padding, so the scrollbar
stays at the edge). Grids are fluid: `repeat(auto-fill | auto-fit, minmax(min(100%, X), 1fr))`; never a narrow column.

## Tokens

- **Colour**: every colour is a token, `light-dark(light, dark)`. Light is a cool near-white page (`#f6f7f9`) with white
  surfaces, blue-grey borders and ink, and an indigo accent; muted and faint text stay at 4.5:1 or better on every surface.
  **Dark is OLED black** (page `#000`): cards and panels lift on dark-grey surfaces with hairline borders and a faint top
  highlight (`--lift`), since shadows can't show on black. One hue per item (`hueClass`) colours its face, tab underline
  and charts.
- **Type**: one family (Inter, else the system face). Fixed small steps for dense UI (`--text-3xs`…`--text-body`), fluid steps above
  (`--text-row`…`--text-3xl`). Sentence case everywhere; no uppercase labels.
- **Space**: a 4px grid (`--sp-*`); page gutters `--gutter`, `--page-top`, `--stack`.
- **Radius**: tags 5px, controls 8px, cards 10px, dialogs and columns 14px; never a pill.
- **Elevation**: `--shadow` at rest, `--shadow-hover` lifted, `--shadow-lg` for overlays.
- **Layout**: `--page-max` (1920px) caps a page's content; `--pane-w` is a side pane's width.
- **Faces**: the face palette (`--face-*`: ten background and shirt pairs, ten skins, nine hair and brow colours, one look
  per accessory) is the only illustration colour, the same in both themes, and lives only in `tokens.css`. A module picks
  a teammate's face as a kit spec (`teammate.face: {hair, accessory, body, skin, hair_color, palette}`,
  `services/shared/face-kit.ts`) or ships an image; with neither, `Face` draws one from the agent's key (`kitFromSeed`).

## Motion

Fast and in answer to an action: `--instant` 90ms (presses), `--fast` 160ms (hovers, exits), `--medium` 220ms (things
arriving), `--slow` 320ms (meters); `--ease-out` in, `--ease-in` out, `--ease-spring` for a small settle. Pages
cross-fade (View Transitions, `App.tsx` `setView`); counts tick. Working states breathe in a small dot, never a large
animated area (OLED smear). `prefers-reduced-motion` makes every transition instant (`ui.css`), so a page needs no rule
of its own.

The motion classes, on tokens: `.enter` arrives rising `--enter-y` over `--medium` (stagger siblings with `style={{"--i": n}}`,
`--stagger` apart); `.lift` rises `--lift-y` with `--shadow-hover` on hover; `.press` shrinks to `--press-scale` while pressed.
Panes slide in over `--medium` and leave over `--fast`; a `Disclosure` and a receipt collapse over `--medium`. That is the
whole vocabulary: enter, lift, press, pane slide, collapse, with one `prefers-reduced-motion` block in `ui.css`. A face's own motion (a working bob and glance, a needs-you ring,
a blink) is CSS too, so reduced motion stills it on its resting frame.

## Accessibility

Every control is a real button or link, reachable by keyboard, with `--ring` on focus; text meets AA on every surface in
both themes; state is never colour alone (a `StatusDot` has a word); dialogs trap focus and close on Escape; phone
inputs are 16px (no zoom).

## Rules the lint enforces

`bun run lint` in `services/board` (ESLint and stylelint, config only; CI runs it): no raw colours or px font sizes
outside `tokens.css`, and no class the kit replaced (`web/legacy-classes.json`, each with what to use instead).

## Home

`Home.tsx`, one read (`GET /api/home`), top to bottom: the greeting (Day-one Next up under it), Your day, then **two rows of two
equal halves** (1fr / 1fr from 1100px, the same gutter on both so the middle edges line up; cards size to their content): **Needs
you | You're waiting on**, then **Today | Since you last looked** (a lone card takes its row; stacked on a phone in that order).
There is no "Your world" heading: Needs you is not part of anyone's world. Then Your team (teammates with news, and Hire a teammate).
**Today's rows are links to the meeting**, opening in a new tab: the event's video-call URL, else its calendar page. google's
`calendar_today` carries it as `url` (Meet link or conference entry, else a Zoom/Meet/Teams URL in the location, else the event's
`htmlLink`; http(s) only), and Home passes it through; an event with none is a plain row. "Prep ready" still opens the prep task.
**Needs you holds everything
waiting on the owner**: the teammates' asks (answers, approval cards, handed-back tasks) and the people waiting on his
reply (open tasks labelled `needs-response`, which Intake files from Slack and email), each ONE compact row. **One row
component** (`DigestRow` in `ui/DigestList.tsx`) draws every list on Home (Needs you, You're waiting on, Today, Since you last
looked): **exactly one line**, ~40px: face or monogram, "who · what" cut with an ellipsis, the age or a link on the right.
**A row's buttons are hidden until it is hovered or holds focus** (`:hover`, `:focus-within`): then they lie over the row's
right end on a fade from transparent to the row's own background, so the text and age slip under them with no layout shift
(Reject…'s reason field takes the whole row). A touch screen (`hover: none`) shows no buttons: a tap opens the drawer, which
has every action. **The whole row is the click target** (no Open button; Enter does the same): Needs you and You're waiting
on rows open a right-hand **drawer** over the page (the board's drawer look: scrim, click outside, Esc or Close dismisses;
focus moves in and back to the row; `min(600px, 92vw)` wide, a full-screen sheet on a phone ending above its bottom bar; Home
underneath keeps its layout). The row text is a real button or link, so Tab and Enter work. Row buttons: an ask shows its
single primary answer (the first option, or Approve and Reject… for a card) and **Later**; an ask with several questions or
options has no inline answer, only Later. A person waiting (`needs-response`) shows **Done** (closes the task as done),
**Later** and **Dismiss** (closes it as cancelled; it stays in history); a task handed back to the owner shows Done only.
You're waiting on rows have Done, Later and Dismiss with the same meanings (Later hides it until 08:00 tomorrow, mouse only:
J/K/E/S belong to Needs you). While picking cards for a batch (Select), each card's box sits before its face, always shown.

**The drawer**, top to bottom in separate areas: the head (the teammate's face, name and job, or the person and where they
wrote; how long it has waited; Close), the ask as the title, **every action** of its kind (a card: Approve, Reject with a
reason, Later; a question: every option and the typed answer, Later; a person: Done, Later, Dismiss; waiting on: Done, Later,
Dismiss; a handback: Done), what it is about (a send's draft; a card's changes, reviewer's note and exact request; the task's
Why and Suggested lines, or its opening), then **Details**: the source (Slack, Email, Meeting, or the teammate) with a link to
the original message when the task has one, the Source block's other lines (Channel, From, Sent, Account, Subject, Meeting,
Note, Quote…), when it arrived (the `time_format` setting), how long it has waited, the task and its open parent, project,
labels and who handles it; a card adds Reads, Cost, who decides and its id. "Open task →" at the foot. `/api/home` carries
these as each row's `about` (`aboutTask` in `services/board/src/home.ts`): the task's own fields and its description's Source,
Reason and Suggested action sections (`## ` headings), the format Intake and the meeting notes write (`Permalink:` or
`Link:` is the original's address, http(s) only); a description without a Source block sends its first 600 characters. Only
fields a row has are shown. Each card lists the **newest ten** (newest first); the greeting and the card's count are the full N.
**Needs you's "View all N →" expands the card in place**, showing every row the count includes (as Since's "All N" does),
because the Tasks page filters tasks by lane or label and an approval card has no task to open there; "Fewer" folds it back.
You're waiting on's "View all N →" (shown past ten) opens Tasks (`#/tasks?show=waiting`: the `waiting-on` label) on Mine,
where each of those tasks is a row. Since is a glance; its "All N" expands in place under the card.
**A block with no source or no data is left out**, never shown empty: Needs you too, and the greeting then says only "Good morning,
<name>." (the greeting counts every row of Needs you, so it never claims "nothing"). A fresh install sees the greeting,
Next up and the team row.

- **Keyboard** (`needs.ts`): J/K move through Needs you, Enter opens the detail drawer, E does the row's main action (approve,
  the recommended option, Done), S is Later. Enter, E and S wait until a row is picked; every key is off while
  typing, with a modifier, or with focus in Ask Aiden, a pane, a dialog or ⌘K.
- **Later** (snooze) hides a row until 08:00 the next day, per account. **Receipts** replace an answered row ("Sent: …", "Approved",
  "Tess is sending it"); only a snooze has Undo (an answer or a decision isn't undoable).
- **The window** of Since is per visit: the first answer's `since_from` goes back with every refetch, and the cursor moves
  to a snapshot's `as_of` once it has been on screen; with a Since digest on the page, once that digest has been in the
  viewport (an IntersectionObserver), so a digest below the fold is not marked seen unread.
- `#/approvals/<id>` opens that card in the drawer: its row when it is listed, else the card read alone (a decided one shows
  its outcome).
- Every other write record is on Insight › Decisions; failed and idle tasks are on Team › All agents (`AttentionStrip`).

## Tasks

`Tasks.tsx` (`#/tasks`), one page with a tool row (title, the tabs, Project | Source | Agent, and the keys on a wide screen) over **one card
of sections**. **Mine | Delegated** are the tabs (with counts; **All**, the old five-column view, and saved boards stay behind
them, see "Kept" below).

- **Mine** is what is assigned to the owner (`own-tasks.ts mineOf`): **New** (the triage bucket, always first, capped at five with
  "Show all N"), **Today**, **Upcoming** (Tomorrow's and the week's buckets, grouped by date: a scheduled task under its day,
  the rest under "Coming up") and **Later** (the backlog). The bucket ids (`triage`, `later`, `backlog`) are unchanged; only the names are.
  A section has a chevron to collapse, a status glyph, its count and a thin coloured left edge (New amber, Today blue, Upcoming
  violet, Later grey); there is no column-header row.
- **Delegated** is the tasks assigned to agents (`delegatedOf`), by the kernel's lane: **Working**, **Waiting on you** (what needs the
  owner, and what is blocked or failed: both are his to act on), **Queued** and **Done today** (green checks). The tab's count is
  the first three groups. A row's progress text is the kernel's own words for its state (`progressOf`: the question it asked, "Approval
  card ready", else `stateWords`); a task with no state row says so.
- **A row** is Home's `DigestRow` in columns (`cols`): the task id, the section glyph, the source icon, the title, then the source
  name or an amber waiting line ("Priya is waiting for you · 3d", from Intake's `needs-response` title), the project chip, the agent
  that filed it (Mine) or holds it (Delegated), and the time (New and Delegated: how long ago; Today: the clock in the owner's
  `time_format`). On hover **Done**, **Later** and **Dismiss** lie over its right end; **Later** opens Tomorrow, Next week
  (the next Monday) and Someday. Dismiss cancels the task (it stays in history; the toast has Undo). A phone shows two-line titles,
  no hover buttons (the drawer has every action) and an amber dot for a waiting task; nothing scrolls sideways at 390px.
- **The drawer** is Home's (`ui/RowDrawer.tsx`; `tasks-drawer` is 720px wide): the section and id with J/K, the title, the waiting line,
  the actions (Done, Tomorrow, Next week, Someday, Merge…, Dismiss on the right; Mine only), five facts (Assignee, Project, Filed
  by, When, Reminder: a recurring task's next run), then Source (the task's Source block, with "Open in Slack…"), About (Why, Suggested),
  Subtasks (the agents' sub-tasks and their state) and Linked task on the left, Activity (comments and the task's milestones) with the
  comment box on the right. The comment box is the one way to write on a task. Updated and "Open task" (`#/t/<id>`, the full page) at the
  foot. A section with no data is left out. `GET /api/issues/<id>` carries `about` (`aboutTask`, as Home's rows do).
- **Keys** (`Tasks.tsx`): J/K move (and step the open drawer), Enter opens, 1 Today, 2 Upcoming, 3 Later, X Dismiss, E Done. Off while typing
  or with another layer open.
- **Filters** are one choice each, kept in the page's filters: Project, Source (the labels that say where a task came from) and Agent
  (Mine: who filed it; Delegated: who holds it).
- **Kept for the owner to rule on:** All (the five buckets, drag between them, the Done and Recurring columns, the carried-over bar and
  quick-add) and saved boards with their filter chips; a saved board whose layout is Delegated shows the same list narrowed by its filters.
- **New installs:** an empty Mine says "Nothing here." in each section; an empty Delegated says nothing is delegated yet.

## Teammates

A teammate is an agent with a `teammate:` block (its module's); the rest are hidden staff behind one. The owner meets
teammates as "Name · Role" everywhere (`TeammateChip`), never a module name in primary text.

- **Team** (`#/team`) lists them with face and state, what each is doing, Rename and who works behind it.
- **A teammate's page** (`#/team/<key>`): its chat (the newest open one, any of its chats from the switcher, Active or
  Settled, or a new one whose placeholder is its sample line) beside a generic side column: what it does, recent work,
  how it is set up (its `controls` modules' declared settings, changed by asking it) and the team behind it. One Advanced
  link goes to its first controlled module's page or settings. Pause pauses only the teammate, never its staff.
- **Hiring** (`#/team/hire`) lists every catalog teammate, official and every installed marketplace's (a third-party
  listing without a kit face gets a monogram), filtered by Available, On your team, marketplace and area. Hire, Home's
  Next up and onboarding all run one setup sequence, `TeammateSetup` (module change with apply tracking, the setup flows
  it still needs inline, its routines resumed, its trial once, its name). "Describe who you need" is a chat with the
  agent holding the architect role; its answer form's `Install <id>` and `Extend <key>` options (checked against the
  page's own rows) take the short path, anything else continues in that chat.
- **Onboarding** (`#/welcome`, Welcome.tsx): start with one teammate, where the team reaches you (with a real test
  message), then Home on day one ([guided-setup.md](guided-setup.md) Part 3).
- **Every chat entry point reaches teammates only** (the composer's @-mentions, Ask Aiden, a teammate's page, the server's
  routing). A chat opened by id (`#/t/<ref>`) opens in the task drawer.

## Modules

Modules declare (`board.signins`, `board.setup_flows`, `board.pages`, `providers.board` (the warehouse's search), settings) and both the board and the
owner's MCP drive the declarations: a Connect on Settings, Connections, a setup sheet or an inline flow in onboarding and hiring
([guided-setup.md](guided-setup.md)), a page under Team, a setting with its help. How a module is built:
[modules/AGENTS.md](../../modules/AGENTS.md).

**A module's page (under Team, `#/team/m/<id>`) is a module view** ([MCP Apps](https://github.com/modelcontextprotocol/ext-apps), protocol
2026-01-26): an HTML resource its own MCP connection serves, declared in `module.yaml`:

```yaml
requires: [board]
contributes:
  board.pages:
    - id: ship                      # its address, #/team/m/ship; unique
      title: Ship
      icon: rocket                  # one of the icons modules/board/schemas/pages.json lists
      order: 10                     # after Team's own pages, ascending
      connection: ship              # one of this module's own connections
      view: ui://ship/page          # served by it (resources/read, text/html;profile=mcp-app)
      tools: [ship_config, ship_configure]   # what the view calls: read or write tools of that connection, named <module>_…
      settings: [ship, code_review]          # optional: setting keys the page may propose beyond its module's own; one of its own listed here is edited on the page alone (the generic settings screens leave it off)
      secret_maps:                           # optional, at most 2: the board's own "Sign-ins" panel under the frame
        - secret: ui_logins                  # one of this module's `setup:` secrets, a JSON map key -> { field: text }
          keys_from: ui_testing.apps[].name  # the keys: one of its own settings (applied value), e.g. each app's name
          fields: [{ name: username, label: Username, kind: text }, { name: password, label: Password, kind: password }]   # kind: text | password | key | totp; optional maxLength (1 to 65536, else 300)
```

- **Secret maps.** Per key the board shows Set / Replace / Clear and which keys hold a value, never the value: the owner types it
  into the board's own form (outside the frame, so the module's HTML never sees it), the board sends it to the kernel's
  `save_secret` with `key`, which merges that one key into the JSON map and writes the vault file in place (nothing restarts: the module
  reads the map on each use; the module's `validate` hook sees that entry alone). A stored value comes back to no browser, tool or log; a
  key the setting no longer names can only be cleared. Only a ready admin's session saves, and the kernel lets only the owner write.
  A `key` field is a multi-line textarea shown as typed (an SSH private key a hidden input would make impossible to check by eye):
  its whitespace, a key's trailing newline included, is kept exactly, and its value is capped by its own `maxLength` (any field that
  declares none is capped at 300). A **clear** goes to the module's `validate` hook too, as `{ secret: { name }, key }` with no
  `value`, so a module can refuse removing an entry something still uses. A clear is **fail closed**: a module whose hook answers
  `{ ok: false }` refuses it, and so does a hook that can't be reached or doesn't answer, since a cleared key can't be read back
  (a written value is still saved unchecked when a hook can't be asked). A module with no `validate:` hook clears as before.

- **Compile** checks it (the connection is the module's, the view is `ui://<module>/…`, no destructive tool and none a write kind routes, tool names
  `<module>_…`) and puts each view with its tools on its connection in the kernel's `connections.json` (`views`).
- **The board** lists the pages after Team's own (its list, phone More, ⌘K) and shows one at `#/team/m/<id>`
  (`ModuleView.tsx`). The view runs in an iframe served from `/api/pages/<id>/frame` with a sandbox CSP (`allow-scripts
  allow-forms` only): an opaque origin with no network, no cookies, no navigation and nothing loaded from outside. Inline
  script and style only; `_meta.ui.csp` domains aren't honoured. The board's own CSP (`frame-src 'self'`) keeps the frame from navigating anywhere outside the board, and the bridge serves only the first document a frame loads; a view that navigates itself, or doesn't send `ui/initialize` within 8 seconds (its module down), is replaced by a Try again.
- **The bridge** is MCP Apps over postMessage, from that frame only: `ui/initialize` (the host context carries `theme` and
  `styles.variables`: the MCP Apps standard names the board has tokens for (`--color-background-*`, `--color-text-*`,
  `--color-border-primary|secondary`, `--color-ring-primary`, `--font-sans`, `--font-text-xs|sm|md-size`,
  `--border-radius-xs|sm|md|lg`, `--shadow-sm|md|lg`; the one table is `TOKENS` in `ModuleView.tsx`), as the board's tokens
  write them, so the view sets `color-scheme` to `theme`; `teammates` maps each teammate's key to its current name), `ui/notifications/initialized`, `ui/notifications/host-context-changed` (the board sends the host context again when the system theme flips; the frame inherits the board's color-scheme, so the two must match or the browser paints an opaque backdrop), `tools/call`, `ui/message` (opens Ask Aiden with the text ready) and `ui/notifications/size-changed`
  (the frame's height). Nothing else is answered. A web host should use a sandbox proxy on a second origin; the board has one
  origin in every exposure mode, so the single sandboxed frame stands in for it.
- **The page kit** (`services/shared/page-kit.css|js`, copied into each module that serves a page by
  `scripts/sync-shared.ts` and inlined by its `mcp.ts`) gives a view the board's look through those variables only, with
  neutral fallbacks, so another MCP Apps host's theme maps too: `.card` with a `.head` (title, meta, action), `.row`,
  `button` and `.primary`, and `.tag` with `.ok`, `.needs` and `.failed` (radius, hairline borders, hover lift, press
  scale, focus ring, reduced motion), plus `.collapse` (an in-place grow), `button.quiet|.sm`, `select.pick` (auto width) and `.tag.run`; a view's `ask(text)` sends `ui/message`. A module page uses these classes instead of its own styles.
- **A tool call** goes board → kernel (`POST /v1/views/<module>/mcp`, the board's key), which lets through only that view's
  resource and its page's tools, and calls the module with a caller assertion of kind `owner` (no agent, no roles, no
  control-plane reach).
- **Settings:** a page's write tool, called by the owner, returns the typed change instead of filing it:
  `structuredContent._aidenhq.settings_change: [{ kind: setting, key, value }]`. The board shows it in a bar outside the
  frame, and the owner's Save files it as his own settings change, refused unless every key is one only the page's module declares or one its `settings` list names (compile accepts a key declared by that module or a module it requires, so a page can propose a change spanning modules; the owner's Save, with the whole change shown outside the frame, is the only gate, and an agent's call stays per module). A setting declared `entry: <field>` (maintainer_repos) takes a list of names or maps carrying that field, so a page can add or change an entry; the Save keeps each map entry a map. A Discard reloads the page, so it keeps no edit the owner threw away (after a Save it keeps its edits: they are what was saved, and the module serves them once applied). Save waits ("Applying…") while any filed change to one of the proposal's settings is in flight or waiting for approval, whichever page filed it (the board's filed-changes list is the one truth, so a refresh or a lost answer keeps the lock); when it is applied the page starts over from the live settings, and a failed one leaves the proposal to retry.
  An agent's call of the same tool files the change itself (`/v1/settings/agent`), so the module's one check serves both.
- **In the owner's Claude** the owner MCP serves each page as an MCP App: an opener `<id>_page` with `_meta.ui.resourceUri`,
  the view (with no `_meta.ui.csp`, so Claude's strict default holds) and the page's tools with visibility `["app"]`; the
  board's own tools are `["model"]`, so no view calls them. Their answers come back fenced as untrusted data (text blocks and every string of `structuredContent`), so a view written for Claude reads values out of the fence. Claude scopes app-visible tools by server, not by view, so there a view can also reach another page's tools (each still only a declared, non-destructive one, run as the board's own route). A proposed setting there is saved by asking Claude to apply it
  (`change_settings`).
- **A view's job:** the module's state and its feature settings, empty states that say how to connect. The example
  (`web/dev/example-view.html`, the mock API's Notes page) is the starting point: no build step, about 100 lines.

Code review's Reviews page is a module view too (`modules/code-review/service/src/page.html`, order 5), results first: a one-sentence summary, what needs the owner, one row per pull request that opens in place to its findings (with the owner's Dismiss), and a rail (what the reviewer covers, Ask, whole-repo checks, Advanced). Advanced writes a repo's settings as editable sentences (through `code_review_configure`'s proposal). Every module page has this one path; an old `#/reviews/…` link redirects to it.

**`board.reads`** are a module's owner-view reads for Home: `{id, connection, tool}`, a read tool of its own connection,
called by the board through the kernel's view route (google's `calendar_today`, owner-channel's `told`). Home names no
module: it asks for a read by id, and leaves its block out when the read is absent or fails.

## Working on the UI without an instance

`node web/dev/mock-api.ts` answers the board's reads on :3120 (`PORT=` to move it) with neutral fixtures, and
`bun run dev:web` serves the UI against it on :5173. `GET /__mock?welcome=1` shows the first-run wizard, `?empty=1` empties
the lists (Home as a fresh install sees it), `?nocal=1` drops Home's calendar, `?slow=800` delays every answer (loading
states). Check a change at 1512, 1920, 2560 and 390 wide, light and dark, Home first.
