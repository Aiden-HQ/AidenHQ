# UI review checklist

The UI/UX Engineer applies this to every pull request that changes what people see, and to each app's weekly audit.

1. **Evidence first.** Run `ui-review <url> --paths <changed pages> --out after` (and `--baseline before` against the
   base commit when you can run both). Open every screenshot. axe and the layout checks are authoritative on what they
   measure; your eyes judge the rest.
2. **Go through the list below**, phone first.
3. **Report:** blocking items first, each with the screenshot, the selector or region, the rule (a section of
   guidelines.md) and the fix. Then the backlog. Cap it at 10 findings and pick the ones that matter most.

## Blocking: the PR needs a fix

**Can't use it**
- [ ] Something can't be done, read or reached at 390px (cut off, overlapping, off-screen, hover-only).
- [ ] The page scrolls sideways at any width (a table or board may scroll inside its own box).
- [ ] An action gives no feedback: no busy state, no confirmation, a silent failure.
- [ ] A screen has no way back, or a primary destination is hidden behind a menu.

**Accessibility (axe serious or critical, or seen)**
- [ ] Text contrast is under 4.5:1, or a control border, icon or focus ring is under 3:1, in either theme.
- [ ] Light or dark mode is broken: hard-coded colours, invisible elements.
- [ ] A control has no label or accessible name, or focus is invisible or lost, or the keyboard can't reach a control.
- [ ] A phone tap target is under 24px, or a main control is under 44px.
- [ ] Meaning is carried by colour alone.

**Behaviour the owner has had to correct before**
- [ ] A filter or search needs an Apply/Show button, or reloads the whole page, or loses focus or typed text while
      updating.
- [ ] Filter state isn't in the URL; an unknown filter value silently shows everything; an option leads to a dead-end
      empty view.
- [ ] Counts, totals or charts disagree with the filters in force.
- [ ] A data view lacks its empty, loading or error state, or shows a reassuring empty message ("all clear") when a
      filter emptied it.
- [ ] A detail view doesn't lead with the current status; the answer is buried under history or raw fields.
- [ ] Details replace the list in a full page load where a drawer would keep the user's place.
- [ ] Invented or misleading data: a fabricated date, a dangling "→", a chart with nothing to compare, a wrong bucket
      label ("Later" holding overdue items).
- [ ] Internal labels on screen: ids, trial or backfill markers, agent names, raw enum values.
- [ ] A derived fact with no link to its source, where the source exists.

**System**
- [ ] A second, different style for the same component on one screen, or more than one primary button in a view.
- [ ] Literal colours or a bespoke component where the kit has one, in a way users will see as broken.
- [ ] Console errors, or LCP over 2.5s or CLS over 0.1 on seeded data.

## Backlog: file it, don't block

- Spacing a step off the scale, copy polish, a literal that should be a token.
- A better layout idea, a component worth adding to the kit, a chart that could be a number.
- 24 to 43px controls that aren't the main action.
- Anything you are unsure about. When in doubt, it goes in the backlog.

## Self-review before any UI PR (Engineers)

- [ ] Uses `tokens.css`, `components.css` and `kit.js` from the kit, at its current version, with no edits to them.
- [ ] At most one primary button per view; the page is checked at 390 and 1280, light and dark.
- [ ] Filters auto-apply, state is in the URL, and updates happen in place.
- [ ] Empty, loading and error states are present, and the copy is in plain words.
- [ ] A seed or fixture mode runs the app locally with realistic data, so a reviewer can screenshot it.
