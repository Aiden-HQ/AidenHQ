# Agent Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Four lanes run in parallel, each in its own
> worktree and PR (`ship:stop`). Steps use checkboxes.

**Goal:** People reach agents through the instance's Slack bot (by default), an agent's dedicated Slack app (opt-in) or
an agent's email address (opt-in). All of these feed the existing summon path.

**Spec:** `docs/superpowers/specs/2026-11-28-agent-reach-design.md`. Read all of it, especially "Settled after Codex
review".

## Global constraints

- Authority comes only from `from_owner`, set in code by an attested connector. Other people's words are fenced data
  at every step: filing, debounce, handoff and the reviewer card.
- `to_agent` is honoured only from the attested connector of that connection, and only for an agent on the reachable
  roster.
- Every reply is bound to its conversation's stored entry point and frozen audience. The agent never passes a channel,
  an address or recipients.
- Review stays light: malice-only, fail open.
- One way: the bound-channel `thread()` and `slack_post` reply path is deleted. Existing thread tasks get a fresh start.
- Conventions as in the product CLAUDE.md. Minimal tests: one end-to-end test per entry point, plus the listed
  regressions.

## Shared interfaces

**Event fields (kernel `SourceEvent`, optional):**
- `to_agent?: string`: an agent key, or `"*"` for "route by name, else the chief of staff".
- `entry?: string`: the connector-owned entry-point id, e.g. `slack:bot`, `slack:app:<app_id>` or
  `gmail:<account>:<address>`.
- `author_name?: string`: the display name of the sender.

**Summon contract additions:**
- `/reply` body gains `entry: string`, `reply_as: "owner" | "agent"` and `agent: { key, name }`.
- A new optional call, `POST {url}/prepare {entry, resource, thread?, in_reply_to, text, reply_as, agent}`, returns
  `{ preview: string, payload: object }`.
  - When a source implements it, the kernel calls it while planning `conversation.reply` and stores `payload` in the
    reviewed record.
  - `/reply` then receives `payload` and sends exactly that. This is how Gmail freezes its account, alias, anchor
    message and recipients.
- The signature is appended only when `reply_as` is `owner`.

**module.yaml:** `contributes.board.reach: [{ id, label, kind: "app" | "address", setting, secret_map? }]`, which the
teammate page's "How to reach" card reads.

**Settings:**
- slack: `slack_agent_apps`, a list of `{ agent }`, plus a named-secret map `slack_agent_apps` with fields `app_token`
  (`^xapp-`) and `bot_token` (`^xoxb-`).
- google: `google_agent_addresses`, a list of `{ agent, address }`.

---

### Lane K: kernel (opus)

- `kernel/src/summon.ts` / `events.ts`:
  - `claim()` opens a conversation for `to_agent`, resolving `"*"` by `matchSummons`, else the chief of staff.
  - Per-line authorship persists through debounce, filing and handoff. A non-owner opening goes through the fenced
    notice path, never `ownerTyped`.
  - The reviewer card names each line's author.
  - The conversation row stores `entry`, `reply_as` (owner for owner summons; agent for `to_agent` entries) and the
    agent.
  - Add `prepare` support, and pass `payload`, `entry`, `reply_as` and `agent` to `/reply`.
- `channels.ts`: delete `thread()` and its endpoint. Bound channels arrive as `to_agent` events.
- The compiler accepts `contributes.board.reach` and the new settings shape.
- **Tests:**
  - a stranger's DM to the bot naming Aria gives one task for aria, fenced, with no owner authority on the card;
  - a stranger's DM immediately followed by an owner message keeps both authors;
  - an unnamed DM goes to the chief of staff;
  - a later unnamed line in the same DM goes to the active agent;
  - `to_agent` from a non-attested connector is ignored;
  - a reply carries `entry`, `reply_as` and `payload` unchanged from the reviewed record.

### Lane S: slack (sonnet)

- **Instance bot.** `map.ts` / `socket.ts` classify each message once, before dedupe. The precedence is: owner command
  DM, then bound channel (`to_agent: <key>`), then addressed bot DM or mention (`to_agent: "*"`), then a plain event.
  This is the same live and on replay.
  - Keep the 30/h bound-channel limit and the channel-memory `noteTask()` link.
- **Persona reply.** `reply_as: agent` with `entry: slack:bot` posts with the bot token, `username` set to the agent's
  name, and the agent's emoji if any. Add bot scope `chat:write.customize` to the advanced manifest.
- **Dedicated apps.**
  - One installation record per app (replacing `app:last`). The board list and socket workers derive from it.
  - Create the app from the manifest, named after the agent.
  - Validate that the token pair is for the right app and workspace, and reject duplicates, including the instance
    app.
  - One Socket Mode worker per app, with the per-app socket, token and health state.
  - On rotation, stop the old worker before starting the new one.
  - Events carry `to_agent: <key>` and `entry: slack:app:<id>`; replies use that app's bot token.
- module.yaml: the `reach` entry, the settings and the secret map.
- **Tests:**
  - a non-owner DM to the bot maps to `to_agent: "*"`;
  - a bound-channel mention maps to `to_agent: <key>`;
  - a `message` and an `app_mention` for the same ts give one event;
  - a dedicated-app DM maps to the app's agent;
  - a persona reply sets `username`.

### Lane G: google (sonnet)

- **Poller** (service loop, every 60 s): one account-scoped scan.
  - It finds mail to or cc each configured address, including the owner's own sent mail.
  - Group deliveries are kept, which means not using inbox.ts's `List-Id` drop for these.
  - It dedupes by message id, durably, and advances the cursor after the kernel accepts the event.
  - It posts events with `to_agent`, `entry: gmail:<account>:<address>`, and `from_owner` (the owner's own sent mail).
  - The same scan marks these messages so Intake's `gmail_inbox_new` skips them, giving one consumer.
- **Summon contract:** `context` (the thread), `prepare` (resolve and freeze the anchor message, the account, the
  `sendAs`-verified alias and the exact reply-all recipients), `reply` (send the frozen payload with `From:` the alias)
  and `react` (no-op).
- **Provenance:** every outbound Gmail write, including `gmail_send`, records its message id or a pre-send token
  durably. An ambiguous timeout is reconciled before retry, and echoes are dropped before owner attestation.
- module.yaml: the `reach` entry, `google_agent_addresses`, and `summon:` plus `kernel.attest-owner` for the
  google_workspace connection.
- **Tests:**
  - a stranger's email to the alias gives one event with `to_agent`;
  - the owner's sent mail cc'ing the alias gives `from_owner: true`;
  - a group delivery is kept;
  - the same message seen twice gives one event;
  - `prepare` freezes recipients, so a Cc added afterwards isn't included;
  - an agent's own send is never attested as the owner's.

### Lane B: board card (sonnet)

- The teammate page gets a "How to reach <Agent>" card, built from every installed module's `contributes.board.reach`
  plus two fixed rows:
  - "Your chats": always on. Name email only when the owner has an agent address to cc.
  - "AidenHQ bot": shown only when the slack advanced tier is installed and the bot is connected.
- Each module row shows its state (from real installation or setting state) and a Manage or Edit link to its module
  page or secret map.
- Follow board-ui.md, and screenshot at 1512, 1920, 820 and 390, light and dark.

## Merge order and cutover

- K, S and G merge together after one integration pass. B can merge any time after K.
- Cutover on our instance:
  1. Stop old Aria's Slack Socket Mode consumer, using its features switch.
  2. Paste its app's tokens into `slack_agent_apps` for aria.
  3. Set `google_agent_addresses` to aria → abotley@polygon.technology.
  4. Apply, test a DM and an email.
  5. Stop old Aria entirely.
