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
compiler's is the last gate.

## The path

1. The owner (a signed-in admin) presses Save or Change on a Settings page. `POST /api/settings/change` (`requireAdmin`)
   takes a typed change: `{ setting, value }` for a declared, non-secret setting, `{ agent, field, value }` for the
   override fields tiers already treat as safe (`model`, `reasoning_effort`, `heartbeat`), `{ caps, agent, value }` for
   an agent's spend caps, or `{ module, name, on }` (the last two are Tier 2 like settings). The board checks it against
   the compiled config and the module catalog (the setting exists, the value is one of its `values`, a URL passes the
   check, the agent exists, the effort is a known level, the heartbeat is one of the compiler's hours and the agent is
   not runner-dispatched).
2. The board files it as the owner's own task (label `settings-change`, no assignee, so no agent wakes), keeps the typed
   change in its own store by task id (for the page) and hands it to the kernel: `POST /v1/settings/change` with the
   board's key, `{ task, changes }`. Nothing reads the change from the task's text. If the kernel refuses it, the board
   cancels the task with the reason and the page shows it.
3. The kernel (`kernel/src/settings-change.ts`) checks the task (the owner's, made and held by no agent, open) and each
   change again against the compiled config and catalog: known kinds only, no unknown fields, schema-checked values, what
   it names exists, no free-form YAML. It computes exactly the files its kind allows (`PATHS`: `instance.yaml` edited
   through the yaml Document API, so comments stay; handbook texts verbatim) from the instance repo's main, read from its
   instance checkout. Turning off a module of the default bundle also lists it in `modules_removed` (so an upgrade never
   adds it back); turning it on takes it off that list.
4. The instance repo's code host writes those files as one commit on main's head, on `settings/<task>` (`apply.ts`
   `hostApply` routes by the repo: codehost-local's `write` for a `local/…` instance, codehost-github's
   `/aidenhq/v1/apply/write` otherwise), only while main is still the commit the kernel read.
5. The kernel files that commit as a `kernel.apply` on the task (requester `SETTINGS`, kind `kernel`, with no exemption in
   any rule), and its planner tiers it on its merits like any instance change (`kernel/src/apply-tier.ts`): a setting is
   the panel's, spend caps and quiet start are the owner's, an agent's `model` / `reasoning_effort` / `heartbeat`
   override is Tier 1, a module turned on or off or a grants override is judged by the module authority diff. On approval
   the code host lands exactly that commit and the apply runs `ops/apply-config.sh`.
6. The board shows the change's progress from the task and its apply record (filed, waiting for approval, applying,
   applied or failed), then the connection's live status; for a sign-in connection, Connect becomes the next step.

## Why code writes the commit

A model adds nothing to a typed edit and could drift from it; the kernel writes it deterministically from the change the
board handed it, and the card shows the exact diff before anything lands. The board's check is the owner's feedback; the
kernel's is the gate, and the compiler's the last.

## Open points (from the architecture cross-check)

- **A changed URL keeps the old sign-in.** The proxies keep one token per connection; pointed at a new server they would
  send it there. The declared host patterns (`*.glean.com`, `*.grafana.net`, `*.clickhouse.cloud`, `mcp.atlassian.com`)
  bound that to the same vendor; Primer has none. Binding each stored token to the URL it was issued for (reconnect on
  a change) is the fix, in the proxies.
- **The compiler's check runs after the commit lands.** A bad value the owner approved anyway lands on main and fails
  the apply (revert to undo). A compile of the change before landing would stop it first.
- DNS rebinding to private addresses is not checked (the URL is the owner's own input, approved on a card).

## The move from .env

Instances that set these URLs in `.env` move them once: put each in `instance.yaml` under `settings:` (in the same
commit as the product bump that brings this change), and remove them from `.env`. Until then that connection reads as
not set up.
