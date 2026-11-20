# The AidenHQ MCP: run the whole instance from your own Claude

Status: design, awaiting the owner's approval (2026-11-20).

## Why

The owner wants to run AidenHQ by asking their own Claude (Claude Code, Claude Desktop, claude.ai, or any MCP client
such as Codex) instead of clicking through the board. Today everything an owner does goes through the board in a
browser or through a chat with Aiden. There is no token, no API for non-browser clients and no MCP for the owner. Ease
of use comes first: adding it should take one command and a sign-in, and an agent that has never seen AidenHQ should
know what to call from the tool list alone.

## Goals

- One remote MCP endpoint per instance, `https://<board>/mcp`, that an owner adds with
  `claude mcp add --transport http aidenhq https://<board>/mcp` (or a claude.ai connector) and signs in to once in the
  browser.
- Everything the owner does day to day: see what needs them, talk to Aiden or any agent, work tasks, decide approval
  cards, change settings (modules, agents, caps, routines, handbooks), connect services, check apps, fleet and costs.
- Tools follow current MCP practice: few, named for outcomes, with annotations, structured results, pagination and
  errors that say what to do next.
- One path per action: each tool calls the same board functions as the board's own routes, so the board UI and the MCP
  never drift.
- A module is manageable over MCP without writing MCP code: the tools read the same manifest points the board renders
  (settings, `board.setup_flows`, `board.signins`).
- It replaces `channel-operator` (owner, 2026-11-20).

## Non-goals

- A local or stdio package, or a pasted token (option B, not chosen).
- One tool per board route. About 110 routes would cost context in every session, and agents pick badly from long lists.
- Account administration (creating admins, TOTP enrolment, resets) and app access (`/access`). These need the person in
  a browser anyway, so they stay on the board.
- Agent-facing tools. Agents keep their own connections (`tasks`, `apps-mcp`, ...). This MCP is for the owner and the
  owner's other admins only.
- New gates. Writes keep their existing tiers. The MCP is just another way for a signed-in admin to act.

## Approaches considered

- **A. Remote `/mcp` on the board with OAuth sign-in (chosen).** Every major client supports this standard path, and the
  kernel's Better Auth already holds the accounts. The cost is an OAuth authorization server, which comes from the
  Better Auth plugin rather than our own code.
- **B. A local `npx aidenhq-mcp` with a pasted owner token.** Sign-in is simpler, but it never reaches claude.ai, adds
  a package to publish and version, and leaves token rotation to the owner.
- **C. Only "talk to Aiden" plus approvals.** This is the least code, but every change goes through an LLM run, so it is
  slow and imprecise. Owner-only acts (sign-ins, Tier 2 changes) would still need the board.

## Design

### Sign-in (OAuth 2.1)

- **Authorization server:** the kernel's Better Auth, with the `@better-auth/oauth-provider` plugin at the same version as
  `better-auth` (1.7.21, published 2026-11-11). It provides:
  - authorization-server metadata;
  - authorization code + PKCE (S256 only);
  - dynamic client registration, which Claude clients use today, plus Client ID Metadata Documents if the plugin supports
    them (the 2026-07-28 spec prefers them);
  - refresh tokens and revocation.
- **Authorize page:** the kernel's existing sign-in (password and TOTP; only an admin with TOTP), followed by one consent
  screen: "<client name> wants to manage AidenHQ as you."
- **Board:** serves `/.well-known/oauth-protected-resource` pointing at that issuer. An unauthenticated `/mcp` request
  gets a `401` with `WWW-Authenticate: Bearer resource_metadata=…`, as the spec requires.
- **Token lifetime:** the access token is short (1 hour) and bound to the `/mcp` resource (RFC 8707 `resource`); the
  refresh token slides like a session (30 days). The board checks each bearer with the kernel, the same way it checks
  session tokens today (`/v1/auth/session`, a 5 s cache), and gets back the account.
- **Revoking:** the board's account page lists each signed-in MCP client (name, last used) with a Revoke button. Disabling
  an account revokes its tokens.
- **Issuer origin:** whatever origin the board's sign-in handoff already uses for the current exposure mode. With
  Tailscale or an SSH tunnel, the MCP works from the owner's own devices (Claude Code, Desktop). claude.ai web and mobile
  need the `public` or `cloudflare` front door, because Anthropic's servers make the call. The setup docs say this
  plainly.

### Transport

- **Server:** the same SDK and mode as every server in the repo: `@modelcontextprotocol/sdk`, stateless Streamable HTTP
  with JSON responses. It is served on the board's browser-facing listener at `/mcp`.
- **Request checks:** `/mcp` is bearer-only. It never reads the cookie, so it skips the browser checks (`x-aidenhq-board`,
  same-origin) that exist to stop request forgery.
- **Front door:** each mode passes `/mcp` and the well-known path through to the board unchanged. Caddy keeps stripping
  `x-aidenhq-*` headers.

### Tools

There are 14 tools. Each is a thin adapter over a board function the SPA's route already uses: it parses arguments,
calls that function as the account, and shapes the result. The server's `instructions` say: start with `status`; use
`ask` for anything that needs judgment or work; use `change_settings` for configuration; links in results open the board
for a human.

| Tool | Hint | What it does |
| --- | --- | --- |
| `status` | read | What needs the owner now: pending cards, needs-you tasks, failing apps, connections and generations, spend today against the cap. The starting point. |
| `ask` | write | Message Aiden (default) or an agent by key, in a new chat or an existing one. Waits up to `wait_seconds` (default 60) for the reply; otherwise returns the chat id and "still working". |
| `tasks` | read | Search and list tasks (bucket, assignee, state, text), paginated. |
| `get_task` | read | One task or chat: thread since a cursor, files, sub-tasks, linked cards. |
| `create_task` | write | A new task for an agent or for the owner, with a schedule or recurrence. |
| `update_task` | write | Comment, move, stop, hand over, schedule, settle or merge one task (`action` plus its fields). |
| `approvals` | read | Pending and recently decided cards: exact request, tier, digest, and the AI reviewer's explanation. |
| `decide` | write | Approve or reject one or more cards by id and the digest that was read, with an optional reason and optional `stale` (a duplicate or dead card, which never counts as the owner's veto). |
| `fleet` | read | Agents (roster, one agent's handbook, grants, scorecard, recent runs, paused state). |
| `modules` | read | Installed modules and the marketplace. For one module: its settings with current values and allowed values, its setup flow steps, and its sign-in state. |
| `change_settings` | write | The typed settings change (module on or off, agent model, effort, heartbeat and pause, caps, routines, rules, handbook, grants, pin, marketplace). Returns the record, its tier and the outcome when it finishes. |
| `connect` | write | Start a service sign-in and return the URL (or device code) for the human to open, paste a secret a setup flow asks for, or check a sign-in's state. |
| `apps` | read | Apps and their health, deploys and incidents. |
| `costs` | read | Spend by agent, day and feature. |

Tool conventions, which also go into the module guidelines:

- **Names:** verb or noun names with no prefix. Clients namespace them as `aidenhq`.
- **Results:** short human text plus `structuredContent` with an `outputSchema`.
- **Pagination:** lists take a `cursor` and return `next_cursor`.
- **Errors:** an error names the fix ("card A-123 changed since you read it: call approvals again").
- **Annotations:** read tools set `readOnlyHint: true`; `decide` and `change_settings` set `destructiveHint: true`.
- **Agent words are data:** results carry agent-authored and external text fenced as data (the existing fence), so the
  owner's Claude sees it as content, not instructions.

### Writes, approvals and stamps

- **Acting as the account:** every write runs as the signed-in account (`account:<id>`), exactly as a board tap does, and
  is labelled `via: mcp` in the activity log and on the card outcome ("approved by Mudit via Claude").
- **Deciding cards:** `decide` calls the kernel's existing `decideCard(id, digest, decision, by, "mcp", reason)` through
  a new bearer-authenticated kernel route. The digest binds the decision to the exact request that was read.
- **Owner authority (2026-11-20):** the owner's Claude may decide every card, Tier 2 included. The access rule changes
  from "cards are decided only on the kernel's pages or by channel token" to "... or by a signed-in admin's MCP
  token".
- **Settings changes:** these are records tiered as today. An owner change files and applies like a board change.

### Retiring channel-operator

Dropped with the module (owner, 2026-11-20):

- `modules/channel-operator` (the host `bin/decide`, `channel_operator_token`, the `operator_decide` limit setting and the
  `watcher` stamp). Decisions made from the owner's Claude now read "via Claude" under the account, instead of
  `watcher`.
- References to remove: `modules/marketplace.json`, `modules/README.md`, `docs/operations.md`,
  `.github/ci/areas.json`, `scripts/lean/parity.json`, `kernel/test/channels.test.ts`.
- Operator scripts that used it (`~/decide.sh`, `~/approvals.sh` on the host) are replaced by the MCP from the
  operator's Claude Code.

Kept: stale rejects (`decide` with `stale: true`, recorded as `stale:account:<id>`, never counted as a veto) and the
channel token path for Telegram and Slack, which is unchanged.

### Modules and MCP

The tools are generic over manifests, so a module gets MCP management by declaring its settings (with `values`),
`board.setup_flows` and `board.signins`. It never needs a board-only screen. The module guidelines (the follow-up
task) state this as the rule: anything an owner configures is declared in `module.yaml`, never only in UI code.

## Tests

- **One end-to-end test:** a fake kernel issues a token; an MCP client lists the tools, calls `status`, files a
  `change_settings`, and `decide`s a card with its digest. A stale digest and a revoked token are refused.
- **Contract test:** each tool's result matches its `outputSchema`.

## Docs

- `docs/setup.md`: "Manage AidenHQ from your Claude", one command and the sign-in.
- `docs/design/access.md`: the new token type and the decide rule.
- `docs/architecture.md`: the MCP on the board.
- `CLAUDE.md`: the inbound rule for 3120/3121 and the decide rule.

## Left to the builder

- Exact board functions to share. Extract the handler bodies the SPA routes call so that the route and the tool both
  call one function. Never call the board's own HTTP routes from inside it.
- The kernel route shape for bearer-checked decide and token introspection.
- How each front-door mode routes `/mcp` and `/.well-known/*`.
- Whether the plugin supports CIMD. If it doesn't, ship DCR now and add CIMD when the plugin does.
