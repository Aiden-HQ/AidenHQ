# Summon an agent from your own chats

Status: draft for owner approval (2026-11-28). Companion spec: `2026-11-28-aria-module-design.md`.

## Intent and why

The owner talks to people on their own accounts (Slack, Telegram, email). Often the next step is work an agent could do:
"ok, I'll find some time for us to chat tomorrow. cc Aria". Because AidenHQ already ingests those accounts, the owner
should be able to loop an agent in right there, by name, with no app switch. The agent gets the message and the
conversation around it as a task, does the work, and answers in the same chat from the owner's account, signed:
"Booked you for 8 pm tomorrow. Sent by Aria from AidenHQ" (AidenHQ linked to the website).

This is generic. It works for every user-facing agent (Aria, Aiden, later ones) and every ingest source. Slack and
Telegram are wired first. Email and later sources plug in through the same contract once their live ingest exists.
It is especially useful in group chats, where the owner can hand work to Aiden mid-conversation.

## Owner decisions (2026-11-28, fixed)

1. **Only the owner summons.** A summons counts only when the message is verifiably the owner's own: the Slack author
   is the owner's user id, Telegram marks it `outgoing`, the email is From the connected account. Anyone else
   writing "cc Aria" is ignored.
2. **The agent may keep talking to the other person, within the ask.** While the task is open, later messages in that
   conversation reach the task. Other people's words are data, never instructions, and the agent stays within what the
   owner asked. Every message it sends is AI-reviewed and signed.
3. **No agent identities of their own.** Agents act through the owner's accounts, with a signature. The standalone
   Aria's Telegram account, Slack app and email alias retire (see the Aria spec).
4. **Generic across all ingests**, including email, even where a source's live pipeline is built later.

## Goals

- `cc <Name>` or `@<Name>` in the owner's own message reaches that agent as a task, with the conversation context.
- The owner sees that it landed within seconds (a 👀 reaction), and gets a reply in the chat as soon as the work is done.
- The agent can post only into the conversation it was summoned in.
- One path for every source: a source joins by implementing one small contract.

## Non-goals

- Other people summoning agents (decision 1). Allowlists can come later if wanted.
- Agents with their own accounts, bots or mailboxes (decision 3).
- Building the email live pipeline now. The contract covers it; the Gmail adapter is built after its ingest.
- Natural-language detection ("Aria, can you…" without `cc`/`@`). A plain mention of a name never fires.

## Anti-goals (failure even if it works)

- An agent's own signed reply wakes it again (loop).
- One summons becomes two tasks (the summon path and Intake both file it).
- A stranger's reply in the thread steers the agent outside the owner's ask, or makes it post somewhere else.
- The summons takes minutes to be picked up because it waited in a triage batch.
- Anything posted to a chat the owner excluded (e.g. the Telegram group the owner has banned agents from).

## Today (research, 2026-11-28)

- Slack: `slack-live` gets the owner's own messages in real time (Socket Mode, user events). Telegram: `telegram-live`
  (TDLib user account) ingests outgoing messages and groups, labels `outgoing`, and already suppresses its own sends
  (`agentSent`). Email: no live ingest. Intake scans the inbox every 30 minutes and never sees sent mail.
- Ingested messages wake only Intake, through event routines: a 60 s batch window, a ~30 s drain, 12 batches/hour per
  routine, no concurrent runs. Intake's handbook treats "AI, do X" as data. There is no summon path.
- The closest existing path is `kernel/src/channels.ts` `thread()`: a colleague's @mention of the bot in a bound Slack
  channel becomes one task per thread, kv-keyed `slack_thread:<id>`, reopened on later mentions.
- Sends as the owner exist (`slack_send_message` via Slack's MCP, `telegram_reply`), each an AI-reviewed write. A Slack
  message posted as the owner comes back through the user stream as an owner-authored event. Nothing marks it, so
  there is no Slack loop guard today.
- Latency: see "Measured latency" below.

## Approaches considered

1. **Through Intake (rejected).** Intake already sees every message. But it sits behind the 60 s batch window and
   hourly caps, and needs an LLM to notice the summons and hand it on. That's slow and unreliable for something
   matched exactly by text.
2. **Each connector detects and files tasks itself (rejected).** This is fast, but the matcher, debounce, task mapping,
   signature and loop guard would be rebuilt per source, and Telegram's event filters have no `contains`. N copies of
   one rule breaks "one way".
3. **One kernel summon path fed by the existing event stream (chosen).** Connectors already POST every message to
   `/v1/events`. They add who wrote it (in code) and which conversation it belongs to. The kernel matches before
   batching, files or updates the task immediately, and serves two task-bound tools for reading context and replying.
   This gives one matcher, one loop guard and one signature, and a source joins by implementing a small adapter.

## Design

### The source contract

A source module that wants summons:

- **Marks each event** it already sends to `/v1/events` with `from_owner: true|false` (decided in code from the
  authenticated identity, never from text) and a `conversation` id (Slack `channel` or `channel:thread_ts`; Telegram
  chat id; Gmail thread id).
- **Implements three calls** the kernel makes on its service (declared in `module.yaml` under one new block, e.g.
  `summon:`): `context(conversation, before_message, n)` returns the last n messages as {author, is_owner, text, ts};
  `reply(conversation, in_reply_to, text)` posts as the owner and returns the new message id; `react(message, emoji)`.
- **Applies its own exclusions** (e.g. `telegram_exclude_chats`) to `reply`/`react`: an excluded conversation refuses.

Slack and Telegram implement it now. Gmail's adapter (From = account; reply-all on the thread) lands with a Gmail
live ingest, outside this build.

### Matching (kernel, one place)

- Runs in `kernel/src/events.ts` on each incoming event, before routine batching.
- It fires only when `from_owner` is true and the text has `cc <Name>`, `cc: <Name>`, `@<Name>` or any of those with
  `@AidenHQ` appended (`cc Aria@AidenHQ`, owner 2026-11-28). Matching is case-insensitive and word-bounded, for a
  summonable agent. A source's native mention markup that resolves to the name also counts.
- **Summonable = the user-facing teammates**, the same set board @-mentions use (`services/board/src/crew.ts`
  `mentionedAgents()`). Hidden agents are not summonable. This needs no new permission setting.
- Several names in one message give one task per named agent.
- **Debounce:** the owner's messages in the same conversation within 5 s fold into one summons, because people often
  send two quick lines.

### The task

- **One conversation, one task per agent.** It's kv-keyed `summon:<source>:<conversation>:<agent>`, the same pattern as
  `thread()`; a closed task reopens on a new summons. `thread()` folds into this path: a bound-channel @mention of the
  bot shares this filing code but keeps its own (colleague, no owner authority) labelling. See "Settled after review".
- **The description** carries:
  - the owner's words, labelled as the owner's request;
  - the conversation's last 10 messages from `context()`, each other-person line fenced as untrusted;
  - a `source:` marker;
  - a done condition ("reply in the conversation with the outcome").
- The task is assigned straight to the named agent and starts at once. The owner's summons is the owner's word, so it
  carries the owner's authority for this ask only.
- **Ack:** right after filing, the kernel calls `react(message, 👀)`. It's tier 0: the owner's own message authorised it,
  and a reaction carries no content.

### Two task-bound tools (a kernel connection, granted to every summonable agent)

- `conversation_context(n?)` reads more of the task's conversation.
- `conversation_reply(text)` posts into the task's conversation, threaded under the owner's message in a Slack channel
  and as a reply in Telegram.
  - It takes **no channel argument**: the kernel looks up the task's conversation, so the agent can't post anywhere
    else.
  - Each reply is a write record (`conversation.reply`, floor 1, AI-reviewed). The reviewer sees the owner's ask and
    the recent context.
  - The kernel appends the owner's signature setting in code (see Settings). Each source's `reply()` renders the link
    in its own markup: Slack `<url|AidenHQ>`, a Telegram text link, an HTML link in email.
- An agent summoned this way needs no grant on the source's own send tools.

### Follow-ups (decision 2)

- **While the task is open**, every later message in that conversation is appended to the task as a comment:
  - the owner's messages are labelled the owner's words;
  - other people's messages are fenced and labelled untrusted.
- **The handbook rule** lives once, in the summon skill: act only within the owner's original ask. Anything beyond it
  goes to the owner through the normal channel, never done on a stranger's say-so.
- **Closing the task stops the forwarding.** A later `cc` reopens it.
- Connectors already emit DMs and active groups. For muted groups, a summoned conversation is forwarded while its task
  is open: the kernel exposes the watched set, or connectors emit all messages and the kernel filters. Builder's call:
  see below.

### One owner per message

- Events the summon path consumes are not added to Intake's batches: the summons itself, and follow-ups in an open
  summoned conversation.
- Everything else flows to Intake exactly as today.

### Loop guard

- The kernel records each message id `reply()` returns, and drops events with those ids before matching.
- It also drops any owner-authored event whose text ends with the rendered signature (from the current setting). That
  catches echoes that arrive before the id is known.
- Telegram's existing `agentSent` suppression stays as is.

### Settings

- Kernel setting `summon` with values `on` | `off`, default `on`. It's quiet-start safe: nothing happens until the owner
  writes `cc`.
- Kernel setting `summon_signature` (owner 2026-11-28: a user setting, this is the default):
  `Sent by {agent} from [AidenHQ](https://aidenhq.ai)`.
  - It's a short template with `{agent}` and markdown links, shown on the owner's settings page.
  - An empty value is refused, because the loop guard and honesty with the other person depend on a signature.
- Exclusions stay per source, in the source module's settings. The instance excludes the banned Telegram group there.

### Latency targets

- Summons -> 👀 within 3 s.
- Summons -> agent run started within 15 s.
- A simple booking -> reply in the chat typically within 90 s. This is bounded by the agent run plus one review.
- The fast path skips the routine window and caps entirely. Measured numbers below set which step to cut next.

### Measured latency (EX44, last 7 days)

Read-only from `kernel.db`. Figures are p50 / p90.

| Step | Today | Summon path |
|---|---|---|
| Event -> routine dispatched | 68 s / 74 s (the batch window is ~66 s; seal -> dispatch < 2 s) | skipped; 5 s debounce |
| Wake -> job started | 6-10 s / 48-162 s (the p90 is queueing at `max_concurrent: 16`) | same, unless prioritised (below) |
| Run duration | Intake 14 s / 39 s; chief of staff 23 s / 252 s; Aria: 4 jobs in 7 days, too few to measure | agent-dependent |
| AI review of one write (Luna) | 20-25 s / 30-45 s for every kind | one review per reply |
| Telegram send executor | never used (0 `telegram.*` records) | first real use |

- The expected p50 of a summoned simple booking is about 5 + 7 + ~30 + 22 ≈ 65 s. The calendar write and the reply
  are each reviewed; if they run in sequence, add ~22 s.
- Three cuts, in order:
  1. Skip the batch window (this design).
  2. Summoned jobs are claimed ahead of background work. The owner is waiting, as old Aria's "owner jobs first" rule
     did. This cuts the 1-3 minute p90 queue wait.
  3. If review time still dominates, review the reply and the calendar write in one record. Builder measures first.
- Seen in passing: 54% of slack-triage batches are dropped, and some worker jobs hit the 120-minute timeout. Both are
  out of scope here and noted for a separate look.

## Slack tiers (owner, 2026-11-28)

- Summoning in Slack needs the **advanced** tier (the user's own Slack app). Basic, which signs in through a shared app
  and Slack's MCP, ingests nothing: its app's events go to the app's owner, not to each instance. Polling search could
  catch only the owner's own messages, so it would be a second ingest path with up to 60 s of delay.
- **Slack setup steers users to advanced.** The two options already sit side by side. Advanced is marked recommended,
  with the differences highlighted: live triage, the `src_slack` warehouse, the bot DM, channel binding, and summoning.
  Basic stays available for users who only want agents to read Slack on demand.
- Coverage on advanced: live events cover every conversation the owner is in, plus public channels they aren't in
  (`slack-live/src/sources.ts`). Gap sync and backfill cover only conversations they're in. Summoning only needs the
  owner's own messages, which are always in conversations they're in.

## Settled after review (builder check + Codex, 2026-11-28)

**Authority**
- **Owner attestation is a privilege.** A connector may set `from_owner` only if it holds a new role, e.g.
  `kernel.attest-owner`, bound to its connected account. Owning the connection isn't enough.
- Email must prove the message came from the account's own Sent mail, not a matching `From` header.
- **The summons reaches the agent as an owner comment.** Dispatch's `ownRequest()` ignores descriptions with a
  `source:` marker, and `speaker()` treats owner-key comments as the owner's words. So:
  - the verified summons text is posted as the owner's comment;
  - the context and other people's follow-ups go through the existing notice mechanism (`FOR_OTHERS`), never as
    owner-key comments;
  - every write review on the task is pinned to the original ask, even after a long back-and-forth;
  - one test checks the authority both the runner and the reviewer see.
- **Colleague @mentions of the bot in bound Slack channels keep working as today.** They're fenced and limited by the
  channel binding. They share the task-filing code with summons but carry no owner authority. This is an engineering
  call that drops nothing.

**Roster and matching**
- The summonable roster comes from the compiled modules config: teammate names and handles. The kernel loads it.
- The board's `mentionedAgents()` regex can't take `@Name@AidenHQ`, so the matcher is new. It lives in the kernel and
  the board keeps its own.
- A user-chosen agent name that collides with a person ("cc Sam") is accepted. `@AidenHQ` disambiguates, and the owner
  can rename the agent.

**Reliability**
- **Claim durably before acting.** The event, its routing decision and the per-agent delivery are stored in the ingest
  transaction. Tasks are filed with the stable filing key from `kernel/src/modtasks.ts`, not `allowDuplicate`, so
  retries and races never make two tasks.
- **React after acceptance.** 👀 fires as soon as the event is durably accepted; the 5 s debounce then folds in more
  lines. That keeps the 3 s ack target.
- **Stable conversation address:** `(account, channel, thread_ts ?? ts)` for Slack channel threads, so a threaded reply
  maps back to its summons.
- **Durable sends.**
  - Each `conversation_reply` is persisted before posting, and the provider message id is reconciled afterwards, even
    after a timeout.
  - Bindings and exclusions are rechecked at execution time.
  - The echo guard keys on message ids, because Slack clips event text at 2,000 characters, which can cut off the
    signature.
- **Slack replay gap.** Gap sync must use the same owner attribution as live events. Failed forwards are kept for retry,
  as Telegram already does.
- **Summons are tasks, not chat-lane turns.** One route per interaction: the agent's lane chat never sees them, and the
  outcome is posted in the source conversation. The task closes with a one-line finish on the board, and nothing
  reaches the owner unless something needs them.
- **Speed cut 2 (summoned jobs claimed first) is in scope.** The owner asked to fix latency, and the p90 queue wait is
  the second-biggest delay.
- The event field shapes, `TEXT_MAX`, and whether consumed events still go to `event_log` are left to the builder.
  The constraint: change-feed readers keep seeing every event.

## Security notes

- Authority comes only from `from_owner`, set in code by the connector. Untrusted text never sets it.
- The private data + untrusted input + external send combination is bounded three ways:
  - replies go only to the conversation the owner summoned into;
  - every reply is AI-reviewed;
  - the handbook binds actions to the owner's ask.

## Builder's calls (left open)

- Exact event fields, and the `summon:` block schema name.
- How follow-ups in muted Telegram groups reach the kernel: a watched set pushed to connectors, or emit everything and
  filter in the kernel.
- Whether `conversation_context` reads through the source service or from the `src_*` warehouse tables.
- How `thread()` callers (Slack `bind.ts`) move onto the summon path.
- Tests: one end-to-end test per wired source (summons -> task -> reply -> echo dropped), plus the matcher.
