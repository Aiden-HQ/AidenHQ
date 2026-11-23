# How to use AidenHQ

## The one rule

**Talk to Aiden, your chief of staff (CoS); let it do the rest.** Aiden routes work to the right agent, follows up and
pushes things to you. You rarely need to open anything else.

| Where | For |
|---|---|
| Your Telegram bot or Slack DM with Aiden | Everything day to day: asks, forwards, answers, decisions |
| The board (`https://<board-host>`, on your tailnet) | Reviewing: today's tasks, chase drafts, approvals, longer threads with an agent |
| Paperclip (`http://localhost:3100` through an SSH port-forward; see [setup](setup.md)) | Inspecting the fleet: org chart, runs, costs, routines |

## Daily rhythm

- **Morning:** the brief arrives as a push. Skim it, reply to the CoS with any decisions.
- **During the day**, send the CoS anything you would otherwise keep in your head:
  - "follow up with Sam on the audit by Thursday"
  - "check whether the fix Priya mentioned actually shipped"
  - "remind me to review the security pass on Monday"
  - "ask the inbox agent what is waiting on me from the auditors"
- **Forward** messages you need to act on or track, with one line of intent: "track this", "chase if no reply by
  Friday", "summarize". Forwarded text is treated as information, never as orders.
- **Chase drafts:** when someone owes you something and goes quiet, the Follow-up Tracker drafts a nudge and pings
  you. Say "send" in its chat and it becomes a Slack draft in your DMs that you send yourself.

## Running the fleet (by asking the CoS)

- "What's stuck?" / "What did the agents spend this week?" / "Status of everything"
- "Run the brief now" / "Pause the Slack scout until Monday" / "Resume it". Admin actions only run on your own
  words, never on something forwarded.
- **Changing the fleet:** "make the brief shorter", "add a Friday check on X", "model for the scout: kimi". The CoS
  hands it to the Engineer, which edits your instance repo (`instance.yaml`, `apps.yaml`, `agents/`) and
  shows you the diff. Nothing changes until you approve.
- **"Install X"** means enable module X: the Engineer adds it to `modules:` in `instance.yaml` (and any settings it
  needs) and you approve. Disabling pauses the module's agents and routines; nothing is deleted.
- **Upgrading the product** is a `product:` bump in `instance.yaml`. The Engineer shows the product commits between the
  old and new pin; the new commit must be on product main.
- **New agents:** ask the Agent Architect for one; it designs the agent (a local module of your instance repo) and hands
  the change to the Engineer. A new agent starts with its designed grants once the AI reviewer passes the change.
- **Product code or a module's handbook** is not instance config: the Engineer opens a PR on the product repo, which
  you merge as usual.

## Apps (long-running software the agents run)

- Ask the CoS: "what apps are running?", "is the warehouse healthy?", "add X to <app>".
- The **DevOps Engineer** owns the apps. An unhealthy app goes to it first. You are paged only if it cannot fix the
  problem in time or it keeps recurring.
- Agents may create and deploy ordinary apps on their own. Sensitive ones need your approval: apps that declare
  restricted roles, keep data, are untrusted, or need extra host access.
- Apps that keep data (for example the warehouse, the shared Postgres) are deployed only when you say "deploy <app>".
- Each app has its own URL on the apps' own tailnet name, `https://aidenhq-<user>-apps.<tailnet>.ts.net:<port>` (never the
  board's name). The board lists them under Fleet, Apps.
- Every app runs sandboxed: it gets nothing outside its own containers (host files, other services, extra privileges)
  unless its registry entry (instance `apps.yaml`, or the module's own for module apps) grants it.

## Secrets

Secrets live in the secret vault: the secrets directory on the host is an encrypted gocryptfs folder, unlocked at boot
by the host's TPM, plaintext only while mounted. Keep the recovery key in a password manager. See
[ops/vault/README.md](../ops/vault/README.md).

## Connect Jira

The `jira` module reads Jira (and Confluence) through Atlassian's own remote MCP server, signed in as you. The Research
The Researcher gets reads only (JQL search, an issue, its change history, comments, projects, releases); nobody gets the
write tools (comment, create issue) until you grant them. Every call is pinned to your Atlassian site.

1. On the host, create the sign-in folder first, as your user and not root: `mkdir -p ~/.config/aidenhq/jira && chmod 700
   ~/.config/aidenhq/jira`. Without it Docker creates a root-owned folder and the sign-in cannot be saved.
2. In the instance repo, add `jira` to `modules:` in `instance.yaml` and apply.
3. On the board, Settings, Connections, Jira: **Connect**. Give your Atlassian site's address (for example
   `https://your-company.atlassian.net`), then sign in with your own Atlassian account in the tab that opens and
   approve read and search access to Jira and Confluence. Atlassian then sends that tab to `http://localhost:3121/jira/callback?...`,
   which can't load: copy its full address into the Connect dialog and press **Finish**
   ([docs/setup.md](setup.md#connecting-accounts)). The banner disappears when it works.
4. Check: ask the CoS "what's open in Jira for project X?".

If the sign-in says your account cannot reach the site, your Atlassian account lacks access to Atlassian's remote MCP
server (Rovo): ask your Atlassian administrator to allow it. A service account with an API token is refused; your own
OAuth sign-in is the supported path. When the sign-in expires, the banner returns with **Reconnect**.

## Let an agent post to Slack

Agents post only to channels you list, from the instance's Slack bot (never your account), each message headed
"*<Agent>* (AI agent)", with no @channel or @here. Two steps, both reviewed like any change:

1. Add the channel ids to `instance.yaml`: `settings: { slack_post_channels: [C0123ABCD] }`.
2. Grant the agent the tool: `slack_live: [slack_post]`.

Replies in the thread are read with the Slack read tools, using the post's `ts`.

## Habits that make it work

- One ask per message, with a deadline or a "done when" if it matters.
- When it is wrong, say so plainly ("too long", "already done", "wrong person"). Corrections are saved and drive
  improvement proposals.
- Early on, glance at what it did before trusting it to act more on its own (sending to people stays approve-first
  until approval rates are high).
