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

1. **Chat is the heart.** It is the home view, gets the most width and care, and nothing in the frame crowds it: a
   change that costs chat space or speed loses.
2. **Tasks** next, then everything else.

## The frame

- **Top bar** (`TopNav`): Chat, Approvals, Tasks, Fleet, Insight; then ⌘K search, today's spend, shortcuts, Settings.
  Live counts sit on the section (approvals waiting, agents working). No sidebar frame (owner rule).
- **Chat's details panel** starts shut below 1920px wide and open from 1920 up; one click on Details opens or hides it,
  and the choice is remembered (localStorage `aidenhq.panel`, a stored choice beats the width). Chat gets the width first.
- **A section of several pages lists them on its left** (`SubNav`): Fleet is Agents, Apps (with pinned app panels),
  Modules, Reviews; Insight is Costs, Flow. Settings uses the same list for its categories. A section of one page has
  no list; chat keeps the full width under the bar with its own conversation list.
- **⌘K** (`Palette`) jumps to any page, agent, chat, app, module or setting from cached data only.
- **Phone**: a bottom bar (Chat, Approvals, Agents, Tasks, More); an open conversation is full screen with no bars.
- **A page's own tools** go in the page (its header, or a `.page-tools` row like Tasks), never in the top bar.

A new board page: add its view to `NavView`/`ITEMS` in `Shell.tsx` and to a section in `SECTIONS` (an existing one
unless it is daily work), its route in `App.tsx`, and a `VIEW_CHUNKS` entry in `queries.ts` so hover prefetches it.

## A page

```tsx
<Page>
  <PageHeader title="Apps" sub="What runs on your server." actions={<Button variant="primary">…</Button>} />
  <Section title="Running" count={n}>…</Section>
</Page>
```

Add only the page's own layout, in its own small CSS file. An item's page (agent, module, app) adds `crumb`, `face`
and `status` to its `PageHeader`, puts `hueClass(name)` on the `Page`, `Tabs` under the header (each tab its own URL),
and `.ui-split` for the work on the left and a rail of `Card`s with `Facts` on the right.

| Need | Use |
| --- | --- |
| A state (working, connected, failed, waiting on you) | `StatusDot`: `working`, `ok`, `needs`, `failed`, `idle`, `done`, `info`, `busy`, `hue` |
| A fact (a count, a kind, a version) | `Tag` (`neutral`, `accent`, `ok`, `needs`, `failed`) |
| The parts of one page | `Tabs` |
| A filter or a choice of two to four values | `Segmented` |
| An action | `Button` / `LinkButton`: one `primary` per view, `quiet` for the least important, `danger` for removal |
| A list of tasks | `ListRows` + `ListRow` |
| A collection (modules, apps, connections) | `TileGrid` + `Tile` (one target per tile, its action raised above it) |
| A number and its trend | `StatBlock` (with `bars`) or `BarChart`; a count or cost that changes: `Ticker` |
| A few label/value facts | `Card` + `Facts`; a usage bar: `Meter` |
| A form | `Field`, `Input`, `Select`, `Switch`, `Checks`; a setting: `FieldRow`; a model: `ModelPicker` (the one model picker, fed by `useModelCatalog`) |
| Something new or wrong above the content | `Banner` (`info`, `warn`, `danger`) with one action |
| Nothing to show | `EmptyState`, which says what to do |
| Loading | a skeleton shaped like the content (`Skeleton.tsx`), never a spinner |
| A short decision | `Dialog`; extra actions: `Menu`; an icon: `Icon` (`ui/icons.tsx`) |

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

## Motion

Fast and in answer to an action: `--instant` 90ms (presses), `--fast` 160ms (hovers, exits), `--medium` 220ms (things
arriving), `--slow` 320ms (meters); `--ease-out` in, `--ease-in` out, `--ease-spring` for a small settle. Pages
cross-fade (View Transitions, `App.tsx` `setView`); counts tick. Working states breathe in a small dot, never a large
animated area (OLED smear). `prefers-reduced-motion` makes every transition instant (`ui.css`), so a page needs no rule
of its own.

## Accessibility

Every control is a real button or link, reachable by keyboard, with `--ring` on focus; text meets AA on every surface in
both themes; state is never colour alone (a `StatusDot` has a word); dialogs trap focus and close on Escape; phone
inputs are 16px (no zoom).

## Rules the lint enforces

`npm run lint` in `services/board` (ESLint and stylelint, config only; CI runs it): no raw colours or px font sizes
outside `tokens.css`, and no class the kit replaced (`web/legacy-classes.json`, each with what to use instead).

## Modules

Modules declare (`board.signins`, `board.setup_flows`, `providers.board`, settings) and both the board and the owner's MCP
drive the declarations: a Connect on Settings, Connections, a setup sheet and wizard step
([guided-setup.md](guided-setup.md)), an API a board page reads (like Reviews), a setting with its help. A page the
declarations can't express is a module view (sandboxed, in the MCP Apps format), designed later. How a module is built:
[modules/AGENTS.md](../../modules/AGENTS.md).

## Working on the UI without an instance

`node web/dev/mock-api.ts` answers the board's reads on :3120 with neutral fixtures, and `npm run dev:web` serves the
UI against it on :5173. `GET /__mock?welcome=1` shows the first-run wizard, `?empty=1` empties the lists, `?slow=800`
delays every answer (loading states). Check a change at 1512, 1920, 2560 and 390 wide, light and dark, chat first.
