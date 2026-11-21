# Mandatory Code Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a repo flagged `mandatory`, AidenHQ's merge queue merges a PR only when the code-review service says its
current head is covered and no important finding is open.

**Architecture:** The code-review service owns finding lifecycle and the per-head verdict (SQLite). The github service's
merge path calls it through an injected `reviewGate` (like `evalGate`) for repos on the compiled mandatory list. Disputes
go to a `judge` mode of the existing review recipe; the owner dismisses on the board.

**Tech Stack:** TypeScript (Node 24), node:sqlite, vitest, React board, zod.

**Spec:** `docs/superpowers/specs/2026-11-21-mandatory-code-review-design.md` (read it in full; its "Calls made" section
is binding).

**Owner changes during the build:** the spec's "Owner changes during the build" section supersedes the tasks below where they
differ (mandatory is a combo's, coverage per head by the batch that reviewed it, one judge per finding per head).

## Global Constraints

- Product `CLAUDE.md` "Conventions" is the full rulebook: one way, no fallbacks, delete what's replaced, minimal tests.
- Never `git stash`; never `git add -A`; build in your own worktree off `origin/main`; PRs are Conventional Commits, squash.
- Verdict values are exactly `pass` | `wait`; there is no `fail`.
- Only `important` findings gate; nits and pre_existing never do.
- Owner's GitHub login alone never dismisses (fleet comments post as it).

## Review Focus

1. A force-pushed or rebased PR (pr-watch update-branch): open important findings are rechecked, not orphaned; no repeats.
2. A review that fails or is superseded while a merge waits: the merge keeps waiting with a reason and resumes on the
   next completed batch, never stranded (pr-watch files a merge once per head).
3. A dispute reply from a non-writer (fork author) or containing instructions: ignored / treated as data.
4. Two combos (claude-code + codex-native) on one head: coverage needs both `done`; one failing keeps `wait`.
5. Repo not mandatory, or code-review module absent: merge path never calls the service; behaviour unchanged.

---

### Task 1: Finding lifecycle and recheck (code-review service + recipe)

**Files:** `modules/code-review/service/src/engine.ts`, `service/src/adapters.ts`, `recipe/review.ts`, tests beside them.

**Produces:** `findings.state` in `open|fixed|dismissed` (keep `outcome` analytics); `dispositions` table
`(finding_id, pr, head, state, reason, evidence, by, at)`; `openImportant(repo, pr): Finding[]`.

- [ ] Test `rechecks every open important finding on a force-push`: PR with an open important finding, new head not a
  descendant → the batch's first run receives it in `previous` (no touched-lines filter); verifier says fixed → `fixed`.
- [ ] Test `uncertain recheck leaves it open` and `a result for a superseded head is discarded` (transactional apply).
- [ ] Test `a restated finding is not re-posted`: finders receive open findings as already-reported; a new finding with
  the same id or flagged `same_as` an open id is dropped from the post and the store.
- [ ] Test `reported again reopens a fixed finding`.
- [ ] Implement; remove the 50-item carry-forward cap for open important findings; full runs and retries pass
  `previous` too. Run `npx vitest run` in `modules/code-review/service` and the recipe tests. Commit.

### Task 2: Coverage, verdict endpoint, fail-closed (code-review service)

**Consumes:** Task 1 `openImportant`. **Produces:** `GET /v1/verdict?repo=&pr=&head=` →
`{ verdict: "pass" | "wait", reasons: { code: string; text: string; unblock?: string }[] }`, auth by a new secret
`code_review_gate_key` (one key per caller); `covered(repo, pr, head): boolean`.

- [ ] Tests: `pass when covered and nothing open`; `wait: review not started` (unknown PR); `wait: the PR moved`
  (asked head ≠ current); `wait while a combo is queued/running`; `wait when one of two combos failed` (after one
  automatic retry, reason says `@aiden review`); `wait with titles+links when an important finding is open`;
  `a focused one-off never counts toward coverage`; `incremental head covered only if its range start was covered`.
- [ ] Fail closed for `mandatory` repos in `engine.ts`/`config.ts`: no budget skip (spend still recorded), forks
  reviewed as `auto`, one automatic retry of a failed run.
- [ ] Mandatory config check in `scripts/modules.ts` where `code_review_mandatory` is compiled: mandatory repo with
  `on_open: []` or `on_push: []` fails the compile with a clear message. Test in `scripts` tests.
- [ ] Wire the secret in `modules/code-review/module.yaml` (and for the github service in Task 4). Commit.

### Task 3: Disputes and the judge

**Consumes:** Task 1 `dispositions`. **Produces:** recipe mode `judge` (input: finding, fenced reply, head; output
`{ verdict: "dismissed" | "upheld", reason }`); service handler for dispute replies; `POST /v1/findings/:id/dismiss`
(board-only, owner session via board's existing token).

- [ ] Tests: `a reply from the PR author or a writer on a finding thread starts one judge run`; `a non-writer's reply is
  ignored`; `judge family differs from the author agent's model family` (author from the `Co-authored-by: AidenHQ
  <agent>` trailer → compiled agent model; unknown → checker model `~openai/gpt-luna-latest`); `indeterminate → upheld`;
  `dismissed is recorded with by=judge and posted as a thread reply`.
- [ ] Map reply → finding id via the hidden marker the poster puts in each inline comment (add it to the comment reader
  in github-mcp if not returned today).
- [ ] Use `kernel/sdk/src/judge.ts` for the family choice. Judge spend counts toward `day_usd`, never skipped on
  mandatory repos. Commit.

### Task 4: Merge gate (github service)

**Consumes:** Task 2 endpoint and key. **Files:** `modules/github/service/src/merges.ts`, `merge-gate.ts`, the service's
wiring, `modules/github/module.yaml`.

- [ ] Tests in `modules/github/service/test`: `mandatory repo, verdict wait → merge stays queued with the reasons`;
  `verdict pass → merges at the bound head`; `service unreachable → wait`; `repo not mandatory → reviewGate never called`.
- [ ] Implement `reviewGate(repo, pr, head): Promise<{ ok: true } | { ok: false; reasons: string[] }>` injected like
  `evalGate`; reasons surface on the merge record. The github module does not `require` code-review. Commit.

### Task 5: Board, deletions, docs

- [ ] Board Reviews page: per PR the verdict and reasons; Dismiss per open important finding (calls Task 3's route with
  a reason). `npx tsc -p tsconfig.build.json --noEmit` in `services/board`.
- [ ] Delete the `aidenhq/review` status writers and `reviewStatus` (`github-mcp/src/review-post.ts`,
  `review-render.ts`); keep the named-check exclusion in `checks.ts`.
- [ ] Rewrite `docs/design/code-review.md` rules (review gates mandatory repos), the "nothing enforces it yet" notes in
  `module.yaml`, `config.ts`, `docs/design/approvals.md`, and the "App where installed" comment. Commit.

### Task 6: Ship and turn on (me)

- [ ] PR(s) green → squash-merge → product pin → apply.
- [ ] Instance: `Aiden-HQ/AidenHQ` `mandatory: true`; `ai_review_code: unless_code_review_mandatory`; apply.
- [ ] Watch the next fleet PRs end to end (review → recheck → verdict → merge) and fix what misbehaves.
