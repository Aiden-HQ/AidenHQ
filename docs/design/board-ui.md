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

Modules declare (`board.signins`, `board.setup_flows`, `board.pages`, `providers.board`, settings) and both the board and the
owner's MCP drive the declarations: a Connect on Settings, Connections, a setup sheet and wizard step
([guided-setup.md](guided-setup.md)), a page in the Fleet sidebar, a setting with its help. How a module is built:
[modules/AGENTS.md](../../modules/AGENTS.md).

**A module's Fleet page is a module view** ([MCP Apps](https://github.com/modelcontextprotocol/ext-apps), protocol
2026-01-26): an HTML resource its own MCP connection serves, declared in `module.yaml`:

```yaml
requires: [board]
contributes:
  board.pages:
    - id: ship                      # its address, #/fleet/ship; unique
      title: Ship
      icon: rocket                  # one of the icons modules/board/schemas/pages.json lists
      order: 10                     # after Agents, Apps, Modules and Reviews, ascending
      connection: ship              # one of this module's own connections
      view: ui://ship/page          # served by it (resources/read, text/html;profile=mcp-app)
      tools: [ship_config, ship_configure]   # what the view calls: read or write tools of that connection, named <module>_…
```

- **Compile** checks it (the connection is the module's, the view is `ui://<module>/…`, no destructive tool and none a write kind routes, tool names
  `<module>_…`) and puts each view with its tools on its connection in the kernel's `connections.json` (`views`).
- **The board** lists the pages after Fleet's own (sidebar, phone More, ⌘K) and shows one at `#/fleet/<id>`
  (`ModuleView.tsx`). The view runs in an iframe served from `/api/pages/<id>/frame` with a sandbox CSP (`allow-scripts
  allow-forms` only): an opaque origin with no network, no cookies, no navigation and nothing loaded from outside. Inline
  script and style only; `_meta.ui.csp` domains aren't honoured. The board's own CSP (`frame-src 'self'`) keeps the frame from navigating anywhere outside the board, and the bridge serves only the first document a frame loads; a view that navigates itself, or doesn't send `ui/initialize` within 8 seconds (its module down), is replaced by a Try again.
- **The bridge** is MCP Apps over postMessage, from that frame only: `ui/initialize` (the host context carries `theme` and
  `styles.variables`: `--color-background-primary|secondary`, `--color-text-primary|secondary|danger|inverse`,
  `--color-border-primary`, `--color-ring-primary`, `--font-sans`, `--border-radius-md`, as the board's tokens write them, so
  the view sets `color-scheme` to `theme`), `ui/notifications/initialized`, `tools/call` and `ui/notifications/size-changed`
  (the frame's height). Nothing else is answered. A web host should use a sandbox proxy on a second origin; the board has one
  origin in every exposure mode, so the single sandboxed frame stands in for it.
- **A tool call** goes board → kernel (`POST /v1/views/<module>/mcp`, the board's key), which lets through only that view's
  resource and its page's tools, and calls the module with a caller assertion of kind `owner` (no agent, no roles, no
  control-plane reach).
- **Settings:** a page's write tool, called by the owner, returns the typed change instead of filing it:
  `structuredContent._aidenhq.settings_change: [{ kind: setting, key, value }]`. The board shows it in a bar outside the
  frame, and the owner's Save files it as his own settings change, refused unless every key is the page's module's own.
  An agent's call of the same tool files the change itself (`/v1/settings/agent`), so the module's one check serves both.
- **In the owner's Claude** the owner MCP serves each page as an MCP App: an opener `<id>_page` with `_meta.ui.resourceUri`,
  the view (with no `_meta.ui.csp`, so Claude's strict default holds) and the page's tools with visibility `["app"]`; the
  board's own tools are `["model"]`, so no view calls them. Their answers come back fenced as untrusted data (text blocks and every string of `structuredContent`), so a view written for Claude reads values out of the fence. Claude scopes app-visible tools by server, not by view, so there a view can also reach another page's tools (each still only a declared, non-destructive one, run as the board's own route). A proposed setting there is saved by asking Claude to apply it
  (`change_settings`).
- **A view's job:** the module's state and its feature settings, empty states that say how to connect. The example
  (`web/dev/example-view.html`, the mock API's Notes page) is the starting point: no build step, about 100 lines.

Reviews is still native board code reading `providers.board`; moving it to a view is the follow-up.

## Working on the UI without an instance

`node web/dev/mock-api.ts` answers the board's reads on :3120 with neutral fixtures, and `npm run dev:web` serves the
UI against it on :5173. `GET /__mock?welcome=1` shows the first-run wizard, `?empty=1` empties the lists, `?slow=800`
delays every answer (loading states). Check a change at 1512, 1920, 2560 and 390 wide, light and dark, chat first.
