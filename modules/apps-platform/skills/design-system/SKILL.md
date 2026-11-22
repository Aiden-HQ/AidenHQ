---
name: design-system
description: Build or change the UI of an AidenHQ app (or the board) with the app starter (Vite + React + shadcn/ui + Tailwind) and the AidenHQ design system (theme, building blocks, guidelines, review checklist). Use for any page, component, style or new app in an AidenHQ app repo or the product.
---

# AidenHQ apps: the starter and the design system

Two folders, in every agent computer (in the product repo, their sources are `modules/apps-platform/design-system/` and
`modules/apps-platform/starter/`):

- `/opt/aidenhq/design-system/`: the design system. Read its `guidelines.md` (the floors every app meets and the
  stack) and `review-checklist.md` (what blocks a UI PR).
- `/opt/aidenhq/app-starter/`: the app starter. Its `README.md` says what's where; its `AGENTS.md` is the
  short version of how to build on it.

**A new app starts from the starter.** A repository made with `aidenhq create-repo` already holds it on main: build on
those files, so your first change holds only the app's own work. Another app repo copies it in
(`cp -r /opt/aidenhq/app-starter/. <repo>/`). Then replace the sample data and the example page with the app's own, and
keep the starter's identity check (`aidenhq-identity.mjs` around the handler in `server.mjs`) in place. An existing app
moves to the starter when its UI is next touched (the design system's `README.md`, migration guide).

**Building blocks, not a template.** `src/components/blocks/` (page header, stat strip, sortable headers, pagination,
board, activity list, empty/loading/error states, detail list, form section, charts), `src/components/ui/` (shadcn/ui),
the example page (`src/pages/projects.tsx`) and `/catalog` are there to use, adapt or ignore; the top-bar shell in
`src/App.tsx` is a sample (many destinations or nested groups: the `SidebarShell` block). What always holds (the guidelines' floors): readable
contrast in both themes; a visible focus ring on everything interactive; details in a `Sheet` at `?item=` that the URL
opens on load; every data view's empty, loading and error states. Colours only from the theme's names (`bg-background`, `text-muted-foreground`, `bg-primary`,
`text-danger`, `bg-chart-1`…), never literal colours or Tailwind palette colours.

**A mockup is the spec.** When the task comes with a mockup (a page's `.tsx` file, often a `theme.css`, and screenshots in
`.aidenhq/files/`), start from its files: copy its `.tsx` and `theme.css` into the app and wire them to the real data,
rather than rewriting from the screenshots. Keep its layout, components and states, and its finish: theme colours, type
scale, spacing, depth (shadows, borders, radii), icons and the interactions its task lists (hover, focus, what slides or
fades). A new app or screen without a mockup: build it from the starter's patterns, and say in your reply that no mockup
came with it.

**It must render under the CSP.** The starter's server sends `script-src 'self'; style-src 'self' 'nonce-…'`: no inline
`<script>`, no `style="…"` in HTML the server writes, no CDN, no `'unsafe-inline'`. A component that renders a `<style>`
tag takes `nonce={cspNonce}` (`@/lib/csp`); a library that injects styles without a nonce isn't used. Keep `npm test`
passing (it builds, serves and checks the CSP), and an existing app's server must serve `dist/` the way the starter's
`server.mjs` does.

**Before you finish:**

- `npm ci && npm test && npm run build` pass; `tokens.css` and `shadcn.css` are unchanged (note their `design-system
  version:` lines in the PR).
- Look at what you changed, in a browser, with the app's Playwright Test setup (the starter's `playwright.config.ts` and
  `e2e/`; an app without it copies them in, with `preview` and `screens` scripts and a seeded preview mode). One
  command, from the app's folder:

  ```sh
  SCREENS=/,/items npm run screens
  ```

  Playwright starts the seeded preview (`npm run preview`), waits for it, screenshots each page in `feature-map.json`
  (or those `SCREENS` names) at 1440 and 390 in light and dark, fails on page errors, console errors (CSP violations
  included) and horizontal overflow, runs the `e2e/` flows, and stops the app. Add a flow for what you changed to `e2e/`
  (`e2e/flows.spec.ts` is the pattern: `getByRole`, `click`, `fill`, `expect(...).toHaveURL`). Open every screenshot
  and fix what looks wrong (overlap, clipping, unstyled or empty areas, a misaligned table), then run it again until it
  passes. The screenshots land in the task's `.aidenhq/out/` (at most 20 are attached after the run: name the pages
  you changed in `SCREENS`); take them after your last change and name them in your report.
- Component logic (what a form sends, what a list shows) gets a Vitest test next to the component, rendered with
  Testing Library (`src/test/dialog-form.test.tsx` is the pattern); the starter's `vite.config.ts` gives every test a
  ready DOM.
- With a mockup, screenshot your pages at its width and mode (a Playwright project at the width its screenshots use) and open
  each one beside the mockup's: fix every difference a person would see at a glance that isn't the real data (greyer,
  flatter, sparser, smaller or bigger type, missing hover or detail), and say in your report what still differs and why.
- Every page renders at its own URL on a link click, Back/Forward and a reload: routes and links use the starter's
  navigation (`src/lib/navigation.tsx`: `useLocation`, `Link`, `navigate`, `useUrlState`) and every route is in the
  server's `PAGES`. Your click-through clicks each nav link you added or changed and shots the page it opens, then
  `goto`s that path and shots it again (the reload): both show the same page.
- Go through the checklist's "Self-review" by reading your code: the mockup matched when there is one, every data
  view's empty, loading and error states, details that reopen from the URL, plain-word copy, phone layout (`max-md:`/`md:` classes, nothing
  wider than the screen).
- A seed or sample-data mode still runs the app locally (you and the reviewer screenshot it), and new states are reachable with
  `?preview=loading|error|empty` or the seed.

In the product repo the source is `modules/apps-platform/design-system/` and `modules/apps-platform/starter/`; after changing either
run `node scripts/sync-shared.ts` (the computers carry copies).
