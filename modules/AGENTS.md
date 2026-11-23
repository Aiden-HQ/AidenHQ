# Building a module

The framework every official module follows, so all of them install, connect, look and behave alike. It is a short list on
purpose: each line links the rule's home, and [CLAUDE.md](../CLAUDE.md) "Conventions" still applies in full.

## The owner's experience

- **Quiet until the owner turns it on.** A module installs with nothing scheduled and no spend. Unconnected, it is an empty
  state that says how to connect, never an error or a failing check
  ([quiet-start.md](../docs/design/quiet-start.md), CLAUDE.md "Every owner, every new install").
- **Fewest steps to connected.** One Connect (a `board.signins` entry), module defaults for every fixed or discoverable
  value, and one inline field only for a genuinely per-install value (CLAUDE.md "A connection connects in one click").
- **A setup flow only when the owner must act elsewhere.** Use a `board.setup_flows` entry for something the owner makes
  first (an OAuth client, an app, a token, a bot), a channel to pair, or a mode to pick (`choose`, a setting with
  `values`) ([guided-setup.md](../docs/design/guided-setup.md), [configuration.md](../docs/configuration.md)).
- **Every mode, every surface.** A mode changes the Connect, status, setup help and secrets alike, with one test per mode
  from a fresh install to connected (CLAUDE.md "Modules with modes").

## Declare, and the board and the owner's Claude both drive it

- **Everything the owner configures is declared in `module.yaml`:** settings (typed, with `values` and a comment that
  explains them), `board.signins`, `board.setup_flows` and `providers.board`. The board draws them with its kit and theme
  ([board-ui.md](../docs/design/board-ui.md)). The owner's MCP reads and sets the same declarations
  ([design](../docs/superpowers/specs/2026-11-20-owner-mcp-design.md)), so a module adds no owner-facing code of its own.
- **Secrets go through a board field, never chat.** Declare each with `setup:`. The board stores it in the vault and the
  module reads it as a file.
- **A richer page is a module view.** When declarations can't express a page, a module ships it as a view in the MCP Apps
  format: a sandboxed HTML resource on the design system that calls only the module's own tools, so it works on the board
  and in the owner's Claude alike. No module has needed one yet; the first module that does builds the board's view host
  (owner, 2026-11-20). Board code stays the board's.
- **Every setting is explained.** Put a comment above each setting in `module.yaml`; it is the help the board and the MCP
  show. Add `pattern` for a value's shape, and `when` for a setting that applies only in one mode.
- **Every sign-in can be tested.** Its service answers `/auth/check` with ok, or what's wrong and how to fix it. The SDK
  proxy does this for you.
- **Setup can be changed later.** A finished setup flow reopens with its current choices; design it so that every step
  makes sense the second time.
- **Validate at the module.** A module whose values need more than a `pattern` declares a `validate` hook. The board and
  the MCP show its errors under the field.
- **A new building block goes in the schema, for every module.** Add it to `modules/board/schemas/` and the board, never to
  one module ([design](../docs/superpowers/specs/2026-11-20-module-primitives-design.md)).

## Connections are MCP servers

- **Build on the SDK's vendor proxy** (`kernel/sdk/src/vendor/proxy.ts`). The full upstream MCP passes through; tools are
  tagged read, write or destructive in `module.yaml`; the module adds hooks only
  ([configuration.md](../docs/configuration.md)). A first-party server uses the same SDK in stateless Streamable HTTP mode
  with `readOnlyHint` annotations (`modules/apps-platform/apps-mcp/src/main.ts`).
- **Not signed in still starts.** `/healthz` says whether it is connected, the tools it saw last stay listed, and every call
  says how to connect: never a crash loop, never a silently empty tool list. Health comes from the kernel, not board
  probes.
- **Grants decide access.** Any agent a tool is granted may use it ([CLAUDE.md](../CLAUDE.md) "One shared tools
  repository").

## Code

- **TypeScript, one way, one owner.** These are CLAUDE.md's "TypeScript", "One way to do each thing" and "One authority per
  concern". Behaviour that varies lives in the module, never as a kernel branch.
- **Agent behaviour is a module skill or prompt.** A handbook states the mission and links the skill (CLAUDE.md "Rules live
  in one place").
- **Gates.** A new non-security gate ships in observe mode. A module never touches the host firewall
  ([minimal-core-install.md](../docs/design/minimal-core-install.md)).
- **Apps a module owns** start from the app starter and the design system (`modules/apps-platform/`).

## Agent anatomy

Read this and [the spec](../docs/superpowers/specs/2026-11-22-agent-anatomy-design.md) before changing an agent, skill,
routine or memory.

- **Parts.** `module.yaml` declares the agents, routines, connections and grants. `agents/<key>/AGENTS.md` is the mission
  only; `skills/<name>/SKILL.md` is the how-to. An agent grants a connection as `connection: read|write|[tools]`.
- **Skills.** Each agent lists every skill it uses in `skills:`; the effective list is
  `(skills ∪ overrides.agents.<key>.skills.add) − overrides.agents.<key>.skills.remove`.
- **Moving work between agents** changes both agents' `skills:` lists and grants. The skill text stays where it is.
- **Routines** run on a schedule or on events: `event: { connection, resource, filter }`. The run reads its batch with
  `routine_events(batch)` (the kernel's `events.ts` queues and fires it). A connection adds an event kind by listing it in
  its `events: { kinds: [...] }` (modules/slack/module.yaml) and mapping the vendor event to a router event in its service
  (slack-live `map.ts` `toSourceEvent`, which sends the owner's `reaction_added` and `reaction_removed` for the task
  emoji); a routine's `filter.kind` then names it.
- **Memory** is the kernel's, one file per agent at `data/kernel/memory/agents/<key>.json`; the repo and the instance hold
  no memory files. An agent uses `memory_note`, `memory_forget`, `memory_read` and `memory_rewrite`.
- **Self-change.** An agent edits its own handbook, skill list, `library` skills and `library` routines with `self_change`;
  each change is a Tier 1 card.
- **Sharing.** The owner publishes a local module (`github.publish_module`): its `module.yaml`, agents' `AGENTS.md` and
  skills go out, memory never.

## Local modules

The owner's and the agents' own modules live in the instance repo, `modules/<name>/` (tier `local`), and the same compiler
loads them. One is always on: its folder enables it. Its `module.yaml` takes only `name`, `description`, `agents` and
`routines`; skills are `skills/<name>/SKILL.md`, found by folder. Every agent, module or local, lists the skills it uses in
`skills:`; nothing is selected implicitly. A local agent's identity is in `module.yaml` (its
`AGENTS.md` has no frontmatter), it has no roles, services, connections of its own, apps or privileged entries, and each
routine names the `agent` it runs as, with at most one schedule whose cron minute is one number. Its routines start active.
A routine may instead name an `event` (`{ connection, resource, filter }`, a non-empty filter): it runs for each batch of that connection's events, and a module's connection declares what it sends as `events:`. The agents' shared skills and routines go in one local module, `library`. ([configuration.md](../docs/configuration.md))

## Tests and docs

- **A few end-to-end tests** per package, run by its CI suite (`.github/ci/areas.json`; [README.md](README.md) "Test
  locally").
- **A README with one shape:**
  1. what the module does for the owner;
  2. how to connect it (or "nothing to connect");
  3. what it grants agents (its tools, read or write);
  4. what a new install sees (`New installs`).
