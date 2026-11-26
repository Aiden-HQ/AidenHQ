# Agent and module pages

An owner sees and changes everything about an agent or a module from the board, without editing YAML: what it is, what
it works on, its settings, its handbook, and a way to talk to it. One page per agent and per module, linked both ways;
one place per thing. Code: `services/board/web/src` (`AgentPage.tsx`, `AgentSettings.tsx`, `AgentHandbook.tsx`,
`AgentGrants.tsx`, `AgentActivity.tsx`, `Modules.tsx`, `ModulePage.tsx`, `Marketplaces.tsx`) and `services/board/src`
(`agent-page.ts`, `agent-handbook.ts`, `agent-pause.ts`, `modules.ts`, `marketplace.ts`, `settings-change.ts`).

## Rules that bind

- **No second editor for a value** (caps are not editable on two pages), no instant save that bypasses review, no pending
  value shown as if live, no owner text silently rewritten on its way into the repo, and no capped list presented as an
  agent's complete history.
- **Every edit is an exact commit with no model in it,** filed as a kernel record: saved in the owner's signed-in board
  session it is his own approval, otherwise tiered by the existing rules (`kernel/src/apply-tier.ts`); see
  [settings-changes.md](settings-changes.md). Module install, update, remove and adding
  a marketplace follow the lean-core rules: AI review always first, an owner tap when the change adds authority.
- Board routes need a signed-in admin. Reuse the board's kit ([board-ui.md](board-ui.md)): no new visual language.
- One pending change per field: while one is in flight its editor shows the stage and offers Cancel; the live value stays
  visible until the change is live.

## Agents list (`#/team/agents`)

The table (Now / Next / Last, grouped by department) whose row expansion is a quick look with **Open page**, Chat and
Give it a task.

## Agent page

`#/team/agents/<key>[/overview|activity|handbook|settings]`. Header: avatar, name, status, what it does, source
(`<module> <version>` or "Your agent"), model and effort, reports to; actions Chat and Give it a task (a teammate only: they open its page, `#/team/<key>`), and a menu to
Pause/Resume (or pause and stop it now).

- **Overview:** needs you, ongoing and past tasks (paged, filterable; `GET /api/agents/by-key/<key>/tasks`, not the
  25-run window); each task opens the drawer, where the owner talks to the agent about that work.
- **Activity:** its jobs newest first, with what woke them, cost and the writes they filed (`GET .../timeline`).
- **Handbook:** Your rules, the main handbook, What it reads, History (below).
- **Settings:** rows that show the module default beside the instance value, each edit opening the preview-to-progress
  flow: model, effort, heartbeat, max parallel, routines (schedule, status, model), connection grants
  (per connection, the exact tools; null resets to the module's grant), and recent changes to this agent.

Pause is operational, not configuration: a signed-in admin pauses the agent in Paperclip (`POST .../pause`), logged as an
event, no commit.

## Modules

`#/team/modules` (Team's list) is a grid of tiles with a segmented **Installed**
(needs-you first, then chosen, then dependencies, core last) / **Available** / **All** and one search. A tile shows name,
state (On, Off, Always on, Needs setup, Security fix, or the in-flight stage), what it brings, why it can't be turned
off, and one action; the whole tile opens the module page. One action follows the module's state everywhere: Turn on,
then In review / Waiting for you, Applying, **Set up** (only when it has a setup flow that isn't done), Installed or
**Update to X**; a failed step shows its reason and Try again. A module declaring a setup flow shows "Then: <title>" while
available, and a "Needs setup" badge and **Set up** (later a quiet **Run setup again**) once installed
([guided-setup.md](guided-setup.md)).

- **On/off** is a toggle (green on, red off) on chosen tiles and the page header, showing the requested position dimmed
  until live. Turn-off edits `instance.yaml modules` through the same review; its dialog lists what stops (agents,
  routines) and what stays (tasks, data on disk), and is refused when another installed module requires it. Core modules
  and dependencies have no toggle. Purging data is separate.
- **Marketplaces:** each with source, pinned sha, module count, newer-version flag, Update; Add and Remove. A newer commit
  or a security advisory shows as a banner with Update. Browse data is read from the pinned shas; nothing newer than 7 days
  is offered (supply-chain rule).
- **Per-module pins:** an `instance.yaml modules` entry may be `{ id, sha }`; the loader resolves that module from its
  marketplace at the sha and the rest follow the marketplace pin. The page shows "Pinned at X" with **Follow
  marketplace**; the card warns that the combination was not tested together. Tiering is the module update rule.

### Module page

`#/team/modules/<name>[/overview|contents|settings|changes]`. Header: name, version, marketplace and tier, the one action, Turn
off. **Overview:** its agents and their ongoing work, what it may do (write kinds and tier, secrets), needs / needed by.
**Contents:** agents, connections, routines, apps, shared prompts, README. **Settings:** its `settings:` fields with
defaults. **Changes:** pending and past changes, with reviewed revert.

## Handbook

- **Your rules:** always editable; stored as `agents/<key>.md` (compiled under "Instance rules"; survives module
  updates). For a local (Architect-built) agent the box is its whole `modules/<name>/agents/<key>/AGENTS.md`, with no fork.
- **Main handbook:** read-only until **Edit main handbook**, which warns that it makes the instance's own copy and stops
  module handbook updates until **Update** (which replaces the edits, keeping Your rules).
- **Fork storage:** `agents/<key>/AGENTS.md` plus `overrides.agents.<key>.handbook_fork`; `scripts/handbook.ts
  readInstructions` reads the fork when that is set; Update is one commit removing both. The page shows "Forked", and when
  the module's file at the pin differs from the fork's base, "module has a newer version" with a diff.
- **What it reads:** the compiled handbook as the agent gets it. **History:** commits touching its handbook files and
  module bumps that changed it, each with a diff; instance commits get a reviewed **Revert**.
- Tiering: Tier 1. A fork or its edit is `role-handbook` when the agent holds a role, else `module-handbook`
  (`kernel/src/apply-tier.ts`); a handbook grants no authority.

## Typed changes

The board validates a typed change (`POST /api/settings/change`, kinds in `services/board/src/settings-change.ts`), files
it as the owner's task (held by him, off the board's columns) and hands it to the kernel (`kernel/src/settings-change.ts`)
with his board session, which checks both again and has the instance repo's code host write exactly the files the kind
allows (YAML through the `yaml` document API so comments survive, text verbatim) and file a `kernel.apply`, decided as his
account. The board shows the stage from the record. The Tier column is what a change without a board session (the MCP's
`change_settings`) gets.

| Kind | Writes | Tier |
|---|---|---|
| agent (model, reasoning_effort, heartbeat, max_parallel) | `overrides.agents.<key>` | 1 |
| caps | `overrides.agents.<key>.caps` | 2 |
| routine (schedules, model) | `overrides.routines.<key>` (pause and resume are the routine's live controls) | 1 |
| rules / handbook / unfork | `agents/<key>.md`, `agents/<key>/AGENTS.md` + `handbook_fork`, or a local agent's `modules/<name>/agents/<key>/AGENTS.md` | 1 |
| grants | `overrides.agents.<key>.connections.<id>` (merged per connection over the module's grants before grant resolution) | 1 for read; 2 when it adds write or destructive tools |
| setting | `settings.<key>` | 2 |
| module, pin | `modules` | per the lean-core module rules |
| marketplace | `marketplaces` | add 2; update and remove per the lean-core rules |

Anything that widens authority tiers as 2 through the authority diff, which compares compiled, effective grants, never a
special case.
