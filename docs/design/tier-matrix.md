# Tier behaviour matrix

A write is filed on one of three paths, and all three tier it with one function, the kernel's `computeTier`
(`kernel/src/tier.ts`): floors, raises, the owner's veto, then the caps. This page records how each path tiers the same
scenario. `services/runner/test/tier-matrix.test.mjs` asserts every cell end to end, so a change to any tier rule fails that
test until this page and the test are updated together.
`TIER_MATRIX_PRINT=1 node --test test/tier-matrix.test.mjs` (in `services/runner`) prints the table.

| Path | Where | How the test drives it |
|---|---|---|
| Kernel module kind | `kernel/src/writes.ts` `file()` | a tool mapped to a kind, through the kernel's proxy (`kernel/test/helpers.mjs`) |
| Kernel conn.tool | `kernel/src/writes.ts` `fileTool()` | a connection's write tool (Tier 0) or destructive tool (Tier 1) with no kind, through the proxy |
| Runner kind | `kernel/src/writes.ts` `fileRunner()` | a push: `classify()` (`services/runner/src/tiers.mjs`) proposes its tier on the merits, `planOf()` makes the plan, and `POST /v1/writes` with the runner's key files it |

The runner only proposes: it never applies a cap. The kernel traces every write on a task to the routine its work came
from (`taskRoutineCap`), applies the instance's autonomy and that routine's cap, and keeps the cap it applied on the record
(`cap`: `{ by: "autonomy", value: "off" }` or `{ by: "routine", value, routine }`). The approve label comes from that field,
never from the review input, so it doesn't depend on a second trace.

## How to read a cell

- **0**: the write runs at once.
- **1**: the AI reviewer decides.
- **1 panel**: the AI reviewer and a second reviewer decide.
- **2 final**: the reviewer reads it first. Its reject is final; its approve goes on to the owner.
- **2 owner**: Tier 2 on its merits. The reviewer reads it first, and every verdict goes on to the owner.
- **2 owner-only**: the owner's tap, with no reviewer.
- **n/a**: the path has no such write (conn.tool has no Tier 2 floor and no panel).
- **Approve label rows**: the code the kernel posts when the reviewer approves a capped record.

Autonomy values are the code's: `off`, `tier0` and `full`. The plan's "review" is `tier0`. An unknown instance value counts
as `off` (`main.ts`), and so does an unknown routine value (`routineCap`). A routine trace that can't be read counts as a
routine set to `off`: the write goes to the owner, and filing never errors on it. When both a routine and the instance cap
a write, the record names the routine.

## The matrix

| Scenario | Kernel module kind | Kernel conn.tool | Runner kind | Same? |
|---|---|---|---|---|
| Tier 0 write, autonomy full | 0 | 0 | 0 | same |
| Tier 0 write, autonomy tier0 | 0 | 0 | 0 | same |
| Tier 0 write, autonomy off | 2 owner-only | 2 owner-only | 2 owner-only | same |
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
| Routine cap off, Tier 0 | 2 owner-only | 2 owner-only | 2 owner-only | same |
| Routine cap off, Tier 1 | 2 final | 2 final | 2 final | same |
| Origin trace unreadable, Tier 0 | 2 owner-only | 2 owner-only | 2 owner-only | same |
| Origin trace unreadable, Tier 1 | 2 final | 2 final | 2 final | same |
| Prior owner veto, Tier 1 | 2 owner | 2 owner | 2 owner | same |
| Approve label, routine cap tier0 | routine_autonomy | routine_autonomy | routine_autonomy | same |
| Approve label, autonomy off | autonomy_off | autonomy_off | autonomy_off | same |

How the scenarios are set up:

- **Tier 2 on its merits**: a module kind with `floor: 2`. On the runner, a request where the product repo isn't known
  to the runner (`unknown-repos`, fail closed).
- **Routine cap**: the task traces through `originRunId` to a routine's run task.
- **Origin trace unreadable**: the control plane answers 500.

Rules: a lifted Tier 0 write gets the cap's rule on every path (`autonomy-off` or `routine-autonomy`). A capped Tier 1
write keeps its own rule (none on conn.tool, the kind's raise on a module kind, the classifier's on the runner); the cap is
in its `cap` field.

## Revalidate at execution

A record the AI reviewer approved runs only while that yes still stands: right before it runs (`run()` for module kinds and
conn.tool, `claim()` for the runner's kinds), the kernel reads the autonomy and traces the routine cap again
(`writes.ts` `revalidate`; an unreadable trace is `off`). The owner's own yes is never re-held.

| Scenario | Kernel module kind | Kernel conn.tool | Runner kind | Same? |
|---|---|---|---|---|
| Reviewer-approved, then autonomy or the routine's cap tightened before it runs | held for the owner | held for the owner | held for the owner | same |

Held means: back to the owner's queue as Tier 2 after the reviewer, with the cap on the record and why after the reviewer's
note. `kernel/test/writes.test.mjs` ("revalidate at execution") asserts it on a runner kind; the other paths share the code.

## Owner decisions (2026-11-18)

1. Instance autonomy `off` raises Tier 0 writes to the owner (Tier 2, owner-only) on every path.
2. A routine cap of `off` raises Tier 0 writes too, so the kernel traces Tier 0 writes to their routine as well.
3. An unreadable routine trace fails closed on every path: it counts as a routine set to `off`, and never errors.
4. The kernel stores the applied cap on the record when it tiers it; the approve label and the runner's review input
   read it from the record. The runner no longer re-traces a task at review.
