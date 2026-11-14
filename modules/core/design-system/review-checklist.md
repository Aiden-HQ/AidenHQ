# UI review checklist

The UI Reviewer applies this to every pull request that changes what people see; the UI/UX Designer applies it in an
app's design audit and to its own mockups. A review is a quick look for obvious, major breakage, not QA and not a
judgement of taste: shell, blocks, palette and layout are the designer's choices. It judges a pull request against its
base: only what the PR introduced blocks, and a finding the base already had is not this PR's, even in a file it touches
(`ui-review --baseline` lists the base's own findings under "already on this base").

1. **Evidence:** run `ui-review <url> --paths <changed pages> --out after` (and `--baseline before` against the base
   when you can run both), read `report.md` and look at the screenshots of the changed pages once. Try the main flow the
   PR touches once. Don't explore every state or width.
2. **Report:** the verdict, each blocker (screenshot or region, what is broken, the fix), then one short non-blocking
   list. When unsure, it is non-blocking.

## Blocking: obvious, major, user-facing breakage this PR introduced

- [ ] The page doesn't render, renders unstyled, or shows errors (page errors, failed loads, CSP blocks).
- [ ] A core flow the PR touches doesn't work: the action does nothing, fails silently, or gives the wrong result.
- [ ] Data on screen is missing or wrong: `NaN`, `undefined`, `[object Object]`, wrong counts or totals, or something
      people could see or do before that is gone when neither the request nor its picked wireframe dropped it.
- [ ] The layout is broken enough to be unusable at desktop width (1280px): content cut off, overlapping or unreachable.
- [ ] A severe accessibility blocker on the primary flow: a control you can't use with the keyboard, or text you can't
      read (axe critical).
- [ ] A structural departure from the mockup the task names as its spec: a missing section, state or view. Never
      pixel, spacing or style differences.

## Non-blocking: one short list, never a failure

Everything else: polish, spacing, copy, craft, minor inconsistencies, edge states (empty, loading, long text), phone
and tablet nits, lesser axe findings, things the base already had. A screen that works but looks generic or is hard to
follow: suggest a mockup from the UI/UX Designer.

## Self-review before any UI PR (Engineers)

- [ ] On the starter's stack; colours from theme names; `tokens.css` and `shadcn.css` unchanged.
- [ ] Matches its mockup when it had one; anything it drops is dropped by the request or its picked wireframe.
- [ ] Checked at 1280 and 390, light and dark, with no console errors or CSP violations, and `npm test` passes (it
      checks the CSP). Engineer jobs: `aidenhq-browse` screenshots the changed pages and clicks through the changed
      flow; its screenshots are attached to the task.
- [ ] Filters apply on change and live in the URL, details open over the list and Back closes them, updates happen in
      place.
- [ ] Empty, loading and error states are present, and the copy is in plain words.
- [ ] A seed or fixture mode runs the app locally with realistic data, so a reviewer can screenshot it.
