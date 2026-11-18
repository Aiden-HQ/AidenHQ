# Agent and module pages

Status: design, approved pending (2026-11-17). Mockups: brainstorm session v1/v2 (throwaway, not in the repo).

## Why

An owner should be able to see and change everything about an agent or a module from the board, without editing YAML
or asking an agent to do it: what it is, what it is working on and has done, its settings, its handbook, and a way to
talk to it. Today that is spread over Settings → Agents and models, Settings → Modules, Settings → Spend, the Agents
row expansion and the chat sidebar, and most of it (handbooks, routines, grants, installs) cannot be changed from the
board at all. This makes creating, running and managing agents easier for any owner, which is the product's goal.

## Goals

- One page per agent and one per module, linked both ways; one place per thing.
- The agent page leads with what it does and its work: needs-you, ongoing and past tasks, each opening its own thread.
- Change model, effort, wakes, routines, caps, connection grants, pause, the owner's rules and the handbook itself.
- Modules: list installed, browse marketplaces, install, update, turn off, add a marketplace.
- Every edit is an exact, reviewable commit that reaches review in seconds.

## Non-goals

- A memory editor, an eval builder, cloning an agent ("Create an agent like this" can later seed the Architect chat).
- Per-agent autonomy (shown as "Fleet default" until a kind for it exists).
- Changing what the tiers decide. New edit kinds map onto the existing tier rules.

## Anti-goals (failure even if it works)

- A second editor for the same value (e.g. caps editable on the agent page and on Settings → Spend).
- Instant saves that bypass review, or a page that shows a pending value as if it were live.
- Owner text silently rewritten on its way into the repo.
- Presenting a capped list (the fleet's 25 recent runs, two weeks of changes) as an agent's complete history.

## Constraints

- Gates in code (CLAUDE.md): every edit is an instance-repo commit filed as a kernel record and tiered by
  `services/runner/src/tiers.mjs` / `kernel/src/tier.ts`. Module install, update, remove and adding a marketplace follow
  the lean-core rules: AI review always first; owner tap when the change adds authority (write kinds, secrets, roles,
  privileged entries, a marketplace, write/destructive grants).
- Board routes need a signed-in admin. Board build: `tsc -p tsconfig.build.json`.
- Agents and Modules are top-bar tabs (owner: the marketplace deserves a first-class link). Settings → Modules goes away; `#/settings/modules` and the old `#/modules` alias open the Modules tab; it sits right after Agents. Other configuration stays behind Settings.
- Reuse the board's components and styles: `settings.css` rows (`st-row`), `ChangePreview` / `ChangeProgress`, the
  fleet table, the task drawer, `LaneChat` / chat. No new visual language.

## Approaches considered

**Pages.** (a) One combined module/agent page: rejected; a module has 0..N agents and Architect-built agents have no
module. (b) Agent page and module page, linked: **chosen**.

**Where work shows.** The first draft had separate Tasks and Activity tabs. The owner folded both into the agent
Overview: tasks are how you see an agent's work; runs live inside tasks; changes show where they were made.

**Write path.** (a) Keep today's path, the Platform Engineer turning a typed change into a commit: an agent run and
minutes per edit, and long owner text passes through a model. (b) Code writes the commit for text, agent for config:
two paths. (c) **Chosen (owner):** code writes the exact commit from the typed change, no model, then files the same
card. This reverses the "Why the Platform Engineer writes the commit" section of `settings-changes.md` (update it): that
reasoning held for two-line YAML edits, not for handbook text and a dozen kinds.

**Handbook editing (owner).** Both a "Your rules" box and an opt-in fork of the main handbook (below).

## The pages

### Agents list (`#/agents`)

Keeps today's table (Now / Next / Last, department grouping, Platform and Your agents). The row expansion becomes a
quick look: needs-you, this week (done, sent back, cost, sparkline), today's spend against the day cap, model and
source module, and buttons **Open page**, Chat, Give it a task.


### Agent page (`#/agents/<key>[/<tab>]`)

Header: avatar, name, status pill, one line: what it does · source (`<module> <version> (<marketplace>, <tier>)` or
"Your agent") · model and effort · reports to. Actions: Chat, Give it a task, Pause/Resume.

Tabs:

- **Overview**
  - Needs you (tasks waiting on the owner), Ongoing (working, queued), History (done and failed, filters, search,
    paged). Each row opens the task in the existing drawer (`#/t/<ID>`), whose thread is where the owner talks to the
    agent about that work; run traces and cost stay in the drawer.
  - Lower: this week (scorecard), corrections (what the owner marked not right, what changed: Coach evidence and the
    resulting handbook change).
- **Chats**: the agent's general chats (not tied to a task) and New chat; reuses the chat views.
- **Handbook**: Your rules, main handbook, What it reads, History (below).
- **Settings**, grouped as rows; each shows the module default beside the instance value with Reset to default, and an
  edit opens the existing preview → progress flow:
  - How it thinks: model, effort.
  - When it works: heartbeat; routines (schedule, timezone, status, model; instructions where the routine is the
    instance's).
  - What it may touch: per connection, the exact tools with read / write / destructive; sign-ins link to
    Settings → Connections.
  - Limits: spend caps (moved here from Settings → Spend, which keeps fleet defaults and pending raise cards);
    autonomy (read-only "Fleet default" for now); Paused.
  - Recent changes to this agent, with their stage.

Pause asks what to do with a running task: let it finish, or stop it now.

### Modules (`#/modules`), a top-bar tab

- **One page of tiles**: every module as a tile in a grid that adds columns as the screen grows. A segmented control
  shows **Installed** (what needs you first, then what you chose, then dependencies, the core last), **Available** or
  **All**, and one search covers both. A tile shows its monogram, name, state as a dot and a word (On, Off, Always on,
  Needs setup, Security fix, In review / Waiting for you / Applying, Change failed), its description, what it brings
  (agents, connections, routines, apps, a pin), why it can't be turned off (core, or needed by another), a third-party
  module's marketplace and tier, and one action. The whole tile opens the module's page.
- **Turn on** (an available module) opens a card with what it adds, what it needs and whether the owner's tap will be
  needed, then **Turn on** files the change.
- **Marketplaces**: a button in the header opens them: each with source, pinned sha, module count, newer-version flag
  and Update; Add marketplace (a repo URL); Remove. A newer marketplace commit or a security advisory shows as a banner
  on the Modules page with **Update**.

A module's one action button follows its state everywhere it is listed (Browse, Installed, the module page header):
**Turn on** → In review / Waiting for you → Applying → **Set up** (only if it has a setup flow that isn't done) →
Installed (or **Update to X** when one is available). A failed or rejected step shows its reason and **Try again**.

**Install** edits `instance.yaml modules` (adds the name, or `{ name, sha }`); the card is the lean-core install card.
**On / off is a toggle** (owner: green when on, red when off) on each installed tile you chose and in the module page header; the label next to it reads On or Off. Switching it off ("Turn off") removes it from `modules` through the same review. Its confirm dialog lists what stops (its
agents and routines), what stays (their tasks; its data on disk, so turning it back on resumes) and is refused, with the
reason, when another installed module requires it. Core modules and dependencies show no toggle. While a change is in review the toggle shows the requested position, dimmed, with its stage beside it; it settles only when the change is live. Deleting a module's
data for good is a separate, explicit purge, not part of this work.

**Setup flows** come from `docs/design/guided-setup.md` (other work): a module's `setup_flow:` block, compiled into the
catalog; the board opens it at `/setup/<module>`; `GET /api/setup-flows` lists installed modules whose flow isn't done
(done = the module's real connection status). These pages only trigger it:
- An available module's tile shows "Then: <flow title>" when it declares a flow.
- Installed rows and the module page show **Set up** (primary) and a "Needs setup" badge while the flow isn't done;
  afterwards the module page keeps a quiet **Run setup again**.
- When an install goes live while the owner is still on the Modules page or that module's page, the board opens its
  setup flow automatically (owner's call); otherwise the Set up button waits.

### Module page (`#/modules/<name>[/<tab>]`)

Header: name, version · marketplace · tier, one-line description; one action button (Install, Set up, Update to X; see above) and Turn off.

- **Overview**: its agents (linking to agent pages), then the ongoing work of all its agents (same task rows), then
  what it may do (write kinds and their tier, secrets), needs / needed by, and what turning it off does (agents that
  stop, tasks kept, data kept on disk).
- **Contents**: agents, connections (status, link to Connections), routines, apps, shared prompts (viewable), README.
- **Settings**: its `settings:` fields, with defaults and the same edit flow.
- **Changes**: pending and past changes to it (install, updates with diff, settings), reviewed revert.

## Handbook editing

- **Your rules**: always editable. Stored as the existing instance addition `agents/<key>.md` (compiled under
  "## Instance rules"); survives module updates. For an instance (Architect-built) agent the box is its whole
  `agents/<key>/AGENTS.md` and there is no fork.
- **Main handbook**: read-only. **Edit main handbook** opens a warning: editing makes the instance's own copy; the agent
  stops getting handbook updates from its module until the owner presses **Update**, which replaces the edits with the
  module's version (Your rules kept); put lasting preferences in Your rules. The editor unlocks only after the owner
  accepts.
- **Fork storage**: `agents/<key>/AGENTS.md` in the instance repo plus `overrides.agents.<key>.handbook_fork: <module
  blob sha it was copied from>`. `scripts/handbook.mjs readInstructions` reads the fork instead of the module's file when
  that override is set. **Update** = one commit removing both. The page shows "Forked" and, when the module's file at
  the current pin differs from the fork's base, "module has a newer version" with a diff.
- **What it reads**: the compiled handbook exactly as the agent gets it (the existing instructions-bundle GET), with each
  part labelled by source.
- **History**: commits touching the agent's handbook files (instance repo) and module bumps that changed its module
  handbook; each with a diff; instance commits get a reviewed **Revert**.
- Tiers: unchanged rules in `tiers.mjs` (`role-handbook`, `agent-handbook`, `module-handbook`, `trial-handbook`);
  creating a fork is a handbook change of the same tier.

## The write path

1. The board takes a typed change (`POST /api/settings/change`, extended), validates it against the compiled config and
   catalog as today, and passes it to the runner (not a Platform Engineer task).
2. The runner, in its instance-repo cache clone, writes exactly the files the typed change names on a `fleet/` branch
   (YAML edits through the `yaml` document API so comments survive; text files verbatim), commits with the owner as
   requester, and files the apply card through its existing card path, so the diff, tiering, review, apply and
   progress reporting are unchanged.
3. The board shows the stage from the record (Filed → Prepared → AI review / Your tap → Applying → Live, or rejected /
   failed with the reason) and keeps the live value visible until it is live.

Typed change kinds (each: the files it may touch, nothing else; the runner refuses anything outside them):

| Kind | Writes | Tier (existing rules) |
|---|---|---|
| agent field (model, reasoning_effort, heartbeat, timeout_sec) | `instance.yaml overrides.agents.<key>` | 1 (`OVERRIDE_SAFE`) |
| caps | `overrides.agents.<key>.caps` | 2 |
| routine (schedules, status, model) | `overrides.routines.<key>` | 1 |
| routine instructions (instance routines only) | the routine's file | 1 |
| rules | `agents/<key>.md`, or `agents/<key>/AGENTS.md` for an instance agent | handbook rules |
| fork / edit fork / update (unfork) | `agents/<key>/AGENTS.md` + `overrides.agents.<key>.handbook_fork` | handbook rules |
| grants | `overrides.agents.<key>.connections` (new override field) | 1 for read, 2 when it adds write/destructive |
| setting | `settings.<key>` | 2 (as today) |
| module on/off, install, update, remove, follow marketplace | `modules` (bare name or `{ name, sha }`) | lean-core §5.7 table |
| marketplace add/update/remove | `marketplaces` | add = 2; update/remove per §5.7 |

New override fields (`handbook_fork`, `connections`) need the compiler and `tiers.mjs` to accept them; anything that
widens authority must tier as 2 via the existing authority diff, not by a new special case.

Pause/Resume is operational, not configuration: it uses the same mechanism as Settings → Kill switches (Paperclip agent
pause) as a signed-in admin action, logged as an event; no commit.

## Data the board needs (new routes, all admin)

- `GET /api/agents/:key`: one view joining roster, settings view (with module defaults), grants (tools per connection
  and class), scorecard, source module and version, fork state.
- `GET /api/agents/:key/tasks?state=needs|open|done|failed&q=&cursor=`: Paperclip issues by assignee (and, for
  runner-dispatched agents, the runner's own), newest first, paged. Not built on `activity.ts`'s 25-run window.
- `GET /api/agents/:key/handbook`: main (module file at the pin, or fork), rules, compiled text, fork base and whether
  the module moved on; `GET .../handbook/history`.
- `GET /api/modules` extended with the catalog's connections, routines, apps, settings, revision, source, README, write
  kinds and secrets; `GET /api/modules/:name`; `GET /api/marketplaces` (entries of every configured marketplace at its
  pin, with what each would add).
- `GET /api/settings/changes?agent=|module=`: changes filtered to one subject, beyond the two-week window when asked.

## Build order (each a PR, usable on its own)

1. Agent page, read-only: routes, `GET /api/agents/:key` and `/tasks`, Overview, Chats, the Agents quick look and
   links. Settings → Agents and models redirects to the agent pages.
2. The runner's typed-change writer; move today's kinds onto it; agent Settings tab (model, effort, heartbeat, caps,
   routines, pause). Settings → Spend loses per-agent caps.
3. Handbook tab: rules, fork / update, What it reads, History, revert.
4. Per-module pins in the loader and compiler; modules list and module page: Installed, Overview, Contents, Settings,
   Changes, update (per module) and turn off.
5. Browse, install, marketplaces.
6. Connection grants per agent.

## Calls settled after the builder check (designer's calls, open to the owner's correction)

- **Fork tier.** `tiers.mjs` gains one accepted shape: a module agent's `agents/<key>/AGENTS.md` together with its
  `handbook_fork` override, tiered by the same rule as that agent's handbook additions (`role-handbook` when it holds a
  role, else `module-handbook`; both Tier 1). No new tier, no authority-diff change: a handbook grants no authority.
- **Module and marketplace tiering** is what the code already does: `tiers.mjs moduleAuthorityParts` and
  `kernel/src/loader/authority.ts` (`classifyModules`, `marketplaceChanges`), from the lean-core spec §5.7 (instance repo,
  `docs/product-history/superpowers/specs/2026-11-16-lean-core-design.md`). Install, turn off and remove are edits of
  `instance.yaml modules`; no new tiering step. The install card's "what it may do" preview is computed by the same
  authority classifier, run on the would-be `instance.yaml` before filing.
- **Per-module pins (owner).** A module can move ahead of (or stay behind) its marketplace: an `instance.yaml modules`
  entry may be `{ name, sha }` instead of a bare name. The loader resolves that module's folder from its marketplace
  repository at that sha (the marketplace's own `marketplace.json` still names the folder); every other module keeps
  following the marketplace pin. A marketplace update leaves pinned modules where they are. The module page shows
  "Pinned at 2.4 · marketplace at 2.3" with **Follow marketplace** (removes the pin) and **Update** (pins the newest
  allowed version of just that module). The card says when the pinned version differs from the marketplace's, since that
  combination was not tested together. Tiering is the existing module update rule (§5.7: AI review, owner tap for new
  authority). This is loader and compiler work (`kernel/src/loader/sources.ts`, `scripts/modules.mjs`) and lands with
  build step 4.
- **Browse data** is read where compile already reads marketplaces (the loader's sources, `kernel/src/loader/sources.ts`,
  with its credentials), at each marketplace's pinned sha, plus the newest commit for "newer version" when the source
  allows it. Nothing newer than 7 days is offered (the supply-chain rule).
- **Grants override** (`overrides.agents.<key>.connections`) merges per connection key over the module's grants and is
  applied before grant resolution in `scripts/modules.mjs` (today overrides land after `delete a.connections`, so this
  moves). Reset to default removes that connection's key. The authority diff compares compiled, effective grants, so
  adding write or destructive tools tiers as 2 without a special case.
- **Tasks by agent** come from one source: Engineer (runner-dispatched) work is Paperclip issues too, so the route lists
  issues by assignee with Paperclip's own paging.
- **The record container.** A typed change still creates an owner-authored `settings-change` task (as today), but no
  agent runs on it: the runner picks it up, writes the commit on its `fleet/` branch and files the card on that task.
  The board's stage display keeps reading the task and card. Writes to the instance clone are serialised by the
  runner's existing instance-repo lock.
- **One pending change per subject field.** While a change to a field (or a handbook file) is in flight, its editor shows
  the change's stage and offers Cancel; a new edit waits until it is live, rejected or cancelled.
- **Pause** is immediate, not a commit: the board pauses the agent in Paperclip as a signed-in admin and logs it as an
  event. Setup must keep a paused agent paused (check `paperclip-setup.mjs`; preserve the status if it resets it).
  "Stop it now" uses the existing stop for that kind of work (chat stop for Paperclip runs, clearing the recovery hold
  per the Paperclip quirk; the runner's cancel for Engineer jobs).
- Routine `autonomy` stays out of the routine kind (not an owner edit on these pages for now).

## Left to the builder

- Exact component split and file names; reuse over new components.
- The runner endpoint's shape (it already files cards; keep the board → runner hop the only new one).
- How the marketplace browse data is fetched and cached (it reads pinned shas only; no background refresh of code).
- Empty, loading and phone layouts, following the existing pages.
- Minimal tests: the writer refuses files outside a kind; a fork round trip (fork, edit, update) compiles; tasks-by-agent
  paging.
