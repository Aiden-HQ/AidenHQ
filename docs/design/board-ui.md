# The board's design system

The board (`services/board/web`) has one kit: tokens in `web/src/ui/tokens.css`, components in `web/src/ui/` (import
from `./ui`), their styles in `web/src/ui/ui.css`. Every part is on `#/design`, in the light and the dark theme side by
side. (Agent-built apps have their own system, shadcn-based: [design-system.md](design-system.md).)

The look: Stripe's polish and Linear's crispness, with more colour. Warm paper background, white surfaces, an indigo
accent, one hue per item (an agent, a module, an app) that colours its face, tab underline and charts. Moderate radius
that shrinks with the element (tags 5px, controls 8px, cards 10px, dialogs 14px), never a pill. Dense but calm.
Fluid at every size: clamp() gutters and type, grids that add columns, never a narrow column on a big screen.

## A new page

Start from the template and add only the page's own layout, in its own small CSS file:

```tsx
<Page>
  <PageHeader title="Apps" sub="What runs on your server." actions={<Button variant="primary">…</Button>} />
  <Section title="Running" count={n}>…</Section>
</Page>
```

An item's page (agent, module, app) adds `crumb`, `face` and `status` to its `PageHeader`, puts `hueClass(name)` on the
`Page`, `Tabs` under the header (each tab its own URL), and `.ui-split` for the work on the left and a rail of
`Card`s with `Facts` on the right.

## What to use for what

| Need | Use |
| --- | --- |
| A state (working, connected, failed, waiting on you) | `StatusDot` with one tone: `working`, `ok`, `needs`, `failed`, `idle`, `done`, `info`, `busy`, `hue` |
| A fact (a count, a kind, a version) | `Tag` (`neutral`, `accent`, `ok`, `needs`, `failed`) |
| The parts of one page | `Tabs` |
| A filter or a choice of two to four values | `Segmented` |
| An action | `Button` / `LinkButton`: one `primary` per view, `quiet` for the least important, `danger` for removal |
| A list of tasks | `ListRows` + `ListRow` |
| A collection of items (modules, apps, connections) | `TileGrid` + `Tile` (one target per tile, its action raised above it) |
| A number and its trend | `StatBlock` (with `bars`) or `BarChart` |
| A few label/value facts | `Card` + `Facts`; a usage bar: `Meter` |
| A form | `Field` (label, control, help or error), `Input`, `Select`, `Switch`, `Checks` |
| A setting on a settings page | `FieldRow`: its name and help on the left, its value or control on the right |
| Something new or wrong above the content | `Banner` (`info`, `warn`, `danger`) with one action |
| Nothing to show | `EmptyState`, which says what to do |
| A short decision or a form that shouldn't leave the page | `Dialog` |
| Extra actions | `Menu` |

## Rules the lint enforces

`npm run lint` in `services/board` (ESLint and stylelint, config only; CI runs it):

- No raw colours (hex, `rgb()`, `hsl()`) outside `tokens.css`, in CSS or in a `className`/`style` string.
- No px font sizes outside `tokens.css`: use a `--text-*` step.
- No class the kit replaced (`web/legacy-classes.json`, each with what to use instead), in `className` or as a CSS rule.

A new token goes in `tokens.css` as `light-dark(light, dark)`, so both themes and `[data-theme]` subtrees work.

## Dark mode and motion

Dark mode is OLED black: the page is `#000`, cards and panels lift on dark-grey surfaces with a faint top highlight
(`--lift`), and status and accent colours are saturated enough to read on black. Motion uses the tokens in `tokens.css`
(`--instant` 90ms for presses, `--fast` 160ms for hovers, `--medium` 220ms for things arriving, `--ease-out` in,
`--ease-in` out); every control shows `--ring` on keyboard focus. `prefers-reduced-motion` makes every transition and
animation instant (`ui.css`), so a page needs no reduced-motion rule of its own.

## Working on the UI without an instance

`node web/dev/mock-api.mjs` answers the board's reads on :3120 with neutral fixtures, and `npm run dev:web` serves the
UI against it on :5173. `GET /__mock?welcome=1` shows the first-run wizard, `?empty=1` empties the lists, `?slow=800`
delays every answer (loading states).
