# Design system for agent-built apps

**Problem.** Apps that Engineers vibe-code looked and behaved below industry standard even after design passes. The old
kit had ten CSS classes and no behaviour, so every app re-invented filters, tables and states, and the owner kept
correcting the same things: Apply/Show buttons on filters, full page reloads that lost the search box's focus, details
that replaced the list, status buried under history, missing or misleading empty states, invented dates and internal
labels on screen.

## Decision

- **Where it lives:** the product repo, `modules/core/design-system/`. It is in `core` because every instance has apps;
  the `design` module only adds the reviewer. `scripts/sync-shared.mjs` copies it byte-for-byte into the app starter
  (`modules/core/templates/app/public/design-system/`) and into the agent computers' image (`/opt/aidenhq/design-system`),
  and a test fails on drift.
  - The agents-org `design-system` repo, the old distribution copy, is retired. Engineers read the product checkout, and
    computers carry the image copy. Archive it once its last consumer has migrated.
  - An instance brands apps with an optional `design/theme.css` in the instance repo (overriding `--accent*`, `--focus`
    and `--font` only).
- **Tech:** framework-agnostic plain CSS (tokens plus component classes), native `<dialog>`, and one dependency-free
  `kit.js` (about 300 lines) for behaviour, driven by data attributes and progressively enhanced. This suits
  server-rendered Node apps with no CSS build, which is what Engineers produce, and React apps can use the same classes.
  - Rejected: Tailwind presets and shadcn/ui (they need a build step and React), Pico (classless styling clashes with
    app markup and offers few data components), and Open Props (tokens only, with hundreds of them).
  - Colours are vendored as values from Radix Colors 3.0.0 (MIT, published 2023-10-02). Its 12-step scales have
    documented roles and dark twins, so four palettes in light and dark come with almost no design debt. A test checks
    every palette and mode for WCAG AA (492 pairs).
- **Themes:** `data-palette="neutral|warm|contrast|data"` on `<html>`, set apart from the existing light/dark switch
  (`data-theme`, or the system setting). `data` is dense: smaller type and tighter cells, while touch screens still get
  44px targets.
- **Toolkit:** `ui-review` in the agent-base image wraps agent-browser 0.41.2, which is already pinned in the image and
  ships an embedded axe-core 4.12 audit (`a11y`), web-vitals (`vitals`) and pixel diffs (`diff screenshot`).
  - It adds viewport and colour-mode loops, in-page layout checks and ffmpeg before|after pictures. It needs no new
    dependency.
  - Lighthouse was left out: it adds about 50 MB and a second Chrome driver, and vitals plus axe cover what blocks a
    review.
  - The computers can't reach live apps (their firewall), so reviews and audits run the app locally from `repo-checkout`
    on seed data. `app_view` confirms the deployed page (light only).
- **Process:** the UI/UX Engineer runs plan → build from the kit → capture → critique against the checklist → fix, at
  most 3 rounds, on every mockup, review and weekly audit (the `design-audit` routine, one Engineer task per app). Changes
  to the kit are product PRs by the Platform Engineer (the UI/UX Engineer proposes them in its task reports), reviewed
  with `ui-review` of the catalog in all palettes.

## Pieces

| Path | What |
|---|---|
| `modules/core/design-system/` | `tokens.css`, `components.css`, `kit.js`, `catalog.html`, `guidelines.md`, `review-checklist.md`, `README.md` (usage + migration) |
| `modules/core/templates/app/` | The app starter: `node:http`, no dependencies, the patterns in place, one e2e test |
| `services/computer/images/agent-base/ui-review` | The review command (screenshots, axe, vitals, layout, diffs → `report.md`) |
| `scripts/test/design-system.test.mjs` | Contrast for every palette and mode; the catalog and starter use only kit classes |
| `modules/design/` | The UI/UX Engineer's handbook and the weekly `design-audit` routine |

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
- **Visual design:** Anthropic's frontend-design skill (spend boldness in one place, avoid generated-page tells, critique
  from screenshots).
- **Review loops:** AI design-review loops (run deterministic checks first, axe is authoritative, judge against a
  written rubric, cap iterations), <https://21st.dev/blog/visual-regression-testing-vs-ai-design-review>.
- **The owner's corrections on live apps,** generalised into rules: guidelines §6 and §12, and the checklist's "Behaviour
  the owner has had to correct before".
