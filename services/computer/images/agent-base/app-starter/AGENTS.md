# Working on this app's UI

This app was started from the AidenHQ app starter: Vite + React + TypeScript, Tailwind CSS 4 and shadcn/ui, themed by
the AidenHQ design system. `README.md` says what's where. These rules keep its pages consistent and working.

- **Building blocks, not a template.** `src/components/blocks/` (Page, PageHeader, PageSection and PageSplit,
  StatStrip, SortHead and Pagination, Board, ActivityList, StatePanel and TableSkeleton, DetailList,
  Field/FormSection/FormActions, BarList, TrendChart and ScheduleChart, SidebarShell) and `src/components/ui/` (shadcn/ui) are there
  to use, adapt or ignore; `/catalog` shows each one. The top-bar shell in `src/App.tsx` and the example page are one
  sample: fit the navigation to the app (many destinations or nested groups: the `SidebarShell` block). Need a control? Add the shadcn
  component (README) before writing your own.
- **What always holds** (the design system's `guidelines.md`): filters, sort and page in the URL (`useUrlState`),
  applied as they change; details open over the list (a `Sheet` at `?item=`) and Back closes them; every data view has
  its empty, loading, error and no-match states; usable at 390px; colours only from the theme's names (`bg-background`,
  `text-muted-foreground`, `bg-primary`, `text-danger`, `bg-chart-1`…), never literal colours; what people could see
  and do stays when restyling.
- **A mockup is the spec.** When a change comes with a mockup (a page's `.tsx` and screenshots), build from it: its
  layout, components and states, wired to the real data.
- **The CSP stays strict:** `script-src 'self'; style-src 'self' 'nonce-…'`. No inline scripts, no CDN, no
  `'unsafe-inline'`. A `<style>` tag a component renders takes `nonce={cspNonce}` (`@/lib/csp`); a library that injects
  styles without one isn't used.
- **Never edit** `src/styles/tokens.css` or `src/styles/shadcn.css` (the vendored theme). Re-theme in a `theme.css`.
- **Keep it reviewable:** a seed or sample-data mode runs the app locally with realistic data, so the UI review can
  screenshot every state.
- **Before a UI PR:** `npm ci && npm test && npm run build`, then the self-review in the design system's
  `review-checklist.md`.
