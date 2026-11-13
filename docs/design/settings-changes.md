# Changing settings from the board

The owner changes instance settings (a connection's URL, a kill switch, an agent's model, effort or heartbeat) from the
board's Settings pages instead of editing `.env` or `instance.yaml` by hand. Nothing new is privileged: the change still
lands as an instance-repo commit through the fleet apply card, tiered by the existing code.

## Where a value lives

- **Connection URLs are module settings.** `GLEAN_MCP_URL`, `GRAFANA_URL`, `GRAFANA_MCP_URL`, `CLICKHOUSE_MCP_URL` and
  `PRIMER_MCP_URL` were `.env` variables; they become `settings.glean_mcp_url` and the like, declared in each module's
  `module.yaml` and passed to compose as `${settings.<key>}` (Jira's `jira_url` already worked this way). They live in
  `instance.yaml` in the instance repo: in git, reviewable, reverted by a revert. Not a board-written file: nothing would
  apply it, and apply-config refuses a dirty checkout.
- A setting declares `type: url` (and optionally `host: "*.glean.com"`): the board shows a URL input for it and both the
  board and the compiler check the value (below). None of them is `required`, so a module compiles before it is set up.
- Secrets never go here. A URL that carries a credential is refused (no current connection needs one: each signs in with
  OAuth through its proxy). If one ever does, it belongs in the vault, not in settings.

## The check (services/shared/url-setting.ts, one copy for the board and the compiler)

`https:` only; no user or password; no `$` (the value lands in compose, which would expand `${SECRET}` into an outbound
URL); no whitespace or control characters; at most 500 characters; a public-looking host (a dotted name, not `localhost`,
not an IP literal), and the declared host pattern when there is one; no fragment; no query parameter whose name looks
like a credential (`token`, `key`, `secret`, `sig`, `password`, `auth`, `code`, `session`, `credential`). Other query
parameters stay allowed (Atlassian's default carries `?tools=all`). The board's check is for the owner's feedback; the
compiler's is the gate, since an agent writes the commit.

## The path

1. The owner (a signed-in admin) presses Save or Change on a Settings page. `POST /api/settings/change` (`requireAdmin`)
   takes a typed change: `{ setting, value }` for a declared, non-secret setting, `{ agent, field, value }` for the
   override fields tiers already treat as safe (`model`, `reasoning_effort`, `heartbeat`), `{ caps, agent, value }` for
   an agent's spend caps, or `{ module, name, on }` (the last two are Tier 2 like settings). The board checks it against
   the compiled config and the module catalog (the setting exists, the value is one of its `values`, a URL passes the
   check, the agent exists, the effort is a known level, the heartbeat is one of the compiler's hours and the agent is
   not runner-dispatched).
2. The board writes the task text itself, from the typed change (never free text), and files it as the owner's own task
   assigned to the Platform Engineer: the exact `instance.yaml` lines, "change nothing else". An owner-made task runs at
   once (the runner's `ownRequest`).
3. The Platform Engineer commits it on a `fleet/` branch of the instance repo. When its turn ends the runner shows the
   real diff and files the apply card, tiered by `services/runner/src/tiers.mjs` unchanged: a `settings` change is
   Tier 2 (the owner taps), an agent's `model` / `reasoning_effort` / `heartbeat` override is Tier 1 (the AI reviewer when
   autonomy is full, else the owner).
4. On approval the runner lands exactly that commit and runs `ops/apply-config.sh`: compile (the URL check again), then
   `docker compose up -d`, which recreates only the services whose environment changed (the one connection).
5. The board shows the change's progress from the task and its card (filed, waiting for approval, applying, applied or
   failed), then the connection's live status; for a sign-in connection, Connect becomes the next step.

## Why the Platform Engineer writes the commit

The runner could write the commit itself (deterministic, no model). That is a new code path that writes the instance
repo outside a task's own branch, for one benefit: removing a model from a two-line YAML edit whose result the owner (or
the reviewer, within the tiers that already allow it) sees as the exact diff before anything lands. The card is the gate;
the board's typed change only makes the request precise. If the Platform Engineer ever writes something else, the card
shows it and the compiler refuses a bad URL.

## Open points (from the architecture cross-check)

- **A changed URL keeps the old sign-in.** The proxies keep one token per connection; pointed at a new server they would
  send it there. The declared host patterns (`*.glean.com`, `*.grafana.net`, `*.clickhouse.cloud`, `mcp.atlassian.com`)
  bound that to the same vendor; Primer has none. Binding each stored token to the URL it was issued for (reconnect on
  a change) is the fix, in the proxies.
- **The compiler's check runs after the commit lands.** A bad value the owner approved anyway lands on main and fails
  the apply (revert to undo). A compile of the change before landing (in the runner's apply path) would stop it first.
- **Deterministic commits.** If the Platform Engineer ever drifts from the typed change, the runner can write the commit
  itself on the task's branch from the hidden typed change; the card and tiers stay as they are.
- DNS rebinding to private addresses is not checked (the URL is the owner's own input, approved on a card).

## The move from .env

Instances that set these URLs in `.env` move them once: put each in `instance.yaml` under `settings:` (in the same
commit as the product bump that brings this change), and remove them from `.env`. Until then that connection reads as
not set up.
