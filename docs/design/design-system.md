# Design system for agent-built apps

**Problem.** Apps that Engineers vibe-code looked and behaved below industry standard even after design passes. The old
kit had ten CSS classes and no behaviour, so every app re-invented filters, tables and states, and the owner kept
correcting the same things: Apply/Show buttons on filters, full page reloads that lost the search box's focus, details
that replaced the list, status buried under history, missing or misleading empty states, invented dates and internal
labels on screen.

## Decision (revised 2026-11-13: shadcn/ui + Tailwind)

The first version (a plain-CSS kit with `kit.js`, 2026-11-12) fixed behaviour but not looks: an app migrated onto it
still read as generic and dated (boxes inside boxes, weak hierarchy, dated controls), because agents composed pages out of
generic classes with no strong defaults. The owner decided that **shadcn/ui + Tailwind** is the default: models produce
polished, modern UI with it by default (it is what v0, Lovable and Bolt generate), and our tokens stay its theme.

- **Stack:** the app starter (`modules/core/templates/app/`) is Vite + React + TypeScript, Tailwind CSS 4, shadcn/ui
  components generated into `src/components/ui` as source (on Radix primitives via `radix-ui`), and lucide icons. A
  small `node:http` server with no runtime dependencies serves the build, `/api/health` and the app's API, so the image
  carries no `node_modules`. The build step this needs, the reason the first version rejected shadcn, is now accepted.
- **Theme:** `tokens.css` (Radix Colors 3.0.0 values: four palettes, light and dark, 492 AA pairs tested) stays the
  only source of colour. `shadcn.css` maps it onto shadcn's variables and Tailwind's colour names, so components need no
  edits and an instance re-themes by overriding tokens or shadcn variables. Two names collide: the tokens' `--accent`
  (brand fill) and `--border` (a width), so Tailwind's `accent` (shadcn's hover fill) maps to `--surface-hover` and
  `border` to `--line`. `dark:` follows `<html data-theme>`, which `public/theme.js` sets from the system or the
  viewer's choice before first paint (`ui-review`'s media emulation keeps working).
- **CSP:** `script-src 'self'` and `style-src 'self' 'nonce-…'` (a fresh nonce per page, written into a meta tag), no
  `'unsafe-inline'`. Radix injects a few `<style>` tags at run time (the scroll lock via `react-style-singleton`, which
  reads `get-nonce`; the Select viewport, which takes a `nonce` prop), so they carry the nonce. Sonner, shadcn's
  default toast, injects an unnonced `<style>` and is replaced by Radix Toast. The lesson behind this: a page broke
  because its `style-src` lacked `'self'`; the starter's test checks the header.
- **Where it lives:** `modules/core/design-system/` (theme, guidelines, checklist) and the starter. `scripts/sync-shared.mjs`
  copies the theme into the starter and both into the agent computers' image (`/opt/aidenhq/design-system`,
  `/opt/aidenhq/app-starter`); a test fails on drift. The catalog is the starter's `/catalog` route.
- **The old kit** (`components.css`, `kit.js`) is deprecated and kept only while an app still vendors
  it; its `catalog.html` is replaced by the starter's `/catalog`. Existing apps migrate when they are next touched for UI (the README's migration guide).
- **Rules:** the behaviour rules from the owner's corrections stay (filters apply instantly, URL state, partial updates,
  details in a drawer, status first, sources on facts, honest empty states).
- **Floors, not a template (revised 2026-11-14).** The first shadcn guidelines prescribed composition down to the block,
  the shell, the type classes and where the gradient went, and mockups came out the same: a full sidebar for three
  links, a permanent detail column beside a board, a large gradient tile. The owner judged the handbooks overfitted.
  Now only behaviour, states, accessibility and the stack are floors; layout, navigation, colour,
  type and motion are guidance with examples, the starter's blocks and shell are optional, and the designer is asked to
  explore directions and fit each app to its people and job. Owner corrections first change or delete an existing rule.
- **Light review (2026-11-14).** The owner wants no QA and no long back-and-forth: a UI review is one quick look that
  blocks only obvious, major breakage the PR introduced (the page doesn't render or errors, a core flow it touches is
  broken, data missing or wrong, unusable at desktop width, a severe accessibility blocker on the primary flow, a
  structural departure from a named, agreed mockup); everything else is a non-blocking note, and when unsure it passes.
  A PR gets at most one failing verdict: the runner files the fix's head as a re-review naming the earlier review, which
  checks only the blockers it named and passes with any left noted for a follow-up unless the page is broken outright.
- **Toolkit and process** are unchanged: `ui-review` (agent-browser with axe, vitals, layout checks and diffs) and the
  UI/UX Designer's plan, explore, build, capture, critique, fix loop, iterated while it improves.

## Pieces

| Path | What |
|---|---|
| `modules/core/design-system/` | `tokens.css`, `shadcn.css`, `guidelines.md`, `review-checklist.md`, `README.md` (usage + migration); the deprecated kit |
| `modules/core/templates/app/` | The app starter: Vite + React + shadcn/ui, a `node:http` server, the example dashboard, `/catalog`, one e2e test |
| `services/computer/images/agent-base/ui-review` | The review command (screenshots, axe, vitals, layout, diffs → `report.md`) |
| `scripts/test/design-system.test.mjs` | Contrast for every palette and mode; the shadcn theme maps onto existing tokens |
| `modules/design/` | The UI/UX Designer's and the UI Reviewer's handbooks (no scheduled audit: the designer audits an app when it moves to the starter, and on request) |

## Sources

The guidelines distil public guidance, adapted for small internal apps:

- **Web interface rules:** Vercel Web Interface Guidelines,
  <https://github.com/vercel-labs/web-interface-guidelines>. Covers URL state, focus, forms, motion, copy and dark mode.
- **States and tables:** GitHub Primer. Loading thresholds and live regions:
  <https://primer.style/product/ui-patterns/loading/>. Empty and error states:
  <https://primer.style/product/ui-patterns/empty-states/>. Data tables:
  <https://primer.style/product/components/data-table/guidelines/>.
- **Colour:** Radix Colors, the 12-step scale and its roles,
  <https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>.
- **Accessibility:** WCAG 2.2 AA (target size 2.5.8, contrast 1.4.3 and 1.4.11), <https://www.w3.org/TR/WCAG22/>.
- **Components:** shadcn/ui, <https://ui.shadcn.com> (MIT), on Radix Primitives, <https://www.radix-ui.com/primitives>.
- **Visual design:** Anthropic's frontend-design skill (spend boldness in one place, avoid generated-page tells, critique
  from screenshots).
- **Review loops:** AI design-review loops (run deterministic checks first, axe is authoritative, judge against a
  written rubric, cap iterations), <https://21st.dev/blog/visual-regression-testing-vs-ai-design-review>.
- **The owner's corrections on live apps,** generalised into rules: the guidelines' "Filters, search and updates" and
  "Detail views", and the checklist's "Behaviour the owner has had to correct before".
