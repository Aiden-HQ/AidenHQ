# Guidelines

How AidenHQ apps work. Apps are built on **shadcn/ui + Tailwind CSS** (Radix primitives, lucide icons) from the app
starter (`modules/apps-platform/starter/`), themed by this design system's `tokens.css` and `shadcn.css`.

These are the **floors** every app meets, and the stack it is built on. The look (layout, navigation, colour, type,
density, depth, motion) is the designer's, made for each app's people and job. What blocks a pull request is in
`review-checklist.md`.

## Design for the job

- **Start from the people and the job:** who uses this, what they come to do, what they must see first. Every screen
  answers one main question and makes its next step obvious, in plain words anyone follows.
- **Truthful:** show what the data supports; unknown stays unknown, and a derived fact links to its source when there
  is one.
- **A redesign may change what the screen does:** drop, merge or add functions, views and sections when that serves the
  people better; today's screen is evidence. The UI/UX Designer's plan and hand-off list what changes, and a change
  that only restyles keeps everything people could see and do.
- **Plan, then mockup.** A new app, a new screen or a major UI change starts with the UI/UX Designer's plan and mockup,
  and the build matches the mockup. Small edits go straight to the build.

## Words and motion

- **Buttons say what happens:** a verb plus its object ("Save changes", "Invite teammate", "Export report"). Headings
  name the thing the section holds ("Open invoices", "Team members"). Numbers come from the data, and copy is written
  for this app's people in the plain voice of a colleague.
- **Motion is quiet feedback:** a button steps on hover and presses to scale .985 for 90ms (`--duration-press`); a card
  inside a link lifts 1px with a soft shadow; a field's focus ring is 3px. Enters ease out (`--ease-out`) over
  `--duration`, exits take `--duration-exit` (shorter).
- **Reduced motion keeps what it can:** with `prefers-reduced-motion` the durations, fades, colour and shadow changes,
  the press and small lifts all stay, and only large movement goes (slides and translations over about 8px, parallax,
  looping animation, big scale-ins); size a slide as `calc(24px * var(--motion-distance))`, which is 0 there.

## Floors

- **Readable contrast in both themes:** text, icons, control borders and focus rings stand out clearly from what is
  behind them, in light and in dark.
- **Visible focus:** everything interactive shows a clear focus ring when reached from the keyboard.
- **Details live in the URL:** opening an item shows it in a `Sheet` (or a page for long detail) whose state is in the
  URL (`?item=…`, added with `push`). Loading that URL opens the same item, so a link can be shared and a refresh keeps
  it; Back closes it, and the list keeps its scroll and filters.
- **Every page has its own URL:** a link click, Back and Forward, and a reload of that URL all show the same page,
  with the state the URL carries (`?item=`, filters). The starter's navigation (`src/lib/navigation.tsx`: `Link`,
  `useLocation`, `useUrlState`) does this; the server answers 200 for every route.
- **Times in the viewer's own zone:** the server stores and sends instants (ISO 8601 with `Z`, or epoch ms), and the page
  formats them in the browser (`Intl.DateTimeFormat` or `toLocaleString` with no `timeZone`; `<time datetime>` with the
  kit's relative time on a server-rendered page). A calendar date (`YYYY-MM-DD`, a due day) stays a date, read as local.
- **Empty, loading and error states** for every data view, written for that view, where the content would be. Empty:
  what goes here and the one action that fills it (after filtering: say that nothing matches and offer Clear filters).
  Loading: a skeleton shaped like the content (`role="status"`). Error: what went wrong in plain words, what was kept,
  and Try again (`role="alert"`).

## The stack

- **shadcn/ui + Tailwind on the starter,** colours from the theme's names (`bg-background`, `text-muted-foreground`,
  `bg-primary`, `text-danger`, `bg-chart-1`…) so light and dark both work, `tokens.css` and `shadcn.css` vendored as
  they are (re-theme in the app's `theme.css`, in light and dark), and the strict CSP: scripts and styles come from the
  app itself, with the nonce.
- **The starter's blocks, shells and presets are a menu:** `src/components/blocks/` (page header, stat strip, sortable
  table pieces, board, activity list, states, detail list, form layout, charts, pickers, timeline, stepper, settings
  rows, KPI cards, shells) has variants; an app imports what it uses, and only that is built. When shadcn lacks a
  component, take it from Origin UI (`originui.com`, MIT, Radix + Tailwind source through the shadcn CLI). Motion comes
  from CSS and the theme's `--duration` and `--ease`; charts from the starter's chart library.
- A component two apps change the same way moves into the starter. Every theme change keeps all palettes and presets
  readable in light and dark and the starter's catalog (`bun run catalog`,
  dev-only) clean in `ui-review`.
