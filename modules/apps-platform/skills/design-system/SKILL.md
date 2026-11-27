---
name: design-system
description: "Guides building or changing the UI of an AidenHQ app or the board on the app starter (Vite + React + shadcn/ui + Tailwind) and the design system: theme, building blocks, guidelines, review checklist, matching a mockup. Use for any page, component, style or new app."
---

# AidenHQ apps: the starter and the design system

In every agent computer: `/opt/aidenhq/design-system/` (read `guidelines.md`, the floors, and `review-checklist.md`, what
blocks a UI PR) and `/opt/aidenhq/app-starter/` (its `README.md` says what's where, `AGENTS.md` is the short build guide).
In the product repo they are `modules/apps-platform/design-system/` and `modules/apps-platform/starter/`; after changing
either run `node scripts/sync-shared.ts`.

**The look** (owner's taste): Stripe's polish and Linear's crispness, with more colour. Buttons, inputs and cards use
moderate corner radius; badges, avatars and switches may be round. Dense but calm, little wasted space. Fluid from a phone to 2560.

**Start from the starter.** A repo made with `aidenhq create-repo` already holds it; another app repo gets
`cp -r /opt/aidenhq/app-starter/. <repo>/`. Replace the sample data and example page with the app's own, and keep the
identity check (`aidenhq-identity.mjs` around the handler in `server.mjs`). An existing app moves to the starter when its UI
is next touched (migration guide in the design system's `README.md`).

**Use the blocks.** `src/components/blocks/`, `src/components/ui/`, the example page and `/catalog` are there to use or adapt
(many destinations: the `SidebarShell` block). Colours come only from the theme's names (`bg-background`,
`text-muted-foreground`, `bg-primary`, `text-danger`, `bg-chart-1`), details open in a `Sheet` at `?item=`, and every data
view has empty, loading and error states.

**A mockup is the spec.** Copy its `.tsx` and `theme.css` (task files in `.aidenhq/files/`) into the app and wire them to real
data; keep its layout, components, states and finish (colours, type scale, spacing, depth, icons, interactions). Without a
mockup, build from the starter's patterns and say so in your reply.

**CSP:** the starter's server sends `script-src 'self'; style-src 'self' 'nonce-…'`. A component rendering `<style>` takes
`nonce={cspNonce}` (`@/lib/csp`). An existing app's server serves `dist/` like the starter's `server.mjs`.

**Before you finish:**

- `bun install --frozen-lockfile --ignore-scripts && bun run test && bun run build` pass; `tokens.css` and `shadcn.css` are unchanged (note their `design-system version:`
  lines in the PR).
- Look in a browser: `SCREENS=/,/items bun run screens` (the starter's Playwright setup; an app without it copies it in)
  screenshots the pages in `feature-map.json` or `SCREENS` at 1440 and 390, light and dark, fails on page errors, CSP
  violations and horizontal overflow, runs `e2e/`, and writes to `.aidenhq/out/` (20 attached: name the pages you changed).
  Add an `e2e/` flow for your change (`e2e/flows.spec.ts` is the pattern), open every screenshot, fix what looks wrong and
  rerun; name the screenshots in your report.
- Component logic gets a Vitest test next to it (`src/test/dialog-form.test.tsx`).
- With a mockup, screenshot at its width and mode, compare, fix visible differences and report what still differs.
- Every page has its own URL that renders on a link click, Back/Forward and reload: use the starter's `src/lib/navigation.tsx` (`useLocation`, `Link`, `navigate`, `useUrlState` for filters and `?item=`) and list each route in the server's `PAGES`. Click each nav link you added and reload its path: same page.
- Read your code against the checklist's "Self-review".
- The seed or sample-data mode still runs locally, and new states are reachable with `?preview=loading|error|empty` or the seed.
