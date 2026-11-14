# UI review checklist

The UI Reviewer applies this to every pull request that changes what people see; the UI/UX Designer applies it in an
app's design audit and to its own mockups. It checks that the UI works for the people using it, not that it uses a
particular shell, block, palette or layout: those are the designer's choices. It judges a pull request against its
base: what the PR introduced or regressed blocks, and a finding the base already had is not this PR's, even in a file it
touches — that goes in the backlog (`ui-review --baseline` lists the base's own findings under "already on this base").

1. **Evidence first.** Run `ui-review <url> --paths <changed pages> --out after` (and `--baseline before` against the
   base commit when you can run both). Open every screenshot. axe and the layout checks are authoritative on what they
   measure; your eyes judge the rest.
2. **Go through the list below.** Then the five-second test on the full-page desktop screenshot: can someone tell what
   the screen is for, what needs attention and what to do next?
3. **Report:** blocking items first, each with the screenshot, the selector or region, the rule (a guidelines section
   by name) and the fix. Then the backlog. Cap it at 10 findings and pick the ones that matter most.

## Blocking: the PR needs a fix

**Can't use it**
- [ ] Something can't be done, read or reached at 390px or 1280px (cut off, overlapping, off-screen, hover-only).
- [ ] The page scrolls sideways at any width (a table may scroll inside its own container).
- [ ] Visibly broken: clipped or overlapping text, `NaN`/`undefined`/`[object Object]`, an unstyled page, chrome or a
      panel that ends partway down the page, a sheet that hides what it should sit over or won't close.
- [ ] An action gives no feedback: no busy state, no confirmation, a silent failure.
- [ ] A screen has no way back, or a main destination is hidden behind a menu on phones.

**Accessibility (axe serious or critical, or seen)**
- [ ] Text contrast under 4.5:1, or a control border, icon or focus ring under 3:1, in either theme.
- [ ] Light or dark mode broken: literal colours (`text-white`, `bg-gray-*`, hex values), invisible elements.
- [ ] A control with no label or accessible name; focus invisible or lost; a control the keyboard can't reach; a sheet
      or dialog that Escape doesn't close or that doesn't return focus to what opened it.
- [ ] A phone tap target under 24px, or a main control under 44px.
- [ ] Meaning carried by colour alone.

**Behaviour the owner has had to correct before**
- [ ] A redesign removes something people could see or do (a stage, group, view, column or field) that the request
      didn't ask to drop. A different layout of the same things is not a defect.
- [ ] A filter or search needs an Apply button, reloads the page, or loses focus or typed text while updating.
- [ ] Filter state isn't in the URL; an unknown value silently shows everything; an option leads to a dead-end view.
- [ ] Counts, totals or charts disagree with the filters in force.
- [ ] A data view lacks its empty, loading or error state, or says "all clear" when a filter emptied it.
- [ ] A detail view doesn't lead with the current status; the answer is buried under history or raw fields.
- [ ] Opening or closing an item's details loses the user's filters or scroll position, breaks Back, or the open item
      can't be shared by its URL.
- [ ] Invented or misleading data: a fabricated date, a dangling "→", a chart with nothing to compare, a wrong bucket.
- [ ] Internal labels that mean nothing to the app's users: ids, trial or backfill markers, raw enum values, ISO
      timestamps.
- [ ] A derived fact with no link to its source, where the source exists.

**Consistency and the stack**
- [ ] The same component in two different styles within the app, or the same action under two names.
- [ ] Not on the stack: not built on the starter's shadcn/ui + Tailwind, a second UI library, or a hand-built version
      of a control shadcn provides (select, dialog, menu, sheet).
- [ ] The vendored `tokens.css` or `shadcn.css` edited, or not at the current version.
- [ ] Console errors or CSP violations (open a sheet, a select and a toast), `'unsafe-inline'` or a CDN in the CSP, or
      LCP over 2.5s or CLS over 0.1 on seeded data.

## Backlog: file it, don't block

- Craft: weak hierarchy, boxes inside boxes, uniform sections, a card grid where a table would compare better, a heavy
  shell for a small app, colour or a gradient spent where it doesn't earn attention, more than one primary action,
  large empty patches or cramped areas, a change with no motion. A screen that works but looks generic or is hard to
  follow: suggest a mockup from the UI/UX Designer.
- Spacing a step off the scale, copy polish, a chart that could be a number, 24 to 43px controls that aren't the main
  action.
- Anything you are unsure about. When in doubt, it goes in the backlog.

## Self-review before any UI PR (Engineers)

- [ ] On the starter's stack; colours from theme names; `tokens.css` and `shadcn.css` unchanged.
- [ ] Matches its mockup when it had one; what people could see and do before is still there.
- [ ] Checked at 1280 and 390, light and dark, with no console errors or CSP violations, and `npm test` passes (it
      checks the CSP). Engineer jobs: `aidenhq-browse` screenshots the changed pages and clicks through the changed
      flow; its screenshots are attached to the task.
- [ ] Filters apply on change and live in the URL, details open over the list and Back closes them, updates happen in
      place.
- [ ] Empty, loading and error states are present, and the copy is in plain words.
- [ ] A seed or fixture mode runs the app locally with realistic data, so a reviewer can screenshot it.
