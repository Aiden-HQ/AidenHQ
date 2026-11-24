# Task truth: done means, delegated work, one activity feed

Status: approved by the owner 2026-11-24 (after a Codex design review). Part 2 of three board upgrades adopted from Orca
Bots (orca.dev/bots); part 1 is `2026-11-24-needs-you-answers-design.md`.

## Why

The owner's drains include tracking and verifying what agents claim. Today the board has the facts (grades, the kernel's
per-task facts, lineage) spread over several views. One look at a task should answer: what counts as done and is it met,
who owns which piece, and what actually happened.

## Goals

1. **Done means** at the top of the task drawer (`Drawer.tsx`), from the grade (`services/board/src/grading.ts`): each rubric
   criterion with **Met / Unmet / Unknown** as text plus colour, one line of the latest verdict's evidence, and the verdict's
   version and time. One deliverable link (PR, app, file…), shown only once its ref resolves. When the filed rubric is empty,
   show the grading module's effective template through its existing read. States: no grade row → nothing; a close without a
   verdict → **Closed without verification**; grading unreachable → **Grade unavailable** (never read as passed).
2. **One delegated-work list**, used in the drawer and in a chat's Details: the Lineage strip (`Lineage.tsx`, `app.ts`
   `lineage()`), Needs you first, then state, agent and elapsed time, each row a link to the child. It replaces chat Details'
   separate task list (`Workspace.tsx` `DetailsPanel` children groups).
3. **One Activity feed** in the drawer: today's comment thread (`Thread`) interleaved with milestones from the kernel's
   per-task facts (`GET /v1/flow?task=`): created; run started / ended (linked to its run trace; a failed run shows its
   reason, a successful one its outcome); asked you (`owner_wait`); card approved / applied / deployed as three distinct
   labels with their source link; graded (`grade.verdict`). The drawer's standalone run links move into these rows.
4. **Chat run line**: under each agent reply that carries a job tag, one line `Ran for 6m 12s · <trigger> ›` that opens
   the existing run trace (`Run.tsx`). The trigger reuses Agent Activity's wake labels and shows only when attributable.

## Non-goals (cut in review)

- "Update from worker" cards in the parent chat (dispatch and grading already report child completion).
- "Added and moved X" action lines (no reliable run→write receipt; the Activity feed shows recorded changes).
- A second steps fold in chat (the run trace has the steps; live `Steps` and `NoiseFold` stay as they are).

## Behaviour changes (owner OK'd)

- Chat Details' grouped child list is replaced by the Lineage list (Needs you first).
- The drawer's standalone run links are replaced by Activity rows.

## Approaches considered

1. **Merge into existing views (chosen):** Done means + Lineage + Activity feed in the drawer, a run line in chat.
2. A new Timeline section beside Activity, Lineage, DetailsPanel and Run: a fourth view of the same facts; rejected.
3. Orca's full chat treatment (worker cards, action lines, step folds): repeats existing notices; rejected.

## Constraints

- Reuse: grades from `grading.ts`, flow facts via a task-scoped board wiring of the kernel's `?task=` read (the board's
  `flowItem` uses `?item=`, which includes descendants), lineage from `lineage()`, wake labels from Agent Activity.
- Owner taste: dense rows, colour paired with explicit status text, moderate radius, no pill buttons.
- Minimal tests; a browser check at 1512, 1920 and 390 widths.
