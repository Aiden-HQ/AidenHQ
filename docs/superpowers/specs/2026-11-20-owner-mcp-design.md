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

- **One origin.** The board's origin is both the resource (`/mcp`) and the issuer. The board passes a fixed allowlist
  through to the kernel's auth handler: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`,
  and `/oauth/{authorize,token,register,revoke}`. These are the only unauthenticated routes added. The kernel listener
  itself stays loopback, and every other route stays admin-only.
- **Authorization server:** the kernel's Better Auth with its MCP / OAuth provider plugin, pinned to a version at least
  seven days old that is compatible with `better-auth` 1.7.21. It provides:
  - metadata;
  - authorization code + PKCE (S256);
  - Client ID Metadata Documents first, and dynamic client registration for clients that still use it;
  - audience binding to `<board>/mcp` (RFC 8707);
  - refresh tokens and revocation.
- **Plugin spike first.** Build step 1 checks the plugin against `auth.db`, which the board's 3129 listener also opens:
  migrations, opaque or JWT tokens, audience binding, and revocation by account. If the plugin can't do this, stop and
  ask; do not hand-roll OAuth.
- **Authorize:** `/oauth/authorize` sends the browser through the existing sign-in (password and TOTP, admins only; the
  kernel page on its usual origin for the mode). Then one consent screen: "<client> wants to manage AidenHQ as you".
- **Discovery:** an unauthenticated `/mcp` gets `401` with `WWW-Authenticate: Bearer resource_metadata=...`.
- **Checking bearers:** a new kernel route, `POST /v1/auth/mcp`, returns `{ account, client, expires }` for a bearer
  whose audience is `/mcp`. Reads may use the board's 5 s cache. Every write re-checks without the cache that the grant
  is live and the account is still a ready admin (TOTP, not disabled), so revoking, demoting or resetting takes effect at
  once. A wrong-audience token is refused.
- **Token lifetime:** a 1 hour access token and a sliding 30 day refresh token.
- **Revoking:** the board's account page lists each MCP client (name, last used) with Revoke. Disabling or resetting an
  account revokes its grants.
- **Who:** every admin. Every admin is an owner (CLAUDE.md), so each signs in as themselves.
- **Request checks:** `/mcp` is bearer-only and never reads cookies. It keeps Host validation and refuses a request with
  an `Origin` that is not the board's own, per the transport spec.

**Which clients work in which exposure mode:**

| Exposure | Claude Code / Codex CLI on the owner's devices | Claude Desktop / claude.ai connectors (they call from Anthropic's cloud, so they need public HTTPS on 443) |
| --- | --- | --- |
| `public` (Caddy, 443) | yes | yes |
| `cloudflare` | yes | yes, once the generated ingress routes the board's host to the board, not only the app gate (`scripts/edge.ts`) |
| `tailscale` (default) | yes, from tailnet devices | no (say so on the setup page) |
| `local` (SSH tunnel) | yes, while the tunnel is up | no |

### Transport

- **Server:** the same SDK and mode as every server in the repo: `@modelcontextprotocol/sdk`, stateless Streamable HTTP
  with JSON responses, on the board's browser-facing listener at `/mcp`.
- **Spec version:** the builder confirms which protocol version the pinned SDK speaks and pins one that negotiates the
  current spec with Claude's clients.
- **Front door:** each exposure mode passes `/mcp`, `/oauth/*` and `/.well-known/oauth-*` through to the board. Caddy
  keeps stripping `x-aidenhq-*` headers.

### Tools

There are 14 tools. Each is a thin adapter over the board's existing route handlers, called in process (never over
HTTP). It runs inside the same request context the board installs before dispatch (account, plus `via: "mcp"`), so the
Paperclip wrapper's byline, pause's immediate stop and a settings change's apply record all behave exactly as a board
tap does (`services/board/src/app.ts` `routeApi`). Few route bodies need refactoring; a tool that would need more than a
small extraction is deferred, not forced. The server's `instructions` say: start with `status`; use
`ask` for anything that needs judgment or work; use `change_settings` for configuration; links in results open the board
for a human.

| Tool | Hint | What it does |
| --- | --- | --- |
| `status` | read | What needs the owner now: pending cards, needs-you tasks, failing apps, connections and generations, spend today against the cap, and setup still to do. On a fresh install with optional modules absent, it lists what is not set up yet with the `connect` link. The starting point. |
| `ask` | write | Message Aiden (default) or an agent by key, in a new chat or an existing one. Always returns the chat id. It waits up to `wait_seconds` (default 20, maximum 50, under Cloudflare's 100 s) for a reply; otherwise it says "still working: call get_task with this id". |
| `tasks` | read | Search and list tasks (bucket, assignee, state, text), paginated. |
| `get_task` | read | One task or chat: thread since a cursor, files, sub-tasks, linked cards. |
| `create_task` | write | A new task for an agent or for the owner, with a schedule or recurrence. |
| `update_task` | write | Comment, move, stop, hand over, schedule, settle or merge one task (`action` plus its fields). |
| `approvals` | read | Pending cards and recent outcomes (approved, rejected, stale): exact request, tier, digest, and the AI reviewer's explanation. A client that lost a response reconciles here. |
| `decide` | write | Approve or reject one or more cards, each by id plus the digest that was read, with an optional reason and optional `stale` (rejects only: a duplicate or dead card, which never counts as the owner's veto). Returns one outcome per card, so one conflict never hides a sibling's success. |
| `fleet` | read | Agents (roster, one agent's handbook, grants, scorecard, recent runs, paused state). |
| `modules` | read | Installed modules and the marketplace. For one module: its settings with current values and allowed values, its setup flow steps, and its sign-in state. |
| `change_settings` | write | The board's typed settings change, every type it already accepts (module on or off, agent model, effort, heartbeat and pause, caps, routines, rules, handbook, grants, pin, marketplace). It returns at once with the record id, its tier and its state (applied, with the reviewer, or waiting for a decision). Follow it with `approvals` or `status`. |
| `connect` | read | For a module's sign-in or setup flow: its state, and the board link that does it (`#/setup/<module>` or the sign-in's Connect). The human opens the link in a browser. Secrets and vendor OAuth never pass through the model. |
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
  is labelled `via: mcp` in the activity log and on the card outcome ("approved by Mudit via Claude"). The board's request
  context carries `via`; paths that don't record it yet show only the account, which is fine.
- **Deciding cards:** a new kernel route, `POST /v1/owner/decide`, takes the MCP bearer, derives `account:<id>` from the
  verified grant (never from the request body) and calls the existing
  `decideCard(id, digest, decision, by, "mcp", reason)`. The digest binds the decision to the exact request that was
  read.
- **Stale rejects:** these are recorded as `stale:account:<id>`. The stamp validator (`kernel/src/writes.ts`) admits it
  for rejects only, with the existing stale semantics (never a veto). That file is under the reviewer-eval gate, so this
  PR needs a passing eval receipt.
- **Owner authority (2026-11-20):** the owner's Claude may decide every card, Tier 2 included. The access rule changes
  from "cards are decided only on the kernel's pages or by channel token" to "... or by a signed-in admin's MCP
  token".
- **Settings changes:** these are records tiered as today. An owner change files and applies like a board change.

### Retiring channel-operator

Dropped with the module (owner, 2026-11-20):

- `modules/channel-operator` (the host `bin/decide`, `channel_operator_token`, the `operator_decide` limit setting and the
  `watcher` stamp). Decisions made from the owner's Claude now read "via Claude" under the account, instead of
  `watcher`.
- Removed in the same PR series (one way, no fallbacks), once the MCP is live. References to remove: `modules/marketplace.json`, `modules/README.md`, `docs/operations.md`,
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

- **One real end-to-end round trip** against the kernel's actual auth:
  - discovery (401, then the metadata);
  - client registration;
  - PKCE authorize with a test admin;
  - token;
  - `tools/list`;
  - `status`;
  - `change_settings`;
  - `decide` with a digest.
  
  Refused: a changed digest, a wrong-audience token, and a revoked grant.
- **Contract test:** each tool's result matches its `outputSchema`.

## Docs

- `docs/setup.md`: "Manage AidenHQ from your Claude", one command and the sign-in.
- `docs/design/access.md`: the new token type and the decide rule.
- `docs/architecture.md`: the MCP on the board.
- `CLAUDE.md`: the inbound rule for 3120/3121 and the decide rule.

## Calls made in review (Codex and builder check, 2026-11-20)

- Issuer is the board's origin with a fixed passthrough allowlist, so one URL works in every exposure mode.
- `connect` is browser-based, so no secrets or vendor OAuth go through the model.
- Writes return at once with an id; `ask` waits at most 50 s.
- Tools call the board's route handlers in process inside its request context, rather than extracting functions.
- Prompts, resources, progress streams and the Tasks extension are deferred until a workflow needs them.
- If the Better Auth plugin doesn't fit, stop and ask.

## Left to the builder

- Each tool's input and output schema.
- Which route handlers each tool composes.
- The front-door config per mode for the passthrough paths.
- Whether the plugin supports CIMD. If it doesn't, ship DCR now and add CIMD when the plugin does.
