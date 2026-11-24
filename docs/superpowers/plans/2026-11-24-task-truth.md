# Task truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One look at a task shows what done means and whether it is met, who owns each delegated piece, and what happened, with a run line under each agent reply in chat.

**Architecture:** Board server enriches `IssueView` with the grade and a task-scoped milestone list; the web drawer renders Done means, the shared Lineage list and one merged Activity feed; chat replies get a run line from the job tags they already carry.

**Tech Stack:** TypeScript, React (board web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-task-truth-design.md`

## Global Constraints

- Build on `main` after part 1 (`feat/board-needs-you-answers`) merged: rebase this branch onto `origin/main` first.
- No worker-update cards, no action lines, no second steps fold. Keep live `Steps` and `NoiseFold`.
- A grade that can't be read is shown as **Grade unavailable**, never as passed; a close without a verdict is **Closed without verification**.
- Colour always paired with status text; existing tokens; no pill buttons.
- Product CLAUDE.md "Conventions" apply. Tests: only those listed. Hard timeouts on every test run; `pkill -f <worktree>/` after; never leave vite/mock-api running; never `git stash`.

## Review Focus

1. Ungraded task: no Done means section at all (no empty box).
2. Grading module down: drawer still loads; Done means says Grade unavailable.
3. A PR deliverable whose ref is still empty: no broken link, text "PR not opened yet".
4. A chat reply with no job tag (owner-typed, notices): no run line.
5. A task with 50+ comments and facts: Activity stays chronological and the drawer opens without a visible stall (one fetch per source).

---

### Task 1: Server — grade and milestones on the task view

**Files:**
- Modify: `services/board/src/app.ts` (issue view builder ~720-760; reuse `gradesOf`), `services/board/src/flow.ts` (task-scoped read of kernel `GET /v1/flow?task=`), `services/board/web/src/types.ts` (`IssueView`)
- Test: `services/board/test/task-truth.test.ts`

**Interfaces:**
- Produces on `IssueView`:
  - `grade: { state: "none" | "unavailable" | "ungraded_close" | GradeState; rubric: { text: string; met: "yes" | "no" | "unknown"; evidence?: string }[]; judgedAt?: string; version?: string; deliverable?: { kind: Deliverable["kind"]; ref: string; href?: string } }` — `rubric` falls back to the grading module's effective template when the filed one is empty; `href` only when the ref resolves.
  - `milestones: { at: string; kind: "created" | "run_started" | "run_ended" | "asked_you" | "approved" | "applied" | "deployed" | "graded"; text: string; href?: string; runId?: string }[]` from the kernel facts for this task only (not descendants).

- [ ] **Step 1: Write failing tests:** graded task → `grade.rubric` carries met/evidence from the latest verdict and `deliverable.href` for a PR ref; grading throws → `grade.state === "unavailable"`; done task with no verdict → `"ungraded_close"`; no grade row → `"none"`; facts `job.started`, `job.ended`(failed, why "timeout"), `work.waiting` owner_wait, `record.decided`, `pr.deployed`, `grade.verdict` → six milestones in time order with the failed run's text containing "timeout".
- [ ] **Step 2: Run** `cd services/board && perl -e 'alarm shift; exec @ARGV' 600 npx vitest run test/task-truth.test.ts` — FAIL.
- [ ] **Step 3: Implement** the two fields.
- [ ] **Step 4: Run** the test plus `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(board): grade and milestones on the task view`

### Task 2: Drawer — Done means, delegated work, one Activity feed

**Files:**
- Modify: `services/board/web/src/Drawer.tsx` (`IssueBody`/`Overview` top; `Thread` ~656; remove the standalone run links ~231), `services/board/web/src/Lineage.tsx` (Needs you first, state + agent + elapsed per row, rows link), `services/board/web/src/Workspace.tsx` (`DetailsPanel` children list → `LineageStrip`), the drawer's css.

**Interfaces:**
- Consumes: `IssueView.grade`, `IssueView.milestones` (Task 1), `LineageStrip` props as today.
- Produces: `DoneMeans({ grade }: { grade: IssueView["grade"] })` in `Drawer.tsx`; `Thread` renders comments and milestones merged by `at`, milestone rows compact (time · text · link).

- [ ] **Step 1: Implement** `DoneMeans`, the Lineage ordering/links, the merged `Thread`, and the DetailsPanel swap; delete the replaced code.
- [ ] **Step 2: Verify** `npm run typecheck && npm run lint && npx tsc -p tsconfig.build.json --noEmit`.
- [ ] **Step 3: Commit** `feat(board): done means, delegated work and one activity feed in the task drawer`

### Task 3: Chat run line

**Files:**
- Modify: `services/board/src/app.ts` (chat view ~815, the job-tag join), `services/board/src/timeline.ts` (wake labels ~86, reuse), `services/board/web/src/Workspace.tsx` (`MessageView`)
- Test: add one case to `services/board/test/task-truth.test.ts`

**Interfaces:**
- Produces on a chat reply: `run?: { id: string; seconds: number; trigger?: string }` — only for replies with a job tag; `trigger` only when the wake label is attributable.
- `MessageView` renders `Ran for 6m 12s · <trigger> ›` linking to the existing run trace route.

- [ ] **Step 1: Write the failing test:** a reply tagged with a job that ran 372 s from a schedule wake → `run.seconds === 372` and `run.trigger` contains the schedule's label; an untagged reply → no `run`.
- [ ] **Step 2: Implement**, run the test and typecheck — PASS.
- [ ] **Step 3: Browser check** with the mock API at 1512, 1920, 390: a graded task (met/unmet/unknown), an ungraded one, grading down, a chat with run lines. Screenshots to the scratchpad; stop servers.
- [ ] **Step 4: Commit** `feat(board): run line under agent replies`

### Finish

- [ ] Run every suite CI runs that this touches (board vitest, typecheck, lint, tsc build).
- [ ] Local Codex review (`codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/task-truth-review.md < /dev/null`), fix every important finding, low-effort re-run on the fixes.
- [ ] One PR: `feat(board): task truth — done means, delegated work, one activity feed`.
