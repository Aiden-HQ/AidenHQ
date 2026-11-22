# Agent anatomy (one PR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One product PR, `feat: agent anatomy (local modules, memory, explicit skills, event routines, sharing, self-edits)`,
and the matching instance-repo change. It delivers the anatomy spec and the owner's 2026-11-23 decisions A-G, and deletes
every old path it replaces.

**Architecture:** The kernel stays the one authority, with one owner per concern:

| Concern | Owner |
|---|---|
| Memory files (fenced when read) | `memory.ts` |
| Turning Slack and GitHub events into routine runs, through Paperclip's own `/run` with its idempotency key | `events.ts` |
| The one path an agent changes itself by: a typed change, checked against the prospective compiled tree, written as an instance commit and filed as the only record, a Tier 1 `kernel.apply` | `settings-change.ts` `asAgent` |

- The compiler loads local modules from `<instance>/modules/`, and every agent has one effective skill list.
- Setup reconciles managed routines by Paperclip id.
- Deleted: merit tiers, the path inventory, routine autonomy, provenance, trial and `private_reads`.
- A tier is now: kind floor, hard refusals, owner veto or save, autonomy off.

**Tech Stack:** TypeScript on Node 24 (`.ts` run directly), `node:sqlite`, `node:test`, `yaml` 2.9.1, vitest (board),
and the Paperclip image pinned in `compose.yaml`.

**Spec:** `docs/superpowers/specs/2026-11-22-agent-anatomy-design.md` (with "Decisions 2026-11-23"). Codex's plan review
(`codex-plan-review.md`, against `origin/main` be39d2c4) is folded in, and line references below are to that commit.

## Global Constraints

- The product `CLAUDE.md` "Conventions" section is binding. Cite it in every builder brief.
- One way. Each replaced path is deleted in this PR:
  - `instanceAgents` and `agents/<key>/agent.yaml`;
  - the memory inbox and the daily memory curation;
  - implicit skill selection;
  - the Slack triage poke, its webhook and `slack_pending_events`;
  - `trial`, `trial_writes` and `TRIAL_*`;
  - merit tiers and the path inventory;
  - routine `autonomy`, routine caps and provenance;
  - `private_reads`;
  - `task_propose_rule`.

  No fallback, no old path running alongside, no follow-up PR.
- Never `git stash`, never `git add -A`. Each lane works in its own worktree off `feat/agent-anatomy` and merges back at
  the end of its stage.
- Minimal tests: the four end-to-end checks (V1-V4) plus the few unit tests named in the tasks. Delete tests of deleted
  code.
- No owner data in the product. Fixtures use `acme`, `example.com` and `review-chaser`. Planted secrets are built at
  runtime.
- Handbook and skill text is positive only. Rules live once.
- Board UI follows `docs/design/board-ui.md`, with screenshots at 1512x982, 1920x1080, 2560x1440, 768, 1024 and 390, in
  both themes.
- `kernel/contract.lock.json` is regenerated once, in Task 17. New routes start `experimental`.
- One Codex review and one security review, in Task 17.
- Memory: `MEMORY_MAX = 4096` bytes per file, `FACT_MAX = 500`, `SOURCE_MAX = 300`, `WRITES_PER_JOB = 10` mutations of
  any kind, 500 tombstones.
- Events:
  - each batch is sealed at the end of a 60 s window;
  - at most 20 events per batch and 2000 characters of text per event;
  - 12 runs per routine per hour and 120 runs per hour in total;
  - a queue cap of 5000 events or 8 MB;
  - 30 GitHub repos polled.
- Routines that agents make, and routines in local modules:
  - at most 20 per agent;
  - one schedule, whose minute field is one literal integer 0-59, checked on the final routine after overrides;
  - an `event` routine needs a non-empty filter;
  - only whitelisted fields.

## Review Focus

1. **`self_change` for something that isn't the agent's.** Covers:
   - another agent's handbook or skill list;
   - a routine owned by another agent, or one whose key collides with a product routine;
   - a profile change by an agent without `fleet-admin`;
   - a prospective tree that does not compile;
   - a call whose signed tool isn't `self_change`.

   Expected: refused before any branch is written. Covered in V2.
2. **Memory poisoning.**
   - Instruction-shaped, leading-imperative ("from now on…", "always…", "send … to …") or fenced facts get a 400.
   - Memory text reaches both prompts only inside the SDK fence.
   - Legacy lines pass the same parser and checks on import.

   Covered in Task 4 and V1.
3. **Events reaching a routine that may not read them.** Covers:
   - a resource beyond the agent's read reach on that connection;
   - a revoked grant;
   - a routine that is paused or deleted;
   - a batch read by another task or agent;
   - an unauthenticated or oversize envelope;
   - the global cap.

   Expected: no run, a 403, or a counted skip or drop that still answers 2xx. Covered by the `events.test.ts` unit test (CI) and V3 (manual).
4. **Publish differing from the owner's preview.** Covers:
   - the module or tip changes after the preview;
   - an agent filing `github.publish_module`;
   - a private destination;
   - a flagged export;
   - memory or secrets in the bytes.

   Expected: refused, and a new preview is needed. Covered in V4.
5. **Upgrade drift.** Covers:
   - a renamed or removed managed routine;
   - a legacy memory file;
   - a handbook with frontmatter;
   - a local manifest smuggling authority keys.

   Expected: no duplicate or orphaned active routine, memory imported or refused line by line, compile refusals by key.
   Covered in V1.
6. **Tier 0 GitHub text.** A thread reply or label carrying an instance host is refused by code on the `fileTool` path.
   Covered in Task 2.

## Verification set (end-to-end; security refusals ride in these paths)

V1, V2 and V4 are fast in-process tests with fakes, and they run in CI. V3 needs Docker and the pinned Paperclip image.
Under the owner's rule (e2e checks are manual one-off runs, and CI stays trimmed), it is a documented manual check that
the builder runs once before opening the PR, never on the EX44 host. There is no new CI job.

| Id | Test file | Proves |
|---|---|---|
| V1 | `scripts/test/upgrade.test.ts` | Covers the upgrade of a fixture instance: `agents/<k>/` reshaped to a local module, a handbook with frontmatter, existing Paperclip routines (fake control plane) and legacy `memory.md`. Runs `memory-move`, compile and setup in sequence. Asserts: memory imported once with `migration:` provenance and its counts, and a rerun skips; setup **interrupted after Paperclip creates a routine** then rerun adopts it by marker (no duplicate); a removed routine is archived, and re-adding it restores the same id; obsolete triggers are disabled with fields unchanged; a pause survives apply; a `library` routine targeting a product agent under quiet start is created active; two schedules through an override fail; manifest smuggling keys refused; `agents/y/agent.yaml` refused with the move message. |
| V2 | `kernel/test/self-change-e2e.test.ts` | Covers the chat handoff and a typed apply. A lane "remember X" becomes a `task_create` handoff, then a job, then `memory_note` (owned by the agent), then the next job's fenced memory section. Aiden's job `self_change` profile and a crew job `self_change` library skill each file one Tier 1 `kernel.apply` with that job as requester, validated at the fetched base, with no `conn.tool` record. A main that moved after the fetch gives "file again". Refusals from Review Focus 1, plus an instruction-shaped note. |
| V3 (manual) | `kernel/test/e2e/events-paperclip.manual.ts`, run with `node kernel/test/e2e/events-paperclip.manual.ts`, outside `npm test` | Event delivery against the pinned Paperclip image (Docker, a throwaway container). A Slack-shaped burst produces one run carrying its variables, and the same batch key fired twice still produces one run. The run's job reads its batch, and the job ends `quiet`. Refusals from Review Focus 3. |
| V4 | `services/board/test/share-e2e.test.ts` | Owner preview, then publish, through the real filing-to-execution path. The board preview is followed by a Save bound to the digest, source, repo, ref and base, then the owner's `fileKernel`, then executor revalidation, then a fake GitHub REST commit made by the code host's commit assembly. A tip moved after Save fails with "preview again". An agent job filing `publish_module` is refused. Plus the other refusals in Review Focus 4. Covers the round trip: export, add as a local-path marketplace, compile with routines paused. |

## Lanes, stages and hot spots

| Stage | Lanes, side by side | Tasks |
|---|---|---|
| 1 | **T** trust cuts ‖ **M** memory | 1-3 ‖ 4-5 |
| 2 | **L** local modules, trial and routine reconcile ‖ **E1** event router, sources, quiet | 6-7 ‖ 8-10 |
| 3 | **S** skills and self-edits ‖ **E2** event compile and triage ‖ **P** sharing | 11-13 ‖ 14 ‖ 15-16 |
| 4 | integration, instance change, deploy | 17-18 |

Hot spots: lanes that share a file within a stage make small commits and rebase on the stage branch before each one. The
lead merges the lane named first back first.

| Stage | Shared files | Lanes (first listed merges first) |
|---|---|---|
| 1 | `scripts/modules.ts`, `scripts/paperclip-setup.ts`, `scripts/compiler/authority.ts`, `kernel/src/{kinds,main,jobs,cp,wakes,backplane,admission}.ts`, `modules/tasks/module.yaml`, `tasks-mcp/src/tools.ts`, `scripts/verify-security.sh` | T, M |
| 2 | `kernel/src/{backplane,main,kinds,admission}.ts`, `modules/tasks/*`, `modules/slack/connections/slack-live/src/*`, `scripts/paperclip-setup.ts` | L, E1 |
| 3 | `scripts/modules.ts`, `scripts/paperclip-setup.ts`, `kernel/src/{backplane,main,settings-change}.ts` | S, E2, P |
| 3 | `kernel/src/writes.ts` | P only |

`kernel/src/apply-tier.ts` belongs to T in stage 1, L in stage 2 and S in stage 3. `contract.lock.json` is touched only
in Task 17.

---

## Stage 1

### Task 1 (T): Tiers without merit rules, path inventory, routine autonomy or provenance

**Files:**
- Modify: `kernel/src/apply-tier.ts`. It becomes parse, hard refusals and the authority lines for the card. `routingDiff`
  is kept because `routing-tune.ts` imports it.
- Modify: `kernel/src/tier.ts`. Delete `routineCap`, `origins`, `taskRoutineCap` and `RoutineCap`.
- Modify: `kernel/src/kinds.ts`. Delete `ownerRequired` from `APPLY_ARGS` and every `paths: true`.
- Modify: `kernel/src/writes.ts`. Delete `writeRaise`, the `k.paths` term and `routineOf`.
- Modify: `kernel/src/admission.ts`.
  - `routineCap` and `provenance` leave the deps.
  - `jobs.routine` is set from the wake cause key (`/^routine:(.+)$/`), not from the trace: routine identity survives,
    tier policy goes.
  - `routine_cap` is no longer written.
- Modify: `kernel/src/{cp,outcomes,escalate,wakes,main,connection-state,review-loop}.ts`. Drop the provenance and cap
  calls.
- Modify: `scripts/compiler/authority.ts` (path ranks), `scripts/compile.ts` (no `paths.json`), `scripts/modules.ts`
  (routine `autonomy`, `routineAutonomyDefault`, `OVERRIDABLE.routines.autonomy`) and `scripts/paperclip-setup.ts`
  (`routineAutonomy`).
- Modify: every module routine's `autonomy:` line: `apps-platform` (2), `fleet-steward` `routing-review`, `maintainer`
  (2), `security`. Also every module's `paths:` block.
- Modify: `modules/github/service/src/evalgate.ts`. `REVIEWER_CODE = [/^modules\/ai-reviewer\//, /^kernel\/sdk\/src\/(reviewer|pass-rule)\.ts$/, /^kernel\/src\/(review-loop|reviews)\.ts$/]`.
- Modify: `scripts/verify-security.sh` (~839-875). Rewrite the tier block to the new rule. Drop the imports of deleted
  files and the path-inventory entries in its CI path list.
- Modify: `CLAUDE.md` Conventions (the tier sentence) and `docs/design/approvals.md`.
- Delete: `kernel/src/provenance.ts`, `kernel/src/paths.ts`, `scripts/paths.ts`, `paths.yaml`, the provenance DDL, and
  their tests. The tables stay unread; there is no data migration.
- Keep: `jobs.authority`, which `boxes.ts`, `identity.ts` and `admission.ts` read.
- Test: `kernel/test/tier.test.ts` (rewritten).

**Interfaces:**
- `computeTier(i: { floor: 0|1|2; raise?: Raise; refusal?: string; priorVeto: boolean; ownerSave?: boolean; autonomy: Autonomy })`.
  `kernel.apply` is always at least Tier 1.
- `applyParts(c) => { refusals: string[]; authority: string[] }`.

- [ ] **Step 1: Write the failing test.**
  `test("an apply is the reviewer's unless refused, the owner's save or autonomy off")`. Rows:
  - no refusal → tier 1;
  - a refusal → reject;
  - `ownerSave` → owner;
  - autonomy off → tier 2;
  - a prior veto → tier 2;
  - a routine-run task → unchanged.
- [ ] **Step 2: Run it.** `cd kernel && node --disable-warning=ExperimentalWarning --test test/tier.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Delete.** Done when
  `git grep -n "routineCap\|routine_cap\|provenance\|ownerRequired\|sensitivity\|paths\.json\|writeRaise\|routineAutonomy" -- kernel scripts modules services ':!*/node_modules/*'`
  returns nothing.
- [ ] **Step 4: Run the suites.** The kernel suite, `cd scripts && npm test && npm run typecheck`, and
  `bash scripts/verify-security.sh --static` (the check mode CI runs). Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(kernel): tiers are floor, refusals, owner and autonomy; delete merit rules, path inventory, routine caps`.

### Task 2 (T): Code refusals on every filing; Tier 0 GitHub state, labels and replies; reviewed product merges; advisory UI review

**Files:**
- Modify: `kernel/src/review-loop.ts`. Export `codeRefusal(r)` (`instance_details`, `files_not_shown`). `reviewInput`
  calls it too.
- Modify: `kernel/src/writes.ts`.
  - `file()` and `fileTool()` (638-656) both call `codeRefusal` before the tier is set.
  - `files_not_shown` compares against the full planned diff (`whole.details`), not the truncated card.
  - The `conn.tool` floor reads the connection's `unreviewed` list.
- Modify: `scripts/modules.ts`. Add a connection field `tools.unreviewed: string[]`: a subset of `destructive`, written
  to `config/kernel/connections.json`. Compile fails on a name that isn't destructive.
- Modify: `modules/github/module.yaml`. `tools.unreviewed: [github_issue_label, github_issue_state, github_pr_thread_reply]`.
  The classes stay `destructive` (explicit-only grants), and the comment is updated.
- Modify: `modules/github/service/src/service.ts` (~223). The check reader keeps check names, so `ci-required` is
  readable on the exact head.
- Modify: `modules/github/service/src/review-gate.ts`. It returns an explicit `{ pass: true }` for a real pass, distinct
  from `undefined` (repo not gated) and from `bypass`.
- Modify: `modules/github/service/src/merge-gate.ts`. Export the one shared predicate
  `productMergeEligible(p: { repo: string; head: string; checks: NamedCheck[]; verdict: Verdict | undefined; productRepo: string }): boolean`.
  It is true only for the product repo, with `ci-required` successful on `head` and `verdict.pass === true` for `head`.
- Modify: `modules/github/service/src/plan.ts` (~199). For the product repo, when `productMergeEligible` holds, the
  product-merge Tier 1 part is **replaced** by `T(0, "product-merge-reviewed")`. It is not added beside it, because the
  planner takes the maximum. The `.github/` and foreign-head parts still apply.
- Modify: `modules/github/service/src/merges.ts` (~329). Just before a Tier 0 product merge, re-run
  `productMergeEligible` on the head. When it fails, the record fails with "eligibility lost at merge: file the merge
  again". The agent's next filing takes the existing Tier 1 path; there is no second path.
- Modify: `modules/github/service/src/{merge-gate,merges}.ts`. Delete the design-review wait and retry state
  (`merges.ts` 259-323). The design review is listed on the card as advisory only.
- Delete: the pending-status step in `modules/design/templates/design-review.yml` (42-45).
- Test: `kernel/test/review-loop.test.ts` (move the `instanceDetails` case), `modules/github/test/plan.test.ts`,
  `modules/github/test/merges.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `test("a Tier 0 GitHub reply carrying an instance host is refused by code")`. Through `fileTool`, a
    `github_pr_thread_reply` with `10.0.0.5` gives `rejected/instance_details`, and the reviewer is not called.
  - `test("product merge eligibility is one exact-head predicate, in plan and at merge")`. Rows:
    - `pass` with `ci-required` green → 0;
    - `bypass` → 1;
    - an ungated repo → unchanged;
    - `ci-required` missing → 1;
    - a head moved between plan and merge → the record fails at merge.
  - `test("a UI PR merges with no design review")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suites.** Kernel, `modules/github`, `modules/code-review`, `modules/design` if it has a suite.
  Expected: PASS.
- [ ] **Step 5: Commit.** `feat: reviewed product merges and GitHub thread state skip the AI reviewer; code refusals on every filing`.

### Task 3 (T): Remove `private_reads`

**Files:**
- Modify: `kernel/src/admission.ts` (`reads`, `web`), `kernel/src/identity.ts` 82-86 (`JobAuthority.reads`, and the
  `private` jobcap filter: every granted jobcap applies), `kernel/src/sandbox.ts`, `kernel/src/backplane.ts`
  (`DIRECTORY`).
- Modify: `scripts/modules.ts` (176, 1045), `scripts/compiler/authority.ts`, `scripts/computers.ts`,
  `scripts/paperclip-setup.ts`, `scripts/verify-security.sh`.
- Modify: `modules/{tasks,engineering}/module.yaml`, `tasks-mcp/src/tools.ts`, the fixtures `boxeng` and `jc`.
- Modify docs: `docs/{architecture,configuration}.md`, `docs/design/{sandboxing,codex-openrouter-engine}.md`.
- Test: delete the `private_reads` cases.

- [ ] **Step 1: Delete.** Done when `git grep -n "private_reads\|\.reads\b\|jobcap.*private" -- ':!docs/superpowers'`
  returns only unrelated hits (review each).
- [ ] **Step 2: Run the suites.** Scripts, kernel and tasks-mcp.
- [ ] **Step 3: Commit.** `refactor: remove private_reads`.

### Task 4 (M): Kernel memory store and route; fenced fill

**Files:**
- Create: `kernel/src/memory.ts`, `kernel/test/memory.test.ts`.
- Modify: `kernel/src/jobs.ts` (export `redact`), `kernel/src/backplane.ts` (route; delete `memory_inbox` from
  `DIRECTORY`), `kernel/src/main.ts`, `kernel/src/kinds.ts` (`KERNEL_ROLES += kernel.memory`),
  `scripts/compiler/authority.ts` (the role's line).
- Modify: `kernel/src/boxes.ts` `launch`. It writes `fillMemory(book, memory.view(key))`.

**Interfaces:**
```ts
export const MEMORY_MAX = 4096, FACT_MAX = 500, SOURCE_MAX = 300, WRITES_PER_JOB = 10;
export type Line = { date: string; src: string; fact: string };
/** One document per agent, <data>/kernel/memory/agents/<key>.json, always replaced whole (temp file + rename). */
export type Doc = { facts: Line[]; forgotten: string[]; imported?: { at: string; from: string; lines: number; refused: number; dropped: number } };
export class MemoryError extends Error { status: 400 | 403 | 409 | 413 | 429 }
export const norm: (fact: string) => string;
export const refusal: (fact: string) => string | undefined;
/** The one check for fact and source: length, redaction, refusal(); src is a task id, an https: URL, or (importLegacy only) "migration:<instance sha>". */
export const checkLine: (l: Line, o?: { migration?: string }) => Line;
/** The Markdown read view: "- (YYYY-MM-DD, src: <src>) <fact>" per fact; at most MEMORY_MAX bytes. */
export const view: (d: Doc) => string;
export const fillMemory: (prompt: string, view: string) => string;   // last {{memory}}, inside the SDK fence; "Nothing yet." when empty
export function createMemory(o: { dir: string; now?: () => number }): {
  read(key: string): { doc: Doc; digest: string };
  view(key: string): string;
  list(): { key: string; bytes: number; updated: string }[];
  note(key: string, n: { fact: string; source: string; job: string }): { line: string };
  forget(key: string, n: { match: string; job: string }): { removed: string[] };
  rewrite(key: string, r: { facts: Line[]; digest: string; job: string; removeOnly: boolean }): { bytes: number };
  importLegacy(key: string, markdown: string, from: string): Doc["imported"];   // no-op when doc.imported is set
};
```
- **`refusal`** applies to every fact. It refuses:
  - `<untrusted-data`, `untrusted content`, `<!--`, `aidenhq:`, a code fence, a leading `#`;
  - `(ignore|disregard|override)… (instructions|rules|handbook|prompt|above|previous)`;
  - `system prompt`, `you are now`, `new instructions`;
  - a forged `\(\d{4}-\d{2}-\d{2}, src:` prefix;
  - a leading imperative: `^(from now on|always|never|do not|don't|you must|you should|make sure)\b`;
  - `\bsend\b.{0,80}\bto\b`.
- **Writes.** Every mutation replaces the whole document atomically, facts and tombstones together, so there is no
  two-file recovery. Every mutation counts toward `WRITES_PER_JOB`.
- **`rewrite`.** The digest must match. Every fact passes `checkLine`. The view stays at most 4096 bytes. With
  `removeOnly` (the Librarian on another agent's document), the facts must be a subset of the base. Removed facts are
  tombstoned.
- **`importLegacy`.** It runs once per agent and is resumable.
  - Each legacy line becomes `{date, src: "migration:<sha>", fact}` (a parsed date where the line has one, else the
    import date) and passes `checkLine`.
  - Duplicates of facts already present are merged.
  - Refused lines are counted. When the result is over the cap, the oldest lines are dropped and counted.
  - The facts and the `imported` marker land in one write.
- **Route.** `POST /v1/memory/:op` (note, forget, read, rewrite).
  - It needs a module token with `kernel.memory` plus the caller assertion of a live job whose **signed tool equals
    `memory_<op>`**.
  - The key comes from the job's grants row.
  - Another agent's document is allowed only for read and rewrite with `removeOnly`, and only when the live grants row
    holds `librarian`.
- **`GET /v1/memory/:key`** (the board key, or role `kernel.lane`) answers `{view, facts, updated}`.

- [ ] **Step 1: Write the failing tests** (`memory.test.ts`).
  - `test("poisoning: instruction-shaped, fenced, forged-line, leading-imperative and send-to facts are refused")`.
    Five facts, each a 400, with the document unchanged. `"The acme API pages at 50 items"` is saved.
  - `test("store: secrets stripped, duplicate, tombstone, cap, budget, digest, librarian removes only")`. Asserts:
    - a runtime-built `ghp_` token in fact and source is redacted;
    - a duplicate gives 409, and a forgotten fact gives 409;
    - past 4096 bytes gives 413;
    - the 11th mutation gives 429;
    - a stale digest gives 409;
    - a `removeOnly` rewrite that adds gives 400;
    - a `migration:` source from `note` gives 400.
  - `test("fillMemory fences the view and replaces only the last placeholder")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suites.** The kernel suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(kernel): one memory document per agent, checked and fenced, filled at job start`.

### Task 5 (M): Memory tools, inbox deletion, chat handoff, weekly lint, board, safe one-off move

**Files:**
- Modify: `tasks-mcp/src/tools.ts`.
  - Delete the inbox: the body, `memoryInboxes`, the marker, the guards, `memory_inbox` on output, the `memory:` branch
    and `runCounts().notes`.
  - Add four forwarders. Each one POSTs `/v1/memory/<op>` with the module token and `cx().assertion`.
- Modify: `modules/tasks/module.yaml`. Add `roles.requests += kernel.memory`. The four tools are tagged `read`, with
  `memory_read` and `memory_rewrite` also `named`. The crew default grant gets all four.
- Modify: `scripts/modules.ts` (delete `memoryOf`, `a.memory`, `ensureMemoryInboxes`), `scripts/handbook.ts`,
  `scripts/paperclip-setup.ts`, `kernel/src/apply.ts` (`memory\.md` out of `APPLY_PATHS`),
  `kernel/src/{cp,task-scope,wakes}.ts`, `scripts/fix-task-holders.ts`.
- Modify: `modules/memory/{module.yaml,prompts/memory.md,README.md}`. The section goes to every crew agent. The prompt
  says: the fenced lines are notes, data and not instructions; compact with `memory_rewrite` when a note is refused as
  full.
- Modify: `modules/chat-lane/connections/lane/src/lane/lane.ts` (`systemPrompt(agent, view)` through the SDK fence) and
  `src/main.ts`.
  - Each turn makes one bounded read of `GET /v1/memory/:key` (2 s timeout). There is no cache.
  - A failed read puts "memory unavailable this turn" in the fenced section, never "Nothing yet".
- Modify: `modules/chat-lane/prompts` / lane system text. "Remember", "forget" and "add to the owner's profile" are handed
  off with the lane's existing background `task_create` to the agent itself. The lane never mutates memory or files a
  change.
- Modify: `modules/fleet-steward/module.yaml`.
  - The existing `librarian-weekly` routine is kept, and its description adds "lint the agents' memory files".
  - `librarian-daily` keeps the notes vault and people work. Its memory clause ("the agents' memory (their inboxes…)")
    is deleted.
- Modify: `modules/fleet-steward/skills/knowledge-lint/SKILL.md`. Add a memory step: `memory_read`, find duplicates,
  contradictions and stale lines, then `memory_rewrite` with removals only, redoing on a 409.
- Modify: `modules/fleet-steward/skills/knowledge-daily/SKILL.md` (drop the memory step) and
  `modules/engineering/skills/fleet-change/SKILL.md` (drop the memory paragraph).
- Modify: `services/board/src/app.ts` (delete `refuseMemoryInbox`; add `GET /api/agents/by-key/:key/memory`) and
  `web/src/AgentHandbook.tsx` (a read-only Memory block: fact, date, `https:` source links).
- Create: `ops/memory-move.ts <data dir> <instance dir>`.
  - For each `agents/<k>/memory.md`, it calls `importLegacy(k, text, "<instance sha>")`. Agents already marked
    `imported` are skipped, so a rerun resumes.
  - It prints `memory: imported <n> merged <m> refused <r> dropped <d> skipped <s>`.
  - It exits non-zero on any error.
  - It does not touch Paperclip.
- Create: `ops/memory-inbox-cleanup.ts`. A one-time manual cleanup (Task 18), not in the deploy path: it cancels open
  `<!-- source:memory-inbox:` tasks with one comment.
- Modify: `ops/apply-config-work.sh`.
  - Run the move before the kernel restart (which enables runtime writes), as a plain command so its exit status stops
    the apply.
  - Fix the grades move's `echo "$(node …)"` masking the same way.
  - `setupInputs()` adds `git -C "$inst" ls-tree -r HEAD -- modules`.
- Modify docs: `docs/{configuration,operations}.md`, `docs/design/access.md`.

- [ ] **Step 1: Check the lane path.** Trace `lane/tools.ts` (Paperclip agent key as bearer) against `identity.ts`
  74-90.
  - If the lane's `task_create` doesn't authenticate on this base, fix it in this task. The lane's own module token plus
    `kernel.lane` calls the proxy on behalf of the lane agent, the same shape as `/v1/settings/agent`.
  - Either way, V2 proves the handoff end to end.
- [ ] **Step 2: Write the failing test.** `test("memory_note forwards with the caller's assertion and makes no Paperclip call")`
  (tasks-mcp).
- [ ] **Step 3: Implement.** Done when
  `git grep -n "memory_inbox\|memory-inbox\|Memory inbox\|memoryOf\|memory\.md" -- ':!docs/superpowers' ':!ops/memory-move.ts'`
  returns nothing.
- [ ] **Step 4: Run the suites.** scripts, kernel, tasks-mcp, lane, fleet-steward and board. For the board also run
  `npx tsc -p tsconfig.build.json --noEmit` and take the six screenshots.
- [ ] **Step 5: Commit.** `feat(memory): tools forward to the kernel; inbox and daily curation removed; chat hands off`.

## Stage 2

### Task 6 (L): Local modules replace instance agents; trial deleted in the compiler

**Files:**
- Modify: `scripts/modules.ts`.
  - `discover(…, instanceDir)` reads `<instance>/modules/*/module.yaml` at tier `local`.
  - Delete `instanceAgents`, `INSTANCE_*`, `trialWrites`, `TRIAL_*` and the trial branches.
  - `tier === "local"` replaces `module === "instance"`.
- Modify: `scripts/compiler/bindings.ts`, `scripts/handbook.ts`, `scripts/paperclip-setup.ts` (metadata `tier`),
  `scripts/agent-check.ts`.
- Test: `scripts/test/agents.test.ts` (the helper writes local modules; delete the trial tests),
  `scripts/test/agent-check.test.ts`.

**Interfaces:**
- `LOCAL_MODULE_KEYS = ["name","description","agents","routines"]`.
  - There is no `skills` key: `skills/` is discovered by directory.
  - `agents` is optional.
- Identity (`name`, `description`, `reports_to`) comes only from `module.yaml`, as today's instance reader takes it. A
  local `AGENTS.md` with frontmatter is refused (`x: a local agent's AGENTS.md has no frontmatter: identity is in module.yaml`).
  Task 18 strips frontmatter from the moved handbooks, and V1 covers that.
- `LOCAL_AGENT_FIELDS` is today's instance fields minus `trial` and `trial_writes`.
- `LOCAL_ROUTINE_FIELDS = ["title","description","concurrency","schedules","agent","model","event"]`.
- Agent-authored routines (local modules and `library`) are validated on the **final** routine, after
  `overrides.routines` is applied: at most one schedule, whose cron minute field is one literal integer 0-59.
  - `agent` is required and may name any compiled agent, because a routine carries no grants.
  - No `status` field. The status at create comes from the routine's defining module (Task 7).
- Compiled agents carry `tier`, which setup copies to Paperclip metadata. The catalog lists local modules as
  `enabled: true`.
- Errors: `local module x: <key> isn't allowed`, `x is a local agent: its rules are its own AGENTS.md`,
  `x is a local module: enabled by its folder`, and
  `agents/y/agent.yaml: an owner-built agent is a local module now (modules/<name>/module.yaml + agents/<key>/AGENTS.md)`.

- [ ] **Step 1: Write the failing tests.**
  - `test("local modules: every manifest key outside the allowlist fails")` covers `prompts`, `default_grants`,
    `connections`, `roles`, `writes`, `settings`, `contributes`, `jobcaps`, `check_jobs`, `services`, `apps`,
    `privileged`, `isolation` and `skills`.
  - `test("a local agent compiles like today's instance agent, with no trial")`. Under quiet start the routine is
    active and the tier is `local`. `trial: true` fails as an unknown field, `cron: "*/5 * * * *"` fails, and two
    schedules added by an override fail.
- [ ] **Step 2: Run them.** `cd scripts && node --disable-warning=ExperimentalWarning --test test/agents.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suites.** `cd scripts && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(compiler): owner-built agents are local modules; trial removed`.

### Task 7 (L): Apply paths, code hosts, settings, board, templates; trial gone at runtime; routines reconciled by id

**Files:**
- Create: `kernel/sdk/src/instance-paths.ts`, a pure module holding `APPLY_PATHS` and `strayFiles`.
  - `kernel/src/apply.ts` and `modules/codehost-local/src/apply.ts` import it.
  - `scripts/sync-shared.ts` copies it to `modules/github/service/src/aidenhq-sdk/`. The image already copies
    `service/src`, so there is no import cycle.
  - Add it to the sync list's header and to `shared.test.ts`.
- Modify: `kernel/src/apply.ts` (delete `isTrial`, `untrialedNewAgents`, `DEFINITION`, `definitionsOf`) and
  `kernel/src/settings-change.ts` (`IsLocal`; `PATHS.rules` → the local `AGENTS.md`).
- Modify: `kernel/src/{admission,backplane,channels,identity}.ts`, deleting `g.trial`, `kernel.trial` and the `trial`
  directory field.
- Modify: `modules/github/service/src/service.ts` and `modules/codehost-local/src/apply.ts` (delete `trialEdits`).
- Delete the trial limits in `tasks-mcp/src/tools.ts` and `modules/tasks/module.yaml`.
- Modify: `modules/chat-lane/.../{main,mcp}.ts`, `modules/owner-channel/.../{main,mcp,notify}.ts`,
  `modules/owner-channel/module.yaml`, `modules/slack/.../bind.ts`, `modules/fleet-steward/service/src/coach.ts` (coach
  by agent age), `modules/platform/module.yaml` and `modules/chief-of-staff/prompts/heartbeat.md`.
- Modify: `services/board/src/{agent-handbook,settings-change,activity,agent-page,app}.ts` and
  `web/src/{AgentHandbook,Agents}.tsx` (`"local"`).
- Modify: `modules/agent-builder/templates/<t>/` → `{module.yaml, agents/<key>/AGENTS.md}` with no trial.
- Modify: `modules/agent-builder/agents/architect/AGENTS.md`, `modules/agent-builder/{README.md,module.yaml}` and
  `skills/design-doc/*`.
- Modify: `modules/engineering/skills/fleet-change/SKILL.md` and `modules/fleet-steward/skills/handbook-prune/SKILL.md`.
- Modify: `scripts/paperclip-setup.ts` (376-462, 538-550) and `scripts/paperclip-diff.ts` (~31): recoverable routine
  identity.
  - Every routine setup creates carries a marker line in its description, `<!-- aidenhq:routine:<compiled key> -->`,
    written **in the create request**, so Paperclip itself holds the identity.
  - The live lookup is the compiled key → id mapping (`routine_keys` in the grants table). A key with no live mapping is
    first recovered by scanning the company's routines, archived included, for its marker. Only then is it created.
    This covers a crash after create, a lost create response, and a removed routine coming back (it is unarchived).
  - A managed routine no longer compiled is archived and its triggers disabled. Its mapping leaves the live grants; the
    marker is its identity.
  - Triggers are reconciled on every pass, even when routine fields and cron are unchanged: a trigger not in the
    compiled form is disabled.
  - Routines with no marker (made on the board) are never touched.
  - `status` is written only on create. It comes from the defining module:
    - `local` (and `library`): active;
    - `declared`: paused;
    - product modules: today's quiet-start rule.

    Afterwards, Paperclip owns pause and resume.
- Modify: `scripts/modules.ts` and `kernel/src/settings-change.ts`: delete `status` from `OVERRIDABLE.routines` and the
  typed `routine` change's `status` field.
- Modify: `services/board/src/settings-change.ts` (schema ~26) and its web form: delete the routine status editor. The
  board's live routine controls (`fleet.ts` ~261) are the one pause and resume.
- Modify docs: `docs/{configuration,core-components,concepts,operations,USAGE,setup}.md`,
  `docs/design/{agent-and-module-pages,quiet-start,approvals,sandboxing}.md`, `modules/README.md`, `modules/AGENTS.md`
  ("Local modules") and `README.md`.
- Delete: `reviewer-cases/clean-graduate-trial-agent.json`, `lane/test/trial.test.ts`,
  `tasks-mcp/test/trial-tasks.test.ts`, and the trial cases in `notify`, `bind` and `service` tests.
- Test: V1 (routine identity, triggers, status), `kernel/test/apply.test.ts` (`strayFiles`), board
  `test/settings-change.test.ts`.

**Interfaces:**
`APPLY_PATHS = /^(instance\.yaml|apps\.yaml|owner\/profile\.md|agents\/[\w.-]+\.md|agents\/[a-z0-9][a-z0-9-]*\/AGENTS\.md|modules\/[a-z0-9][a-z0-9-]*\/(module\.yaml|agents\/[a-z0-9][a-z0-9-]*\/AGENTS\.md|skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md))$/`.
`agents/<key>/AGENTS.md` is a handbook fork only.

- [ ] **Step 1: Write the failing tests.**
  - `strayFiles([...local module, library SKILL.md])` returns `[]`.
  - `strayFiles(["agents/x/agent.yaml","modules/x/run.sh","agents/x/memory.md"])` returns all three.
  - The board's `rules` on a local agent is accepted, and its `grants` is refused.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement and move the templates.** Grep-review `git grep -n -i "trial" -- kernel scripts modules services`
  so no agent-trial hit remains.
- [ ] **Step 4: Run the suites.** Kernel, scripts (shared-drift included), board (`tsc -p tsconfig.build.json`),
  github, codehost-local, tasks-mcp, lane, notify, slack-live, fleet-steward, ai-reviewer and `services/computer`.
  Expected: PASS.
- [ ] **Step 5: Commit.** `feat: apply, code hosts, board and templates on local modules; trial deleted; routines reconciled by id`.

### Task 8 (E1): Kernel event router

**Files:**
- Create: `kernel/src/events.ts`.
- Modify: `kernel/src/backplane.ts`, `kernel/src/main.ts` (wiring; `setInterval(drain, 15_000)` plus one drain at
  start), `kernel/src/kinds.ts` (`kernel.events`).
- Modify: `kernel/src/main.ts` ~111 `cpApi`. Merge the caller's `init.headers` into its own instead of replacing them,
  so `Idempotency-Key` reaches Paperclip. This fix ships with a one-line assertion in the router test.
- Test: `kernel/test/events.test.ts` (CI), V3 (manual).

**Interfaces:**
```ts
export type SourceEvent = { connection: string; resource: string; id: string; kind: string; author?: string; text?: string; labels?: string[]; bot?: boolean; url?: string };
export type Filter = { kind?: string | string[]; author?: string | string[]; label?: string | string[]; contains?: string[]; bot?: boolean };
export const matches: (f: Filter, e: SourceEvent) => boolean;
export type IngestResult = { queued: number } | { skipped: "invalid"; why: string } | { dropped: number; reason: "overflow" | "cap" };
export function createEvents(o: {
  db: DatabaseSync; grants: () => GrantsTable; connections: () => Record<string, Connection>;
  run: (routineId: string, key: string, vars: { batch: string; count: string }) => Promise<{ status: number; issue?: string }>;
  routine: (id: string) => Promise<{ status: string; assignee: string } | undefined>;   // throws on timeout
  now?: () => number; log?: Log;
}): {
  ingest(module: string, e: unknown): IngestResult;     // always 2xx unless the caller isn't the connection's module (403)
  resources(module: string, connection: string): string[];
  batch(job: { task: string; agent: string; routine: string; taskRoutine?: string }, id: string): { pending: true; retry_after_s: number } | { count: number; events: Omit<SourceEvent, "connection">[] };
  drain(): Promise<void>;
};
```
- **Step 0 (before any code): probe the pinned Paperclip image.** Run `POST /api/routines/:id/run` as the owner, with
  `variables` and an `Idempotency-Key`, twice with the same key. It passes when all three hold:
  - one run exists, with the variables;
  - the second call returns the **same issue id**;
  - the created task carries the routine's identity (`originKind: routine_execution`, `originId` = the routine id).

  If any part fails, stop and report to the lead. No other path is written.
- **Tables** (kernel.db, `CREATE IF NOT EXISTS`):
  - `event_queue(seq, routine, id, batch, body, at, UNIQUE(routine, id))`.
    - `body` is nulled 24 h after its batch is dispatched. The row (the dedupe id) is deleted at 7 days.
    - Pending (unbatched) events are capped at 2000; retained payloads are bounded by the 24 h expiry.
  - `event_batches(id, routine, task, count, state open|sealed|firing|fired|dropped, tries, sealed_at, dispatched_at)`.
    The hourly caps are counted from `dispatched_at`.
- **`ingest`.** It answers 2xx for everything except a caller that isn't the connection's module (403), so a source
  never stalls on one item.
  - An envelope that fails the schema (bounded strings, at most 10 labels, text clipped to 2000) is `skipped: "invalid"`
    and counted. It is permanent: the source acknowledges it and moves on.
  - Over the 2000 pending cap, the answer is `dropped: overflow`, acknowledged and counted.
  - Otherwise, for each subscription on that connection and resource, the event is queued when the agent holds a
    declared `reads` tool on that connection and `matches` is true. The source delivers only resources its own
    credential reads (Task 9), so a routine reaches exactly what its agent's read grant reaches. There is no owner step.
- **`drain`.** One non-overlapping drain (a running flag).
  - Per routine, one open batch at a time. It is sealed at 60 s or 20 events, and the batch id is a uuid.
  - **Fire** a sealed batch:
    - recheck the subscription, the grant and `routine(id)`;
    - paused or deleted → `dropped`;
    - a lookup timeout → stays `sealed`, retried next drain;
    - over 12 per routine or 120 in total in the past hour (by `dispatched_at`) → `dropped: cap`, counted.
  - Then set `state = firing` and call `run` with `Idempotency-Key = batch id`. On a 2xx, in one transaction, store
    `task = issue`, `state = fired` and `dispatched_at`.
  - A transport error, 429 or 5xx keeps `firing`, retried with the same key until 10 minutes after sealing, then
    `dropped`. Same key, same issue (probed), so a lost response recovers the binding.
- **`batch`.** Bound to the run.
  - `job.task === batch.task`, the routine's assignee is `job.agent`, and `job.routine === batch.routine` → the events.
    The subscription and grant are rechecked here too.
  - A `firing` batch whose routine matches the caller's task's routine origin (`taskRoutine`) answers
    `{pending: true, retry_after_s: 10}`, for at most 10 minutes. This covers the wake scanner starting the job before
    the binding is stored.
  - Anything else is 403.
- **Routes:**
  - `POST /v1/events` (module, `kernel.events`);
  - `GET /v1/events/sources?connection=` (own connections);
  - `GET /v1/events/batch/:id` (a live job whose signed tool is `routine_events`).

- [ ] **Step 1: Run the probe (Step 0) and record the result in the PR body.**
- [ ] **Step 2: Write the failing test.** `test("drain, caps, gates and binding")`, against a fake `run`. Covers:
  - one sealed batch per routine per window with a stable key;
  - a duplicate id dropped;
  - a 21st event starts a new batch;
  - overflow and an invalid envelope answer 2xx and are counted;
  - the per-routine and global caps come from `dispatched_at`;
  - a revoked read grant or a paused routine fires nothing;
  - a lookup timeout and a 500 retry with the same key;
  - a read during `firing` is `pending`, and after binding returns the events;
  - another task's read is 403;
  - `cpApi` forwards `Idempotency-Key`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suites.** The kernel suite and typecheck in CI. V3 is run by hand.
- [ ] **Step 5: Commit.** `feat(kernel): event router runs routines through Paperclip's idempotent run`.

### Task 9 (E1): `routine_events` tool; Slack and GitHub sources

**Files:**
- Modify: `tasks-mcp/src/tools.ts`. `routine_events({batch})`, read-tagged, GETs as the caller.
- Modify: `modules/tasks/module.yaml`. `roles.requests += kernel.events`; the crew default grant.
- Modify: `modules/slack/module.yaml`.
  - `roles.requests: [kernel.events]`.
  - Connection declaration: `connections.slack.events: { resource: "channel id", kinds: [message, app_mention], filter: [kind, author, contains, bot], reads: [slack_read_channel] }`.
- Modify: `modules/slack/connections/slack-live/src/{map,socket}.ts`.
  - Bot posts carry `bot: true`.
  - A kept event is forwarded only after the existing pairing, owner-chat and bound-mention routing (`socket.ts` 28-66).
  - A 2xx (queued, skipped or dropped) is acknowledged. A transport error, 429 or 5xx stays un-acked, so Slack
    redelivers.
- Modify: `modules/github/module.yaml`.
  - `roles.requests += kernel.events`.
  - Connection declaration: `connections.github.events: { resource: "owner/repo", kinds: [issues.opened, issue_comment.created, pull_request.opened, push], filter: [kind, author, contains], reads: [github_issue_read] }`.
    These are the kinds the repository events feed carries with no extra discovery. Labels and reviews are deferred.
- Modify: `modules/github/service/src/flow.ts` (~180-210). The existing polling loop and its budget handling gain one
  more pass, with no new loop and no new file.
  - It reads `GET /v1/events/sources?connection=github`. Only repos the code host's token reads are polled, up to 30;
    any beyond the cap are logged as a fact.
  - It sends a conditional request (ETag) on the first page only, then pages until the cursor.
  - A missing or expired cursor resets to the first page only, with a logged gap.
  - The cursor advances once the kernel answers 2xx. The kernel answers 2xx for skipped and dropped items too, so one
    bad event can't pin the cursor.
  - Delivery is best-effort: GitHub can delay its feed by hours.
- Test: one each:
  - `routine_events passes the caller through`;
  - `a kept Slack event is forwarded once, after owner routing, with its bot flag`;
  - `a poll sends the ETag on page one, pages to the cursor, resets a lost cursor with a gap, and advances past a skipped event`.

- [ ] Write the tests and confirm they fail. Implement. Run the tasks-mcp, slack-live and github suites.
- [ ] Commit: `feat(slack,github): event sources for routines`.

### Task 10 (E1): Quiet routine runs

**Files:**
- Create: `kernel/src/quiet.ts`.
- Modify: `kernel/src/jobs.ts`. The `job_end` transaction puts `quiet` in the existing `job.ended` fact data and in no
  other place (no new column).
- Modify: `kernel/src/work.ts` (~37). The existing job fact reader exposes it.
- Modify: the board consumer of the work view that lists run tasks, which hides quiet ones.
- Test: `kernel/test/jobs.test.ts`.

**Interface:** `quietRun(db, job: { id; task; at; routine?; state; requester }): boolean`. It is true when all of these
hold:
- the job has a `routine` and ended `done`;
- every record it filed since `job.at` is a `conn.tool` whose `args.tool` is `paperclip_tasks.task_finish` or
  `paperclip_tasks.task_wait`;
- it created no task.

- [ ] Write the failing test
  `test("only-closing routine job is quiet; a write or a created task is not; quiet is in job.ended only")`.
- [ ] Implement it, then run the tests.
- [ ] Commit `feat(kernel): record quiet routine runs`.

## Stage 3

### Task 11 (S): `self_change`: an agent changes itself, one record

**Files:**
- Modify: `kernel/src/settings-change.ts` `asAgent`.
  - Add the self kinds below. They skip the `agent.module === module` check, which `setting` keeps.
  - Validation happens at the fetched base, not on live config:
    - fetch the instance main (`d.main`), giving `base`;
    - snapshot the instance tree at `base` into a temp dir, bounded to 2 MB;
    - load the inputs with the staged compiler's own loader (export `loadInputs` from `scripts/compile.ts`: bundle
      adoption, host settings, catalog);
    - resolve paths and permissions from that snapshot's compile;
    - apply the edits and compile again.

    A compile error is the refusal.
  - The same `base` goes to the code host's existing compare-and-swap (`service.ts` ~888). When main moved, the existing
    "main moved, file again" answer stands, with no rebase queue.
  - The before and after compiled outputs are passed to the planner for the skill-enabler lines (Task 13).
- Modify: `kernel/src/backplane.ts` `/v1/settings/agent`.
  - It requires the assertion's signed tool to be `self_change`, or `settings_change` for the existing `setting` kind.
  - Roles are read from the live grants row, not the assertion.
- Modify: `modules/tasks/module.yaml`. `roles.requests += kernel.settings`. `self_change` is tagged `read`, so no
  `conn.tool` record is made and the `kernel.apply` is the only record. It joins the crew default grant.
- Modify: `tasks-mcp/src/tools.ts`.
  - `self_change({changes, why})` returns `{record, tier, state}`. The description says: wait on it with `task_wait`
    before finishing, because the executor skips approvals of closed tasks.
  - Delete `task_propose_rule`.
- Modify: `modules/platform/prompts/improving.md`. It is the one source: fix yourself with `self_change`. Product code
  and module text stay an Engineer task. Only Aiden changes the owner's profile; others ask Aiden.
- Modify: `modules/engineering/skills/fleet-change/SKILL.md`, `modules/agent-builder/agents/architect/AGENTS.md`,
  `docs/core-components.md` and `docs/design/settings-changes.md`.
- Test: V2.

**Interfaces.** The typed changes. Each must name the requester and nothing else:
```ts
{ kind: "rules", agent: <self>, text }   // local: modules/<m>/agents/<k>/AGENTS.md (no frontmatter); else agents/<k>.md
{ kind: "skill", name, text }            // modules/library/skills/<name>/SKILL.md, id library.<name>; any agent; frontmatter validated by the prospective compile
{ kind: "skills", agent: <self>, add?: string[], remove?: string[] } // always instance.yaml overrides.agents.<k>.skills {add, remove}
{ kind: "routine_def", key, routine?: Routine, delete?: true } // modules/library/module.yaml routines["<self>-<key>"]
{ kind: "profile", text }                // owner/profile.md, ≤ 20 KB; live role fleet-admin only
{ kind: "setting", key, value }          // unchanged
```
Refusals:
- `<k> changes only itself`;
- `routine <key> belongs to <other>` (an existing library routine with another `agent`);
- `routine key <key> is a product routine`;
- `only fleet-admin (Aiden) changes the owner profile: ask Aiden`;
- `a local handbook has no frontmatter`;
- the prospective compile's error.

- [ ] Write V2 and confirm it fails.
- [ ] Implement.
- [ ] Run the kernel and tasks-mcp suites and V2.
- [ ] Commit: `feat(kernel): agents file their own handbook, skill, routine and profile changes`.

### Task 12 (S): One effective skill list; implicit selection deleted

**Files:**
- Modify: every `modules/<m>/module.yaml` with `agents:` and the agent-builder templates.
- Modify: `scripts/modules.ts`.
  - `promptEntries` drops `skill:`, `when` and `unless` for skills.
  - `promptApplies` loses its `p.skill` clause.
  - The skills block (~1182-1198) changes.
  - The override loop (1108-1125) skips `skills`, like `connections`.
  - `OVERRIDABLE.agents += skills`.
- Modify: `kernel/src/sandbox.ts`. Job staging reads the compiled effective list, unchanged in shape.
- Strip `when:`/`unless:` from every `modules/*/skills/*/SKILL.md`.
- Modify docs: `docs/configuration.md`, `modules/AGENTS.md`, `CLAUDE.md`.
- Test: `scripts/test/skills.test.ts`.

**Interfaces:** `effectiveSkills(def, override, catalog): string[]`.
- The rule: `(def.skills ∪ override.add) − override.remove`.
- One override shape for every agent, local or product: `overrides.agents.<k>.skills: { add?: string[]; remove?: string[] }`.
- An id is validated against the catalog of available modules, enabled or not:
  - an id in an available but disabled module is dropped;
  - an id in no available module fails: `agents.<k>.skills: unknown skill <id>`.
- The same function feeds job staging (through the grants table) and `skillLines` (Task 13).

- [ ] **Step 1: Snapshot first, before any compiler edit.** On `origin/main`, a scratch script (not committed) compiles
  and dumps `{agent: skills}` for each of:
  - the default bundle;
  - all modules enabled;
  - all modules enabled with every optional provider disabled;
  - a scratch clone of the instance after Task 18's reshape.
- [ ] **Step 2: Write the lists.** Each product agent's full sorted list goes into `skills:`. Local agents' lists go
  into Task 18.
- [ ] **Step 3: Write the failing tests.**
  - `test("an agent gets exactly its effective list")` covers:
    - an owned module plus a connection grant gives nothing;
    - an override `add` adds;
    - an override `remove` removes a product skill;
    - a disabled optional provider is dropped;
    - an unknown id fails.
  - `test("when on a skill fails compile")`.
- [ ] **Step 4: Delete implicit selection.** All four snapshots compare equal after the change.
- [ ] **Step 5: Run the suites, then commit.** The scripts suite and typecheck. Commit:
  `feat(compiler): one effective skill list per agent; implicit selection deleted`.

### Task 13 (S): Reviewer sees skill enablers

**Files:**
- Modify: `scripts/compiler/authority.ts` (`skillLines`).
- Modify: `kernel/src/apply-tier.ts` (583-606). Module sides load whenever the change touches `instance.yaml` **or** any
  `modules/` path. `skillLines` reads the before and after compiled agent lists, from Task 11's staged loader for agent
  filings and from the code host's compiled sides for other filings. It is appended to `authority`.
- Modify: `modules/ai-reviewer/service/security/policy/01-what-malice-is.md` (one paragraph).
- Add two reviewer cases: `clean-library-skill-added-and-enabled-for-one-agent` and
  `library-skill-tells-agent-to-post-secrets`.
- Test: `kernel/test/apply-skills.test.ts`.

**Interface:** `skillLines(a: { files: string[]; before: Record<string, string[]>; after: Record<string, string[]> }): string[]`.
The `before` and `after` arguments are the compiled effective lists. The lines:
- `skill <id> changed; enabled by agent <k>, … (review)`, or `… enabled by no agent (review)`;
- `skill <id> has code: <n> files besides SKILL.md (review)`;
- `agent <k> enables skill <id> (review)`;
- `agent <k> stops enabling skill <id>`.

- [ ] Write the failing tests:
  - `a library-only commit lists its enablers` (a local agent, a product agent through override, a non-enabler not
    named);
  - `a skill folder with a script is flagged as code`.
- [ ] Implement, then run the kernel and ai-reviewer suites.
- [ ] Commit `feat(apply): skill changes name the agents they steer`.

### Task 14 (E2): The `event` field and Slack triage migration

**Files:**
- Modify: `scripts/modules.ts`.
  - Add `event` on module and local routines.
  - `connections.<n>.events` goes to `config/kernel/connections.json`.
  - An event routine is forced `always_enqueue`; `event` together with `webhook` fails.
  - Append the suffix `New events: batch {{batch}} ({{count}}). Read them with routine_events(batch), then follow the routine above.`.
  - Apply the local and library lints (Global Constraints).
  - Delete slack's legacy `paperclip` network (~109).
- Modify: `scripts/paperclip-setup.ts`. `writeGrants` emits `routine_events: {[routineId]: {key, agent, connection, resource, filter}}`.
- Modify: `modules/open-loops/module.yaml`.
  - `slack-triage` becomes `event: { connection: slack, resource: "*", filter: { kind: [message, app_mention], bot: false } }`.
  - Drop `webhook`, `webhook_base`, `secrets_prefix`, `concurrency` and the `slack_pending_events` grant.
- Modify: `modules/open-loops/skills/triage-slack/SKILL.md`.
- Delete in `modules/slack/module.yaml`: the `slack_live_triage_webhook_*` secrets and env, and `slack_pending_events`.
- Delete in `slack-live/src/{main,mcp,store,socket}.ts`: `poke`, the debounce, `TRIAGE_WEBHOOK_*`, the `events` table,
  `takePending`, `insertEvent` and the tool.
- Modify: `scripts/bootstrap.sh` and `modules/slack/README.md`.
- Docs: `docs/configuration.md` (routines row) and `modules/AGENTS.md` (`connections.<n>.events`).
- Test: `scripts/test/modules.test.ts`, with a fixture.

- [ ] Write the failing test `test("event routines compile and the lints hold")`.
  - It accepts a Slack and a GitHub event routine.
  - It refuses each of these, naming the cause:
    - 21 routines for one agent;
    - `*/5 * * * *`;
    - an empty filter;
    - an undeclared filter key;
    - an agent without a `reads` tool;
    - `event` with `webhook`;
    - `resource: "*"` in a local module;
    - a routine carrying `tools:`.
  - The bundle's `slack-triage` compiles to an `event` routine with no webhook secrets.
- [ ] Implement and delete. Done when `git grep -n "slack_pending_events\|TRIAGE_WEBHOOK\|triage_webhook"` returns
  nothing outside `docs/superpowers`.
- [ ] Run the scripts, slack-live and open-loops suites. Commit: `feat(routines): event trigger in compile; Slack triage on it; poke deleted`.

### Task 15 (P): Export a local module (portable content only)

**Files:** Create `kernel/src/module-share.ts`.

**Interface:**
```ts
export type Finding = { file: string; rule: "secret-value"|"setting-value"|"memory-fact"|"profile-fact"|"secret-shaped"|"local-reference"|"symlink"|"too-big"; detail: string };
export type Export = { module: string; source: string /* commit sha */; files: Record<string, string>; notShared: { path: string; why: string }[]; findings: Finding[]; isolation: "trusted"|"untrusted"; scripts: string[]; grants: Record<string, string[]>; digest: string };
export function exportModule(name: string, d: { instanceDir: string; sha: string; catalog: Dict[]; compiled: Dict; settings: Record<string, unknown>; secrets: string[]; memory: string[]; profile: string }): Promise<Export>;
```
- **Files.** Only regular blobs from `git ls-tree -r <sha> -- modules/<name>`. A symlink is a finding. The module must be
  tier `local`.
- **Content.** Exactly what a local module may hold (Task 6): `module.yaml`, `agents/<k>/AGENTS.md`, `skills/**`.
  There is no general manifest transformation. `module.yaml` is shared as written, except that two things go to
  `notShared` with a reason the preview shows:
  - an agent's `reports_to` and `image`;
  - routines whose `agent` is outside the module, or that carry a literal `event.resource`.
- **`isolation`** is `trusted` when any agent grants a write or destructive tool, or the module has scripts. `grants`
  lists each agent's effective grants.
- **The scan is a backstop.** It checks:
  - setting values and vault secrets of 6+ characters, in plain, base64 and URL-encoded forms;
  - memory facts (from every memory document's `facts`) and profile lines of 20+ characters;
  - the known secret shapes;
  - local references: other local modules' paths and the instance repo name.
- **Limits.** 100 files and 512 KB. `digest` is the sha256 of canonical `{source, files}`.

- [ ] Implement it. V4 is the test.
- [ ] Commit `feat(kernel): export a local module for sharing`.

### Task 16 (P): Publish bound to the owner's preview; install paused once

**Files:**
- Create: `modules/github/schemas/publish_module.json`. A closed schema:
  `{repo, ref, base, source, module, files, digest}`.
- Modify: `modules/github/module.yaml`:
  `writes: publish_module: { floor: 2, filer: owner, stale: fail, card: *card }`.
- Modify: `kernel/src/kinds.ts` and `kernel/src/writes.ts`, adding two generic kind fields:
  - `filer: owner`: only `fileKernel` with a verified `owner` may file the kind. `request()` and admission refuse it for
    any job, so no agent can file a publish.
  - `stale: fail`: on the existing executor revalidation path (`writes.ts` ~415), a stale record fails ("the repo moved
    since your preview: preview again") instead of refiling.

  `fileKernel(kind, {args, task, requester, owner})` accepts a kernel-planned kind, or a module kind with an executor.
- Modify: `modules/github/service/src/plan.ts`.
  - `publishModulePart` REJECTs the product and instance repos, a name not in `owner/name` form, and `local/`.
  - Otherwise it gives `T(2, "publish-module")`, with target `{repo, ref, commit: base}`.
  - The durable preview evidence is the owner-decided record's own canonical args and bound target. Every replan reads
    those; no filing-time fact.
- Modify: `modules/github/service/src/service.ts`.
  - `stateFor` refuses:
    - a repo GitHub reports `private: true`;
    - a missing repo;
    - a `<module>/` subtree that `marketplace.json` doesn't list from this source;
    - a tip that isn't `args.base`.
  - `execute` reuses the existing commit assembly (~812): the previewed files plus the `marketplace.json` upsert, as one
    commit, through the guarded ref update.
- Create: `modules/github/service/src/share.ts`, holding only `digestOf` and `upsertMarketplace`.
- Modify: `kernel/src/settings-change.ts`. Extract `ownerTask(taskId, credential)` from `apply`.
- Modify: `kernel/src/backplane.ts`, two routes on `auth=board`:
  - `POST /v1/modules/share/preview {module, repo, ref}` returns names, sizes, `notShared` with reasons, findings,
    isolation, scripts, grants and `{source, base, digest}`. It returns the full payload only when there are no
    findings.
  - `POST /v1/modules/share {task, credential, module, repo, ref, source, base, digest}` re-exports at `source`, refuses
    on any difference or finding, then calls `fileKernel` with `owner`.
- Modify: `kernel/src/main.ts`.
- Modify: `services/board/src/{settings-change,app}.ts` (`{kind:"share", …}`) and `web/src/ModulePage.tsx`.
  - The Share section shows the exact payload, "contains code", the effective grants, "not shared" with reasons, the
    blocking findings and the private-repo warning.
  - Without GitHub it shows one line: "Sharing needs GitHub connected."
- Modify: `services/board/src/marketplace.ts` `addsOf` ("routines start paused"). The paused-once rule itself is Task 7's
  create status.
- Create: `docs/design/sharing.md` (New installs; the limit that prose can hold owner data).
- Test: V4.

- [ ] Write V4 and confirm it fails.
- [ ] Implement.
- [ ] Run the github, codehost-local, kernel, scripts and board suites (`tsc -p tsconfig.build.json`, the six
  screenshots) and V4.
- [ ] Commit `feat(sharing): publish a local module, bound to the owner's preview`.

## Stage 4

### Task 17: Integration, CI, reviews, PR

- [ ] Merge the lanes and reconcile the shared docs. Run `node scripts/lean/contract-lock.ts --write` and commit the
  result.
- [ ] Run `node scripts/ci-local.ts`; everything must be green. That covers:
  - `scripts`, `kernel`, `services/board`, `services/computer`;
  - modules `tasks-mcp`, `chat-lane/lane`, `owner-channel/notify`, `slack-live`, `open-loops`, `github`,
    `codehost-local`, `fleet-steward`, `ai-reviewer`, `code-review`, `grading`, `dispatch`, `platform` and `design`;
  - `scripts/verify-security.sh --static`;
  - V1, V2, V4. Also V3, run by hand once with its output in the PR body.
- [ ] Compile a scratch clone of the instance after Task 18's reshape, offline. Expected:
  - the same agent count;
  - `aria`, `roadmap-keeper` and `roadmap-feedback` at `tier: local`;
  - the same routine keys;
  - `--sizes` equal except the memory section;
  - Task 12's snapshots equal.
- [ ] **Security review** (Codex, read-only) of the new paths:
  - `/v1/memory/*`;
  - `self_change` and the prospective compile;
  - `/v1/events*`;
  - the local-module allowlist;
  - share preview, publish and export;
  - code refusals on `fileTool`.

  Fix each finding with a test in V1-V4 or the unit test of that file.
- [ ] **Local Codex review**:
  `codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`
  in the background. Fix every important finding. Re-runs use `--base <last reviewed sha>` at `low`.
- [ ] **Open the PR.** CI runs `reviewer-eval` because the base's `REVIEWER_CODE` matches; read its result. The body
  lists each dropped behaviour for the owner's OK:
  1. trial: its write limits, own-chats-only, the refused Slack channel and thread, the notify decision exception,
     graduation applies, trial coaching (now by age);
  2. routine autonomy, caps and provenance; webhook routines get the reviewer only;
  3. merit labels, path sensitivity, `ownerRequired`; every apply is Tier 1;
  4. the reviewer on product merges with CI and a code-review pass, and on GitHub label, state and thread replies;
  5. `private_reads`;
  6. reviewer-eval runs outside the reviewer's own code;
  7. the design-review merge wait;
  8. the memory inbox, daily memory curation, memory in git, `conf`, the owner memory scope, and legacy lines refused
     on import (counted);
  9. the Engineer hop for instance definitions and `task_propose_rule`;
  10. implicit skill selection;
  11. the triage webhook and poke, and the leading-edge event fire;
  12. agent routines running more than hourly or with more than one schedule; the board's routine status override
      (live pause and resume stay); GitHub label and review events (deferred); the Steward's skill inventory (cut);
  13. the result of the Paperclip probe.

### Task 18: Instance change and deploy

- [ ] **Instance commit 1** (pin bump included: the old product ignores `modules/` and the new one refuses
  `agent.yaml`). A throwaway reshape script using the yaml Document API:
  - `agents/<k>/agent.yaml` → `modules/<k>/module.yaml` as
    `{name, description, agents: {<k>: def minus routines, trial, trial_writes}, routines: {<k>-<rk>: r minus autonomy, with agent: <k>}}`;
  - `agents/<k>/AGENTS.md` → `modules/<k>/agents/<k>/AGENTS.md`, with frontmatter stripped after checking that it
    matches the YAML identity;
  - each local agent's `skills:` from Task 12's instance snapshot;
  - delete `overrides.routines.*.autonomy` and any `private_reads`;
  - set `product: <merged sha>`;
  - **keep `agents/*/memory.md`.**

  Verify with Task 17's compile step.
- [ ] **Before pushing:**
  - Tell Aiden in WOR-7241 (`~/aiden-msg.sh`) that applies on old paths will be refused, and to re-file them with
    `self_change`.
  - Check the product repo's branch protection for a required `design-review` context, and remove it
    (`gh api repos/<product>/branches/main/protection`).
- [ ] **Push and apply.** Push from the Mac clone. In the background, run
  `ssh -i ~/.ssh/aidenhq-ex44 mudit@95.216.21.102 '~/aidenhq/ops/aidenhq-apply --wait'`. Check:
  - the `memory:` line (imported, refused, skipped);
  - no duplicate routines in Paperclip;
  - triage triggers disabled.
- [ ] **Live checks:**
  - the board lists the three agents under "Your agents", with Memory blocks;
  - Aria answers in chat;
  - "remember X" in chat lands in memory through the handoff;
  - a TEST task where Aiden adds a library skill through `self_change` shows a Tier 1 card naming its enablers;
  - one Slack message produces one triage run.
- [ ] **One-time cleanup:** run `node ops/memory-inbox-cleanup.ts` once (it cancels the old inbox tasks).
- [ ] **Instance commit 2, after 7 days with no rollback:** `git rm agents/*/memory.md` and update `agents/README.md`.
- [ ] Remove the worktrees and the lane branches.

## New installs

- **Fresh install.**
  - No local modules, no memory ("Nothing yet").
  - Explicit skill lists from the bundle.
  - Slack triage (`*`) gets events once Slack advanced mode is connected.
  - Without GitHub, the Share section is one line.
  - Quiet start is unchanged.
- **Another owner's agents** are `modules/<name>/` in their instance repo, or a marketplace module (`declared`, routines
  paused once).
- **A stock install with `agents/<key>/agent.yaml`.** There are none today (owner: no users yet). Its updater's staged
  compile fails with the move message and it stays on its pin; the release note gives the move.

## Step-0 probe result (2026-11-23, pinned image 2026.1106.0) — binding for Tasks 8-10, 14

- `POST /api/routines/:id/run` IGNORES the `Idempotency-Key` header. Send the key in the JSON body:
  `{"idempotencyKey": "<sealed batch id>", "payload": {"batch": "<id>"}}` (body key, max 255 chars; a same-key retry
  returns the same run and issue). No bearer triggers.
- Use `payload` (kept verbatim as `triggerPayload`), not `variables` (dropped unless the routine declares them).
- A 202 is not success: require `status === "issue_created"` and a `linkedIssueId` in the run; otherwise retry/fail.
- `/run` runs paused routines (only archived gives 409): the kernel checks paused before calling (plan already drops).
- Event routines compile with concurrency `always_enqueue` (default `coalesce_if_active` merges identical payloads).
- The created issue carries `originKind: "routine_execution"`, `originId` = routine id, `originRunId` = run id.
