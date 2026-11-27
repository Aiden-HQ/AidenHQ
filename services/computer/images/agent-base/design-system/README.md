# AidenHQ design system

The default look and behaviour of every app agents build. Apps are **shadcn/ui + Tailwind CSS** (Radix primitives, lucide
icons) on Vite + React, started from the app starter (`modules/apps-platform/starter/`). This folder holds the theme those
components wear, the rules, and the review checklist.

| File | What it is |
|---|---|
| `tokens.css` | Every colour, size, space, radius and duration: four palettes (`neutral`, `warm`, `contrast`, `data`) from Radix Colors, each in light and dark, all AA. |
| `presets/` | Theme presets, one file each (`crisp`, `polished`, `editorial`, `dense`, `ops`, `indigo`, `soft`, `slate`, `minimal`, `graphite`): palette in light and dark, accent, radius, fonts and density. An app imports one after `shadcn.css` and sets `<html data-palette="<name>">`. A starting point, not a rule; all AA. |
| `shadcn.css` | Maps the tokens onto shadcn's variables (`--background`, `--primary`, `--muted-foreground`, `--sidebar`…) and Tailwind's colour names, plus status (`ok`, `warn`, `danger`, `info`), `link`, `page` and `chart-1…6`. Points Tailwind's `dark:` at `<html data-theme>`. |
| `guidelines.md` | The floors every app meets (readable contrast in both themes, visible focus, details at a URL that opens them on load, empty, loading and error states) and the stack. The look is the UI/UX Designer's, per app. |
| `review-checklist.md` | What blocks a UI pull request (obvious, major breakage only; the rest is a non-blocking note), plus the Engineer's self-review. |
| `components.css`, `kit.js` | **Deprecated:** the plain-CSS kit (version 2), kept only for apps that still vendor it until they migrate (below). Don't use it in new work. |

The catalog is the starter's dev-only `catalog.html` (`bun run catalog`): every block, component, variant, shell and
preset, themed, with palette and mode pickers (`?palette=crisp&mode=dark`). Apps never ship it. The product repo is the
source. The starter vendors `tokens.css`, `shadcn.css` and `presets/` in `src/styles/`, and the agent computers carry this folder at `/opt/aidenhq/design-system/` and the starter at
`/opt/aidenhq/app-starter/` (byte-identical copies, `node scripts/sync-shared.ts`; a test fails on drift).

## A new app

Start from the UI/UX Designer's mockup when the app has one. Copy the starter (without `node_modules` and `dist`) into
the app's repo, keep its `AGENTS.md`, and follow its README. Use its building blocks
(`src/components/blocks/`), components and the example page's patterns where they fit, and replace the sample shell
with navigation that suits the app; add shadcn components with the pinned CLI (`bunx shadcn@4.23.0 add <name>`, then the fix-ups in the starter's README), pin any new
dependency exactly at a version at least 7 days old, and check the browser console for CSP violations.

**Re-theming:** an app or instance overrides tokens (`--accent*`, `--focus`, `--font`) or shadcn's variables in a
`theme.css` imported after `shadcn.css`, in light and dark, checked for contrast. When the instance repo has
`design/theme.css`, apps use that file. Don't edit the vendored files.

**Updating:** copy `tokens.css` and `shadcn.css` again and note the version (the `design-system version:` line) in the PR.
Blocks and fixed components are app-owned copies, so an app made before a block existed doesn't have it: copy any
missing or older file from the current starter's `src/components/blocks/` and `src/components/ui/` (e.g.
`ui/sidebar.tsx`) when you need it.

## Migrating an existing server-rendered app

For an app that renders HTML on the server (with or without the old kit). One Engineer PR per step where possible; the
UI Reviewer reviews each with `ui-review capture --baseline` against the version before. The data layer, the API, auth, the
gate check and migrations stay as they are: only the UI moves.

1. **Split the server into an API.** Every page's data becomes a JSON route (`GET /api/<view>?<the page's query>`)
   returning what the template used to receive, built from the same service functions. Writes stay as they are (or
   become JSON `POST`/`PATCH` with the same validation). Keep `/api/health`. Agent-facing API routes don't change.
2. **Add the client.** Copy the starter's `index.html`, `vite.config.ts`, `tsconfig.json`, `components.json`, `src/`
   (without the example page), `public/theme.js` and its dependencies into the repo. Point the build at `dist/` and have
   the server serve `dist/` the way the starter's `server.mjs` does: the HTML with a fresh nonce and the strict CSP
   (`script-src 'self'; style-src 'self' 'nonce-…'`, no `'unsafe-inline'`), hashed assets from `/assets/`, and the same
   HTML for every client route. A multi-stage Dockerfile builds the client.
3. **Rebuild one page at a time,** most-used first, following its mockup when it has one: navigation that fits the
   number of destinations, routes and links through the starter's navigation (`src/lib/navigation.tsx`), filters in the URL (`useUrlState`) with the same parameter names as before so old links keep
   working, details in a `Sheet` at `?item=`, and every state. Everything people could see and do before (every lane,
   group and view) stays unless the page's mockup changes it. Until a page moves, its old server-rendered route keeps working;
   switch routes over as they land.
4. **Compose each page afresh** from its mockup or the starter's blocks rather than porting markup: the main content
   first, long feeds beside or below it, and history in the detail sheet or its own paged view.
5. **Retire the old UI:** delete the templates, the vendored kit (`components.css`, `kit.js`) and its copy script once the
   last page has moved. Run `ui-review capture` and `ui-review routes` on every page and fix anything blocking,
   then ask the UI/UX Designer for the app's design audit (one task naming the app and its repository).

An app on the old kit that isn't being touched for UI stays as it is. Migrate it the next time its UI changes, or when
a design audit lists "migrate to shadcn/ui".
