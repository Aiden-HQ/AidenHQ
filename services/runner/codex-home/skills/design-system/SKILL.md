---
name: design-system
description: Build or change the UI of an AidenHQ app (or the board) with the app starter (Vite + React + shadcn/ui + Tailwind) and the AidenHQ design system (theme, building blocks, guidelines, review checklist). Use for any page, component, style or new app in an AidenHQ app repo or the product.
---

# AidenHQ apps: the starter and the design system

Two folders, copied from the product at the start of this run:

- `$CODEX_HOME/skills/design-system/files/`: the design system. Read `files/guidelines.md` (the floors every app meets and the
  stack) and `files/review-checklist.md` (what blocks a UI PR).
- `$CODEX_HOME/skills/design-system/starter/`: the app starter. Its `README.md` says what's where; its `AGENTS.md` is the
  short version of how to build on it.

**A new app:** copy the starter into the repo (`cp -r "$CODEX_HOME/skills/design-system/starter/." <repo>/`), then replace
the sample data and the example page with the app's own. Never start from a blank Vite app, server-rendered HTML or another
UI library.

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
- Look at what you changed, in a browser: `aidenhq-browse` serves the build, screenshots each page at 1440 wide and runs
  a short click-through, reporting console errors, CSP violations and failed loads. One command, from the app's folder:

  ```sh
  aidenhq-browse http://127.0.0.1:4173 --start "PORT=4173 node server.mjs" --paths /,/items \
    --steps steps.json --out "$AIDENHQ_TASK_WORKTREE/.aidenhq/out"
  ```

  `steps.json` clicks through the flow you changed (`[{"click": "role=button[name=\"New item\"]"}, {"fill": "#name",
  "value": "Lamp"}, {"press": "Enter"}, {"wait": "text=Saved"}, {"shot": "saved"}]`). Open every screenshot and fix
  what looks wrong (overlap, clipping, unstyled or empty areas, a misaligned table) and every reported problem, then run it
  again until it prints `clean`. `--width 390` checks the phone layout. Files in `.aidenhq/out/` (at most 20) are
  attached to the task after the run; name them in your report.
- With a mockup, screenshot your pages at its width and mode (`--width 1280`, the width its screenshots use) and open
  each one beside the mockup's: fix every difference a person would see at a glance that isn't the real data (greyer,
  flatter, sparser, smaller or bigger type, missing hover or detail), and say in your report what still differs and why.
- Go through the checklist's "Self-review" by reading your code: the mockup matched when there is one, every data
  view's empty, loading and error states, details that reopen from the URL, plain-word copy, phone layout (`max-md:`/`md:` classes, nothing
  wider than the screen).
- A seed or sample-data mode still runs the app locally (you and the reviewer screenshot it), and new states are reachable with
  `?preview=loading|error|empty` or the seed.

In the product repo the source is `modules/core/design-system/` and `modules/core/templates/app/`; after changing either
run `node scripts/sync-shared.mjs` (the computers carry copies).
