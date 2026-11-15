# Working on this app's UI

This app was started from the AidenHQ app starter: Vite + React + TypeScript, Tailwind CSS 4 and shadcn/ui, themed by
the AidenHQ design system. `README.md` says what's where. These rules keep its pages consistent and working.

- **A menu, not a template.** `src/components/blocks/` and `src/components/ui/` (shadcn/ui) are a library with
  variants (props such as `variant`, `size`, `side`); nothing is required, and an app's build carries only what it
  imports. The README lists every piece. Pick the shell that fits the app's navigation (`TopBarShell`, `SidebarShell`,
  `BareShell`, or none). The example page is one sample. Need a control? Use or add a shadcn component (README) before
  writing your own.
- **"Powered by AidenHQ".** Every shell renders `PoweredBy` (`src/components/powered-by.tsx`) at the foot of the
  page by default. It is not required: the app's owner may move or remove it.
- **Theme:** keep the default palette, pick a preset (`src/styles/presets/`: import it after `shadcn.css` and set
  `<html data-palette="<name>">`), or adapt one in a `theme.css`. Presets are starting points, not rules.
- **The catalog is dev-only:** `npm run catalog` (`catalog.html`, `src/catalog/`) shows every block, component,
  variant, shell and preset. It is never an app route or part of a build; leave it out of the app's repo.
- **What always holds** (the design system's `guidelines.md`): readable contrast in both themes; a visible focus ring
  on everything interactive; details at a URL (a `Sheet` at `?item=`, say) that opens them on load and that Back
  closes; empty, loading and error states in every data view; colours from the theme's names (`bg-background`,
  `text-muted-foreground`, `bg-primary`, `text-danger`, `bg-chart-1`…) so light and dark both work; what people could
  see and do stays when only restyling (a redesign's mockup decides what changes).
- **A mockup is the spec.** When a change comes with a mockup (a page's `.tsx`, often a `theme.css`, and screenshots),
  start from its files and wire them to the real data: its layout, components and states, and its finish (theme
  colours, type scale, spacing, depth, the interactions it lists). Compare your screenshots with its own, side by side
  at the same width and mode, before a PR.
- **Navigation:** routes and links use the starter's navigation (`src/lib/navigation.tsx`): pick the page from
  `useLocation().path` (as `src/App.tsx` does), link with `Link`, move from code with `navigate`, and keep page state in
  the query with `useUrlState`. Every route is also in `server.mjs` `PAGES`. Then every page works on a link click, on
  Back and Forward, and on a reload or a shared link, with the state its URL carries.
- **Keep `feature-map.json` current:** it lists the app's pages and a few stateful URLs (`?status=…`, `?item=…`), each
  with what should be visible there, and `ui-review` reviews those paths by default (README, "The feature map"). Add an
  entry when a page or a view that lives at a URL changes.
- **The CSP stays strict:** `script-src 'self'; style-src 'self' 'nonce-…'`. No inline scripts, no CDN, no
  `'unsafe-inline'`. A `<style>` tag a component renders takes `nonce={cspNonce}` (`@/lib/csp`); a library that injects
  styles without one isn't used.
- **Never edit** `src/styles/tokens.css` or `src/styles/shadcn.css` (the vendored theme). Re-theme in a `theme.css`.
- **Keep it reviewable:** a seed or sample-data mode runs the app locally with realistic data, so the UI review can
  screenshot every state.
- **Before a UI PR:** `npm ci && npm test && npm run build`, then the self-review in the design system's
  `review-checklist.md`. `ui-review` (in agent computers) clicks every link on the pages it reviews and reports any
  route that doesn't render on click, Back/Forward or reload.
