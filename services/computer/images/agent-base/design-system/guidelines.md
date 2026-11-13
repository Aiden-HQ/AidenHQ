# Guidelines

How AidenHQ apps look and behave. Engineers build to these rules with the kit's components; the UI/UX Engineer reviews
every UI pull request against [review-checklist.md](review-checklist.md). Each rule is short on purpose: follow it, or
write down why not in the PR.

## 1. Principles

1. **Answer first.** Every screen opens on what needs attention and the current state of things. Details, history and
   settings are one step away, never in front of the answer.
2. **Simplest thing that works.** One primary action per view, fewer controls, fewer options. Add nothing "just in
   case": a control earns its place when people ask for it or use it.
3. **Phone first.** Design at 390px, then give it room. No horizontal page scroll, ever.
4. **The page never jumps.** Filtering, saving and loading update the part that changed, in place. No full reloads, no
   lost focus, no layout shift.
5. **Truthful.** Show only what the data supports: no invented dates, no placeholder arrows, no internal labels, no
   charts that say nothing. Every derived fact links to its source.
6. **Use the kit.** Tokens and catalog components before bespoke CSS. If two apps need a new component, it goes in the
   kit.

## 2. Layout and hierarchy

- **One title per page** (`.title`), section headings (`.heading`) clearly smaller, body one size. Hierarchy comes from
  size, weight and space, in that order; colour and boxes come last. Design it in greyscale first.
- **Page header** (`.page-header`): title, one line of context (owner, freshness), actions on the right. At most one
  `.btn-primary` per view; the others are secondary (`.btn`) or ghost (`.btn-ghost`).
- **Space from the scale only** (`--space-1`…`--space-8`: 4 8 12 16 24 32 48 64). Related things are close and groups
  sit apart. Group with space before adding a border; add a card only when space alone can't group.
- **No cards inside cards.** Don't repeat a three-across card grid of icon, heading and blurb, and don't use a left
  colour stripe as decoration.
- **Width:** reading pages stay narrow (`.page-narrow`, about 72 characters a line). Dashboards and tables use the room
  (`.page-wide`): full width, with the most important block (the board, the list) above secondary feeds.
- **Density:** internal tools may be dense (`data-palette="data"`), but density never shrinks touch targets on phones
  or text below 12px.

## 3. Typography

- The scale only: `--text-xs` 12 (meta, column headers), `sm` 14 (secondary, tables), `md` 16 (body), `lg` 18, `xl` 22,
  `2xl` 28, `3xl` 36. Body line height 1.5, headings 1.25. Nothing under 12px.
- Two weights do the work: regular and semibold (bold for the page title). No italics for emphasis and no gradient text.
- Numbers use tabular figures (`.num`) and are right-aligned in tables. Format numbers and dates with `Intl` for the
  viewer's locale.
- Dates: relative for recent ("2 h ago", `<time data-relative>`), with the absolute date on hover; absolute ("4 Dec")
  beyond a month. Never a bare ISO timestamp.
- Sentence case for everything: titles, buttons, labels. No all-caps labels and no eyebrow text over every heading.

## 4. Colour and themes

- Colours come only from tokens. Light and dark are both required, and the kit makes dark free unless a colour is
  hard-coded.
- Pick a palette with `<html data-palette>`: `neutral` (default), `warm`, `contrast` (high contrast, for people who need
  it or for wall displays) or `data` (dense dashboards). A brand accent goes in a `theme.css` that overrides only
  `--accent*` and `--focus` and is checked for contrast.
- **Contrast (WCAG 2.2 AA):** 4.5:1 for text, 3:1 for large text, icons, control borders and focus rings. The tokens
  pass this; literals and opacity tricks are what fail. Don't put grey text on a coloured background: use that hue's
  ink token.
- **Meaning is never colour alone:** a status is a dot plus a word (`.status`), a badge has text, an error has words.
- Colour is for meaning and the one primary action. Everything else stays neutral.

## 5. Navigation

- Primary destinations are always visible: up to five in `.bottombar` on phone, `.topbar nav` or `.sidebar` on desktop.
  No hamburger menu for main sections, and no control that only appears on hover.
- Mark where the user is (`aria-current="page"`). Every screen has a way back. Links are real `<a href>` elements, so
  Cmd-click and Back work.
- **Details open beside the list, not instead of it:** use a drawer (`a[data-drawer]`) whose URL can be shared; Back
  closes it, and the list keeps its scroll and filters. Use a full page only for long, multi-part detail.
- Command palette (`dialog[data-command]`, Ctrl/Cmd+K) for apps with more than about 20 items to jump to.

## 6. Filters, search and partial updates

- **Filters apply as soon as they change.** No "Apply" or "Show" button: selects, chips and checkboxes apply on change,
  and search applies after a 250ms pause in typing (`form[data-autoapply]`). Keep an Apply button inside the form for
  no-JS use (`data-autoapply-submit`; kit.js hides it).
- **Never reload the page to filter.** Swap only the results region. The search box keeps its focus, caret and text
  while results update.
- **State lives in the URL** (query params, updated with `replaceState`), so a filtered view can be shared and survives a
  refresh. Unknown values in the URL show a clear message and are never silently ignored to return everything.
- **No dead ends:** offer only filter options that have results, or show their counts. Totals, counts and charts always
  match the filters in force. Say how many results there are and announce it (`[data-count]`).
- **Empty after filtering is not "all clear".** Say "No items match these filters" and offer Clear filters. Never show a
  reassuring message ("nothing needs attention") when the filter, not the data, emptied the view.
- Saving uses the same mechanism (`form[data-async]`): the button shows it is busy, the changed region updates, and a
  toast confirms ("Item saved"). Use the action's own name in the confirmation.

## 7. Perceived performance and optimistic UI

- Under 1s, show nothing new. From 1 to 3s, show a skeleton where the content will be (the same shape, so nothing
  jumps) or a spinner in the control. From 3 to 10s, show progress. Beyond 10s, run it as a background job and notify
  when it's done.
- Refreshing a region keeps the old content visible and dimmed (`aria-busy`), never a blank flash.
- Optimistic updates for cheap, reversible actions (toggle, rename, reorder): change the UI at once, roll back with an
  error toast if the server refuses.
- Budgets: LCP under 2.5s, CLS under 0.1, and an interaction responds within 100ms. Give images a width and height.
  Lazy-load below the fold. Paginate or virtualise lists over about 100 rows.

## 8. Empty, loading and error states

Every data view has all three, written for this view:

- **Empty** (`.empty`): what goes here, why it's empty, and the one action that fills it ("Add the first item").
- **Loading** (`.skeleton` shaped like the content, `role="status"`, `aria-busy`): no layout jump when data arrives.
- **Error** (`.error-state`, `role="alert"`): what went wrong in plain words, what was kept ("your filters are kept"), and
  Retry. Never "Something went wrong" on its own, a stack trace or a raw status code.
- Partial data is labelled as partial ("3 of 5 sources answered").

## 9. Forms

- Every control has a visible `<label>`. A placeholder is an example, never the label. Hints go below the field
  (`.hint`, linked with `aria-describedby`).
- Ask for the least: one free-text field plus "the agent fills in what's missing" beats a form of required fields. Say
  in the hint what helps most. Mark the optional fields, not the required ones.
- Use the right `type`, `inputmode` and `autocomplete`. Never block paste. Inputs are 16px on phones so iOS doesn't zoom.
- Validate on submit, then live on the fields that failed. The error sits next to the field, says how to fix it, and
  focus moves to the first error. Keep what the user typed.
- The submit button stays enabled until the request starts, then shows busy (`aria-busy`). Warn before leaving with
  unsaved changes.
- One column. Buttons at the end, primary first, full width on phone.

## 10. Tables or cards

- **A table** when people compare values across rows (status, owner, dates, numbers). **Cards or a list** when each item
  is read on its own or has a varied shape. **A board** when the main question is "what stage is each item in".
- Tables: a sticky header, short column names, one kind of data per column, numbers right-aligned, the most recent first
  by default, sortable headers (`table[data-sortable]`). Leave empty cells blank rather than "—". Wrap rather than
  truncate; when you truncate, put the full text in `title`.
- On phone a table becomes stacked cards (`.table-stack` with `data-label` on every cell), or it scrolls inside its own
  box (`.table-wrap`). The page itself never scrolls sideways.
- Show a page of 25 to 50 rows with pagination or "Load more" (`a[data-load-more]`), not 1,000 rows.

## 11. Drawers, dialogs and destructive actions

- Use a drawer (`dialog.drawer`) for detail and editing beside a list, and a modal (`dialog.modal`) only for a short
  decision. Both trap focus, close on Esc and on the backdrop, and return focus where it was. On phone, the drawer is
  full screen.
- **Destructive actions:** prefer undo (a toast with Undo for about 5s) over a confirmation. When the action can't be
  undone, confirm once (`data-confirm`), name the thing and the consequence in the question, and use the action's verb on
  the button ("Archive", not "OK"). Red is for the confirming step, not every delete link.
- Archive rather than delete wherever the data matters, and keep history.

## 12. Detail views: status first

- Lead with a summary block (`.summary`): the current state as one word with its status colour, the key date, and the
  next step. Someone glancing for five seconds gets the answer.
- Then the essentials as key-value pairs (`.kv`), each with its source link. Then history (`.timeline`), newest first,
  one line per change ("Due date moved 14 Nov → 28 Nov", with its source).
- Hide what doesn't help a glance: internal ids, provenance labels for data imports, trial or backfill markers, and
  fields that are empty.

## 13. Accessibility (WCAG 2.2 AA, built into the kit)

- Semantic HTML first: `<button>` for actions, `<a href>` for navigation, real `<table>`, `<dialog>`, `<label>`. No click
  handlers on `<div>`.
- Every interactive element shows a focus ring (`:focus-visible`, never removed). The keyboard reaches everything in a
  sensible order. A skip link leads to `main`.
- Touch targets are at least 44px on phones (`--tap`) and never under 24px anywhere. Keep 8px between targets.
- Icon-only buttons have an `aria-label`, and decorative icons get `aria-hidden`. Images have alt text that says what
  they show.
- In-place updates announce their result through a live region (kit.js does this through `[data-count]`).
- Respect `prefers-reduced-motion` (the tokens do) and never disable zoom.

## 14. Motion

- Motion only explains a change: something opened, moved or was added. 100ms for small state changes, 160ms by default,
  240ms for drawers. Entering motion decelerates (`--ease-enter`) and exiting motion is faster.
- Animate only `transform` and `opacity`, and never use `transition: all`. Avoid decorative entrance animations and
  hover motion on every card.

## 15. Copy and microcopy

- Plain words in the user's terms, not system terms: "Items", not "records"; "Couldn't save", not "Error 500". No
  internal names, ids or agent jargon on screens people see.
- Buttons say what happens ("Save item", "Archive"). The same action keeps the same word through the flow (the "Archive"
  button leads to an "Archived" toast).
- Sentence case. Short sentences. Active voice. Numerals for counts. Say each thing once: don't let the label, hint and
  intro repeat each other. After drafting, cut a third of the words.
- Error messages say what happened and what to do next, with no blame and no apology.

## 16. Data visualisation

- Chart only what answers a question better than a number or a table. A chart with one point, or one where every point
  falls on the same date, is not drawn: show the number instead.
- Use a bar for comparison, a line for change over time and a stat tile for a single number with its change. No pie
  charts beyond 3 slices, no 3D and no dual axes.
- Use `--chart-1…6` in order, and label series directly or with `.legend` and `.legend-key`. Colour is never the only key.
- Axes start at zero for bars. Show units, and use the same time window as the filters. Every chart has a text
  alternative (`role="img"` and an `aria-label` that states the takeaway).
- Don't invent data points. A missing value is a gap, not today's date or a zero.

## 17. Changing the kit

A component or token joins the kit when two apps need it. Every change keeps all four palettes in light and dark
passing contrast (`scripts/test/design-system.test.mjs`), adds its example to `catalog.html`, keeps `ui-review` of the
catalog at zero blocking, and updates these guidelines when it changes a rule.
