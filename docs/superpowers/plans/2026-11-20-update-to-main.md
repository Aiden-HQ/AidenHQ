# Plan: update a release install to a main commit

Spec: [2026-11-20-update-to-main-design.md](../specs/2026-11-20-update-to-main-design.md).

## Files

- `scripts/compiler/release.ts`: `resolveRelease(file, instance, descends?)` accepts `product:` != kernel when
  `descends(kernel, product)`, and returns `images: {}` then. `readRelease(instance, f, kernelUrl = KERNEL_URL)` supplies
  `descends` (product on the official kernel repo's main, kernel its ancestor).
- `kernel/src/updates.ts`:
  - `verifyMain(d, text, to)`: resolve, onMain, descends, `ci-required` green, `readRelease` on the pinned text.
  - `checkLocked`: an ask whose `release` is a 40-char sha is a main move (`prepareMain`: `landKernel`, `commitOn` on
    `update/main-<sha12>`). A release behind the running product is skipped silently (`Behind`).
  - `follow`: a main move keeps the followed release's name; `labelOf(r)` names it in texts.
  - `createUpdates(...).requestMain(to, by)`: awaits the `precheck` child (`runMain`), then asks as Update now does.
  - CLI `main <to>`: the precheck, JSON `{ sha, compare }` or exit 3 with the reason.
- `kernel/src/auth-api.ts`: `POST /v1/owner/update` (board key + MCP bearer) → `update(to, account:<id>)`.
- `kernel/src/main.ts`: wire `update` and `runMain`; the task title uses `labelOf`.
- `services/board/src/kernel-auth.ts`: `mcpUpdate` (longer timeout). `services/board/src/mcp.ts`: the `update` tool in
  `WRITE_TOOLS`.
- Docs: `docs/design/release-updates.md` (the main source), `docs/operations/hand-pinned.md`, operations.md line.

## Tests

- `kernel/test/updates.test.ts`: a main commit with green CI is prepared (product moved, release kept) and filed; refused:
  off main, red/pending/missing CI, not descending; a jump then the next release that descends is accepted, an older one
  skipped silently.
- `scripts/test/release.test.ts`: a descendant product resolves with no images; a non-descendant is refused.
- Board: the tool list test, if one counts tools.
