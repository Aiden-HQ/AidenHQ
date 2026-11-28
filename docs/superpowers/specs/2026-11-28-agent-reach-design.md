# How people reach agents

Status: approved by the owner (2026-11-28). Builds on `2026-11-28-summon-agents-design.md`.

## Intent

Other people, not only the owner, should be able to reach an agent: DM it on Slack, or email it. Aria is the first
case: people schedule with the owner through her Slack bot and her address `abotley@polygon.technology`.

It must be generic, for every user and future modules, and stay simple to use and maintain.

## Owner decisions (2026-11-28, fixed)

- **Default for everyone: the instance's one Slack bot.** People DM or @mention it. A message naming an agent goes to
  that agent; anything else goes to Aiden, who hands it on. Replies post under the agent's name. No extra apps, which
  avoids a workspace full of bots.
- **Optional: a dedicated Slack app for chosen agents.** The agent then receives and sends freely as its own bot. For
  our instance, Aria takes over standalone Aria's existing app.
- **Agents can have an email address:** any address that lands in the owner's Gmail and that the owner can send as.
  This can be a Workspace alias or group, like abotley@, or a plus-address, like you+aria@.
- **No Telegram identities.** Standalone Aria's Telegram account is dropped.
- Simple, maintainable architecture that future channels and modules reuse.

## Architecture: one path, more entry points

An entry point is a way a message reaches an agent. Every entry point feeds the summon path
(`kernel/src/summon.ts`): one conversation becomes one task for one agent, the agent answers with `conversation_reply`,
the conversation is pinned, and replies get a light review.

| Entry point | Owned by | Routing | Authority | Reply as |
|---|---|---|---|---|
| Owner's own chats, `cc Aria` *(live)* | slack, telegram, google | name match | owner | the owner, signed |
| Instance bot: DM or @mention | slack | name match, else Aiden | owner if the owner wrote it, otherwise untrusted | the bot, under the agent's name |
| Channel bound with `/aiden assign-channel` | slack | the bound agent | the same | the bot, under the agent's name |
| An agent's dedicated Slack app | slack | that agent | the same | that app's bot |
| An agent's email address | google | that agent | owner if the owner sent it, otherwise untrusted | that address (send-as) |

### Kernel changes

They're small, and nothing is channel-specific.

- **Event field `to_agent?: string`.** It's set by an attested source for messages sent to an agent's entry point:
  - an agent key for a dedicated app, an email address or a bound channel;
  - `"*"` for the instance bot, which routes by name, else to the chief of staff.
- **`claim()` opens a conversation** when `to_agent` is set, as well as on the owner's `cc`.
  - A non-owner ask goes through the fenced notice path (`FOR_OTHERS`), never as an owner comment.
- **Each conversation row stores `reply_as: owner | agent`.**
  - The kernel passes it to the source's `/reply`, with the agent key.
  - The signature is added only when replying as the owner, since an agent's own identity speaks for itself.
- **One path for bound channels.** `channels.ts thread()` and `slack_post` replies for bound channels are deleted.
  Bound channels become `to_agent: <key>` events on the same path.

### slack (slack-live)

- **Instance bot inbound.**
  - Non-owner DMs, which are dropped today, and @mentions are forwarded with `to_agent: "*"`.
  - Messages in a bound channel are forwarded with `to_agent: <key>`.
  - The owner's command DM stays Aiden's chat, unchanged.
- **Persona replies.** `/reply` with `reply_as: agent` posts with the bot token, `username` = the agent's name. This
  needs bot scope `chat:write.customize`.
  - The avatar: Slack needs a public `icon_url`, and board faces aren't public. So use the agent's emoji if it has one,
    otherwise the bot's own icon (builder's call).
- **Dedicated apps.** slack-live runs one Socket Mode connection per app, so the module-global socket and token state
  become per-app.
  - Apps are created from the same manifest flow, named after the agent.
  - Each app's two tokens are pasted once, into a named-secret map `slack_agent_apps` keyed by agent.
  - DMs and @mentions to the app become `to_agent: <key>`; replies post with that app's bot token.
  - No pairing per app: owner identity is the same Slack user id.

### google (google-workspace-mcp)

- **Poller.** Every 60 s, for each configured address, the service searches the owner's Gmail for new mail to or cc
  that address. It keeps a per-address cursor, reuses inbox.ts's noise filters, and posts events with
  `to_agent: <key>`. `from_owner` is true when the message is the owner's own sent mail.
- **Summon contract.** It implements `context` (the thread) and `reply` (reply-all on the thread, `From:` the agent's
  address, after a `users.settings.sendAs` check). `react` is a no-op.
- When the owner cc's an agent's address on their own email, that is a summons. Email summoning comes with this at no
  extra cost.

### Configuration and UX

Each channel module declares the entry points it offers. The teammate page renders them in one card, so there's one
place per agent.

```
How to reach Aria
  Your chats     cc Aria or Aria@AidenHQ, in your Slack, Telegram or email     always on
  AidenHQ bot    people DM @aidenhq-alpha and name Aria                        always on
  Own Slack app  Aria Botley · connected                                       [Manage]
  Email          abotley@polygon.technology                                    [Edit]
```

- Settings live in the owning module:
  - slack `slack_agent_apps`: a list of agents, plus the token map;
  - google `google_agent_addresses`: a list of `{agent, address}`.
- The card reads a small, generic declaration from each module:
  `contributes.board.reach: [{ setting, label, kind: app|address }]`. This is the second use (slack, google), which
  justifies one declaration instead of hard-coding the channels in the board.

## Security

- Authority still comes only from `from_owner`, which connectors set in code.
- Other people's messages are fenced data. The agent acts within its job and the owner's preferences, and replies get
  the light, malice-only review.
- A dedicated app or address replies only into its own conversation; the agent passes no channel or address.

## Our instance cutover

1. Ship the above.
2. Hand standalone Aria's Slack app to the new Aria by pasting its tokens into `slack_agent_apps`, and stop the old
   Socket Mode consumer first, because two consumers split events.
3. Set Aria's address to abotley@.
4. Stop standalone Aria.

## Builder's calls

- Exact field names. Persona avatar handling. Poller query vs the Gmail history API (start with a query and a cursor).
- How the board card links to each module's settings and secret map.

## Settled after Codex review (2026-11-28)

1. **Authorship is kept per message, end to end.** That covers filing, debounce, Aiden's handoff and the reviewer card.
   - A non-owner opening is never posted as owner-typed, and the reviewer is told who wrote each line.
   - `to_agent` is honoured only from the attested connector for that connection, and only for an agent on the
     reachable roster.
   - Test: a stranger's DM followed by an owner message.
2. **Each conversation stores a connector-owned entry-point id**, e.g. `slack:bot`, `slack:app:<id>` or
   `gmail:<account>:<alias>`. It's copied into the reviewed reply record and used for context, react, reply and retry.
   - For Gmail, the anchor message, the account, the verified alias and the exact reply-all recipients are frozen
     before review. A Cc added during review never widens the audience.
3. **Every outbound Gmail write gets durable provenance**, including `gmail_send`.
   - An ambiguous timeout is reconciled against it before any retry.
   - Echoes are dropped before owner attestation, so an agent's own send never comes back as the owner's words.
4. **Slack messages are classified before dedupe.** `message` and `app_mention` share `channel:ts`, so classification
   decides one event per message.
   - The precedence is the same live and on replay: owner command DM, then bound channel, then addressed bot, then a
     plain event.
   - Only an addressed opening creates a task. Later unnamed lines in that DM go to the agent that's already active.
   - Kept: the bound-channel rate limit and the `noteTask()` link for channel memory. Existing thread tasks get a fresh
     start, per the owner's no-migration rule.
5. **One consumer per Gmail message.** One account-scoped scan classifies mail for an agent's address before Intake
   sees it.
   - It dedupes by message id, durably, and advances the cursor after the kernel accepts the event.
   - The scan includes the owner's sent mail, for summons, and keeps group deliveries that the `List-Id` filter would
     drop.
   - The card's "your chats" line names email only where the owner has an agent address to cc.
6. **One installation record per Slack app.** The board list and the socket workers are derived from it.
   - The token pair's app and workspace are validated, and duplicates, including the instance app, are rejected.
   - On rotation, the old consumer stops before the new one starts.
   - The card shows reachability from real installation state, so a basic-tier install advertises no bot.
