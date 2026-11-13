# App starter

What a new app's repo starts from: a dependency-free Node server that renders HTML and already uses the design system
(`public/design-system/`, vendored unchanged from the product's `modules/core/design-system/`). Copy this folder into the
new repo, add the CI template (`modules/core/templates/ci/`), then replace the sample `ITEMS` with the app's data.

- `npm start` serves on `PORT` (8080). `npm test` runs one end-to-end test. Add dependencies only when needed, pinned
  exactly (the CI's 7-day rule applies).
- It already has the patterns the UI review checks: the app shell, a page header, filters that apply on change and update
  only `#results` (state in the URL), a responsive sortable table, details in a drawer (`data-drawer`), empty, no-match,
  unknown-filter and error states, a theme toggle, and `/health` answering `{ok: true, checks: []}`.
- Keep sample or seed data runnable locally (`npm start` with no database), so the UI/UX Engineer can screenshot every
  state with `ui-review`.
- Rules and markup: the product's `modules/core/design-system/` (`guidelines.md`, `catalog.html`). A shared app also follows `docs/setup.md` "What a shared app must do".
