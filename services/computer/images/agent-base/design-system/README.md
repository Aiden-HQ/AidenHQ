# AidenHQ design system

The default look and behaviour of every app agents build: design tokens with four themes, a CSS component kit, a small
dependency-free script for in-place updates, a live catalog, and the rules the UI/UX Engineer reviews against. It works
in any stack: plain HTML from a Node server, a template engine, or React (use the class names).

| File | What it is |
|---|---|
| `tokens.css` | Every colour, size, space, radius and duration. Four palettes (`neutral`, `warm`, `contrast`, `data`), each in light and dark. |
| `components.css` | The component classes: app shell, page header, buttons, forms, filters, tables, cards, stat tiles, badges, tabs, drawers, modals, toasts, states, pagination, timeline, board, charts, command palette. |
| `kit.js` | Opt-in behaviour by data attribute: filters that apply on change with in-place updates and URL state, drawers, async forms, confirms, sortable tables, load more, command palette, tabs, relative times, theme toggle, toasts. |
| `catalog.html` | Every token and component, live. Open it with `?palette=warm&mode=dark` (or use its pickers). Copy markup from here. |
| `guidelines.md` | The rules: layout, type, colour, navigation, filters, partial updates, states, forms, tables, dialogs, accessibility, motion, copy, data visualisation. |
| `review-checklist.md` | What blocks a UI pull request and what goes to the backlog, plus the Engineer's self-review. |

The product repo is the source (`modules/core/design-system/`). The app starter (`modules/core/templates/app/`) and the
agent computers (`/opt/aidenhq/design-system/`) carry byte-identical copies (`node scripts/sync-shared.mjs`).

## Using it in an app

1. Copy `tokens.css`, `components.css` and `kit.js` unchanged into the app's static folder (e.g. `public/design-system/`).
   A new app gets them from the starter, `modules/core/templates/app/`.
2. Load them in this order, before any app CSS:
   ```html
   <html lang="en" data-palette="neutral">
   <meta name="color-scheme" content="light dark">
   <link rel="stylesheet" href="/design-system/tokens.css">
   <link rel="stylesheet" href="/design-system/components.css">
   <script src="/design-system/kit.js" defer></script>
   ```
3. Build from the catalog's markup. App CSS only adds what the kit lacks, and only with tokens (no literal colours or
   pixel sizes). If two apps need the same thing, it moves into the kit.
4. **Branding (optional):** a `theme.css` loaded after `tokens.css` may override only `--accent*`, `--focus` and
   `--font`, in both light and dark. When the instance repo has `design/theme.css`, apps use that file.
5. To update, copy the three files again and note the version (the `design-system version:` line) in the PR.

## Migrating an existing app

One Engineer PR per app; the UI/UX Engineer reviews it with `ui-review --baseline` against the old version.

1. Replace the vendored `tokens.css` and `components.css` with this version, and add `kit.js`. Then list the kit's
   class names that the app's own CSS also defines (`.card`, `.board`, `.stat`, `.tabs`, `.badge`, `.notice`, `.kv` are
   the usual ones). For each, delete the app's rule where the kit's does the job, or rename the app's class where it
   doesn't. Otherwise the two rules merge, and you get double padding or stray markers.
2. Rename tokens that changed in 2.0: links and text on a surface use `--accent-ink`, not `--accent` (which is now
   the solid fill). `--duration` stays, and `--ease*` are new. Type sizes moved to a 16px body (`--text-md`). Then delete
   the app's own copies of things the kit now has: buttons, inputs, tables, badges, cards, empty and error states.
3. Put the shell in place: `.app` > `.topbar` (+ `.bottombar` on phone) > `main.page`, and `.page-header` on each page.
4. **Filters:** make the filter `<form method="get">` a `data-autoapply` form with `data-target` naming the results
   region's id, and keep the Apply button as `data-autoapply-submit`. The server keeps rendering the full page for a
   URL. kit.js fetches it and swaps the region, so no new endpoint is needed.
5. **Details:** add `data-drawer` to links that open an item, and wrap the detail page's content in
   `<div data-drawer-content>`. The same URL still works as a full page.
6. **Tables:** add `.table-stack` and `data-label` on cells, and `data-sortable` where sorting helps.
7. Add the three states to every data view, and remove bespoke CSS that duplicates the kit. Run `ui-review` at 390 and
   1280 in light and dark, and fix anything blocking.
