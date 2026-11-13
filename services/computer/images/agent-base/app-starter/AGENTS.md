# Working on this app's UI

This app was started from the AidenHQ app starter: Vite + React + TypeScript, Tailwind CSS 4 and shadcn/ui, themed by
the AidenHQ design system. `README.md` says what's where. These rules keep its pages consistent and working.

- **Compose, don't invent.** Build pages from `src/components/blocks/` (Page, PageHeader, PageSection and PageSplit,
  StatStrip, SortHead and Pagination, Board, ActivityList, StatePanel and TableSkeleton, DetailList,
  Field/FormSection/FormActions, BarList, TrendChart and ScheduleChart) and `src/components/ui/` (shadcn/ui). `/catalog`
  shows every one in use; the list page (`src/pages/`) shows how they compose. Need something they don't cover? Add the
  shadcn component (README) before writing your own.
- **The layout rules that matter most:** one surface per section and never a bordered box inside another; the block
  that fits the question (a table to compare, a Board for stages, an ActivityList for what changed, a ScheduleChart
  for dates), never a grid of look-alike cards; keep the lanes, groups and views the app already has when restyling;
  secondary things in a PageSplit side rail; a summary of numbers is one StatStrip; filters, sort and page in the URL
  (`useUrlState`), applied as they change; details in a `Sheet` at `?item=` that Back closes; every data view has its
  empty, loading, error and no-match states; one primary button per view; colours only from the theme's names
  (`bg-background`, `text-muted-foreground`, `bg-primary`, `text-danger`, `bg-chart-1`…), never literal colours.
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
