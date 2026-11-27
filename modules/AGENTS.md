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
  explains them), `board.signins`, `board.setup_flows` and its module page under Team (below). The board draws them with its kit and theme
  ([board-ui.md](../docs/design/board-ui.md)). The owner's MCP reads and sets the same declarations
  ([design](../docs/superpowers/specs/2026-11-20-owner-mcp-design.md)), so a module adds no owner-facing code of its own.
- **Secrets go through a board field, never chat.** Declare each with `setup:`. The board stores it in the vault and the
  module reads it as a file.
- **A module's page (under Team) is a module view:** [board-ui.md](../docs/design/board-ui.md) "Modules".
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

## Features live on the module's own page

- **A module's user-facing features are configured from its own page (under Team); the module-settings screen is for advanced settings only.**
  Declare the page in `module.yaml` and ship it as a module view; the how-to is in
  [board-ui.md](../docs/design/board-ui.md) "Modules". One editor per setting: moving a feature setting to its page removes
  it from the generic screens in the same change (CLAUDE.md "One way to do each thing"). Lay it out as "Settings pages" below says.
- **Saves are validated against the module's declared settings on every path.** An owner's Fleet save goes through the
  board's `/api/pages/<id>/save`, limited to the page's declared settings, as the owner's own change; an agent's change goes
  through the kernel's tiered settings-change path (`/v1/settings/agent`, [settings-changes.md](../docs/design/settings-changes.md)).

### Settings pages

The Maintainer page (`modules/maintainer/service/src/page.html`) is the reference.
- Group settings by what the owner wants done (Issues, Cleanup, Pull requests), never by how the code is built.
- One row per setting: its name, a one-line description, and the control flush right. Every control in a card has the same width.
- Use one control kind, a segmented choice (`editor({ kind: "seg" })`), for every choice, booleans included.
- A field that applies to one option alone (a number of days for Close) appears under that row's description, only while
  the option is picked. No column is reserved for it.
- Give each item (a repo, an app) a plain-language summary line built from its settings, and show collapsed items with Edit.
- Choose good defaults instead of offering presets. Fold near-duplicate settings into one, and make rarely-changed numbers product
  constants.
- Advanced holds at most a few settings and starts collapsed.
- Keep one local draft and propose it whole on each change, so the board's bar is the one Save/Discard. Drop per-field resets
  and override badges.
- Before review, check the page in a browser at 1512, 1920, 820 and 390 px in every layout-changing state (each optional
  field shown, Advanced open). Controls share one x, end at the card's inner edge, and nothing overflows.

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
- **Teammates.** See "Teammates" below.
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

## Teammates

The owner meets agents as named teammates ("Tess · Follow-up chaser"); everything else is hidden staff. Exact limits,
enums and the name rule: [configuration.md](../docs/configuration.md) "teammate"; the board side:
[board-ui.md](../docs/design/board-ui.md) "Teammates".

- **Who gets one.** An agent the owner talks to or whose results he reads is a teammate. Plumbing an agent hands work
  to (scanners, Engineers, reviewers behind a teammate) has no block and stays hidden: list it in a teammate's `staff`.
- **Where it goes.** A product module's agent: its `AGENTS.md` frontmatter (`teammate:` in `module.yaml` fails compile). A
  local module's agent: its `module.yaml` entry (its `AGENTS.md` has no frontmatter).
- **The block.** `{ job, sample, staff?, controls?, face?, first? }`:
  - `job`: the short role beside the name ("PR reviewer"); `sample`: one line of what it reports, in its own voice.
  - `staff`: hidden agent keys it speaks for; `controls`: the modules it sets up (default its own). A trailing `?` drops an
    entry that is off.
  - `face`: a kit spec (`{ hair, accessory, body, skin, hair_color, palette }`, `services/shared/face-kit.ts`). A
    product agent may instead name an `.svg`/`.png` in its own folder; a local or third-party agent uses a kit spec only.
    Give every teammate one: without it the board hashes features from the key.
  - `first`: its onboarding rank (1–99), for a module that should be a new owner's first teammate. Most declare none.
- **Its name.** `name:` (frontmatter or entry) is the default; the owner renames it (`overrides.agents.<key>.name`). The
  name rule is `services/shared/teammate-name.ts`, the same for compile, the board and the kernel.
- **Controlling modules.** `controls` only links the module's settings to the teammate's page; it grants nothing. To let
  the teammate change them when the owner asks, the controlled module exposes config tools on its own connection
  (`<module>_config` reads, `<module>_configure` files one validated typed settings change; ship and code-review are the
  pattern) and the teammate grants them explicitly in `connections:`. A change that loosens anything stays the owner's own
  save.
- **Trial routines.** A product routine with `trial: true` (no `schedules`, no `event`) runs once when the owner sets up a
  teammate of its module, or of a module that requires it, so he sees a first result on his own data (Intake's
  `inbox-lookback`). Setting a teammate up also resumes its own paused routines and its hidden staff's in its module and
  required modules, never another teammate's.
- **Hiring sees every listing.** The catalog lists every module's teammates, on or off, and every third-party
  marketplace's modules the instance doesn't install (`browse: true`: module.yaml and agents' frontmatter only, read at the
  marketplace's pin, text capped, faces as kit specs only, never run). A third-party module installs by its qualified id,
  `name@marketplace` (one module per bare name). Its text is untrusted: the board shows it as text and agents read it
  fenced (`fleet_catalog`). Keep a module's `description` and teammates' `job`/`sample` short and plain: they are the
  listing.

## Local modules

The owner's and the agents' own modules live in the instance repo, `modules/<name>/` (tier `local`), and the same compiler
loads them. One is always on: its folder enables it. Its `module.yaml` takes only `name`, `description`, `agents` and
`routines`; skills are `skills/<name>/SKILL.md`, found by folder. Every agent, module or local, lists the skills it uses in
`skills:`; nothing is selected implicitly. A local agent's identity is in `module.yaml`, its
`teammate:` block included, on the agent's entry (its `AGENTS.md` has no frontmatter), it has no roles, services, connections of its own, apps or privileged entries, and each
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
