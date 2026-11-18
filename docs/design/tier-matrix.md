# Tier behaviour matrix

A write is tiered on one of three paths today. This page records how each path tiers the same scenario, so the
differences are visible before they are unified. `services/runner/test/tier-matrix.test.mjs` asserts every cell, so a
change to any tier rule fails that test until this page and the test are updated together.
`TIER_MATRIX_PRINT=1 node --test test/tier-matrix.test.mjs` (in `services/runner`) prints the table.

| Path | Where | How the test drives it |
|---|---|---|
| Kernel module kind | `kernel/src/writes.ts` `file()` (`computeTier` + `capped()`) | a tool mapped to a kind, through the kernel's proxy (`kernel/test/helpers.mjs`) |
| Kernel conn.tool | `kernel/src/writes.ts` `fileTool()` | a connection's write tool (Tier 0) or destructive tool (Tier 1) with no kind, through the proxy |
| Runner kind | `services/runner/src/main.mjs` `tierFor()`: `autonomyCap(classify(action, s), autonomyNow())` | a push, through `classify()` (`services/runner/src/tiers.mjs`) and `autonomyCap` |

The runner's trace (`commonTierState`) and its review input (`reviewOne`) live inline in `main.mjs`. The test
reproduces both: the review input in `runnerReviewInput()`, the trace by calling `origins()` against a control plane
that fails.

## How to read a cell

- **0**: the write runs at once.
- **1**: the AI reviewer decides.
- **1 panel**: the AI reviewer and a second reviewer decide.
- **2 final**: the reviewer reads it first. Its reject is final; its approve goes on to the owner.
- **2 owner**: Tier 2 on its merits. The reviewer reads it first, and every verdict goes on to the owner.
- **2 owner-only**: the owner's tap, with no reviewer.
- **error**: the tiering call fails, so the request is not filed.
- **n/a**: the path has no such write (conn.tool has no Tier 2 floor and no panel).
- **Approve label rows**: the code the kernel posts when the reviewer approves a capped record.

Autonomy values are the code's: `off`, `tier0` and `full`. The plan's "review" is `tier0`. An unknown instance value
counts as `off` in both the kernel (`main.ts`) and the runner (`autonomyNow`). An unknown routine value counts as `off`
too (`routineCap`).

## The matrix

| Scenario | Kernel module kind | Kernel conn.tool | Runner kind | Same? |
|---|---|---|---|---|
| Tier 0 write, autonomy full | 0 | 0 | 0 | same |
| Tier 0 write, autonomy tier0 | 0 | 0 | 0 | same |
| Tier 0 write, autonomy off | 0 | 0 | 2 owner-only | **differs** |
| Tier 1 write, autonomy full | 1 | 1 | 1 | same |
| Tier 1 write, autonomy tier0 (the verdict is shadowed at review) | 1 | 1 | 1 | same |
| Tier 1 write, autonomy off | 2 final | 2 final | 2 final | same |
| Tier 2 on its merits, autonomy full | 2 owner | n/a | 2 owner | same |
| Tier 2 on its merits, autonomy off | 2 owner | n/a | 2 owner | same |
| Panel kind, autonomy full | 1 panel | n/a | 1 panel | same |
| Routine cap full, Tier 1 | 1 | 1 | 1 | same |
| Routine cap tier0, Tier 0 | 0 | 0 | 0 | same |
| Routine cap tier0, Tier 1 | 2 final | 2 final | 2 final | same |
| Routine cap tier0, panel kind | 2 final panel | n/a | 2 final panel | same |
| Routine cap off, Tier 0 | 0 | 0 | 2 owner-only | **differs** |
| Routine cap off, Tier 1 | 2 final | 2 final | 2 final | same |
| Origin trace unreadable, Tier 0 | 0 | 0 | error | **differs** |
| Origin trace unreadable, Tier 1 | 2 final | 2 final | error | **differs** |
| Prior owner veto, Tier 1 | 2 owner | 2 owner | 2 owner | same |
| Approve label, routine cap tier0, the runner's review input | routine_autonomy | routine_autonomy | routine_autonomy | same |
| Approve label, routine cap tier0, a review input without the cap | new_authority | new_authority | n/a | latent (see 5) |
| Approve label, autonomy off, the runner's review input | autonomy_off | autonomy_off | autonomy_off | same |

How the scenarios are set up:

- **Tier 2 on its merits**: a module kind with `floor: 2`. On the runner, a request where the product repo isn't known
  (`unknown-repos`, fail closed).
- **Routine cap**: the task traces through `originRunId` to a routine's run task.
- **Origin trace unreadable**: the control plane answers 500.

Notes:

- **Rule names differ even where behaviour is the same.** A routine-capped Tier 1 record has these rules (asserted in
  the second test):
  - module kind: `routine-autonomy`
  - conn.tool: none, because `fileTool` sets no rule
  - runner: its part's own rule (for example `empty-repo`), with the cap in `routineCap`
- **Within the kernel, runner kinds lift Tier 0 too.** `writes.ts` `fileRunner()` lifts Tier 0 to the owner under autonomy
  off. So the first difference below is also a split inside the kernel, between its module kinds and its runner kinds.
  This comes from reading the code; the test doesn't assert it.
- **An unreadable trace fails closed on the kernel only at filing.** At review time, the runner's `reviewOne` traces the
  task again for every kernel-tiered record. If that trace fails, the review input is an error. The kernel then waits
  out `REVIEW_TRIES` failed reviews and rejects the record (`failedVerdict`, not on its merits). This comes from reading
  the code; the test doesn't assert it.

## Owner decisions needed

1. **Tier 0 write under the instance's autonomy off.**
   - Kernel module kinds and conn.tool: run at once (`computeTier` leaves Tier 0 at Tier 0).
   - Runner kinds: wait for the owner's tap, with no reviewer (`autonomyCap`; `fileRunner` agrees).
   - Recommended: lift in the kernel too. "Off" should mean the owner decides every write, as `autonomyCap`
     documents. Today an agent's Slack post or tool write still runs.
2. **Tier 0 write from a task a routine with autonomy off started.**
   - Kernel module kinds and conn.tool: run at once.
   - Runner kinds: wait for the owner's tap (`routineCapped`).
   - Recommended: lift in the kernel too. A routine set to off is a deliberate owner choice, and it should hold
     for every write its tasks make.
3. **Origin trace unreadable, Tier 1 write.**
   - Kernel: the cap is `off`, so the reviewer reads it first and the owner decides (2 final).
   - Runner: the tiering call fails, so the request isn't filed.
   - Recommended: the kernel's way, on both paths. It fails closed but still lets the write through to the owner,
     so a transient control-plane error doesn't block the work.
4. **Origin trace unreadable, Tier 0 write.**
   - Kernel: never traces a Tier 0 write, so it runs.
   - Runner: the tiering call fails.
   - Recommended: follow decision 2. If Tier 0 is lifted under a routine's off, the kernel must trace Tier 0 writes
     and treat an unreadable trace as `off`. Otherwise, keep not tracing.
5. **Where the capped approve label comes from.**
   - Kernel: the label depends on the review input the runner sends. With the cap it is `routine_autonomy`; without it,
     `new_authority`. The kernel's record carries `review_first: final` and a rule (none on conn.tool), but not the cap.
   - Runner: re-traces the cap at review, so the label is `routine_autonomy` in production.
   - Recommended: the kernel keeps the cap on its own record and derives the label from it, with the same rule on
     conn.tool. That way the label doesn't depend on a second trace that can fail (see the notes).
