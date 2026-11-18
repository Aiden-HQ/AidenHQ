# Large changes

## Split, build side by side, integrate once

A large build with independent parts (several screens, files or modules) is split and built side by side, then
integrated and checked once at the end:

- Plan the split, then `spawn_agent` one sub-agent per part, in parallel. Keep tightly coupled edits in one agent.
- Each brief is self-contained (a sub-agent doesn't see the task): the goal, the files it owns, the conventions, and
  "edit only these; don't commit, build or publish".
- `wait_agent` with a `timeout_ms` of at most 600000, and repeat (a silent run is stopped as stalled); close the agents
  when done.
- Integrate, build and test once yourself.
- Publish in slices as parts land (`aidenhq pr`, stacked branches), so the time limit never loses finished work.

Work that spans several tasks splits the same way: several Engineer tasks side by side, integrated and checked once.

## Stacked PRs

The AI reviewer reads up to 150,000 characters of diff per card, and `code-review` refuses a diff much over ~2,000
lines. A change bigger than that is planned as stacked PRs from the start: each branch made from the one before, split
at file seams, each diff under those sizes, each published on its own (`aidenhq pr <org/repo> <branch>`).

## Large rewrites hold the files they replace

While an app has an open PR that is a large rewrite (a framework or page-layer replacement, a starter or design-system
migration, a generated tree swapped out; roughly a thousand changed lines, or a whole directory replaced), the files it
replaces are held.

- Other work on those files waits until the rewrite merges, or targets the rewrite branch.
- Before opening a PR, read the app's open PRs for such a rewrite and compare file lists. A PR into the default branch
  against held files waits for the rewrite.
- A change that only touches held files is retargeted onto the rewrite branch when the rewrite's owner agrees that is
  safe; otherwise its task is parked with a note saying what it waits on.
- Changes to other files (data layer, API, server, migrations, tests, CI) land normally.
- Once the rewrite merges or closes, each held fix is re-confirmed as still needed against the new code before it is
  redone: a held patch is rewritten for the new code, not replayed.
