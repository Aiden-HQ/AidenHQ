# UI review checklist

The UI Reviewer applies this to every pull request that changes what people see; the UI/UX Designer applies it in an app's design audit and to its own mockups.

1. **Evidence first.** Run `ui-review <url> --paths <changed pages> --out after` (and `--baseline before` against the
   base commit when you can run both). Open every screenshot. axe and the layout checks are authoritative on what they
   measure; your eyes judge the rest, starting with composition (guidelines §2 and §17).
2. **Go through the list below**, phone first. Then the five-second test on the full-page desktop screenshot: the
   answer, the key figure and the primary action jump out; squinting, the sections don't all look the same; nothing is
   cut off or left as a large empty patch. Compare it with the starter's `/catalog` blocks: it should look at least as
   finished.
3. **Report:** blocking items first, each with the screenshot, the selector or region, the rule (a section of
   guidelines.md) and the fix. Then the backlog. Cap it at 10 findings and pick the ones that matter most.

## Blocking: the PR needs a fix

**Can't use it**
- [ ] Something can't be done, read or reached at 390px (cut off, overlapping, off-screen, hover-only).
- [ ] The page scrolls sideways at any width (a table may scroll inside its own container).
- [ ] An action gives no feedback: no busy state, no confirmation, a silent failure.
- [ ] A screen has no way back, or a primary destination is hidden behind a menu (a hamburger or the sidebar-in-a-sheet
      on phones).

**Accessibility (axe serious or critical, or seen)**
- [ ] Text contrast is under 4.5:1, or a control border, icon or focus ring is under 3:1, in either theme.
- [ ] Light or dark mode is broken: literal colours (`text-white`, `bg-gray-*`, hex values), invisible elements.
- [ ] A control has no label or accessible name, or focus is invisible or lost, or the keyboard can't reach a control.
- [ ] A phone tap target is under 24px, or a main control is under 44px.
- [ ] Meaning is carried by colour alone.

**Composition (the generic, dated look)**
- [ ] A bordered box inside another bordered box: more than one level of border between the page and the content.
- [ ] The wrong block for the question (guidelines §2, §10): a grid of cards for data people compare (a table), stages
      shown as tabs or one table where lanes belong (a `Board`), or a long feed of boxed entries ahead of the main content.
- [ ] Uniform chrome: every section the same heading and bordered table, the same rows shown twice on one screen, or a
      column of identical badges.
- [ ] A chart that is mostly empty space or has marks too small to read (guidelines §16).
- [ ] Grey on grey: a muted fill holding muted fills or muted text; panels on a near-identical background.
- [ ] No clear hierarchy: the title, section headings and item names at about the same size and weight.
- [ ] Decoration as information: coloured stripes, uppercase eyebrow labels or provenance pills on every item.

**Behaviour the owner has had to correct before**
- [ ] A redesign drops or flattens structure people rely on (lanes, groups, a view, a column) that the request didn't
      ask to change (guidelines §1.9).
- [ ] On a full-page desktop screenshot, the sidebar stops partway down (copy `ui/sidebar.tsx` from the current starter).
- [ ] A filter or search needs an Apply/Show button, or reloads the whole page, or loses focus or typed text while
      updating.
- [ ] Filter state isn't in the URL; an unknown filter value silently shows everything; an option leads to a dead-end
      empty view.
- [ ] Counts, totals or charts disagree with the filters in force.
- [ ] A data view lacks its empty, loading or error state, or shows a reassuring empty message ("all clear") when a
      filter emptied it.
- [ ] A detail view doesn't lead with the current status; the answer is buried under history or raw fields.
- [ ] Details replace the list in a full page load where a sheet would keep the user's place, or the open detail isn't
      in the URL (Back doesn't close it, it can't be shared).
- [ ] Invented or misleading data: a fabricated date, a dangling "→", a chart with nothing to compare, a wrong bucket
      label ("Later" holding overdue items).
- [ ] Internal labels on screen: ids, trial or backfill markers, agent names, raw enum values, ISO timestamps.
- [ ] A derived fact with no link to its source, where the source exists.

**System**
- [ ] Not on the stack: a new app that isn't built from the app starter (shadcn/ui + Tailwind), a second UI library, or
      a hand-built control or pattern where a shadcn component or a starter block exists.
- [ ] A second, different style for the same component on one screen, or more than one primary button in a view.
- [ ] The vendored `tokens.css` or `shadcn.css` edited, or not at the current version.
- [ ] Console errors or CSP violations (open a sheet, a select and a toast), `'unsafe-inline'` or a CDN in the CSP, or
      LCP over 2.5s or CLS over 0.1 on seeded data.

## Backlog: file it, don't block

- Spacing a step off the scale, copy polish, an arbitrary value that should be a theme name.
- A change with no motion (a panel that pops in, a press with no response), large empty patches or cramped areas, a
  screen that would confuse a non-technical person.
- A better layout idea, a component worth adding to the starter, a chart that could be a number.
- 24 to 43px controls that aren't the main action.
- Anything you are unsure about. When in doubt, it goes in the backlog.

## Self-review before any UI PR (Engineers)

- [ ] Built from the starter's components and theme names; `tokens.css` and `shadcn.css` unchanged.
- [ ] One surface per section, at most one bordered level, the block that fits each question (table, board, activity
      list, schedule chart), one primary button per view, and the existing structure (lanes, groups, views) kept.
- [ ] Composed from the starter's blocks; a new screen matches its mockup when it had one.
- [ ] Checked at 390 and 1280, light and dark, with no console errors or CSP violations, and `npm test` passes (it checks
      the CSP). Engineer jobs: `aidenhq-browse` screenshots the changed pages at 1440 and clicks through the changed
      flow; its screenshots are attached to the task.
- [ ] Filters apply on change, state is in the URL, details open in a sheet, updates happen in place.
- [ ] Empty, loading and error states are present, and the copy is in plain words.
- [ ] A seed or fixture mode runs the app locally with realistic data, so a reviewer can screenshot it.
