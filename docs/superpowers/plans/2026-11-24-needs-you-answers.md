# Needs you, answered in place — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner answers an agent's open question in one tap from My day's Needs-you list or from a Telegram button, and every such answer lands exactly once on the question it was meant for.

**Architecture:** A kernel claim route keyed by `(task, wait_since)` is the one guard both surfaces call before posting; each still posts the way it does today. The board's Needs-you payload gains the open question and its options; one extracted `AnswerForm` renders answers everywhere. `notify` passes a single single-choice question (and its wait's start) to Telegram, which renders it as buttons whose press claims first.

**Tech Stack:** TypeScript, Node (`node:sqlite`), React (board web), zod, vitest (board, modules), `node --test` (kernel).

**Spec:** `docs/superpowers/specs/2026-11-24-needs-you-answers-design.md`

## Global Constraints

- Telegram stays the only push channel; keep board browser notifications (`web/src/notify.ts`) and in-chat card Approve/Reject untouched.
- No "Replying to" chip, no Up next, no Approve/Reject on Needs-you rows.
- One way: reuse `askedQuestions` (`services/board/src/chats.ts`), `buttonsMarkup` rules (`telegram.ts`: ≤ 4 labels, one line, ≤ 40 chars, printable ASCII), `pc.addComment`, the kernel owner-message post.
- A bound answer is posted to the asking task only: no `mentionedAgents` routing on the answer route.
- Styling: existing tokens in `web/src/styles.css`/`ui/tokens.css`; no pill buttons; first option marked "Recommended" with the existing `q-rec` look.
- Product CLAUDE.md "Conventions" apply. Tests minimal: the cases listed here, nothing more.
- Tests run under a hard timeout (`perl -e 'alarm shift; exec @ARGV' 600 …`); `pkill -f <worktree path>/` after each run; never leave vite/mock-api running; never `git stash`.

## Review Focus

1. Owner taps on the board and on Telegram within seconds: exactly one comment lands; the second surface says "Already answered".
2. The agent replaces its question (new wait) after the Telegram message went out: tapping the old button is refused, nothing posts.
3. The board's post fails after a successful claim: the claim is released, the owner can retry, the typed text is still there.
4. An answer text that @mentions another agent: it still posts only on the asking task.
5. A question whose options can't be Telegram buttons (5 options, multi-select, non-ASCII): Telegram shows the spelled-out text and a typed reply still works.

---

### Task 1: Kernel answer claim + wait start in the wait response

**Files:**
- Create: `kernel/src/answers.ts`
- Modify: `kernel/src/backplane.ts` (route table near line 191-199; handlers near the `/v1/channel/*` block ~line 913 and the board-authenticated routes), `kernel/src/idle.ts` (`wait()` return, ~line 360-405)
- Test: `kernel/test/answers.test.ts`

**Interfaces:**
- Produces: `answers(db: DatabaseSync, states: TaskStateRead, now: () => number): { claim(task: string, waitSince: string, by: string): "ok" | "stale" | "taken"; release(task: string, waitSince: string, by: string): void }`
- Produces HTTP: `POST /v1/answers/claim {task, wait_since}` → 200 `{ok:true}` | 409 `{error:"stale"|"taken"}`; `POST /v1/answers/release {task, wait_since}` → 200. Auth: the board token or a module with the same role check as `POST /v1/channel/owner-message`. `by` = the caller (`board` or module id).
- Produces: `POST /v1/wait` response gains `since: string` (the recorded wait fact's `at`, ISO) when a wait was recorded.

- [ ] **Step 1: Write the failing tests** in `kernel/test/answers.test.ts` (use the fake state reader pattern from `task-state.test.ts`):
  - `claim succeeds once for the open owner wait`: state `{attention:[{who:"owner",why:"owner_wait",…}], wait_since:"2026-11-24T10:00:00.000Z"}` → first `claim(t, since, "board")` is `"ok"`, second `claim(t, since, "telegram")` is `"taken"`.
  - `claim refuses a stale wait`: `claim(t, "2026-11-24T09:00:00.000Z", "board")` while `wait_since` is 10:00 → `"stale"`; no open owner wait at all → `"stale"`.
  - `release lets the same wait be claimed again`: claim → release (same `by`) → claim is `"ok"`; release by another `by` changes nothing.
- [ ] **Step 2: Run** `cd kernel && perl -e 'alarm shift; exec @ARGV' 300 node --disable-warning=ExperimentalWarning --test test/answers.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `answers()`** in `kernel/src/answers.ts`: table `answer_claims (key TEXT PRIMARY KEY, by TEXT NOT NULL, at INTEGER NOT NULL)`, key `answer:<task>:<wait_since>`; read the task's state via `states` (same reader the backplane uses for `GET /v1/tasks/state`); "stale" unless it has an `owner_wait` attention and `wait_since === waitSince`; `INSERT OR IGNORE` decides "ok" vs "taken". Head comment in the file's house style, a few lines.
- [ ] **Step 4: Wire the two routes** in `backplane.ts` and add `since` to `idle.wait()`'s result (the `at` it recorded).
- [ ] **Step 5: Run** the test again plus `test/idle.test.ts` — expect PASS.
- [ ] **Step 6: Commit** `feat(kernel): claim an owner answer once per open wait`

### Task 2: Board server — open question on Needs-you rows, bound answer route

**Files:**
- Modify: `services/board/src/app.ts` (`GET /api/needs-you` ~1768-1795; `asksOf` ~884-896; add `POST /api/issues/:ref/answer` next to the comments route ~2165), `services/board/src/task-state.ts` or wherever `kernelStates` lives (add a `claimAnswer`/`releaseAnswer` kernel call with the same bearer and timeout), `services/board/web/src/types.ts` (`NeedsYou`, `Ask`), `services/board/web/src/api.ts`
- Test: `services/board/test/answers.test.ts` (fakes from `test/fake-states.ts`, `test/kernel.ts`)

**Interfaces:**
- Consumes: Task 1's claim/release routes.
- Produces type: `NeedsYou.items[n].ask?: { question: string; questions: Question[]; waitSince: string }` — present when the row has an `owner_wait` attention; `questions` from `askedQuestions(comments, assigneeAgentId)` else `[{ question: state.question ?? "", options: [] }]`.
- Produces: `Ask` (from `asksOf`) gains `waitSince: string`.
- Produces HTTP: `POST /api/issues/:ref/answer` body `z.object({ body: z.string().trim().min(1).max(30_000), wait_since: z.string() }).strict()`; same guard as the comments route (`editableIssue`); claim → `pc.addComment(issue.id, displayText(text), true)` → on post failure release and rethrow; 409 → `{ error: "Already answered, or the question changed." }`. Returns `{ identifier, message }`. No @mention delivery, no reopen.
- Produces web: `api.answer(ref: string, body: string, waitSince: string): Promise<{ identifier: string; message: string }>`.
- Needs-you `items` sorted by the owner attention entry's `since`, oldest first.

- [ ] **Step 1: Write the failing tests** in `services/board/test/answers.test.ts`:
  - `needs-you carries the open question and options`: an owner_wait task whose agent's reply has `<!-- aidenhq-questions:[{"question":"Ship?","options":["Wait","Publish"]}] -->` → item `ask.questions[0].options` equals `["Wait","Publish"]` and `ask.waitSince` equals the state's `wait_since`.
  - `answer posts once`: kernel fake returns 200 for the first claim → one comment posted on that task; kernel fake returns 409 → response 409 and no comment.
  - `answer with an @mention stays on the task`: body `"@Researcher do the first"` → exactly one comment, on the asking task, no delivery to Researcher.
  - `failed post releases the claim`: `addComment` throws → a release call reaches the kernel fake and the route errors.
- [ ] **Step 2: Run** `cd services/board && perl -e 'alarm shift; exec @ARGV' 600 npx vitest run test/answers.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the payload fields, sorting, kernel calls, route and `api.answer`.
- [ ] **Step 4: Run** the new test plus `test/asks.test.ts test/chat-routes.test.ts` — expect PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(board): bind owner answers to the open wait`

### Task 3: Board web — AnswerForm and Needs-you as My day's default

**Files:**
- Create: `services/board/web/src/AnswerForm.tsx`
- Modify: `services/board/web/src/Workspace.tsx` (delete `QuestionForm` ~1382-1424; `MessageView` ~874 and `AskView` ~1353-1376 use `AnswerForm`), `services/board/web/src/Attention.tsx`, `services/board/web/src/App.tsx` (My day default ~240 and ~389-395), styles in the existing css file that holds `q-rec`.

**Interfaces:**
- Consumes: `api.answer`, `NeedsYou.items[n].ask`, `Ask.waitSince` (Task 2).
- Produces: `AnswerForm({ questions, onAnswer, autoFocus }: { questions: Question[]; onAnswer: (text: string) => Promise<unknown>; autoFocus?: boolean }): JSX.Element`.
  - One question, not `multi`, with options → each option is a button that answers on tap; the first is marked "Recommended"; a one-line "Type your answer" input sends on Enter.
  - Several questions or `multi` → today's pick-then-Send behaviour and text shape (`**question**\nreply` joined by blank lines; `(skipped)` for an empty one).
  - No options → the typed input only.
  - While `onAnswer` is pending: all controls disabled. On reject: re-enabled, typed text kept, the error shown under the control. On resolve: the form shows "Sent" until the parent's live refresh removes it.
- Chat `MessageView` keeps posting through its existing `answer` (a chat turn, not a wait); `AskView` and Needs-you rows call `api.answer(identifier, text, waitSince)`.
- Needs-you row with `ask`: question text first (bold), then agent · task id (link to `#/t/<identifier>`) · age, then `AnswerForm`. The row is not wrapped in the `ListRow` anchor (the controls sit beside the link). Card rows and rows without `ask` keep today's `ListRow`.
- After a row's answer resolves, focus moves to the next row's first control, else the "Fleet attention" heading.
- My day: `AttentionStrip` (non-compact) selects "needs" by default even when its count is 0. The page-level default tab effect (App.tsx ~389-395) is unchanged except that My day's Needs-you strip is the first thing shown at every width.

- [ ] **Step 1: Implement `AnswerForm`** and swap `QuestionForm` out of `Workspace.tsx` (delete the old component).
- [ ] **Step 2: Rebuild the Needs-you rows** in `Attention.tsx` and the default selection.
- [ ] **Step 3: Verify** `cd services/board && npm run typecheck && npm run lint && npx tsc -p tsconfig.build.json --noEmit`.
- [ ] **Step 4: Check it in a browser** with the board's mock API at 1512, 1920 and 390 widths: one-tap answer, typed answer (Enter), multi-question Send, a 409 showing the error and keeping the text. Screenshot each into the scratchpad; stop vite/mock-api afterwards.
- [ ] **Step 5: Commit** `feat(board): answer owner questions in place on My day`

### Task 4: Telegram one-tap answers through the claim

**Files:**
- Modify: `modules/owner-channel/connections/notify/src/kernel.ts` (`wait` returns `since`), `modules/owner-channel/connections/notify/src/notify.ts` (`Message` type ~33; building `m` ~198-203), `modules/channel-telegram/connections/telegram/src/send.ts` (`Message` ~15; `transportSend` ~66-77), `modules/channel-telegram/connections/telegram/src/telegram.ts` (`buttonsMarkup` neighbour), `modules/channel-telegram/connections/telegram/src/chat.ts` (callback handling ~226-250), `modules/channel-telegram/connections/telegram/src/kernel.ts` (claim/release calls)
- Test: `modules/channel-telegram/connections/telegram/test/telegram.test.ts`, `modules/owner-channel/connections/notify/test/notify.test.ts`

**Interfaces:**
- Consumes: Task 1's `since` from `POST /v1/wait` and the claim/release routes.
- Produces: notify `Message.answer?: { options: string[]; since: string }` — set only when the notify call has exactly one question, not `multi`, with 2–4 options, and the wait recorded a `since`; `actions` and `answer` are never both set (actions win).
- Produces: `answerMarkup(store: Store, task: string, since: string, labels: string[]): InlineKeyboard | undefined` — same label rules as `buttonsMarkup` (undefined, not a throw, when a label fails them); stores `ans:<id>` = `JSON.stringify({ label, task, since })`.
- Press handling for `ans:<id>`: read and clear the kv (restore on failure as today); `claim(task, since)`; 409 → edit the keyboard to one disabled `Already answered` button and `answerCallbackQuery` text "Already answered, or the question changed."; ok → `deliver` the label exactly as a `btn:` press does (thread reply to that task); on deliver failure → `release(task, since)`, restore the kv, rethrow.

- [ ] **Step 1: Write the failing tests:**
  - notify: a decision with one single-choice question of options `["Wait","Publish"]` and a wait returning `since` → the sent `Message.answer` equals `{ options: ["Wait","Publish"], since }`; with `multi: true` or 5 options → no `answer`.
  - telegram: `answerMarkup` stores `{label, task, since}` per button and returns undefined for a non-ASCII label; a press whose claim returns 409 posts nothing and edits the keyboard to "Already answered"; a press whose claim returns 200 delivers the label to the task's thread.
- [ ] **Step 2: Run** `npx vitest run` in each module folder under a 600 s timeout — expect FAIL.
- [ ] **Step 3: Implement** the notify field, `answerMarkup`, `transportSend` choosing `answerMarkup` when `m.answer` is set, the press branch and the kernel calls.
- [ ] **Step 4: Run** both modules' suites — expect PASS.
- [ ] **Step 5: Commit** `feat(telegram): one-tap answers to owner questions, claimed once`

### Finish

- [ ] Run every suite CI runs that these touch (kernel, board incl. typecheck/lint/tsc build, notify, telegram, and `services/computer` / `scripts` tests if any handbook text changed).
- [ ] Local Codex review: `codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null` (background); fix every important finding.
- [ ] Open one PR titled `feat(board): answer owner questions in place, bound to the open wait`.
