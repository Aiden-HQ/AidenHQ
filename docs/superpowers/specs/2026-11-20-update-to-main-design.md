# Update a release install to a main commit

Owner-approved 2026-11-20. Code: `kernel/src/updates.ts`, `scripts/compiler/release.ts`, the owner MCP
(`services/board/src/mcp.ts`). How release updates work: [docs/design/release-updates.md](../../design/release-updates.md).

## Why

A release install (get.aidenhq.ai) gets only graduated releases: the nightly cut at 18:00 UTC, graduation, then the
02:00-05:00 install. An owner waiting on a fix that just merged (a tester, say) wants their install on that main commit
now, by asking their own Claude (Claude Code on the board's owner MCP), not by editing files on the host.

## Approaches

1. **An `update` tool on the owner MCP, verified by the kernel's updater (chosen).** One more source for the updater: a
   commit on the kernel repo's main. Same fixed repository, same "verified before anything runs", same filing as Update now.
2. **Hand-pinning (chosen, as a separate mode, documented only).** The owner leaves releases: removes `release:`, pins
   `product:` and applies on the host. That is how we run our own instance; `docs/operations/hand-pinned.md` writes it down
   for an owner's Claude. No code.
3. **Follow main continuously (rejected).** A channel knob, an unattended move to untested commits every hour, and a second
   update path to maintain. Out of scope; the hand-pinned mode covers owners who want that.

## Design

- **The tool.** `update { to: "main" | "<40-char sha>" }` on the owner MCP, a write tool (the MCP layer re-checks the
  bearer as for `decide`). The board posts it to the kernel's `/v1/owner/update` with the bearer, beside `/v1/owner/decide`:
  the kernel derives who from the grant (`account:<id>`) and hands the request to the same updater object Update now uses
  (`createUpdates`). No new authority: the request becomes the same UPDATER `kernel.apply` that Update now files.
- **Verification (the updater, `verifyMain`).** In order, each a refusal with its reason returned to the tool:
  the instance follows a release from the official distro; `main` resolves to the kernel repo's head (`git ls-remote` on the
  constant `Aiden-HQ/AidenHQ` over https); the commit is on that repository's main (`onMain`); it descends from the running
  `product:` and isn't it (no downgrade, nothing to do); its `ci-required` check run (GitHub Actions' own, latest by start)
  completed with success on that exact commit, as the distro's release.yml requires of a release's kernel (still running,
  failed and missing are three different reasons); and the pinned instance resolves (`readRelease`).
- **Synchronous refusal, asynchronous install.** The kernel runs the check (`updates.ts main <to>`, a bounded child) before
  it answers, so the tool gets the refusal or the resolved commit at once. Then it asks for that commit as Update now asks
  for a release: the hourly check's child verifies again against the instance's main, puts the commit on the product
  checkout's origin main (`landKernel`) and commits `product: <sha>` (with `release:` unchanged) on the instance repo's
  `update/main-<sha12>`; the kernel files it, follows it, and tells the owner installed / failed / refused through the same
  update notices.
- **Tier.** Whatever the apply planner gives the move: `release:` doesn't change, so it is a forward product pin
  (`pin-forward`, Tier 1, the AI reviewer) plus the module authority diff, as on any instance. Nothing in the planner changes.
- **release.ts.** `product:` must be the release's kernel, or descend from it on the kernel repo's main (checked in the
  official repository, a constant) with its `ci-required` green. Anything else is refused as before.
- **Build vs pull (one decision).** `readRelease` returns the release's prebuilt images only when `product:` is the
  release's kernel. Otherwise it returns none, so compile leaves every image to build from the checkout (compose and the
  computers), as a hand-pinned instance does.
- **Rejoining releases.** No new code: the updater already takes a newer graduated release only when its kernel descends
  from the running product. One change: a newer-named release whose kernel is behind the running product (cut before the
  commit the owner moved to) is skipped silently by the check, not told to the owner as a failed check; the planner's verify
  still refuses it.

## Security

- Fixed source: the kernel repository is the constant; `to` is `main` or a 40-char sha, nothing else.
- Verified before anything runs, twice (the precheck, then the check that prepares), and the planner checks the product
  move is forward along product main again.
- CI green always (owner, 2026-11-20): release.ts resolves a `product:` ahead of the release's kernel only with that commit's
  `ci-required` green (one judge, `ciRefusal`, shared with the updater); an unreadable status refuses. Another filer's forward
  pin on a release install meets the same checks.

## New installs

A fresh install from the installer follows a release with auto-updates on; nothing changes for it until the owner asks
for `update`. The tool needs only the owner MCP (default bundle) and GitHub's public API; GitHub, monitoring and other
optional modules play no part. A hand-pinned instance gets a refusal ("doesn't follow a release") and the doc link.

## Out of scope

Following main continuously; any board UI.
