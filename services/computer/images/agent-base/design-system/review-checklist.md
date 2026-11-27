# UI review checklist

The UI Reviewer applies this to every pull request that changes what people see; the UI/UX Designer applies it in an
app's design audit and to its own mockups. A review is a quick look for obvious, major breakage; taste is the
designer's: shell, blocks, palette and layout are the designer's choices, and a mockup the task names as its
spec fixes them for the build. It judges a pull request against its
base: only what the PR introduced blocks, and a finding the base already had is not this PR's, even in a file it touches
(`ui-review capture --baseline` lists the base's own findings under "already on this base").

1. **Evidence:** run `ui-review capture <url> --out after` and `ui-review routes <url> --out routes` from the app's folder, which reviews the app's `feature-map.json` (its
   pages and stateful URLs); `--paths <changed pages>` replaces that list. Run it with `--baseline before` against the
   base when you can run both, read `report.md` and look at the screenshots of the changed pages once. With a named mockup,
   also put the head beside the mockup's screenshots (`ui-review capture --baseline <dir of the mockup's screenshots>`, named
   as `ui-review` names its own, writes before|after pictures). Try the main flow the PR touches once; that is enough.
   Only screenshots taken now, of the app built from the head under review, are evidence: images committed in the
   repository, attached by others or left from an earlier head show another commit.
2. **Report:** the verdict, each blocker (screenshot or region, what is broken, the fix), then one short non-blocking
   list. When unsure, it is non-blocking.

## Blocking: what must still hold on the pages the PR changes

A PR that breaks one of these, where its base held it, is blocked.

- [ ] The page renders, styled, loads every resource and runs cleanly under the CSP.
- [ ] Each core flow the PR touches works and gives the right result.
- [ ] Every nav link and in-app link renders its page on click, on Back and Forward, and on reload, and the header's
      brand opens home at the top from every page (`ui-review routes` lists each one in its report).
- [ ] Every visible button, `[role=button]` and other clickable element visibly acts when clicked: the address, the
      page, the focus or what is open changes. A click that changes nothing is a dead click.
- [ ] The data on screen is present and right (real values, the right counts and totals), and everything people could
      see or do before is still there unless the request or the mockup changes it.
- [ ] The layout is usable at desktop width: content fits, sits clear of other content, and can be reached.
- [ ] The primary flow works from the keyboard and its text is readable (axe reports nothing critical).
- [ ] With a mockup the task names as its spec, the build matches it at a glance side by side: its sections, states
      and views, and its look (theme colours, type scale, density, depth, and the interactions it lists). Pixel-level
      nudges and differences that come from the real data are notes.

## Non-blocking: one short list of notes

Everything else: polish, spacing, copy, craft, minor inconsistencies, edge states (empty, loading, long text), phone
and tablet nits, lesser axe findings, things the base already had. For a screen that works but could serve its people
better, suggest a mockup from the UI/UX Designer.

## Self-review before any UI PR (Engineers)

- [ ] On the starter's stack; colours from theme names; `tokens.css` and `shadcn.css` as vendored.
- [ ] Matches its mockup when it had one, side by side at the mockup's width and mode: same theme colours, type scale,
      spacing, depth and detail, and the hover, focus and open/close motion it lists; what it drops is what the request
      or the mockup drops.
- [ ] Checked at desktop and phone width, light and dark, with a clean console and CSP, and `bun run test` passes (it checks
      the CSP). Engineer jobs: `bun run screens` (Playwright) screenshots the changed pages and runs the changed flow; its
      screenshots are attached to the task.
- [ ] Meets the guidelines' floors: readable contrast in both themes, visible focus, details at a URL that opens them on
      load, every page at its own URL, and empty, loading and error states.
- [ ] Every nav link and in-app link renders its page on click, Back/Forward and reload: routes and links go through
      the starter's navigation (`Link`, `useLocation`), each route is in the server's `PAGES`, and `ui-review routes`
      reports every link as rendering.
- [ ] The header brand is `Link href="/"`, opens home at the top from every page, and every visible control acts:
      `ui-review routes` reports the brand and each control it clicks, with nothing under "To look at".
- [ ] Forms and async work: a button that starts work shows it is pending and is disabled until it ends; an error sits
      under the field it belongs to; a destructive action asks to confirm or offers undo; a toast announces without
      taking focus.
- [ ] A seed or fixture mode runs the app locally with realistic data, so a reviewer can screenshot it.
