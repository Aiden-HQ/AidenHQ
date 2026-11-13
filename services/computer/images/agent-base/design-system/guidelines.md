# Guidelines

How AidenHQ apps look and behave. Apps are built on **shadcn/ui + Tailwind CSS** (Radix primitives, lucide icons) from the
app starter (`modules/core/templates/app/`), themed by this design system's `tokens.css` and `shadcn.css`. Engineers build
to these rules; the UI Reviewer reviews every UI pull request against [review-checklist.md](review-checklist.md). Each
rule is short on purpose: follow it, or write down why not in the PR.

## 1. Principles

1. **Polished, crisp and easy for anyone.** The bar is Stripe's polish on Linear's crisp, efficient layout, with a
   little more colour: professional, never childish or playful, and easy for a non-technical person (plain words, an
   obvious next step on every screen). The primary action and the key figures stand out; everything else stays calm.
2. **Answer first.** Every screen opens on what needs attention and the current state of things. Details, history and
   settings are one step away, never in front of the answer.
3. **Simplest thing that works.** One primary action per view, fewer controls, fewer options. Add nothing "just in
   case": a control earns its place when people ask for it or use it.
4. **Phone first.** Design at 390px, then give it room. No horizontal page scroll, ever.
5. **The page never jumps.** Filtering, saving and loading update the part that changed, in place. No full reloads, no
   lost focus, no layout shift.
6. **Truthful.** Show only what the data supports: no invented dates, no placeholder arrows, no internal labels, no
   charts that say nothing. Every derived fact links to its source.
7. **Compose, don't invent.** Pages are built from the starter's building blocks (`src/components/blocks/`: page
   header, page split, stat strip, sortable paged table, board, activity list, states, detail list, form layout,
   charts), shadcn/ui components from `src/components/ui/` and the theme's colour names, before anything bespoke. Copy
   patterns from the starter's example page and `/catalog`. Never bend content into the wrong block because it's the
   one that exists: if no block fits, compose it from shadcn components and theme names and propose the block.
8. **Mockup first for anything new.** A new app, a new screen or a major UI change starts from the UI/UX Designer's
   mockup, and the build matches it. Small edits don't need one.
9. **Keep the structure people rely on.** A redesign changes how things look, not how they're organised. The groups,
   lanes, views and columns people use today stay unless the request says to change them: five lanes stay five lanes
   (restyled), not tabs over one table.

## 2. Composition and hierarchy

Most of what makes a page look generic or dated is composition, not colour. These rules come first in every review.

- **One surface per section.** A section sits on the page background, or in one bordered container (a table, a summary
  strip, a form card). Never a bordered box inside another bordered box: **at most one level of border** between the page
  and the content. Group inside a container with space, a divider (`Separator`, `divide-y`) or a heading, not another box.
- **Pick the block by the question** (§10): compare values across items → table; what is in each stage → board (the
  `Board` block's lanes); what happened → activity list; when is each thing due → schedule chart. No grid of
  look-alike cards for any of them. A card is for one object or one settings group. A summary of numbers is one strip
  split into cells (`StatStrip`), not four floating cards.
- **A clear type scale.** One page title (`text-2xl font-bold tracking-tight`), section headings (`text-lg font-semibold
  tracking-tight`, the `PageSection` block), item names `text-sm font-medium`, body `text-sm`, meta `text-xs
  text-muted-foreground`. Hierarchy comes from size, weight and space, in that order; colour and boxes come last. Design
  it in greyscale first.
- **Vary the rhythm.** A page that repeats heading, sentence, bordered table, heading, sentence, bordered table looks
  assembled from a catalog. Give each section the form its content needs (a board, a compact list, a chart, a rail),
  put secondary things (a recent-changes feed, related items, a detail page's facts) in a side rail on wide screens
  (`PageSplit`) instead of another full-width section, and don't show the same rows twice on one screen.
- **Comfortable, not sparse.** Everything takes the space it needs and fits comfortably: no large empty patches, no
  oversized type or controls (normal-size text, not zoomed in), little wasted space, nothing cramped. Sections `gap-6`
  (24px) apart, page padding `px-4 py-5` on phones and `md:px-8 md:py-8` on desktop, related things `gap-2`/`gap-4`
  (the `Page` block does this). Space from Tailwind's scale only; no arbitrary pixel values.
- **No grey on grey.** Content sits on `bg-background` (or the sidebar's `bg-sidebar`). A muted fill (`bg-muted`) marks
  one thing (a table header row, a selected item, a skeleton, a board lane holding items on the background), never a
  container holding other muted things. Secondary
  text is `text-muted-foreground` on `bg-background`, never on `bg-muted` inside a card.
- **Decoration earns nothing.** No left colour stripes, no uppercase eyebrow labels over every item, no pills for metadata
  that isn't a status, no shadows on things that don't float (only popovers, sheets, dialogs and toasts have shadows, plus the primary
  button's slight lift).
- **Shape:** moderate radii from the tokens (6px controls, 8 to 10px cards and panels). Never pill or oval buttons;
  only tiny badges, avatars and switches are round.
- **Key figures and the primary action stand out:** the primary button is the one filled, lit control in a view; the
  hero cell goes to the page's headline figure: the total on a plain list, but on a page that exists to drive
  decisions, the count that needs one;
  a figure that needs attention takes its status tone (`tone`); a zero stays plain (no tone, no coloured dot); other
  figures stay plain.
- **Page header:** title, one line of context (what this is, freshness), actions on the right. At most one primary
  (`Button` default variant) per view; the others are `outline`, `secondary` or `ghost`.
- **Width:** dashboards and tables use the room (`max-w-6xl`); reading and forms stay narrow (`max-w-2xl`, about 72
  characters a line). The most important block (the table, the board) comes before secondary feeds; a feed is capped
  (`ActivityList limit`) in a side rail, with a link to the rest. Long prose (a description, a "why") is capped at
  about 72 characters a line even on a wide page.
- **Density:** comes from tables (compact rows, `text-sm`), not from shrinking type or cramming cards. The `data` palette
  tightens everything for dense internal dashboards. Density never shrinks touch targets on phones or text below 12px.

## 3. Typography

- Tailwind's scale only, driven by the tokens: `text-xs` 12 (meta, column headers), `text-sm` 14 (tables, controls,
  secondary), `text-base` 16 (reading), `text-lg` 18, `text-xl` 22, `text-2xl` 28, `text-3xl` 36 (big numbers). Nothing
  under 12px.
- Strong, crisp type: bold (`font-bold tracking-tight`) for the page title and key figures, semibold for headings and
  badges, `font-medium` for controls and table names, regular for the rest. No italics for emphasis and no gradient
  text. The starter ships Inter (self-hosted); keep one family.
- Numbers use `tabular-nums` and are right-aligned in tables. Format numbers and dates with `Intl` for the viewer's
  locale.
- Dates: relative for recent ("2 hours ago"), absolute ("4 Dec") beyond a month, and the absolute date on hover or nearby.
  Never a bare ISO timestamp.
- Sentence case for everything: titles, buttons, labels. No all-caps labels.

## 4. Colour and themes

- Colours come only from the theme's names (`bg-background`, `text-foreground`, `text-muted-foreground`, `bg-primary`,
  `text-link`, `border-border`, `bg-ok-soft`, `text-danger`, `bg-warn-solid`, `bg-chart-1`…). No literal colours, no
  `text-white`/`bg-black`, no Tailwind palette colours (`bg-blue-500`). Tailwind's `accent` is the subtle hover fill; the
  brand colour is `primary`.
- Light and dark are both required. `dark:` follows `<html data-theme>`, set from the system or the viewer's choice; the
  theme makes dark free unless a colour is hard-coded.
- The default (`neutral`) is crisp and colourful: a deep sidebar, one saturated indigo, outlined status badges, and a
  violet-to-indigo gradient (`bg-primary-gradient`) on exactly three things: the primary action, the current navigation
  item and the page's one hero figure (StatStrip `tone: "hero"`). Trends are a smooth line over a soft area.
- Pick a palette with `<html data-palette>`: `neutral` (default), `warm`, `contrast` (high contrast) or `data` (dense
  dashboards). Re-theme in a `theme.css` that overrides only tokens (`--accent*`, `--focus`, `--font`) or shadcn's
  variables, in light and dark, checked for contrast.
- **Contrast (WCAG 2.2 AA):** 4.5:1 for text, 3:1 for large text, icons, control borders and focus rings. The tokens
  pass this; literals and opacity tricks (`text-foreground/50`) are what fail. Don't put grey text on a coloured
  background: use that hue's ink (`text-ok` on `bg-ok-soft`).
- **Meaning is never colour alone:** a status is a dot plus a word, a badge has text, an error has words.
- Colour with intent: the primary action, statuses (the outlined `StatusBadge`: dot plus word, or a lane's dot), chart
  series, the current place in the navigation, and the icons of empty states in the primary's soft tint. Gradients only
  where the theme puts them (the three things above, plus the logo); no gradient backgrounds or gradient text. Enough
  colour that a screen feels alive and is easy to scan; never decoration that competes with the content, and never
  colour alone carrying meaning.
- **Status colours by meaning:** finished (done, shipped, closed) is the brand colour, on track is `ok`, at risk
  `warn`, late or blocked `danger`, not started or unknown grey. Grey for good news reads as disabled. When every row in
  a view has the same status (a lane, a tab, a filtered list), drop the status column: it's the heading already.

## 5. Navigation

- Primary destinations are always visible: the `Sidebar` on desktop, a bottom bar of up to five on phones. Never a
  hamburger menu or the sidebar-in-a-sheet for main sections on phones, and no control that only appears on hover.
- Mark where the user is (`aria-current="page"`, `isActive`). Every screen has a way back. Links are real `<a href>`
  elements, so Cmd-click and Back work.
- **Details open beside the list, not instead of it:** a `Sheet` whose state is in the URL (`?item=…`, added with
  `push`), so it can be shared; Back closes it, and the list keeps its scroll and filters. Use a full page only for long,
  multi-part detail.
- A command menu (shadcn `Command` in a `Dialog`, Ctrl/Cmd+K) for apps with more than about 20 things to jump to.

## 6. Filters, search and partial updates

- **Filters apply as soon as they change.** No "Apply" or "Show" button: selects, toggles and checkboxes apply on change,
  and search applies as you type (debounce 250ms when it calls the server).
- **Never reload the page to filter.** Only the results change. The search box keeps its focus, caret and text while
  results update.
- **State lives in the URL** (query params, updated with `replaceState`; the starter's `useUrlState`), so a filtered view
  can be shared and survives a refresh. Unknown values in the URL show a clear message and are never silently ignored to
  return everything.
- **No dead ends:** offer only filter options that have results, or show their counts. Totals, counts and charts always
  match the filters in force. Say how many results there are and announce it (`aria-live="polite"`).
- **Empty after filtering is not "all clear".** Say "No items match these filters" and offer Clear filters. Never show a
  reassuring message ("nothing needs attention") when the filter, not the data, emptied the view.
- Saving updates the changed part in place: the control shows it is busy, the row or region updates, and a toast confirms
  in the action's own words ("Status changed"), with Undo where it can.

## 7. Perceived performance and optimistic UI

- Under 1s, show nothing new. From 1 to 3s, show a `Skeleton` shaped like the content (so nothing jumps) or a spinner in
  the control. From 3 to 10s, show progress. Beyond 10s, run it as a background job and notify when it's done.
- Refreshing keeps the old content visible (dimmed if it helps), never a blank flash.
- Optimistic updates for cheap, reversible actions (toggle, rename, status): change the UI at once, roll back with an
  error toast if the server refuses.
- Budgets: LCP under 2.5s, CLS under 0.1, and an interaction responds within 100ms. Give images a width and height.
  Paginate or virtualise lists over about 100 rows.

## 8. Empty, loading and error states

Every data view has all three, written for this view, in the place the content would be (one container, no nesting):

- **Empty:** what goes here, why it's empty, and the one action that fills it ("Add the first project").
- **Loading:** `Skeleton` rows shaped like the content, `role="status"`, `aria-busy`.
- **Error:** what went wrong in plain words, what was kept ("your filters are kept"), and Try again, `role="alert"`.
  Never "Something went wrong" on its own, a stack trace or a raw status code.
- Partial data is labelled as partial ("3 of 5 sources answered").

## 9. Forms

- Every control has a visible `Label`. A placeholder is an example, never the label. Hints go below the field, linked
  with `aria-describedby`; an invalid field gets `aria-invalid` and its error text below it.
- Ask for the least: one free-text field plus "the agent fills in what's missing" beats a form of required fields. Mark
  the optional fields, not the required ones.
- Use the right `type`, `inputmode` and `autocomplete`. Never block paste. Inputs are 16px on phones (the starter's
  `Input` does this) so iOS doesn't zoom.
- Validate on submit, then live on the fields that failed. Focus moves to the first error. Keep what the user typed.
- The submit button stays enabled until the request starts, then shows busy. Warn before leaving with unsaved changes.
- One column. Buttons at the end, primary first, full width on phone.

## 10. Tables, lists and boards

- **A table** when people compare values across rows (status, owner, dates, numbers). **A list** when each item is read
  on its own. **A board** when the main question is "what stage is each item in". Cards in a grid are none of these.
- **Boards:** the `Board` block, one lane per stage or status in the order work flows, side by side on desktop (stacked
  on phones), each with its count. Up to about six lanes; more stages means a table with a status filter. Items are
  compact (the name, one meta line, at most one signal such as a slip or an owner): no status pill inside a lane that
  already names the status, no stripes. A long lane shows its first items and Show all. An app that has lanes keeps
  them; a table view beside the board (`?view=`) is fine, replacing the board isn't.
- Tables: one bordered container (`rounded-xl border`, `overflow-hidden`), a muted header row, short column names, one
  kind of data per column, numbers right-aligned, what needs attention first by default, sortable headers that say which
  way they sort (`aria-sort`). Leave empty cells blank rather than "—". Rows open their detail (click and a real link on
  the name). The name column carries the weight (`font-medium`, with a meta line under it instead of a low-value
  column); the rest stay regular or muted, so a table isn't a grid of equally loud cells.
- On phone, keep the two or three columns that matter and fold the rest into a second line under the name
  (`md:hidden`), or let the table scroll inside its container. The page itself never scrolls sideways.
- Show a page of 25 to 50 rows with pagination or "Load more", not 1,000 rows.

## 11. Sheets, dialogs and destructive actions

- A `Sheet` for detail and editing beside a list (full width on phone), a `Dialog` only for a short decision, a
  `DropdownMenu` for row actions. Radix handles focus trapping, Esc, the backdrop and returning focus.
- **Destructive actions:** prefer undo (a toast with Undo for about 5s) over a confirmation. When the action can't be
  undone, confirm once in a `Dialog`, name the thing and the consequence in the question, and use the action's verb on the
  button ("Archive", not "OK"). The `destructive` variant is for the confirming step, not every delete link.
- Archive rather than delete wherever the data matters, and keep history.

## 12. Detail views: status first

- Lead with the current state: the status (dot and word), the key date, and the next step. Someone glancing for five
  seconds gets the answer.
- Then the essentials as label-value pairs (`DetailList`), each with its source link. Then history, newest first, one
  line per change ("Due date moved out by five days", with its source) in an `ActivityList`, not a box per change; the
  same date isn't repeated on every line. On a full detail page, the facts sit in a side rail (`PageSplit`) beside the
  status and history.
- Hide what doesn't help a glance: internal ids, provenance labels for data imports, trial or backfill markers, and
  fields that are empty.

## 13. Accessibility (WCAG 2.2 AA)

- Semantic HTML first: `<button>` for actions, `<a href>` for navigation, real `<table>`, `<label>`. No click handlers on
  `<div>` (a clickable row also has a real link). Radix supplies roles and keyboard behaviour for menus, selects, sheets
  and dialogs: don't rebuild them.
- Every interactive element shows a focus ring (`focus-visible:ring-[3px] ring-ring` at full strength, never removed or faded with an opacity). A skip link leads
  to the content.
- Touch targets are at least 44px on phones (the starter's buttons, inputs and selects are `max-sm:h-11`) and never under
  24px anywhere.
- Icon-only buttons have an `aria-label`; decorative icons get `aria-hidden`. Images have alt text that says what they
  show.
- In-place updates announce their result through a live region. Respect `prefers-reduced-motion` and never disable zoom.

## 14. Motion

- Motion is smooth and fast (150 to 250ms), never bouncy, springy or playful, and never janky: it explains every
  change and is part of the polish: sheets, dialogs, menus and toasts slide and fade in and out
  (the components' `animate-in`/`animate-out`); new content and state panels fade in where they appear; rows that
  arrive after a filter fade in; buttons answer a press (`active:scale`) and hover. A change with no motion feels
  broken; motion with no change is noise (no looping or decorative animations).
- Durations and easing come from the tokens: transitions default to `--duration` and `--ease`, and an animation you
  add names one (`duration-(--duration-slow)`), never a literal. The shadcn components' own open and close animations
  keep their built-in timings. Animate `transform` and `opacity` only, never
  `transition: all`. Reduced motion (`prefers-reduced-motion`) makes it all instant, which the theme does for you.

## 15. Copy and microcopy

- Plain words in the user's terms, not system terms: "Projects", not "records"; "Couldn't save", not "Error 500". No
  internal names, ids, raw enum values or agent jargon on screens people see.
- Buttons say what happens ("Save project", "Archive"). The same action keeps the same word through the flow.
- Sentence case. Short sentences. Active voice. Numerals for counts. Say each thing once. After drafting, cut a third of
  the words.
- Error messages say what happened and what to do next, with no blame and no apology.

## 16. Data visualisation

- Chart only what answers a question better than a number or a table. A chart with one point, or one where every point
  falls on the same date, is not drawn: show the number instead.
- A bar for comparison, a line for change over time, a number in the summary strip for a single figure. No pie charts
  beyond 3 slices, no 3D and no dual axes.
- Use `chart-1…6` in order, and label series directly or with a legend. Colour is never the only key. Axes start at zero
  for bars; show units; use the filters' time window. Every chart has a text alternative stating the takeaway.
- Don't invent data points. A missing value is a gap, not today's date or a zero.
- **Dates on a calendar** (due dates, launches, first plan versus now): `ScheduleChart`, one compact line per item, the
  axis fitted to the dates (not a fixed quarter that leaves most of the width empty), marks you can see (a 12px point,
  a bar for a moved date), today marked. Undated items are listed beside it, never plotted at a made-up date. It is the
  view of those rows: don't repeat them as a table under it (offer a table view instead).
- **A chart earns its space:** marks big enough to see, most of its area carrying data, and the takeaway readable in five
  seconds. A chart that is mostly empty space, or tiny marks in one corner, is redrawn (fit the axis, change the form)
  or replaced by a number.

## 17. Anti-patterns

What made earlier agent-built apps look generic and dated. Each one blocks a review.

- **Boxes inside boxes.** A page wrapped in a bordered panel, holding bordered sections, holding bordered cards, holding
  bordered pills: four nested outlines before any content. Fix: content on the page background, one container per
  section, dividers inside it.
- **Everything is a card.** A grid of look-alike cards for data people compare, a long feed of near-identical boxed
  entries (one per change) taking the whole first screen, and board items stuffed with pills, stripes and every field.
  Fix: a table for comparing, `ActivityList` capped in a side rail for changes, and for stages the `Board` block's
  compact items (the lanes stay).
- **Flattened structure.** A redesign that turns lanes into tabs over one table, drops a view or merges groups people
  used, because a rule or block seemed to call for it. Fix: keep the structure (§1.9) and restyle it.
- **Uniform chrome.** Every section the same heading, sentence and bordered table, every cell the same weight, a column
  of identical grey badges, the same rows shown twice. Fix: the block that fits each section's question, a side rail,
  weight on the name column, status colours by meaning (§4), one view per set of rows.
- **Sparse charts.** A fixed time window with the data bunched in one corner, dots a few pixels wide, a chart then a
  table of the same rows. Fix: §16.
- **Grey on grey.** Dark panels on a page of almost the same shade, muted text on muted fills, so nothing stands out
  and contrast falls below AA. Fix: one background, one surface, muted fill only for a header row or a selection.
- **Weak hierarchy.** The title, section headings and item names at almost the same size and weight, with small grey meta
  lines doing the work. Fix: the type scale in §2, and fewer things per item.
- **Decoration as information.** A coloured left stripe and an uppercase eyebrow label ("NEW", "UPDATED") on every
  entry, and a pill on every item saying where the data came from. Fix: the status as a dot plus a word, provenance in
  the detail sheet's source link, nothing on the list.
- **Raw data on screen.** ISO timestamps, arrows between raw dates, internal markers (which import or
  pipeline produced a row). Fix: formatted dates (§3), plain words (§15), internal labels hidden (§12).
- **Dated controls.** Native-looking selects and buttons at different heights with ad-hoc borders. Fix: the shadcn
  components at their default sizes, one control height per toolbar.

## 18. Changing the design system

**Beyond shadcn/ui:** when a needed component isn't in shadcn, take it from Origin UI (`originui.com`, MIT; plain
Radix + Tailwind source through the shadcn CLI, no extra runtime library), with the same fix-ups, pinning and CSP check.
No animation or effects libraries (Magic UI, Aceternity and the like): their motion is decorative and playful, and they
add runtime dependencies. No second chart library while BarList, TrendChart and ScheduleChart cover the need.

The theme (`tokens.css`, `shadcn.css`) is the product's; apps vendor both unchanged. A new component comes from shadcn
(`npx shadcn@<pinned> add <name>`, then the fix-ups in the starter's README) into the app's `src/components/ui/`; when two apps change a component the same way, the
change goes into the starter. Every theme change keeps all four palettes in light and dark passing contrast
(`scripts/test/design-system.test.mjs`), keeps the starter's `/catalog` at zero blocking in `ui-review`, and updates
these guidelines when it changes a rule.
