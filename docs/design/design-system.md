# Design system for agent-built apps

(The board has its own kit and guide: [board-ui.md](board-ui.md). The two share the taste, not tokens.)

Apps that Engineers build use shadcn/ui + Tailwind on a shared theme, with a small set of floors instead of a template.
Usage and migration live in `modules/apps-platform/design-system/README.md`; this note is how the pieces fit.

- **Stack:** the app starter (`modules/apps-platform/starter/`) is Vite + React + TypeScript, Tailwind CSS 4, shadcn/ui
  components generated into `src/components/ui` as source (on Radix via `radix-ui`) and lucide icons. A small `node:http`
  server (`server.mjs`) with no runtime dependencies serves the build, `/api/health` and the app's API, so the image
  carries no `node_modules`.
- **Theme:** `tokens.css` (Radix Colors: four palettes, light and dark, all AA) is the only source of colour. `shadcn.css`
  maps it onto shadcn's variables and Tailwind's colour names, so components need no edits; `presets/` are optional themes
  and an instance re-themes by overriding tokens or shadcn variables. Two names collide: the tokens' `--accent` (brand
  fill) and `--border` (a width), so Tailwind's `accent` maps to `--surface-hover` and `border` to `--line`. `dark:`
  follows `<html data-theme>`, set by `public/theme.js` before first paint.
- **CSP:** `script-src 'self'` and `style-src 'self' 'nonce-...'` (a fresh nonce per page in a meta tag), never
  `'unsafe-inline'` or a CDN. Radix's runtime `<style>` tags carry the nonce; Radix Toast replaces Sonner, which injects
  an unnonced style. The starter's test checks the header.
- **Where it lives:** `modules/apps-platform/design-system/` (theme, guidelines, checklist) and the starter.
  `scripts/sync-shared.ts` copies the theme into the starter and both into the agent computers' image
  (`/opt/aidenhq/design-system`, `/opt/aidenhq/app-starter`); a test fails on drift. The catalog is the starter's dev-only
  `catalog.html` (`npm run catalog`). The plain-CSS kit (`components.css`, `kit.js`) is deprecated and kept only for apps
  that still vendor it.

## Rules

- **Floors, not a template.** Only these bind: readable contrast in both themes, visible focus, details at a URL that
  opens them on load, empty, loading and error states, and the stack. Layout, navigation, colour, type and motion are
  guidance; the starter's blocks and shell are optional, and the designer fits each app to its people and job. The
  handbook says what good looks like, never a list of looks to avoid. An owner correction first changes or deletes an
  existing rule.
- **Behaviour rules from the owner's corrections:** filters apply instantly, URL state, partial updates (no reload that
  loses focus), details in a drawer, status first, sources on facts, honest empty states, no invented dates or internal
  labels on screen.
- **Light UI review.** A UI review is one quick look that blocks only obvious, major breakage the PR introduced (the page
  doesn't render, a core flow it touches is broken, data missing or wrong, unusable at desktop width, a severe
  accessibility blocker on the primary flow, a structural departure from a mockup the task names); everything else is a
  non-blocking note, and when unsure it passes. A PR gets at most one failing verdict: the re-review checks only the
  blockers that verdict named (`modules/design/agents/ui-reviewer/AGENTS.md`). The reviewer judges a PR by the before|after
  pictures of each changed page (`ui-review --baseline`), dark mode included: what is broken in the after that was fine
  in the before. Its model is GPT Sol by default (`modules/design/module.yaml`); set another with
  `overrides.agents.ui-reviewer.model` in `instance.yaml`.

## Pieces

| Path | What |
|---|---|
| `modules/apps-platform/design-system/` | `tokens.css`, `shadcn.css`, `presets/`, `guidelines.md`, `review-checklist.md`, `README.md` (usage and migration); the deprecated kit |
| `modules/apps-platform/starter/` | The app starter: blocks, `server.mjs`, example dashboard, catalog, e2e tests |
| `services/computer/images/agent-base/ui-review` | The review command (screenshots with `--full` stepping through an app's inner scroller, axe, layout and route checks, headless vitals and tiny text as notes; with `--baseline`, a frozen page clock, before\|after pictures and a "Look at these first" list of the changed pages to `report.md`) |
| `modules/design/` | The UI/UX Designer's and the UI Reviewer's handbooks (no scheduled audit: the designer audits an app when it moves to the starter, and on request) |
