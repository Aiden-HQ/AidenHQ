# Fleet overview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Who is working on what reads at a glance from the sidebar, Fleet and agent pages, and each agent's automations read in plain words in one place.

**Architecture:** Client-only relabelling and ordering in the sidebar, Fleet and agent Overview; one server join extension feeding routine rows in agent Settings, which absorb Fleet's expanded schedule list.

**Tech Stack:** TypeScript, React (board web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-fleet-overview-design.md`

## Global Constraints

- Build after part 2 (`feat/board-task-truth`) merged: rebase onto `origin/main` first (both touch `Workspace.tsx`).
- No agent-row preview, no nested workers, no new agent-page lanes.
- Colour paired with text; existing tokens; no pill buttons.
- Product CLAUDE.md "Conventions" apply. Tests: only those listed. Hard timeouts; `pkill -f <worktree>/` after runs; never leave vite/mock-api running; never `git stash`.

## Failure modes to test

1. A group with chats that need you and chats working: the count is needs-you (with its colour and words), not working.
2. A paused schedule routine: no next run time, "Paused" shown.
3. An event routine whose subscription isn't applied yet: shows "Not set up yet", not a blank.
4. Fleet with zero working agents: groups keep their usual order, no empty "Now" column artefacts.
5. An agent with two jobs running: the nav badge counts runs ("2 active runs"), the Fleet row shows the agent once.

---

### Task 1: Sidebar count, Fleet order, nav badge, Open tasks

**Files:**
- Modify: `services/board/web/src/Workspace.tsx` (Sidebar group header ~243, ~322), `services/board/web/src/sidebar.ts` (~49-64), `services/board/web/src/Agents.tsx` (group ordering ~63, Now column ~338), `services/board/web/src/Shell.tsx` (nav badge ~79), `services/board/web/src/AgentPage.tsx` ("Working now" ~99-180)

**Interfaces:**
- Produces: `groupCount(chats: ChatRow[]): { kind: "needs" | "working"; n: number } | null` in `sidebar.ts` — needs-you count from owner attention if > 0, else working count (`kind === "working"`), else null. The group header renders it with a `title` that says the count covers this agent's chats.

- [ ] **Step 1: Implement** `groupCount` and the header count (remove the separate dots), Fleet's working-first order and wider Now title, the "N active runs" badge text, and the Open tasks rename with live-first order.
- [ ] **Step 2: Verify** `cd services/board && npm run typecheck && npm run lint`.
- [ ] **Step 3: Commit** `feat(board): fleet at a glance — group counts, working first, active runs`

### Task 2: Automations in agent Settings

**Files:**
- Modify: `services/board/src/app.ts` (`settingsData` ~1320), `services/board/src/paperclip.ts` (`Routine` ~79: `nextRunAt?: string | null`), `services/board/src/settings.ts` (`settingsView` routine rows), `services/board/web/src/SettingsAgents.tsx` (~175 routine rows), `services/board/web/src/Agents.tsx` (remove the expanded schedule list ~354-416, keep one "Next run" line)
- Test: `services/board/test/settings-routines.test.ts`

**Interfaces:**
- Produces on each routine row: `next?: string` (ISO, only for an enabled schedule on an active routine) and `wakes?: { connection: string; resource?: string; filter?: string } | "not_applied"` for event routines, read from the applied kernel subscription.

- [ ] **Step 1: Write failing tests:** an active schedule routine with Paperclip `nextRunAt` → row `next` equals it; a paused one → no `next` and `paused: true`; an event routine with an applied subscription → `wakes.connection` set; without → `wakes === "not_applied"`.
- [ ] **Step 2: Run** `cd services/board && perl -e 'alarm shift; exec @ARGV' 600 npx vitest run test/settings-routines.test.ts` — FAIL.
- [ ] **Step 3: Implement** the join and the routine rows ("Weekdays 9:00 AM · next Tue 09:00", "Wakes on a new Linear issue", "Paused", "Not set up yet"); move Fleet's schedule list out, keep its next-run line.
- [ ] **Step 4: Run** the test, typecheck, lint, `npx tsc -p tsconfig.build.json --noEmit` — PASS.
- [ ] **Step 5: Browser check** with the mock API at 1512, 1920, 390 (sidebar counts, Fleet, agent Overview, agent Settings); screenshots to the scratchpad; stop servers.
- [ ] **Step 6: Commit** `feat(board): automations in plain words on the agent's settings`

### Finish

- [ ] Board suites CI runs; local Codex review (`codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/fleet-overview-review.md < /dev/null`), fix important findings.
- [ ] One PR: `feat(board): fleet overview — who is working on what at a glance`.
