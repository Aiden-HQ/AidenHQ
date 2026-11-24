# Needs you, answered in place

Status: approved by the owner 2026-11-24 (after a Codex design review). Part 1 of three board upgrades adopted from Orca Bots
(orca.dev/bots); parts 2 (task truth panel) and 3 (fleet overview) get their own specs.

## Why

The owner's biggest drains are following up, tracking and verifying. Decisions that are truly his already reach him (the
Steward and Aiden settle the rest, `kernel/src/escalate.ts`), but answering one means opening the task. Orca's "Needs you"
list answers in one tap. Push stays on Telegram (owner, 2026-11-24: Telegram is the only phone push channel; no web push).

## Goals

1. My day opens on **Needs you** at every width (also at zero: "Nothing needs you right now."). Failed and Unexplained idle
   stay selectable. Rows are ordered by the age of the owner obligation (the attention entry's `since`), oldest first.
2. A row with an open owner question leads with the question, then agent, task link and age, and carries the answer control
   in place. Card rows keep the card sentence and link to the card; Approve/Reject stay on Approvals and in-chat cards.
3. **One answer control** (`AnswerForm`) used by Needs-you rows and by chat asks (`AskView`, `MessageView`): a single
   single-choice question is one tap (first option marked Recommended); a typed reply sends on Enter; several questions or a
   multi-select keep an explicit Send. While sending the control is disabled; on error the typed text stays and the error
   shows; on success the row leaves when the live refresh confirms, and focus moves to the next row (or the heading).
4. **An answer is bound to the exact open wait.** Before posting, the board and Telegram each claim `(task, wait_since)` at
   the kernel. The claim succeeds only while that task's open owner wait started at `wait_since` and nobody claimed it yet.
   A stale answer (the wait ended or was replaced) or a second answer (board + Telegram) is refused with a visible message.
   A claimant whose post fails releases its claim. A bound answer always lands on the asking task; it is never rerouted by
   @mentions.
5. **Telegram decisions get one-tap buttons** from the same structured question: a single single-choice question with 2–4
   options that pass the existing button rules (`buttonsMarkup`: one line, ≤ 40 chars, printable ASCII). A tap goes through
   the same claim. Otherwise (several questions, multi-select, labels Telegram can't show) the spelled-out text stays and a
   typed reply works as today.

## Non-goals

- Web push, a service worker, an "Up next" schedule view, a "Replying to" composer chip (cut in review: the system can't
  tell an answer from a plain message, and the owner's next comment ends the wait anyway).
- Approve/Reject buttons on Needs-you rows.
- Changing who a question reaches.

## Kept (owner decision)

- Board browser notifications (`web/src/notify.ts`): they cover the case where `notify` keeps the Telegram message back
  because the owner is active on the board (`notify.ts` `boardOnly`).
- Approve/Reject on cards inside chats: same kernel decide route as Approvals.

## Approaches considered

1. **Kernel claim route, each surface posts its own way (chosen).** `POST /v1/answers/claim` + release, keyed by task and
   `wait_since`, in kernel.db. Smallest change; mirrors the board's existing relay claim (`relayed:<comment>:<dest>`).
2. Route every answer through the kernel's owner-message (`POST /v1/channel/owner-message`) with the check inside. One write
   path, but board answers would change author and gain a `[board]` prefix, and the board's comment route would split.
3. Board-only check. Leaves Telegram taps unbound; doesn't fix double answers.

## Constraints

- One way per concern; reuse `askedQuestions`, `buttonsMarkup`, the existing comment and owner-message posts.
- Owner taste: Stripe polish + Linear crispness + colour, no pill buttons, moderate radius (existing `styles.css` tokens).
- Works in every exposure mode (nothing here is tailnet-specific).
- Minimal tests: a few end-to-end-ish cases per layer, no component tests.
