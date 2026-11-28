# Aria Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. There are two lanes in parallel, each in
> its own worktree and PR. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Aria becomes an installable product module with a settings page, real time-finding, scheduling with other
people through summons, and an optional nightly optimizer.

**Architecture:**
- A generic `calendar_find_times` read tool goes in the google module, which does the date math in code.
- `modules/aria` holds the agent, its skills, the routine, and a small service serving the page plus
  `aria_config` / `aria_configure`, following the Maintainer/Ship page pattern.

**Tech Stack:** TypeScript on Bun; google-workspace-mcp; the board page-kit.

**Spec:** `docs/superpowers/specs/2026-11-28-aria-module-design.md`. The summon tools it uses are in
`docs/superpowers/plans/2026-11-28-summon-agents.md`, under "Shared interfaces".

## Global Constraints

- Nothing owner-specific: no "Mudit", no Dubai, no Polygon examples. Time zone and time format come from
  `scripts/handbook.ts` injection or the owner setting.
- Optional grants use `?`: slack, glean, `apps.warehouse_query`, `conversation`. Requires google, chat-lane, tasks,
  board.
- In `marketplace.json`, not in the default bundle. Quiet start: no schedule runs until the owner turns the optimizer
  on.
- Calendar writes and replies get a light review (malice-only, fail open). Bookings are confirmed only after Google
  reports success.
- The optimizer is off by default, at 02:00 owner time. Its move cap is counted in code from recorded calendar-write
  records.
- Settings defaults come from old Aria's `~/Development/calendar-manager/templates/principal/settings.yaml`.
- Page layout rules from modules/AGENTS.md, checked at 1512/1920/820/390 px.
- The starting point is the instance repo's `modules/aria/`. Clone it with `gh repo clone aidenhq-alpha/aidenhq-instance`
  into the scratchpad.

---

### Lane A (google): `calendar_find_times` and safe bookings

**Model:** sonnet.

**Files:**
- Create: `modules/google/connections/google-workspace-mcp/src/find-times.ts`.
- Modify:
  - `src/workspace.ts` / `src/write-tools.ts`: recheck free/busy before create/move; a stable event id for retried
    creates; `If-Match` on moves.
  - `modules/google/module.yaml`: the read tool; an optional free/busy scope offered on sign-in.
  - `modules/google/skills/calendar-changes/SKILL.md`: confirm only after success; report a conflict for an
    owner-named time.
- Test: `modules/google/connections/google-workspace-mcp/test/find-times.test.ts`.

**Interfaces:**
- Produces: `calendar_find_times(args)`.
  - `args`:
    ```ts
    {
      duration_min: number;
      window_start: string;            // ISO
      window_end: string;              // ISO
      attendees?: string[];            // emails
      working_hours: Record<"mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun", [string, string][]>;  // "HH:MM"
      call_windows?: { best?: [string, string][]; ok?: [string, string][] };
      buffer_min: number;
      min_notice_hours: number;
      max_per_day?: number;
      timezone: string;
      account?: string;
    }
    ```
  - Returns:
    ```ts
    { slots: { start: string; end: string; tier: "best" | "ok" | "last_resort"; timezone: string }[];
      attendee_freebusy: "used" | "not_granted" | "not_visible" }
    ```
  - Ranking: tier first, then adjacency to an existing meeting (back-to-back), then the earliest.
  - The day's time zone switches to the owner's flight/stay/working-location entries they organised or accepted.

- [ ] **Step 1: Failing tests.**
  - It skips busy blocks and respects the buffer, minimum notice and `max_per_day`.
  - Over a DST boundary, the slots keep their local wall time.
  - A working-location entry in another zone shifts that day's hours.
  - Ranking prefers `best` over `ok`, then back-to-back, then earliest.
  - Without the free/busy scope it returns `attendee_freebusy: "not_granted"` and still answers.
  - A create retried with the same key makes one event.
  - A move whose etag changed is refused.
- [ ] **Step 2:** Run under a 600 s alarm. Expected: FAIL.
- [ ] **Step 3:** Implement with the existing calendar client.
- [ ] **Step 4:** Run again. Expected: PASS. Then `pkill -f "${WT:?}/"`.
- [ ] **Step 5:** Commit `feat(google): calendar_find_times and safer calendar writes`.

### Lane B (aria): module, page, skills, optimizer, evals

**Model:** sonnet.

**Files:**
- Create `modules/aria/`:
  - `module.yaml`:
    - the agent `aria` with its `chat:` block, from the instance version;
    - optional grants;
    - `settings:`, as listed below;
    - routine `optimize-calendar`;
    - `contributes.board.pages` entry `aria`, icon `chat`, tools `aria_config` and `aria_configure`;
    - `roles.declares: aria-admin`.
  - `agents/aria/AGENTS.md`: mission only, generic, with `teammate:` frontmatter. Drop the `tasks.delegate-work`
    skill; complex work goes to Aiden through `task_create` assigned to `chief-of-staff`.
  - `skills/scheduling/SKILL.md`: the spec's "Scheduling skill" rules, written once.
  - `skills/optimize-calendar/SKILL.md`.
  - `service/`: `src/page.html` (page-kit), `src/mcp.ts` (`aria_config` returns all settings; `aria_configure`
    proposes changes), `src/prefill.ts`, `src/optimizer-cap.ts`, a Dockerfile and `package.json`.
  - `README.md` with the four sections.
  - `test/`.
- Modify: `modules/marketplace.json`, `.github/ci/areas.json`.
- Port: the 39 `ru-*` and 5 `adv-*` scenarios from calendar-manager `evals/scenarios/` into the format the learning
  loop's correction cases use. Find it; if none exists, use `modules/aria/evals/*.json` with the same fields and
  note it.

**Settings keys:**

| Key | Default |
|---|---|
| `aria_working_hours` | per-weekday ranges |
| `aria_call_windows` | best / ok |
| `aria_default_durations` | intro, one_on_one, external |
| `aria_buffer_min` | |
| `aria_travel_buffer_min` | |
| `aria_min_notice_hours` | |
| `aria_max_meetings_per_day` | |
| `aria_blocking_calendars` | |
| `aria_vips` | |
| `aria_team_domains` | |
| `aria_preferences` | free text |
| `aria_followup_after_hours` | |
| `aria_max_followups` | |
| `aria_negotiation_deadline_days` | |
| `aria_optimizer` | `off` (values `on` / `off`) |
| `aria_optimizer_at` | `02:00` |
| `aria_optimizer_max_moves` | |
| `aria_optimizer_prompt` | old Aria's text |

The other defaults are copied from `templates/principal/settings.yaml`. Each key gets a title, a help comment and
`writers: [aria-admin]`.

**Interfaces:**
- Consumes:
  - `calendar_find_times` from Lane A;
  - `conversation_context` / `conversation_reply` from the summon plan (optional grant);
  - `wake_at` from chat-lane.
- Produces: `aria_config() -> {settings: Record<string, unknown>}` and `aria_configure({changes})`, which returns the
  board's `settings_change` structured content.

- [ ] **Step 1: Failing tests.**
  - The compiler accepts the module: the `official-modules` suite passes with aria listed.
  - `aria_config` returns every key with defaults.
  - The page HTML renders every section; checked with a page-kit snapshot or a DOM check.
  - Prefill: given 4 weeks of fake events it proposes working hours that cover ≥90% of meetings, plus the most
    common duration.
  - The optimizer cap: with `max_moves` = 3 and 3 recorded moves tonight, a 4th is refused.
  - The handbook text contains no "Mudit", no "Dubai", no "Polygon".
- [ ] **Step 2:** Run the module tests and the compiler suite under a 600 s alarm. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - The page follows `modules/maintainer/service` as its reference.
  - Prefill runs as a one-shot when the page opens and finds no saved working hours. It proposes values through the
    board's Save bar and never writes silently.
- [ ] **Step 4:** Run again. Expected: PASS.
  - Screenshot the page at 1512/1920/820/390 with a scratchpad playwright-core script against the module's mock.
  - Then `pkill -f "${WT:?}/"`.
- [ ] **Step 5:** Commit `feat(aria): Aria as an official module with a settings page`.

## Review Focus

1. **The owner has no working hours saved and Google isn't connected yet.** The page shows the Connect state, not
   errors; the agent says it needs Google. Lane B test.
2. **The owner travels to another time zone mid-week.** `find_times` uses the local zone for those days. Lane A test
   (working-location shift).
3. **The other person replies after the negotiation deadline.** The task is closed; a new summons is needed. Covered
   by the summon plan's reopen test, plus the scheduling skill wording.
4. **The owner named an exact time, and it is taken by the time of review.** It reports a conflict, never silently
   moves. Lane A test (recheck before create).
5. **An optimizer retry after a crash.** The cap still holds across runs. Lane B cap test, counting recorded records.

## Merge order and cutover

- Lane A merges first; it's independent.
- Lane B merges after Lane A and summon Lane 1, with `ship:stop` until then.
- Cutover on our instance, per the spec:
  1. switch to the official module;
  2. move the Telegram group ban to the exclude-chats setting;
  3. run 3 days with standalone Aria's writes off;
  4. stop standalone Aria and archive calendar-manager.
