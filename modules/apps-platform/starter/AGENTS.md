# Working on this app

This app was started from the AidenHQ app starter: Vite + React + TypeScript, Tailwind CSS 4 and shadcn/ui, themed by
the AidenHQ design system. This file is the map an engineer reads first: which file owns which screen, how to run and
test it, and the rules that keep its pages consistent. `README.md` has the longer tour.

## Map

Replace the starter's rows with the app's own as its screens arrive; a reviewer maps a PR's changed files to the routes
it screenshots from this table.

| Route or piece | Owned by |
|---|---|
| `/` (Projects: list, filters, detail sheet at `?item=`) | `src/pages/projects.tsx`, data in `src/hooks/use-projects.ts` and `src/lib/projects.ts` |
| `/teams` | `src/pages/teams.tsx` |
| Unknown paths (404) | `src/pages/not-found.tsx` |
| Routes, shell and header | `src/App.tsx` (`ROUTES`, the shell); every route is also in `server.mjs` `PAGES` |
| API (`/api/health`, `/api/items`) and the CSP | `server.mjs` |
| Pages and stateful URLs the UI review visits | `feature-map.json` |
| Component tests and their setup | `src/**/*.test.tsx`, `src/test/setup.ts`, `bunfig.toml` |
| Browser checks and screenshots | `e2e/`, `playwright.config.ts` |
| Theme | `src/index.css` (and a `theme.css` when re-themed) |

## Run, test, lint

```sh
npm ci                            # once
npm run lint                      # Oxlint, well under a second
bun test src/pages/x.test.tsx     # one component test file (seconds, no build)
node --test test/app.test.mjs     # one server test file
npm test                          # every test: component tests, then build, serve and check the pages, CSP, health and API
npm run preview                   # build, then serve the app with its sample data on 4173 (stop with Ctrl-C)
npm run screens                   # screenshots at 1440, 1920, 2560, 768 and 390, light and dark, plus the e2e/ flows: one command
npx playwright test e2e/flows.spec.ts --project desktop-light   # one browser flow
```

## Testing

- **What people see and click** (a dialog, a sheet, a form, navigation, layout at a width): a Playwright flow in `e2e/`
  against the real app (`e2e/flows.spec.ts` is the pattern). `npm run screens` starts the seeded preview itself, waits
  for it and stops it; the screenshots land in `.aidenhq/out/<page>-<project>.png`, ready to attach; `SCREENS=/,/teams npm
  run screens` limits them to the pages a change touches.
- **A component's logic** (what a form sends, what a list shows for given data): a `bun test` test next to it,
  `src/**/*.test.tsx`, rendered with Testing Library and driven with user-event. `bunfig.toml` preloads a
  happy-dom DOM (`src/test/setup.ts`) before any component loads, so Radix dialogs, sheets and selects open as in a browser;
  `src/test/dialog-form.test.tsx` is the pattern to copy. Stub `fetch` for the API (assign `globalThis.fetch`, restore it in `afterEach`).
- **The API and data:** a server test in `test/` (`test/app.test.mjs`).
- **Sample data:** the preview's data lives with the server (`server.mjs` here; a real app's seed or fixtures file), so
  every state a reviewer needs is one URL in `feature-map.json`.
- **Tools you need:** install them into the workspace (`npm i -D --save-exact --before=<7 days ago> <pkg>@<version>`, or
  `npx <tool>` for a one-off) and commit only what the app keeps using.

## Keeping this file current

A change that adds, moves or removes a screen, route, shared component, API route or test command updates the Map and
these commands in the same PR, as it does `feature-map.json`.

## Rules for the UI

- **A menu, not a template.** `src/components/blocks/` and `src/components/ui/` (shadcn/ui) are a library with
  variants (props such as `variant`, `size`, `side`); nothing is required, and an app's build carries only what it
  imports. The README lists every piece. Pick the shell that fits the app's navigation (`TopBarShell`, `SidebarShell`,
  `BareShell`, or none). The example page is one sample. Need a control? Use or add a shadcn component (README) before
  writing your own.
- **React habits for a Vite app:**
  - Define each component at module level, so state survives a re-render.
  - Derive a value while rendering; keep `useEffect` for syncing with the outside world.
  - Update state from the previous state with the functional form: `setCount((n) => n + 1)`.
  - Write `count > 0 ? <List /> : null`, so a 0 renders nothing instead of printing "0".
  - Load heavy views (charts, editors, maps) with `React.lazy`.
  - Virtualise a list that can pass 50 rows.
- **"Powered by AidenHQ".** Every shell renders `PoweredBy` (`src/components/powered-by.tsx`) at the foot of the
  page by default. It is not required: the app's owner may move or remove it.
- **Theme:** keep the default palette, pick a preset (`src/styles/presets/`: import it after `shadcn.css` and set
  `<html data-palette="<name>">`), or adapt one in a `theme.css`. Presets are starting points, not rules.
- **The catalog is dev-only:** `npm run catalog` (`catalog.html`, `src/catalog/`) shows every block, component,
  variant, shell and preset. It is never an app route or part of a build; leave it out of the app's repo.
- **What always holds** (the design system's `guidelines.md`): readable contrast in both themes; a visible focus ring
  on everything interactive; details at a URL (a `Sheet` at `?item=`, say) that opens them on load and that Back
  closes; empty, loading and error states in every data view; times kept as UTC instants (ISO 8601 with `Z`) in
  `server.mjs` and the API and shown in the viewer's zone by the browser; colours from the theme's names (`bg-background`,
  `text-muted-foreground`, `bg-primary`, `text-danger`, `bg-chart-1`…) so light and dark both work; what people could
  see and do stays when only restyling (a redesign's mockup decides what changes).
- **A mockup is the spec.** When a change comes with a mockup (a page's `.tsx`, often a `theme.css`, and screenshots),
  start from its files and wire them to the real data: its layout, components and states, and its finish (theme
  colours, type scale, spacing, depth, the interactions it lists). Compare your screenshots with its own, side by side
  at the same width and mode, before a PR.
- **Navigation:** routes and links use the starter's navigation (`src/lib/navigation.tsx`): pick the page from
  `useLocation().path` (as `src/App.tsx` does), link with `Link`, move from code with `navigate`, and keep page state in
  the query with `useUrlState`. Every route is also in `server.mjs` `PAGES`. Then every page works on a link click, on
  Back and Forward, and on a reload or a shared link, with the state its URL carries. A page's shell says who the app is
  and where home is: the header's brand is `Link href="/"` and opens home in its default state; a redesign starts from
  the starter's shells; every clickable element visibly acts.
- **Keep `feature-map.json` current:** it lists the app's pages and a few stateful URLs (`?status=…`, `?item=…`), each
  with what should be visible there, and `ui-review` reviews those paths by default (README, "The feature map"). Add an
  entry when a page or a view that lives at a URL changes.
- **The CSP stays strict:** `script-src 'self'; style-src 'self' 'nonce-…'`. No inline scripts, no CDN, no
  `'unsafe-inline'`. A `<style>` tag a component renders takes `nonce={cspNonce}` (`@/lib/csp`); a library that injects
  styles without one isn't used.
- **Never edit** `src/styles/tokens.css` or `src/styles/shadcn.css` (the vendored theme). Re-theme in a `theme.css`.
- **One way to do each thing.** A change that replaces a pattern, component or page deletes the old one in the same PR, so the code shows only the current way and the next change copies it.
- **Keep it reviewable:** a seed or sample-data mode runs the app locally with realistic data, so the UI review can
  screenshot every state.
- **Before a UI PR:** `npm ci && npm run lint && npm test && npm run screens`, then the self-review in the design system's
  `review-checklist.md`. `ui-review routes` (in agent computers) clicks every link on the pages it reviews and reports any
  route that doesn't render on click, Back/Forward or reload.
