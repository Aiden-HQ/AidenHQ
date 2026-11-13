# Guidelines

How AidenHQ apps should work and feel. Apps are built on **shadcn/ui + Tailwind CSS** (Radix primitives, lucide icons)
from the app starter (`modules/core/templates/app/`), themed by this design system's `tokens.css` and `shadcn.css`.

Two kinds of rule live here. **Floors** (behaviour, states, accessibility, the stack) hold in every app; only the
review checklist's "Blocking" items and departures from a task's named, agreed mockup block a review. **Craft** (layout, navigation, colour, type, motion) is guidance and examples, not a template:
each app gets the design that fits its people and its job. Nothing here mandates a shell, a palette, a gradient or a page
layout.

## Design for the job

- **Start from the people and the job.** Who uses this, what they come to do, what they must see first. Every screen
  answers one main question and makes its next step obvious. Easy for a non-technical person: plain words, no guessing.
- **Be intentional, not templated.** Give each app a point of view that fits its content: how dense it is, how it is
  laid out, where colour goes, how it moves. Ask "what would a great product team build for exactly these users?", not
  "what does the starter look like?". Defaults are a starting point, never the answer by themselves.
- **Answer first.** A screen opens on what needs attention and the current state of things. Details, history and
  settings are one step away.
- **Simplest thing that works.** Fewer controls, fewer options, one primary action per view. A control earns its place
  when people need it.
- **Truthful.** Show only what the data supports: no invented dates, placeholder arrows, internal labels or charts that
  say nothing. A derived fact links to its source when the source exists.
- **Keep what people rely on.** A redesign may change the layout freely, but what people could see and do (the stages,
  groups, views and fields they use) stays possible unless the request says to drop it. Five stages people track stay
  five visible stages, however they are drawn.
- **Mockup first for anything new.** A new app, a new screen or a major UI change starts from the UI/UX Designer's
  agreed mockup, and the build matches it. Small edits don't need one.

## Layout and navigation

- **Navigation fits the destinations:** how many there are, how they group and how often people switch. A single
  screen may need none; a few often suit a slim top bar or tabs; many or nested ones may earn a sidebar; a command menu
  (Ctrl/Cmd+K) helps past about 20 things to jump to. A full-height sidebar for three links is wasted weight.
- **Details slide in over the work.** Opening an item shows it in a `Sheet` (from the right, full width on phone) whose
  state is in the URL (`?item=…`, added with `push`): it can be shared, Back closes it, and the list keeps its scroll and
  filters. A permanent column beside the main content is only for work that is genuinely side by side (comparing two
  things, editing while reading); it never squeezes the main view. A full page is for long, multi-part detail.
- **Hierarchy from size, weight and space,** then colour, then boxes. One clear page title, a visible type scale, and
  the important thing on each screen obvious at a glance. Squint: the sections shouldn't all look the same.
- **Surfaces stay flat.** Group with space, dividers and headings rather than boxes inside boxes.
- **Dense without clutter.** Everything fits comfortably with little wasted space: no large empty patches, no oversized
  type or controls, nothing cramped. Density comes from compact rows and tight grouping, not tiny text.
- **Width fits the content.** Tables and boards use the room; prose and forms stay near 72 characters a line.
- **Works on a phone.** Every app is usable at 390px: nothing cut off, no sideways page scroll, main destinations
  reachable without a hamburger menu, no control that only appears on hover. Mockups are desktop unless asked.
- **Navigation basics:** mark where the user is (`aria-current`), give every screen a way back, and use real `<a href>`
  links so Cmd-click and Back work.

## Emphasis, colour and type

- **Headline only what matters.** Each view has one primary action and, at most, one figure or item that deserves the
  eye. Strong colour, a heavy weight or a gradient are spent there, sparingly, and only when they earn attention.
  Everything else stays calm. No large gradient blocks, gradient backgrounds or gradient text.
- **Colour with intent:** the primary action, statuses, chart series and the current place in the navigation. Enough
  colour that a screen is easy to scan, never decoration that competes with the content.
- **Colours come from the theme's names** (`bg-background`, `text-muted-foreground`, `bg-primary`, `text-danger`,
  `bg-chart-1`…), never literal colours or Tailwind palette colours, so light and dark both work. Pick the palette that
  fits the app (`<html data-palette>`: `neutral`, `warm`, `contrast`, `data`) or give the app its own in a `theme.css`
  that overrides tokens (`--accent*`, `--focus`, `--font`) or shadcn's variables, in light and dark, checked for
  contrast.
- **Status by meaning:** finished is the brand colour, on track `ok`, at risk `warn`, late or blocked `danger`, not
  started grey. A status is a dot or icon plus a word, never colour alone. When every row in a view shares a status,
  drop the status column.
- **Type:** Tailwind's scale, nothing under 12px. The starter ships Inter; an app may choose another self-hosted family
  if it suits the product (one family, two at most). Numbers `tabular-nums`, right-aligned in tables, formatted with
  `Intl`. Dates relative when recent ("2 hours ago"), absolute beyond a month, never a bare ISO timestamp. Sentence case;
  no all-caps labels.

## Data views

- **Pick the form by the question.** Compare values across items: a table. Read each item on its own: a list. What
  stage is each item in: a board with one lane per stage, in flow order, each with its count. What changed: a compact
  activity feed. When things are due: a timeline. A single figure: a number. A grid of look-alike cards answers none of
  these well.
- **Tables:** short column names, one kind of data per column, what needs attention first by default, sortable headers
  that say which way they sort (`aria-sort`), rows that open their detail (with a real link on the name), and 25 to 50
  rows a page. The name column carries the weight; the rest stay quiet. On phone, keep the columns that matter and fold
  the rest under the name, or scroll inside the table's container.
- **Boards:** compact items (the name, a meta line, at most one signal). Past about six stages, a table with a status
  filter reads better.
- **Charts** earn their space: a bar to compare, a line for change over time, marks big enough to see, the axis fitted
  to the data, a text alternative stating the takeaway. A chart of one point is a number. Missing values are gaps, never
  invented points. No pies beyond 3 slices, no 3D, no dual axes.

## Filters, search and updates

- **Filters apply as they change.** No Apply button; search applies as you type (debounce 250ms when it calls the
  server).
- **Never reload the page to filter or save.** Only the changed part updates; the search box keeps its focus and text.
- **State lives in the URL** (the starter's `useUrlState`), so a view can be shared and survives a refresh. An unknown
  value shows a clear message, never silently everything.
- **No dead ends:** offer options that have results, or show counts. Totals, counts and charts match the filters in
  force; the result count is announced (`aria-live="polite"`).
- **Empty after filtering is not "all clear".** Say "No items match these filters" and offer Clear filters.
- **Saving** shows the control busy, updates in place, and confirms in a toast in the action's words, with Undo where it
  can. Cheap, reversible actions update optimistically and roll back with an error if the server refuses.

## States and speed

- **Every data view has its empty, loading and error states,** written for that view, where the content would be.
  Empty: what goes here and the one action that fills it. Loading: a skeleton shaped like the content (`role="status"`).
  Error: what went wrong in plain words, what was kept, and Try again (`role="alert"`). Partial data says it is partial.
- Under 1s show nothing new; 1 to 3s a skeleton or a busy control; longer, progress; beyond 10s a background job.
  Refreshing keeps the old content visible. LCP under 2.5s, CLS under 0.1, interactions answer within 100ms. Paginate or
  virtualise past about 100 rows.

## Detail views, forms and dialogs

- **Detail views lead with the current state:** the status, the key date and the next step, then the facts (each with
  its source), then history newest first, one line per change. Hide internal ids, import markers and empty fields.
- **Forms:** a visible label on every control (a placeholder is an example, not a label), hints and errors under the
  field and wired to it, the right `type` and `autocomplete`, 16px inputs on phones, validate on submit then live on the
  failed fields, keep what was typed, ask for the least. Warn before leaving unsaved changes.
- A `Dialog` only for a short decision; a `DropdownMenu` for row actions. Prefer Undo over confirming; when an action
  can't be undone, confirm once, naming the thing and the consequence, with the action's verb on the button. Archive
  rather than delete where the data matters.

## Motion

Fast and smooth (150 to 250ms, the tokens' `--duration` and `--ease`), never bouncy or playful. Motion answers what a
person did: sheets, dialogs and menus slide and fade, new content fades in where it appears, a pressed button responds.
No looping or decorative animation; at most one deliberate moment per screen that isn't a response. Animate `transform`
and `opacity` only. Reduced motion makes it instant (the theme does this).

## Accessibility (WCAG 2.2 AA)

- Semantic HTML: `<button>` for actions, `<a href>` for navigation, real tables and labels; Radix supplies menus,
  selects, sheets and dialogs, so don't rebuild them.
- Contrast 4.5:1 for text, 3:1 for large text, icons, control borders and focus rings, in both themes. Opacity tricks
  on text are what usually fail.
- A visible focus ring on everything interactive; a skip link to the content; touch targets 44px on phones, never
  under 24px. Icon-only buttons have an `aria-label`. In-place updates announce through a live region. Never disable
  zoom.

## Copy

Plain words in the user's terms ("Projects", not "records"; "Couldn't save", not "Error 500"). No internal names, ids,
raw enum values or agent jargon. Buttons say what happens, and the same action keeps the same word. Short sentences,
active voice, sentence case. Errors say what happened and what to do, with no blame and no apology.

## Generic tells

What makes an agent-built app look assembled rather than designed. Avoid them; they aren't banned when the content
really calls for one.

- A heavy shell for a small app (a full sidebar for three links), or a fixed side panel that squeezes the main view.
- Boxes inside boxes; every section the same heading, sentence and bordered table; the same rows shown twice.
- A grid of look-alike cards for data people compare; a long feed of boxed entries ahead of the main content.
- Big gradient tiles or banners; colour everywhere so nothing stands out; grey on grey so nothing does either.
- Decoration as information: coloured stripes, uppercase eyebrow labels or provenance pills on every item.
- Raw data on screen: ISO timestamps, internal markers, arrows between raw dates.

## The stack and its building blocks

- **The stack is fixed:** shadcn/ui + Tailwind on the starter, colours from the theme's names, `tokens.css` and
  `shadcn.css` vendored unchanged (re-theme in `theme.css`), and the strict CSP (no inline scripts, no CDN, no
  `'unsafe-inline'`).
- **The blocks are optional.** `src/components/blocks/` (page header, stat strip, sortable table pieces, board,
  activity list, states, detail list, form layout, charts, a sidebar shell for apps with many destinations) and the starter's shell and example page are there to use,
  adapt or ignore. They save time and already meet the floors; they are not the required design.
- When shadcn lacks a component, take it from Origin UI (`originui.com`, MIT, Radix + Tailwind source through the
  shadcn CLI). No animation or effects libraries, and no second chart library while the starter's charts cover the need.
- A component two apps change the same way moves into the starter. Every theme change keeps all four palettes AA in
  light and dark (`scripts/test/design-system.test.mjs`) and the starter's `/catalog` clean in `ui-review`.

## The owner tends to like

One reference point, not a rule: Stripe's polish on Linear's crisp, efficient layout, with a bit more colour; moderate
corners, no pill buttons, normal-size type, little white space, professional rather than playful or childish.
