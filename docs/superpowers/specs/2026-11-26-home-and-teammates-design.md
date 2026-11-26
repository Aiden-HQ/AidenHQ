# Home and named teammates: the board overhaul

Status: designed with the owner 2026-11-26; owner delegated the build and deploy. Mockups (final row):
https://claude.ai/artifact/5W74qBdVvMKcWh8BXcLJXB (the HTML sources and renders go to builders as files).

## Why

People who install AidenHQ find Aiden hard to use, don't know what it can do, and feel overwhelmed. The board opens
on a chat screen and lists raw agents and modules. The fix is not more features: it is a home that shows what needs
you and what your team did, a team of named teammates you can understand at a glance, and onboarding that gets one
real result fast while showing everything Aiden can bring in.

## Goals

- A new user sees, within a minute, everything Aiden can do, and gets one real result on their own data.
- A running user opens Home and sees what needs them (answerable in place), what happened since they last looked,
  their world (who they wait on, today's meetings, what they promised), and which teammates did something new.
- Every user-facing capability has one named teammate (face, name · role) you talk to and control by chatting;
  plumbing agents are hidden.
- Hiring a teammate checks the team and the installed marketplaces first; Archie builds only when nothing fits.
- Onboarding sets up push delivery (Telegram or Slack) with a test message.
- One design system in the board UI kit, so every page (and module pages) looks this good.

## Non-goals

- Mission control on Home (agent grids, run counts, cost charts): stays on Team › All agents and Insight.
- Per-teammate trust controls (asks first vs acts) and per-screen error/connecting states beyond the kit's
  defaults: later.
- The "what eats your week" onboarding question (dropped by the owner).
- Redesigning module pages other than giving them the shared kit (a deeper pass, starting with code review, follows).

## Anti-goals

- A wrapper agent that relays to another agent (two agents per capability). The persona is the agent.
- A second home, a second chat path, or a fallback to the old Chat tab. One way.

## Decisions (owner, fixed)

1. Home is the landing page. Order: Needs you (answered in place; row click opens a detail pane) beside Since you
   last looked + one Idea; then Your world; then Your team (only teammates with something new).
2. Chat is secondary: no Chat or Approvals tab. Top bar: Home (needs-you badge) · Tasks · Apps · Team · Insight,
   Search ⌘K, Ask Aiden ⌘J (right side panel), Settings. Approval deep links (`#/approvals/<id>`) keep working.
3. Teammates: a module defines user-facing (named) and hidden agents. Hidden agents never talk to the user; rarely
   they reach the user through the chief of staff. A teammate can combine several modules.
4. Users name teammates; defaults are suggestions: Aiden (Chief of staff), Tess (Follow-up chaser), Nora (Meeting
   notes), Max (PR reviewer), Sam (Release manager), Mia (Repo maintainer), Iris (App builder), Archie (Agent
   Architect), Vik (Security), Rhea (Researcher). Shown everywhere as "Name · Role".
5. Faces: a module may ship its own face; otherwise a rich parametric SVG face from the kit (also for Archie-built
   teammates). Faces show state: idle, working (eyes move, green dot), needs you (brows up, amber ring).
6. Hiring: describe → look in your team and installed marketplaces → extend/install is a short path (confirm +
   connect) → only "build new" goes to Archie's proposal → name → trial run.
7. Onboarding: start with ONE teammate (Tess by default) with the whole roster visible below ("Everyone Aiden can
   bring in", Set up next / Later); then "Where should your team reach you?" (Telegram recommended, Slack DM, only
   this board) with Send a test; then Home on day one. Set up the rest one by one.
8. Aiden owns inbox triage (Intake is Aiden's hidden staff).
9. Layout is wide (content up to 1920px), fluid at 1512/1920/2560 and 390, animated (one motion vocabulary, reduced
   motion respected), polished.

## Approaches considered

- **A. Teammate = a real agent marked user-facing in its module (chosen).** Existing agents get a role and a default
  name; two thin new agents fill gaps. One agent per capability, no relay hop, the module format carries it, the
  Architect builds teammates as local modules the same way.
- B. A persona layer on top of agents (a mapping in the board or a wrapper agent). Faster to add, but two names for
  one thing, an extra model hop and drift between the mapping and the fleet. Rejected (one way).
- C. Keep agents as they are and only restyle the board. Doesn't fix "overwhelming": users would still meet ~20
  agents and 50 modules.

## Design

### 1. Teammates in the module format

- **User-facing marker.** An agent is a teammate when it declares a `teammate:` block: `{job, sample, staff,
  controls, face}` (`job` is the short "PR reviewer" line; a separate word from Paperclip's `role` and the
  authorization `roles`). Product modules: the block in the agent's AGENTS.md frontmatter; local modules: in the
  module.yaml agent entry (add to `LOCAL_AGENT_FIELDS`). No block = hidden. Compile validates it (staff keys exist,
  controls name installed modules, `face` is a file inside the agent's own folder) and carries it into the compiled
  agent, the Paperclip metadata (`display()`), `fleet_catalog`, the catalog (`config/modules.json` keeps the
  `agents` key array for its consumers and adds `teammates: [{key, name, job, sample, description}]`) and the board
  roster (`RosterAgent.teammate`).
- **Hidden agents.** No `role`: not in Team, hiring, @-mentions, Ask Aiden or Home; still in Team › All agents
  (advanced) and in a teammate's collapsed "Team behind <name>" (the hidden agents of the same module(s)). A hidden
  agent that must reach the owner does it through `notify` (owner-channel), as today; handbooks say so.
- **Names.** `name:` stays the default name. Add `name` to `OVERRIDABLE.agents` (instance.yaml
  `overrides.agents.<key>.name`) so a rename survives every apply (`agentBody` already reads `a.name`); add an agent
  `name` field to the board's settings change (`kind: agent`), validated in board and kernel (1–24 chars, unique
  among teammates case-insensitively so `@name` stays unambiguous). Routing stays on keys and descriptions, so a rename breaks
  nothing; handbooks refer to teammates by key or role, never by default name (grep and fix).
- **Faces.** `face:` in frontmatter (or the local agent entry) names a file in the agent's folder (SVG or PNG, ≤200
  KB). Compile copies it to `config/faces/<key>.<ext>`; the board serves `/api/faces/<key>` and the roster carries
  `face` (url or null). The bundled `public/crew/*.svg` portraits move into their modules as `face:` files (the old
  `avatar:` field and `/crew/` path are deleted). No face: the kit's parametric face, seeded by the agent key (stable
  across renames), with a palette and features chosen from the seed. State is drawn by the kit for parametric faces
  (eyes, brows, ring, dot) and by an overlay (ring + dot) for shipped faces.
- **Roster (mapping, defaults).**

  | Teammate | Agent key (module) | Change |
  |---|---|---|
  | Aiden · Chief of staff | chief-of-staff | role; owns inbox triage (Intake hidden behind him) |
  | Tess · Follow-up chaser | open-loops | rename default, role |
  | Nora · Meeting notes | new `meetings` agent (meetings) | new thin agent: owns meeting notes and actions; the Researcher's meeting-scan routine moves to her |
  | Max · PR reviewer | reviewer-manager (code-review) | rename default, role |
  | Sam · Release manager | new `ship` agent (ship) | new thin agent: talks about and configures ship; ship's service stays the engine |
  | Mia · Repo maintainer | maintainer | rename default, role |
  | Iris · App builder | app-maintainer (apps-platform) | rename default, role; handbook: owns app requests end to end (designs with UI Designer, builds via Engineer, runs as today) |
  | Archie · Agent Architect | architect (agent-builder) | rename default, role; hiring flow (§5) |
  | Vik · Security | security-watch (security) | rename default, role; Red Teamer hidden behind him |
  | Rhea · Researcher | assistant (chief-of-staff) | rename default, role |

  Hidden: Intake, Engineer, UI Designer, UI Reviewer, Red Teamer, Fleet Steward, Session.
- **Controlling a module by chat.** A teammate changes its modules through their own config tools (code-review,
  maintainer and ship already have them: `ship_config`/`ship_configure`); an agent's call files through
  `/v1/settings/agent` as a kernel settings record. The chat shows that record as a diff card; Undo files the inverse
  change bound to the applied revision, so it is refused if the setting changed since. Its page links once to the
  module page for advanced settings.
- **Nora** takes over the whole meeting workflow: the `meeting-scan` routine (meetings module) and `meeting-actions`
  (now under Intake), their skills and grants, and the `ops-key` role, from the Researcher and Intake.
- **Hidden agents that page the owner** (Intake's urgent Slack alerts) keep their immediate `notify`; the board and
  channels attribute them to the teammate they work for ("Aiden · urgent"). Nothing is rerouted through a busy agent.

### 2. Board information architecture

- **Routes.** `#/` Home (default; `savedView` and its "chat" default are deleted). `#/team` (teammates),
  `#/team/<key>` (teammate page), `#/team/hire` (hiring page + flow), `#/team/agents` (all agents, advanced, today's
  Agents page), `#/team/modules` (today's Modules page) and module pages under `#/team/m/<page>`. `#/apps`, `#/tasks`
  (today's board, with Sessions in its sub-nav when the module is on), `#/insight/{costs,flow}`, `#/settings`.
  Old routes (`#/c`, `#/agents/…`, `#/fleet/…`, `#/modules/…`, `#/approvals`) redirect to their new home once, in
  `parseRoute`, and the old views are deleted.
- **Chats.** The teammate visibility rule applies to every entry point (new-chat text, explicit agent targets,
  in-thread mentions, fast-lane sends). A teammate's chats live on its page, with per-agent history (not the fleet-wide
  20-chat cap) (the conversation pane is today's Workspace conversation, reused).
  Ask Aiden (⌘J, top bar) opens a right side panel with Aiden's current chat and its history list; it is non-modal
  (the page stays usable), Escape closes, focus returns. `@name` in Ask Aiden still routes to a teammate (chats.ts
  `pickAgent`, restricted to teammates).
- **Approvals.** Owner cards appear as Needs-you rows (Approve/Reject in place, the exact request in the detail
  pane); `#/approvals/<id>` opens Home with that row's pane open. Batch decide moves to a "Select" mode on Needs you.

### 3. Home

One endpoint, `GET /api/home`, so the page loads in one request (SWR-cached like other boot queries):

- **needs**: owner obligations only (owner waits, handbacks, pending owner cards), deduplicated where a task's
  attention is a card, oldest first, each with a stable id (task id or card id). Each row: teammate (key, name, job,
  face, state), question, optional `detail` (e.g. a draft), kind (`answer` with options | `approval` | `open`), age.
  Answers reuse the wait-bound `/answer` and the digest-bound card decide; batch decide keeps per-card outcomes.
  Snooze ("Not now", S) hides a row until 08:00 next day (per account). After an answer the row collapses to a
  receipt; Undo only where the action is undoable (card decisions aren't; a sent answer isn't). `#/approvals/<id>`
  still resolves decided cards directly.
- **Drafts (Tess):** her chaser ask carries the draft as `detail` with options Send / Not now; Edit answers with
  free text. Send answers Tess, who reruns her fresh delivery check and then sends through the existing write gates
  (today a Slack draft for the owner; posting as the owner is allowed through the gates).
- **since**: what the team told the owner since the account's cursor: owner-channel's 14-day notify ledger
  (`notify_recent`: kinds done, fyi, digest) plus tasks closed in that window (by completion time), deduplicated by
  task, grouped per teammate; top 3 + "All N". The response carries `as_of`; the client advances the account's cursor
  to that `as_of` only after the snapshot rendered (not on exit), so arrivals during a visit are never skipped.
- **world**: waiting-on = open tasks labelled `waiting-on` (Tess's): title, age, overdue. Today = a module-owned
  owner-view read declared by the google module (`calendar_today`: today's events in the owner's timezone for the
  connected account), called by the board through the kernel's declared-tool path like module pages; a prep link
  when a task references the event. "You promised" ships later: Intake records promises in prose today, so it waits
  for a structured `due` on owner tasks. A block with no source or no data is omitted (no empty cards).
- **team**: teammates with something in `since`, each with a one-line result (the latest item).
- **idea**: Aiden's suggestions are tasks Aiden files with label `idea` and an owner question (Yes / Not now), so
  they reuse the answer contract and never count as Needs you. Home shows open ideas one at a time (Not now = answer
  "not now", closing it). Until Aiden files them the block is omitted.
- **Greeting** counts only needs ("Three things need you; the rest is handled." / "Nothing needs you.").
- Keyboard: J/K move, Enter opens the pane, E done/approve, S snooze (Not now), scoped to the Needs list, off while
  typing.

### 4. Onboarding

`Welcome.tsx` keeps its gates (model, recovery key, organisation) and replaces the rest with three screens:

1. **Start with one teammate.** Recommended card (Tess unless the instance setting `onboarding_first` names another
   teammate) with a rename field, what it does, what it connects, the first result to expect, and "Set up Tess":
   enable her module and its requirements (open-loops needs Intake, Slack and Google) through the existing module
   change with Modules' apply tracking, run the required connections' setup flows inline (`SetupFlow`), turn her
   routines on (setting her up is the owner's "turn it on" under quiet start), then run a one-off trial: Intake's scan
   over the last 7 days, so Tess has waiting-on tasks to show. No eligible data: "Nobody owes you anything right
   now; Tess keeps watching." A failed apply shows its error with Retry. Below: "Everyone Aiden can bring in": every
   teammate from the catalog with its sample line, Set up next / Later (stored per account; Next up on Home reads it).
2. **Where should your team reach you?** Telegram (channel-telegram setup flow inline), Slack DM (slack advanced
   flow), or only this board (sets `notify_transports: []`). **Send a test**: an owner-channel route that sends a test card through
   the chosen transport only (not the fallback chain) and returns the transport's actual delivery result; its buttons
   are inert (they only acknowledge).
3. **Home on day one:** the first result card, Next up, and the roster row. The server-side welcome finish
   (`welcome.ts`) lands on Home instead of creating an Aiden chat.

Modules declare per teammate a one-line `sample:` (the example result) used by onboarding and hiring.

### 5. Hiring

- **Catalog breadth.** Official modules are already catalogued when disabled. For third-party marketplaces, a
  separate browse step reads metadata (module.yaml + agent frontmatter) of every listed module at the marketplace's
  pin, outside the install graph, so a broken unselected entry can never block an apply. Installing carries the
  qualified identity (`name@marketplace`) through the module change into instance.yaml; a name collision is refused.
- **Hiring page** `#/team/hire`: "Describe who you need" band, search (job, name, tool), filters (Available, On your
  team, per marketplace, area), teammate cards (face or a monogram tile for modules without a face, Name · Role,
  marketplace, what it does, Advanced ▸ modules). Hire = install (the existing `{kind:"module", on:true}` change)
  with its setup flow, then the name step.
- **Describe flow:** the description goes to Archie as a chat. Archie's first step extends his existing
  `fleet_catalog` lookup to the shared catalog (teammates and browsable modules), and he answers with a form: Extend
  <teammate> / Install <module> / Build new. The page renders Archie's form (AnswerForm). Extend and Install are the short path; Build
  new continues Archie's existing flow (proposal → build via Engineer → trial on real data), with the name step
  before the trial.

### 6. Design system (board UI kit)

All new UI is built from `web/src/ui`; pages compose, never restyle. Add or upgrade:

- **Face** (parametric kit + shipped-image mode, states, sizes 24–96, reduced motion) and **TeammateChip**
  (face + Name · Role).
- **DecisionRow** (needs row: teammate, question, inline actions by kind, receipt with Undo), **DetailPane**
  (slide-in), **DigestList**, **SidePanel** (Ask Aiden), **Stepper**, **OptionCard** (radio/checkbox card),
  **Disclosure**, **Kbd**, **SectionCard** (header with title, meta, action).
- **Motion tokens** in tokens.css: durations (--instant/--fast/--medium/--slow exist), ease-out/ease-in, enter
  (fade-up 6px, staggered), hover lift, press scale, pane slide, collapse; one `@media (prefers-reduced-motion)`
  block. Layout tokens: page max width 1920, gutters, fluid grids (`auto-fill/auto-fit` minmax).
- `#/design` catalogue shows every component in both themes. `docs/design/board-ui.md` is rewritten: Home is the
  heart (not chat), the nav above, the component list, motion rules.
- **Module pages** get the same look: `services/shared/page-kit.css/js` is kept in sync with the board tokens and
  the core components via the existing `scripts/sync-shared.ts` (buttons, rows, cards, tags, section headers), so code review and other
  module pages pick it up. Their redesign is the next project.

### 7. Not changed

Paperclip ownership of tasks, approvals gates and tiers, the kernel's needs-you state, owner-channel as the one path
to the owner, chat storage as Paperclip tasks.

## Phasing (one product PR each, merged and deployed in order)

1. **Kit + teammates data**: motion/layout tokens, Face/TeammateChip and the other components, `#/design`;
   `teammate:` block/name override through compile, Paperclip, catalog and roster; portraits moved into
   modules; roster defaults and the two new agents (Nora, Sam) with their config tools.
2. **Board IA + Home + Team**: new nav and routes (old views deleted), `/api/home`, Home, teammate pages, Ask Aiden
   panel, approvals folded into Needs you, board-ui.md.
3. **Onboarding + hiring + push test**: Welcome rewrite, send-test route, hiring page, `catalog_search`, marketplace
   metadata breadth, Archie's handbook, Aiden's `idea` notifies, page-kit sync.

## Settled during review (designer's calls, not the owner's)

1. **Teammate ↔ modules and staff.** A teammate declares `staff:` (hidden agent keys behind it, any module) and
   `controls:` (module names it configures; default: its own module). "Team behind <name>" lists `staff`; the
   teammate is granted its controlled modules' config tools; Advanced links go to those modules' pages/settings.
   Defaults: Aiden staff [inbox-agent, fleet-steward]; Iris staff [engineer, ui-designer, ui-reviewer] controls
   [apps-platform, design]; Vik staff [red-teamer]; Sam controls [ship, ci]; Max controls [code-review]; Rhea
   controls [chief-of-staff's research routines]. "Extend <teammate>" in hiring = Archie files an improvement to that
   teammate (a routine/skill in a local module, plus `controls`/grants if a module is added), through the existing
   improvement path.
2. **Teammate page side column is generic**: what it does (description), recent work (its recent tasks/timeline,
   existing endpoints), how it's set up (its controlled modules' settings rendered from their declared settings and
   labels), staff, one Advanced link. No per-module widgets. **Pause** pauses the teammate and its staff (existing
   agent pause); it does not stop module services, and the button says "Pause Max and his staff".
3. **No new `draft` kind.** Drafts are an owner question whose options are e.g. "Send" / "Not now", with an optional
   `detail` text (the draft, ≤2000 chars) added to the owner-question shape; Edit = answer with free text. Send
   answers the teammate, which then sends through the existing write gates (AI review). Sends have no Undo; the
   receipt says "Tess is sending it".
4. **Needs you is owner-only**: owner waits, handbacks and owner cards. Failed and unexplained-idle stay with the
   Fleet Steward and show on Team › All agents; they are not in the Home badge or greeting.
5. **Non-owner board accounts** see Home without Needs you, onboarding or approvals (since / world / team only).
   Last-visit and Set-up-next are stored per account, so the team version stays open.
6. **Catalog breadth**: metadata is read once per marketplace pin (instance.yaml marketplace sha), cached by sha, so
   applies refetch only when a pin changes; a failed read of an uninstalled module is skipped with a warning, never
   fails the apply.

## Left to the builder

Component APIs and file layout inside `web/src/ui`; `/api/home` field names; the parametric face's feature set
(beyond: seeded, stable, three states, reads at 24px); how last-visit is stored; test choice (a few end-to-end
checks per phase, per the repo's minimal-tests rule); exact redirects.

## Risks

- Renamed defaults (Follow-up Tracker → Tess…) confuse existing handbook text: grep for agent display names in
  handbooks/skills and switch to keys/roles in phase 1.
- Calendar reads per Home load: cache for 5 minutes per account.
- Deleting the Chat tab removes the cross-agent chat list; chats stay reachable per teammate, in Ask Aiden history and
  in Search.
