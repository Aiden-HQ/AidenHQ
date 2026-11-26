# Phase 3: Onboarding, hiring, push test

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner rule: native execution, one review
> at the end of the phase) to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new owner meets one teammate (Tess by default), sets it up and sees a first result on their own data. They see
everyone else Aiden can bring in, choose where the team reaches them (with a real test message) and land on Home. A
running owner hires from `#/team/hire`, which shows the team and every installed marketplace (third-party listings
included) before Archie builds anything new.

**Architecture:** Welcome, Hire and Home's "Set up next" all use one client sequence, `TeammateSetup`. It runs: module
change (apply tracked) → required connections' setup flows inline → the teammate's routines resumed → its module's trial
routines run once → name. Every step's state is read back from the server, so a reload or Retry is idempotent. Compile
gains a browse step that reads every third-party marketplace listing's metadata outside the install graph, cached by
pin sha. The catalog then lists teammates a user can hire, and Archie's `fleet_catalog` can match a description against
them. The push test is a board-keyed kernel route that sends one fixed card to exactly one transport and returns that
transport's own answer.

**Spec:** `docs/superpowers/specs/2026-11-26-home-and-teammates-design.md` §4, §5, §6 (module pages) and "Settled" 1, 5, 6.
**Index (cross-phase contracts, fixed):** `docs/superpowers/plans/2026-11-26-home-teammates.md`.
**Mockups:** `docs/superpowers/plans/2026-11-26-home-teammates-mockups/` V3NewInstall (1512, reach, home), V3Hiring,
V3Hire (+ `-existing`). The spec wins over a mockup. Deviations are listed under "Mockup vs spec".

**Builds on (consumed exactly as the index names them):**
- Phase 1: `teammate:` block and its compile/Paperclip/catalog path. Catalog `teammates: {key, name, job, sample,
  description}[]` (covering disabled official modules too). `RosterAgent.teammate {job, sample, staff, controls, face:
  {src} | {kit: FaceKit} | null}`. `GET /api/faces/<key>`. Override `overrides.agents.<key>.name`. The rename change is
  `{kind: "agent", agent: <key>, field: "name", value: <name>}` (owner only), checked by the name rule in
  `services/shared/teammate-name.ts`. Kit exports, with the props as phase 1 lands them:
  - `Face({seed, src?, kit?, state?, size? (16–96), label})`
  - `TeammateChip({agent, state?, size?, job?, href?})`
  - `Stepper({steps, current (0-based), label?})`
  - `OptionCard({type, name, value, checked, onChange, title, sub?, badge?, media?, disabled?})`
  - `Disclosure({summary, defaultOpen?, children})`
  - `SectionCard({title, meta?, count?, action?, flush?, children})`
  - `DetailPane`
  - classes `.enter`, `.lift`, `.press`
- Phase 2: routes `#/`, `#/team`, `#/team/<key>`, `#/team/hire`, `#/team/modules`. `GET /api/home` → `Home`. A
  teammate page holds its chats. The Ask Aiden panel.

**Assumptions about phases 1-2 that the index does not fix.** Check each against main when you start, and fix this
plan, not the contract:
- A1. Phase 2's `Home` type is extended here by one optional field, `start` (Task 9). No other Home field changes.
- A2. Phase 1's teammate-block parser in `scripts/modules.ts` (the function that reads an AGENTS.md frontmatter
  `teammate:` and a local agent entry's) is exported, so the browse step reuses it. If it isn't, export it.
- A3. The phase 2 teammate page opens a given chat by identifier through a link (`#/team/<key>` plus phase 2's chat
  parameter). Build new hands off with that link.
- A4. The catalog's `teammates[]` entries carry no face. Task 2 adds `face: {src} | {kit: FaceKit} | null` to them, in
  the roster's shape. It also widens phase 1's file copy (`config/faces/`) to every official catalogued teammate, so
  hiring and onboarding draw faces for modules that aren't enabled. This is an additive contract gap.


Code references are symbols in the tree as of `73e688a92` (before phases 1-2), not line ranges: phases 1-2 move every
line in the files this phase touches. Re-find each symbol on main before editing.

## Decisions made here (with the one-line reason)

- **D1. Qualified install.** The module change's `name` accepts `name@marketplace` (`NAME_Q`). Both checkers resolve
  it against the catalog by (name, marketplace). The kernel writes it into `instance.yaml modules:` exactly as given.
  Turning on a module whose bare name is already installed from another marketplace is refused. *Why:* the existing
  change carries it, so no new kind is needed. **Contract note:** this widens the existing `{kind:"module"}` shape,
  which the index doesn't list.
- **D2. Browse entries live in `config/modules.json`**, marked `browse: true`, `enabled: false`, `chosen: false`, with
  no `settings`, `defaults`, `readme`, `writes` or `secrets`. Name-keyed consumers skip them (Task 3 lists each one).
  *Why:* one catalog, which Modules, hiring, the kernel's checks and `fleet_catalog` already read.
- **D3. Third-party text is untrusted.** Browse reads cap `description` at 300 characters and `job`, `sample` and
  `name` at the contract limits. A failing value drops that teammate. Faces are never read from third-party modules:
  their cards use a monogram tile. `fleet_catalog` fences every browse entry's strings. *Why:* the text reaches both
  the board and Archie's prompt.
- **D4. Area filter = the agent's `department`** (the existing registry in `kernel/defaults.json` plus instance
  departments), not the mockup's "Your day / People / …" labels. **Contract gap:** the catalog teammate entry gains
  `department: string` (the department's display name, resolved at compile). This is additive, but it is not in the
  index.
- **D5. Push test is a kernel route, not an owner-channel one.** `POST /v1/notify/test {to}` (the board's key) calls
  the kernel's existing one-transport send (`createNotify` → `post`) with a fixed test message. It never touches
  `owner_notify`'s queue or owner-channel's routing. *Why:* owner-channel can reach a transport only through
  `/v1/notify/send` (role `kernel.notify`), and its client drops the transport's `reason`. The spec wants "the chosen
  transport only, not the fallback chain", which is exactly `post()`. **Spec deviation:** §4 says "an owner-channel
  route".
- **D6. Inert buttons** are a new optional field on the transport `Message`: `inert?: string[]` (labels, at most 3).
  Telegram renders them with `callback_data: "test"`, and a press only answers the callback ("Test received"). Slack
  renders a Block Kit `actions` block with `action_id: "inert:<n>"`, and a press is acknowledged and nothing else.
  `actions` and `answer` are never set on a test.
- **D7. The teammate to offer first comes from the module format, not a setting.** The `teammate:` block gains an
  optional `first: number` (a positive integer; lower is recommended earlier). Onboarding recommends the available
  teammate with the lowest `first`; when none declares one, it picks the first teammate alphabetically by `job`.
  open-loops' Tess declares `first: 1`. No core setting names a module. **Index addition:** phase 1's teammate block
  carries `first` through compile and into the catalog `teammates[]`. The coordinator adds it to the index.
- **D8. Trial = routines marked `trial: true`.** A product module may declare a routine with `trial: true` and no
  `schedules` or `event`. Setting up a teammate runs each trial routine of its module and of the modules its module
  requires, once. Intake gains `inbox-lookback` (the last 7 days of Gmail and Slack). The core never names Intake.
- **D9. "Turn her routines on"** resumes every paused scheduled or event routine whose agent is the teammate, or is a
  hidden agent (no `teammate`) of the teammate's module or of a module it requires. A routine run by another teammate
  stays paused. For open-loops: `open-loops-sweep`, Intake's `inbox-scan` and `slack-triage` (whatever Intake still
  owns after phase 1), and nothing of Aiden's. *Why:* without its feeders Tess has nothing to chase. The rule comes
  from declarations, not keys.
- **D10. Rename happens after the apply.** A `{kind:"agent", agent, field:"name", value}` change is refused until the agent is
  compiled, so the onboarding card's rename field holds its value (component state + sessionStorage) and files it
  once the module change reads `applied`. One extra apply, only when the name differs from the default.
- **D11. Set up next / Later** are stored per account in the board store's `meta` table under key
  `teammates:<accountId>`, as JSON `{next: string[], later: string[]}` (agent keys). The welcome pre-queues one
  suggestion (marked "Suggested for you"): the first catalog teammate that is neither the one being set up nor already
  on the team.
- **D12. Welcome finish lands on Home** (`#/`). Instead of Aiden's welcome chat, it files one chief-of-staff task
  through the existing `POST /v1/board-tasks` (role `fleet-admin`, source `welcome`) with fixed text. Aiden answers it
  by filing his first `idea`. The six-point tour is deleted.
- **D13. Build new names in the design review.** Archie's in-chat "Build it?" form (or the Primer lock) gains the
  question "What should we call them?", and the name goes into the local `module.yaml` agent `name:`. That comes
  before the build and so before the trial, which satisfies "name before trial" with no extra apply. Extend and
  Install name in the page's own name step (D10).
- **D14. Archie's form options are machine-checked, never trusted.** The page treats an option as a short path only
  when it matches `^Install ([a-z0-9-]+)@([a-z0-9-]+)$` against a hiring row the board itself listed, or
  `^Extend ([a-z0-9-]+)$` against an on-team teammate key. Anything else is sent to Archie as a plain answer. The
  install itself is the owner's click (`TeammateSetup`), filed as his own module change.
- **D15. One catalog tool.** `fleet_catalog` gains `teammates` and `modules` sections. The phasing line's
  `catalog_search` is not built; that stray name in the spec is flagged.

## File structure

**Create**
- `services/board/src/teammates.ts`: the hiring list (`GET /api/teammates`), start (`POST /api/teammates/<key>/start`),
  trial status (`GET /api/teammates/<key>/trial`), per-account queue (`GET|PUT /api/teammates/queue`), and the
  `start` block for Home.
- `services/board/web/src/TeammateSetup.tsx`: the one setup sequence (enable → apply → flows → routines → trial → name).
- `services/board/web/src/Hire.tsx` + `hire.css`: `#/team/hire`, the hiring page, and its describe flow.
- `services/board/web/src/onboarding.css`: Welcome's three screens and Home's getting-started band.
- `services/board/web/src/GettingStarted.tsx`: Home's day-one band (Next up + "More your team can do").
- `modules/intake/skills/look-back/SKILL.md`: the 7-day trial scan.
- `modules/agent-builder/skills/hiring/SKILL.md`: how Archie answers a hiring description.
- `modules/chief-of-staff/skills/ideas/SKILL.md`: how Aiden files `idea` tasks.
- `services/board/test/teammates.test.ts`: end-to-end routes (start, trial, queue, welcome finish).

**Modify**
- `scripts/compiler/sources.ts`: `browseMarketplaces()` (metadata outside the install graph, cached by sha).
- `scripts/modules.ts`: append browse entries to the catalog, add `department` to catalog teammates, copy faces for
  every official teammate, carry routine `trial`.
- `scripts/paperclip-setup.ts`: strip `trial` before Paperclip, and slim `modules` in `catalog.static.json`.
- `services/board/src/settings-change.ts`, `kernel/src/settings-change.ts`: qualified module names, collision refusal.
- `services/board/src/welcome.ts`, `services/board/src/app.ts`, `services/board/src/main.ts`: new welcome
  state/finish, mount teammates routes, delete `OPERATOR`.
- `services/board/src/setup-flows.ts`, `modules/board/schemas/setup_flows.json`: delete `wizard`.
- `services/board/src/modules.ts`, `services/board/src/marketplace.ts`: skip or qualify browse entries.
- `services/board/web/src/Welcome.tsx` (rewrite), `SetupFlow.tsx`, `SetupPaths.tsx` (inline + preselected path),
  `ModuleParts.tsx` (qualified name), `api.ts`, `types.ts`, `App.tsx` (route `#/team/hire` → `Hire`), `ModuleView.tsx`
  (full MCP Apps variable set), Home view from phase 2 (renders `GettingStarted`), `web/dev/mock-api.ts`.
- `kernel/src/notify.ts`, `kernel/src/backplane.ts`: `POST /v1/notify/test`.
- `modules/channel-telegram/connections/telegram/src/{send.ts,chat.ts}`,
  `modules/slack/connections/slack-live/src/{send.ts,socket.ts or main.ts}`: `inert` buttons.
- `modules/tasks/connections/tasks-mcp/src/tools.ts` (`fleet_catalog`).
- `modules/intake/module.yaml` (`inbox-lookback`, skill), `modules/open-loops/agents/open-loops/AGENTS.md` (`teammate.first: 1`),
  `modules/chief-of-staff/module.yaml` (`idea` label, `ideas` skill), `modules/agent-builder/module.yaml` (`hiring`
  skill), `modules/channel-telegram/module.yaml`, `modules/slack/module.yaml`, `modules/google/module.yaml` (drop `wizard`).
- `modules/agent-builder/agents/architect/AGENTS.md`, `modules/agent-builder/templates/*/module.yaml` (`teammate:`),
  `modules/chief-of-staff/agents/chief-of-staff/AGENTS.md`.
- `services/shared/page-kit.css` (restyle), `scripts/sync-shared.ts` (copy list).
- `ops/test/unattended-install.sh`, `scripts/test/remote-sources.test.ts`, `kernel/test/notify.test.ts`,
  `kernel/test/settings-change.test.ts`.
- Docs: `docs/design/guided-setup.md`, `docs/design/quiet-start.md` §3, `docs/design/board-ui.md` (one
  "Onboarding and hiring" paragraph), `docs/configuration.md` (teammate `first`, routine `trial`), the modules' READMEs touched.

## Tasks

### Task 1: Browse third-party marketplaces outside the install graph

**Files:** Modify `scripts/compiler/sources.ts` (new export after `remoteModules`). Modify `scripts/modules.ts`
(`compile`, the `catalog` build at `const catalog = [kernelEntry, …]`, and the warnings).

**Interfaces**
- Produces: `export function browseMarketplaces(instance: Dict, f: Fetch & { parse: (s: string) => unknown }, warn: (msg: string) => void): BrowseEntry[]`
- `type BrowseEntry = { name: string; marketplace: string; description: string; requires: string[]; agents: string[]; teammates: { key: string; name: string; job: string; sample: string; description: string; department: string }[]; revision: string }`
- Consumes: `marketplacesOf`, `marketplaceEntries`, `sourceOf`, `checkout`, `wantedRemote` (sources.ts), `cacheRepo`'s
  `hash` helper, and phase 1's teammate parser (A2).

- [ ] For each third-party marketplace in `marketplacesOf(instance)` (never `aidenhq`), at its pinned `at`, read the
      cache file `join(f.cacheDir, "browse", hash(`${at.url}|${at.path}|${at.sha}`) + ".json")`. On a hit, use it and
      fetch nothing. The cache holds the **whole** listing. The entries the instance installs (`wantedRemote`) are
      filtered out **after** reading, so installing or removing one never needs a refetch.
- [ ] On a miss: `checkout(at)`, then `marketplaceEntries(...)`. For each entry, do `sourceOf` → `checkout` → read
      `module.yaml`. The whole browse step has a 90 s budget across all marketplaces. Past it, every entry not read
      yet is skipped with one warning ("browse ran out of time: <n> entries not listed") and nothing is cached for
      that marketplace, so an apply is never held by dead remotes. Skip the entry, with `warn("marketplace <m>: <name> not
      listed: <reason>")`, when: the read throws, `def.name` ≠ entry name, or the module has `apps` or a service
      `build` (the same rule `remoteModules` refuses). For each `agents.<key>`, read its `agents/<key>/AGENTS.md`
      frontmatter with the phase 1 parser. A teammate block that fails validation, or text over the caps (D3), drops
      that teammate with a warning. A `face` file is never read or copied. A `FaceKit` face is enum data: keep it
      when it validates against phase 1's enums, and drop it otherwise.
- [ ] A marketplace whose checkout or `marketplace.json` fails gets `warn(...)` and is skipped whole.
- [ ] Write the cache file only when every entry was read without a transient error (a fetch/timeout). A listing with
      skipped entries for permanent reasons (bad manifest) is still cached; a network failure is retried next apply.
- [ ] In `compile`, call it after `remoteModules` (inside the try that builds `all`; it never throws). Append one
      catalog row per entry: `{ name, description, enabled: false, chosen: false, requires, agents, routines: [],
      connections: [], apps: [], marketplace, tier: "declared", browse: true, revision, teammates }`.
- [ ] Verify: `cd scripts && node --test test/remote-sources.test.ts` passes, including Task 13's new case.

### Task 2: Catalog teammate `department`, every official face, routine `trial`

**Files:** Modify `scripts/modules.ts`: the catalog `teammates` (phase 1), the face copy (phase 1), and
`r.status = …` in the routines loop. Modify `scripts/paperclip-setup.ts`: routine plans (`const plans = …routines`)
and `writeCatalog`.

**Interfaces**
- Consumes: phase 1's catalog `teammates`, the face copy, and `KERNEL_DEFAULTS.departments`.
- Produces: catalog teammate `+ department: string`, `+ face: {src} | {kit: FaceKit} | null`; compiled routine `trial?: true`; `catalog.static.json` `modules: {name, description, marketplace, tier, enabled, browse?, requires, teammates}[]`.

- [ ] The catalog teammate entry adds `department: string`, the display `name` of the agent's `department` from the
      merged registry (`[...KERNEL_DEFAULTS.departments, ...instance.departments]`, `general` when unset).
- [ ] Catalog teammate entries gain `face` in the roster's shape (A4). The file copy covers every teammate of every
      official module, enabled or not, into `config/faces/<key>.<ext>`. Local and declared modules stay enabled-only,
      as in phase 1.
- [ ] A product routine may set `trial: true`. Compile fails when a `trial` routine has `schedules` or `event`. Keep
      `trial` on the compiled routine (the board reads it). `paperclip-setup.ts` drops `trial` from the body it sends
      Paperclip. `LOCAL_ROUTINE_FIELDS` stays unchanged: a local module has no trial.
- [ ] `writeCatalog`: `modules` keeps only `{name, description, marketplace, tier, enabled, browse, requires,
      teammates}` (drop `readme`, `defaults`, `writes`, `secrets`, `prompts`), so `fleet_catalog` stays small.
- [ ] Verify: `node scripts/compile.ts` against `fixtures/twin`'s instance writes `config/modules.json` with
      `teammates[].department` and a routine with `trial: true`; `scripts#2` suite green.

### Task 3: Qualified install and collision refusal

**Files:** Modify `services/board/src/settings-change.ts` (`ChangeSchema` module member, `checkChange`'s
`ch.kind === "module"` branch, `describe`). Modify `kernel/src/settings-change.ts` (`moduleOf`, the `case "module"`
check, and the `case "module"` writer). Modify `services/board/src/modules.ts` (`moduleStates`),
`services/board/src/marketplace.ts` (`browseModules`, `marketplacesOf`), `services/board/web/src/ModuleParts.tsx`
(`TurnOnCard.go`, `useModuleToggle`'s preview item).

**Interfaces**
- `NAME_Q = /^[a-z0-9][a-z0-9-]{0,60}(@[a-z0-9][a-z0-9-]{0,60})?$/`, used only by `{kind: "module"}`.
- `ModuleRow` gains `id: string` (`name` for official/local, `name@marketplace` for third-party) and `browse: boolean`.

- [ ] Board `checkChange`: split `ch.name` on `@`, then find the row with `x.name === bare && (x.marketplace ?? "aidenhq") === (mkt ?? "aidenhq")`.
      A third-party row needs the qualified form ("say <name>@<marketplace>"). On `on: true`, refuse when another
      row with the same bare name is `enabled`: "a module named <bare> is already installed from <marketplace>".
- [ ] Kernel: the same resolution in `moduleOf` and the collision check. The writer pushes `ch.name` as given. Off
      compares `entryName(x) === bare` (unchanged). `modules_removed` stays bare.
- [ ] Every name-keyed consumer of the catalog ignores `browse: true` rows, except Modules' Available list,
      hiring, and the two checkers. Grep `catalog.find(`, `catalog.filter(` and `.name ===` in
      `services/board/src/{settings.ts,settings-change.ts,marketplace.ts,modules.ts,grants.ts}`,
      `kernel/src/settings-change.ts` and `scripts/paperclip-setup.ts`, and fix each one found.
- [ ] Modules page: a browse row shows as Available with its marketplace (`publisher`). Turn on files `m.id`.
- [ ] Verify: the kernel's `kernel/test/settings-change.test.ts` case (Task 13) passes. `cd services/board && npx vitest run test/settings-change.test.ts` passes.

### Task 4: Push test route and inert buttons

**Files:** Modify `kernel/src/notify.ts` (`createNotify` return), `kernel/src/backplane.ts` (route table near
`POST /v1/notify`, and handler). Modify
`modules/channel-telegram/connections/telegram/src/send.ts` (`Message`, `transportSend`) and `chat.ts` (callback loop
before `answerCallbackQuery`). Modify `modules/slack/connections/slack-live/src/send.ts` (`Message`,
`transportSend`) and the Socket Mode handler (block_actions are acked and ignored). Modify `services/board/src/app.ts`
(new route), `web/src/api.ts`.

**Interfaces**
- Kernel: `notify.test(to: string): Promise<{ sent: boolean; off?: true; reason?: string }>`. Route `{ method: "POST",
  path: "/v1/notify/test", auth: "board" }`, body `{to}` where `to` ∈ installed channels with a transport (else 404).
- Fixed message: `{ kind: "decision", text: "Test from AidenHQ: this is how a decision reaches you. The buttons do nothing.", inert: ["Looks good", "Not now"] }`.
- Board: `POST /api/notify/test {transport: "channel-telegram" | "slack"}` (owner only) → the kernel's answer unchanged.
  `api.notifyTest(transport)`.

- [ ] `test(to)` = `post(to, TEST)`. It writes no `owner_notify` row and is never retried.
- [ ] Telegram: when `m.inert?.length`, `markup = { inline_keyboard: [m.inert.map((t) => ({ text: t, callback_data: "test" }))] }`
      (actions and answer ignored). In the callback loop, `data === "test"` sets `said = "Test received"` and goes
      nowhere else.
- [ ] Slack: `inert` adds an `actions` block of buttons `action_id: "inert:<i>"`. Its Socket Mode handler acks the
      envelope and does nothing for `inert:` actions (read how `socket.ts` acks today, then add only the ignore).
- [ ] A transport that isn't set up answers `{sent: false, off: true}` (existing behaviour). The board shows it
      verbatim ("Telegram isn't paired yet").
- [ ] Verify: Task 13's kernel notify case passes. The telegram and slack-live suites stay green.

### Task 5: Teammate `first`, the trial routine, routines resumed

**Files:** Modify `scripts/modules.ts` (the phase 1 teammate validator and the catalog `teammates[]`),
`modules/open-loops/agents/open-loops/AGENTS.md` (frontmatter), `modules/intake/module.yaml` (routine + skill),
create `modules/intake/skills/look-back/SKILL.md`, modify `modules/intake/README.md`.

**Interfaces**
- Produces: teammate block `first?: number` (validated as a positive integer, carried into the catalog's
  `teammates[]` and the compiled `teammate`; a browse row keeps it, since it is plain data), routine
  `inbox-lookback {trial: true}`, and skill `intake.look-back`.

- [ ] The teammate validator accepts `first` (an integer ≥ 1), and compile fails on anything else. The catalog and the
      compiled teammate carry it. open-loops' frontmatter `teammate:` gets `first: 1`.
- [ ] Intake routine `inbox-lookback`: title "Inbox look-back", `agent: inbox-agent`, `trial: true`,
      `concurrency: skip_if_active`, description "Today is {{date}}. Follow your look-back skill: the last 7 days,
      then finish with a count line." Add `intake.look-back` to `inbox-agent.skills`.
- [ ] `look-back/SKILL.md` (mission + steps; rules link to `triage-email`/`triage-slack`, never copied):
      `gmail_search` `newer_than:7d in:inbox` (all accounts), and a Slack search for the last 7 days of messages to
      or from the owner (its granted `slack: read` tools). Apply triage-email step 4's and triage-slack's task rules
      with the same `source:` markers, so the live scans later deduplicate against them. File nothing older than 7
      days. Leave the Gmail cursor (`gmail_inbox_ack`) alone. Finish line, e.g. "Looked back 7 days: 4 waiting-on, 2
      needs-response".
- [ ] Verify: `node scripts/compile.ts` passes; the compiled `inbox-lookback` has `status: active` (no schedule) and
      `trial: true`.

### Task 6: Teammates server routes

**Files:** Create `services/board/src/teammates.ts`. Modify `services/board/src/app.ts` (mount next to `welcomeRoutes`).

**Interfaces**
```ts
export interface HireRow {
  key: string; name: string; job: string; sample: string; description: string; department: string;
  module: string; id: string;            // id: "name" or "name@marketplace" (D1)
  marketplace: string; browse: boolean; onTeam: boolean;
  face: { src: string } | { kit: FaceKit } | null;  // roster shape; browse rows: a validated kit only, never a file
  requires: string[];                    // modules turned on with it (the Advanced disclosure)
  connections: string[];                 // setup flows (module names) its requires-closure still needs
}
export function teammateRoutes(d: { pc: Paperclip; store: Store; sources: () => Sources; flows: SetupFlowPoint[]; facesDir: string }): SetupRoute[];
```
- `GET /api/teammates` → `{ rows: HireRow[]; first: string | null }`. Rows come from catalog `teammates` (A1 contract) across
  every entry, official first, then marketplaces A→Z. `first` = the key of the available teammate (not on the team; browse rows
  included) with the lowest `first`. When none declares one, the first available teammate alphabetically by `job`;
  when everyone is hired, `null`, and the first screen is skipped.
- `POST /api/teammates/<key>/start` (owner only, after the module is applied): resumes the D9 routines with
  `setRoutinePaused(pc, t, false)` (only `status === "paused"` ones), then runs each D8 trial routine once with
  `pc.request("POST", "/api/routines/<id>/run", { source: "manual" })`. It records
  `meta("trial:<key>") = {at, runs: [{routine, issue}]}`. Returns `{ resumed: string[]; trials: string[] }`. Calling it
  again resumes but doesn't rerun, unless the recorded trial is `failed` (then it reruns), so Retry is idempotent.
  Body `{ trial?: boolean }`: `false` resumes only (the client sends it when a required connection was skipped).
- `GET /api/teammates/<key>/trial` → `{ state: "none" | "running" | "done" | "failed"; found: { identifier: string; title: string; labels: string[] }[] }`.
  State comes from each run's task (kernel task state). `found` = open tasks created by the trial routines' agents
  since `at` (Paperclip issue list filtered by `createdByAgentId` and `createdAt`), at most 10. Confirm in Paperclip's
  `routines/:id/run` answer which field carries the run's issue, and use that one.
- `GET /api/teammates/queue` → `{ next: string[]; later: string[] }`. `PUT` with the same body (each ≤ 20 keys,
  `AGENT` regex). Stored per account (D11).
- `homeStart(accountId): Home["start"]` (Task 9).

- [ ] Map D9 from compiled routines (`agent`) plus catalog (`agents`, `requires`, `teammates`): the requires-closure
      of the teammate's module, then routines whose agent is the teammate or a non-teammate agent of a closure module.
- [ ] Non-owner accounts: `start` and the welcome routes answer 403. The list and queue work for anyone (Settled 5).
- [ ] Verify: Task 13's `services/board/test/teammates.test.ts` passes.

### Task 7: Welcome server side

**Files:** Modify `services/board/src/welcome.ts` (whole file), `services/board/src/app.ts` (the `welcomeRoutes({…})`
call, `OPERATOR` and its two comparisons), `services/board/src/main.ts` (pass the board-task filer already built as
`fileAlert`).

**Interfaces**
- `WelcomeDeps = { accounts: KernelAuth; store: Store; marker: string; fileTask: (t: { title: string; description: string; source: string }) => Promise<void>; teammates: () => HireRow[] }`
- `GET /api/welcome` → `{ finished: boolean; modelReady: boolean; recoveryKeyWaiting: boolean }` (`wizard` deleted).
- `POST /api/welcome/finish` body `{}` (strict) → `{ ok: true }`.

- [ ] Finish (owner only, once, guarded as today): `fileTask({ title: "A new owner finished setup", source: "welcome",
      description: "<owner> finished onboarding. On the team: <on-team teammates' 'Name · job', from the catalog>.
      Follow your ideas skill: file the first idea." })`. Then set `welcome_finished` meta and write the marker. The
      text is built from catalog values only, never from the request.
- [ ] Delete `welcomeText`, `post`, the `wizard` filter and `OPERATOR` (both comparisons at `s !== OPERATOR` become
      plain `s`). Grep `OPERATOR` again after; expect no hits.
- [ ] Verify: `ops/test/unattended-install.sh` (Task 13) passes locally under the 600 s alarm.

### Task 8: `TeammateSetup` and inline setup flows

**Files:** Create `services/board/web/src/TeammateSetup.tsx`. Modify `SetupFlow.tsx` (`SetupFlow` props, the
`flow === null` redirect, the `setup-overlay` wrapper), `SetupPaths.tsx` (initial `Path`), `api.ts`, `types.ts`.

**Interfaces**
```ts
export function TeammateSetup(props: {
  row: HireRow;                 // what to set up
  name?: string;                // a rename the owner typed before (D10); filed after apply when it differs
  nameStep?: boolean;           // Hire: show the name field after setup
  onDone: (r: { trial: TrialView }) => void;
  onSignIn: () => void;
}): JSX.Element
export function SetupFlow(p: { module: string; change?: boolean; inline?: boolean; path?: "basic" | "advanced"; onDone: () => void; onSignIn: () => void }): JSX.Element
```
Stages, each derived from server reads (catalog via `api.modules()`, `useFiled`, `api.setupFlows()`,
`api.teammateTrial()`):

1. **Enable:** when `!row.onTeam` and no filed change is in flight: `file([{ kind: "module", name: row.id, on: true }])`
   (the module change; its requirements come on with it). Show `ChangeProgress` with Modules' apply tracking.
   `failed`/`rejected` show the change's detail with **Retry** (files again; the "already on" refusal reads as success).
2. **Connect:** for each module in `row.connections` whose flow isn't `done`, `<SetupFlow inline module=… onDone=next />`,
   one at a time. Skip lets the owner continue. The teammate then starts with less, and the stage says so.
3. **Turn on + trial:** `api.teammateStart(row.key, { trial: !skipped })`, then poll `teammateTrial` every 5 s
   (visible tab) until `done`/`failed`/`none`. When a required connection was skipped, there is no trial: the stage
   reads "<Name> is on. Connect <titles> and <name> starts on its next run", with the flow's Connect still offered.
   `failed` reads "<Name>'s first run didn't finish" with the run's task link (`#/tasks` detail) and **Retry**,
   which calls start again and so reruns the trial.
4. **Name** (when `nameStep`, or a pending rename): `Field` prefilled with `row.name`. Save files
   `{ kind: "agent", agent: key, field: "name", value }` only when it changed. The field validates live with
   `services/shared/teammate-name.ts` (the same rule the board and kernel enforce), and a server refusal shows under
   the field.

- [ ] `SetupFlow inline`: no `setup-overlay` wrapper and no `PageHeader` (the host shows the title). `flow === null`
      calls `onDone` instead of `location.replace`. `path` preselects `SetupPaths`' path (`"advanced"` for Slack DM).
- [ ] Wrap with `ChangesScope` where the host isn't already inside one (Welcome, Hire).
- [ ] Reload safety: the stage is recomputed from the reads on mount; sessionStorage holds only the typed name.
- [ ] Verify: `npx tsc -p tsconfig.build.json --noEmit` in `services/board`.

### Task 9: Welcome rewrite and Home on day one

**Files:** Rewrite `services/board/web/src/Welcome.tsx` (keep `WelcomeGate`, `ModelGate`, the `key` and `org`
screens). Create `GettingStarted.tsx`, `onboarding.css`. Modify the phase 2 Home view (render `GettingStarted` when
`home.start`), `services/board/src/teammates.ts` (`homeStart`), the phase 2 `/api/home` handler (add `start`).

**Interfaces**
- `type Screen = { kind: "key" } | { kind: "org" } | { kind: "first" } | { kind: "reach" }`
- `Home["start"]?: { nextUp: HireRow | null; more: Pick<HireRow, "key" | "name" | "job" | "face">[] }`. It is present
  for an owner whose queue has a not-on-team teammate, or within 7 days of `welcome_finished`. `more` = catalog
  teammates not on the team (max 8 faces).

Screen **first** (V3NewInstall-1512): `Stepper` (`steps` = the 3 onboarding steps, `current` 0) "Step 1 of 3 · Your first teammate"; the right-hand note "Nothing runs
on its own until you say so." when `quiet_start` is on.
- [ ] Heading "Start with <name>.", from `GET /api/teammates` `first`. The recommended `SectionCard` shows: `Face`
      (96), an inline rename `Input` (1–24), job, Does = description, Connects = `row.connections` titles + "read-only
      until you say otherwise", "First result you'll see" = `sample`, and the primary button "Set up <name>".
- [ ] Set up mounts `TeammateSetup` in the card's place. When it finishes: the trial `found` list, rows like V3NewInstall-home
      ("<title>" with labels), or the empty line "Nothing to show yet; <name> keeps watching." Then **Continue**.
- [ ] Below: "Everyone Aiden can bring in", a fluid `auto-fill minmax(300px, 1fr)` grid of every other catalog
      teammate (`.enter` stagger). Each card: `TeammateChip`, job, sample in quotes, and **Set up next** / **Later**
      (toggles; writes `PUT /api/teammates/queue`). The suggestion (D11) shows `Tag` "Suggested for you". Link
      "Browse all teammates →" goes to `#/team/hire`.

Screen **reach** (V3NewInstall-reach): heading "Where should your team reach you?"
- [ ] Three `OptionCard`s (`type: "radio"`, `name: "reach"`; Telegram with `badge` "Recommended"), Slack DM, Only this board. Each card's hint comes
      from the mockup copy.
- [ ] Telegram picked and not paired: `<SetupFlow inline module="channel-telegram" />`. Slack picked and the bot
      isn't set up: `<SetupFlow inline module="slack" path="advanced" />`. The kit `Disclosure` hides the flow once done.
- [ ] **Send a test** (Telegram/Slack only) calls `api.notifyTest(transport)`. It shows "Sent ✓ · Send again" on
      `sent`, or the reason ("not set up yet", "the transport answered 502") with Try again. The preview panel shows
      the test card's text and its two inert buttons.
- [ ] **Continue** files `{ kind: "setting", key: "notify_transports", value: [picked] }` (Only this board: `[]`), only
      when it differs from the current value, then finishes.
- [ ] Finish: `api.welcomeFinish()`, then `go("#/")`. The bar keeps "Finish setup later" (finish from any screen).
      The old dots bar is replaced by `Stepper`.

Home **day one** (V3NewInstall-home): `GettingStarted` sits above Home's sections. It shows the Stepper (`current` 2) "Step 3 of 3 ·
Your home" only during the welcome session (sessionStorage), then the Next up card ("Set up <name>" → `#/team/hire?setup=<key>`;
"Later" moves the key to `later`), then the "More your team can do" row of faces with "See everyone →" to
`#/team/hire`. The first result is Home's own world/team blocks; nothing is duplicated.

- [ ] Verify with the mock API at all widths (final section).

### Task 10: Hiring page `#/team/hire`

**Files:** Create `services/board/web/src/Hire.tsx`, `hire.css`. Modify `App.tsx`: phase 2's `#/team/hire` route
renders `Hire`; query `?setup=<key>` opens that row's setup, and `?install=<id>` that id's.

**Interfaces**
- Consumes: `GET /api/teammates` (`HireRow[]`), `TeammateSetup`, and kit `Face`, `TeammateChip`, `Disclosure`, `DetailPane`, `SectionCard`, `Segmented`.
- Produces: `export function Hire({ onSignIn }: { onSignIn: () => void }): JSX.Element`, which takes the URL params `setup`, `install` and `chat`.

Layout per V3Hiring-1512: `PageHeader` "Hire a teammate", subline, action link "Browse raw modules →" to `#/team/modules`.
- [ ] The "Describe who you need" band (`SectionCard`, Archie's `Face`) opens the describe flow (Task 11).
- [ ] Controls row: search `Input` (matches name, job, description, module, tool names from `connections`); `Segmented`
      **Show**: Available | On your team (n) | one segment per marketplace name ("AidenHQ" for `aidenhq`); `Segmented`
      **Area**: All + each department present. Narrow widths wrap the controls under the search.
- [ ] Grid `auto-fill minmax(320px, 1fr)` of cards (`.lift`). Each card: `Face` (`seed` = key, plus `src`/`kit` from
      `row.face`). A browse row with no kit gets a monogram tile instead (the initials of `job`, hue from
      `hueClass(key)`), since its features would otherwise hash from a stranger's key; "Name · Job"; marketplace line; description; a
      `Disclosure` "Advanced" listing `module`, `requires` and connections; a `Tag` "On your team" / "Not hired"; and
      **Hire** (primary).
- [ ] Hire opens a `DetailPane` holding `TeammateSetup` with `nameStep`. On done, the pane shows the trial result and
      "Open <name>" (`#/team/<key>`).
- [ ] Empty states (`EmptyState`): no match ("Nothing matches … Describe who you need instead" → describe), no
      third-party marketplace ("Add a marketplace" → `#/team/modules`).
- [ ] Verify at all widths with the mock API.

### Task 11: Describe flow (Archie)

**Files:** `Hire.tsx` (describe view, steps per V3Hire). Modify `modules/tasks/connections/tasks-mcp/src/tools.ts`
(`fleet_catalog`), `modules/agent-builder/module.yaml` (skills), the Architect's `AGENTS.md` (step 1, §2 Definition,
step 4), create `modules/agent-builder/skills/hiring/SKILL.md`, and edit the templates' `module.yaml` (`teammate:`).

**Interfaces**
- Consumes: `api.newChat(text, agentKey)`, `api.chat(ref)`, `openQuestions`, `AnswerForm`, and `api.answer(ref, body, waitSince)`.
- Produces: `fleet_catalog` `section: "agents" | "mcp_servers" | "apps" | "teammates" | "modules"`; skill `agent-builder.hiring`.

Page, as a `Stepper`: Describe → Look for existing → Set up.
- [ ] **Who builds:** the agent holding grants role `architect` (`services/board/src/grants.ts`), resolved
      server-side into `GET /api/teammates` as `builder: { key, name, face } | null`, never the key `architect` in
      code. With no holder (agent-builder off), the describe band reads "To describe a teammate, hire <the
      agent-builder module's teammate> first" and its button opens that row's Hire.
- [ ] **Describe:** a `textarea` with three example chips (mockup copy), the "Where we look first" side card, and
      primary "Look for existing teammates". Submit = `api.newChat(text, builder.key)`, then keep `identifier` in
      the URL (`?chat=<id>`) so a reload resumes.
- [ ] **Look for existing:** poll `api.chat(id)` every 4 s while visible. Until a form arrives: a skeleton shaped like
      the match list, plus "Archie is looking in your team and marketplaces". When `openQuestions(chat.messages)`
      returns the form: render its message text (markdown) above `AnswerForm` (`askedAbove`). `onAnswer(label)`:
  - `Install <name>@<mkt>` matching a row (D14): the page answers Archie with the label (`api.answer(id, label,
    chat.state.wait_since)`), then step 3 = `TeammateSetup` for that row (`nameStep`).
  - `Extend <key>` matching an on-team teammate: answer Archie, then show "<builder> is adding this to <name>; you'll
    see the change for approval." with a link to the chat on `#/team/<builder.key>` (A3).
  - Anything else (Build new, free text): answer Archie and hand off to the chat on the builder's teammate page (A3).
- [ ] `fleet_catalog`: the `section` enum adds `teammates` and `modules`. `teammates` = every catalog teammate with
      `{key, name, job, sample, description, department, module, id, marketplace, on_team}`. `modules` = the slim
      catalog rows (Task 2). A row with `browse: true`, or any non-`aidenhq` marketplace, has its strings wrapped with
      the SDK fence (`src/aidenhq-sdk/fence.ts`, already synced into tasks-mcp) and `untrusted: true`. `query` filters as today.
- [ ] `hiring/SKILL.md`: on a hiring description, call `fleet_catalog` (`teammates`, then `modules` with a query) and
      ask at most one clarifying form first if the job is unclear. Then answer with **one form**, at most 4 options,
      best first, using exactly: `Extend <key>` (an on-team teammate whose job covers part of it, via a local-module
      routine/skill as the existing "Change agent" path), `Install <name>@<marketplace>` (copy `id` exactly; never
      invent one), `Build new`. The form text gives one plain line per option: what it covers, what it needs
      connected, and for a third-party module "from <marketplace>, reviewed when installed". On an `Install …` answer
      the owner installs from the hiring page: reply once ("Setting it up from the hiring page") and `task_finish`.
      On `Extend …`, continue as "Change agent". On `Build new`, continue the six steps.
- [ ] Architect handbook: step 1's first bullet ("First check whether an existing agent already does this") links the
      hiring skill instead of restating it. §2 Definition: a user-facing agent gets `teammate: { job, sample }` in its
      local `module.yaml` entry (phase 1 field), and a helper agent gets none. Step 2's chat review form ("Build it?")
      adds the question "What should we call them?" (suggested name first, two alternatives), and the Primer path asks
      it in the lock reply (D13). The design also proposes a `FaceKit` (`teammate.face`), and the owner adjusts it with phase 1's face picker
      in the build path, by its phase 1 name. Add `agent-builder.hiring` to `architect.skills`.
- [ ] Templates (`modules/agent-builder/templates/*/module.yaml`): each user-facing template agent gets a `teammate:` block.
- [ ] Verify: `cd modules/tasks/connections/tasks-mcp && npm test` (Task 13's case); `node scripts/compile.ts` passes
      (skill lists resolve).

### Task 12: Aiden's ideas and page-kit sync

**Files:** Create `modules/chief-of-staff/skills/ideas/SKILL.md`. Modify `modules/chief-of-staff/module.yaml` (label
`idea`; `chief-of-staff.ideas` in `chief-of-staff.skills`; the daily-brief routine description gains "then follow your
ideas skill"), the chief-of-staff `AGENTS.md` (replace "First chat with a new owner" with one line linking the
skill). Modify `services/shared/page-kit.css`, `services/board/web/src/ModuleView.tsx` (`TOKENS`), and
`scripts/sync-shared.ts` (page-kit copy list).

**Interfaces**
- Produces: label `idea`, skill `chief-of-staff.ideas`, and idea tasks carrying one owner question. Phase 2's Home
  `idea` block consumes them as they are.
- Produces: a `hostContext().styles.variables` that is a superset of today's (MCP Apps standard names only), and the
  `page-kit.css` classes `.card .head .row button .primary .tag(.ok|.needs|.failed)`.

- [ ] `ideas/SKILL.md`: an idea takes two steps, because owner-channel binds a question's wait only to the task the
      asking agent is running on (`notify.ts`: `resolved?.agentId === caller?.id`):
      1. From the triggering run, file the idea: `task_create`, label `idea`, assignee himself, title the
         suggestion, description the context.
      2. The assignment wakes him on the idea task. There he sends `notify` `kind: decision`, `task: <idea>`, with
         one question and two options: first the exact words that do it, then `Not now`.

      At most one open idea at a time.
      - **Not now** closes it (`task_cancel`). The same idea isn't offered again for 30 days (memory note).
      - **A paused routine:** the first option names it ("Resume the daily brief", 12+ characters), so the answer is
        the owner's own words for `fleet_control` `resume_routine`. Confirm that a board `/answer` comment passes
        `relayableWords` (`services/board/src/fleet.ts`): the owner's account, no `<!-- aidenhq-` marker. If it
        doesn't, that is a defect to fix in `relayableWords` for wait-bound answers, in this PR.
      - **A teammate:** the option is "Set up <Name>", and the reply links `#/team/hire?setup=<key>`. It never installs
        anything itself.
      - **Triggers:** the welcome task (D12) and the end of each daily brief.
      - **Sources of ideas:** the owner's Set-up-next queue (from the board's catalog, never guessed), paused routines
        worth turning on (the tour's old point 5 moves here), and skipped connections. The spec's "Yes / Not now" is
        read as "the doing words / Not now".
- [ ] Page kit: `ModuleView.TOKENS` sends the MCP Apps standard variables the board has tokens for. Add
      `--color-background-tertiary`, `--color-background-info|danger|success|warning`, `--color-text-tertiary|info|success|warning`,
      `--color-border-secondary`, `--border-radius-xs|sm|lg`, `--shadow-sm|md|lg`, `--font-text-xs-size|sm-size|md-size`,
      each mapped to the board token in one table. `page-kit.css` restyles its buttons (`button`, `.primary`), rows,
      `.card`/`.head` (section header with title + meta + action), and tags (a new `.tag` with `.ok/.needs/.failed`)
      to the board kit's look (radius, hairline borders, hover lift, press scale, focus ring, reduced motion), only
      through those variables with neutral fallbacks, so Claude's host theme maps too. No new markup contract: the
      existing class names keep working.
- [ ] `sync-shared.ts`: the page-kit copy list covers every module whose `mcp.ts` inlines it (grep `page-kit.css` under
      `modules/*/service/src/mcp.ts`; today ship, maintainer, code-review; sessions inlines it too, so add it only if
      it has a `page.html`). Run `node scripts/sync-shared.ts`; `scripts/test/shared.test.ts` stays green.
- [ ] `web/dev/example-view.html` does not use the kit today. Give it the `/*kit:css*/` and `/*kit:js*/` markers,
      and have the mock API inline `services/shared/page-kit.{css,js}` there, as `mcp.ts` `pageHtml` does. The mock's
      Notes page then shows the shared kit.
- [ ] Verify: open the mock's Notes module page (`#/team/m/notes`) in both themes. Its buttons, rows, tags and
      section header read like the board's.

### Task 13: End-to-end checks (minimal; the only new tests)

- [ ] `scripts/test/remote-sources.test.ts`, test "a third-party marketplace's listing is browsable without
      installing it, and a broken entry is skipped": the `marketplace()` helper with two plugins, `twin` (good, with
      an agent whose AGENTS.md has a `teammate:` block) and `broken` (`module.yaml` name mismatch). Instance lists the
      marketplace and no modules. `compile` succeeds. Assert: the catalog has a `twin` row with `browse: true`,
      `marketplace: "acme"`, `teammates[0].job`. There is no `broken` row, and `warnings` names it. Delete the
      marketplace repo dir, compile again, and the twin row is still there (the cache hit).
- [ ] `kernel/test/settings-change.test.ts`, test "a module installs by name@marketplace; the same bare name from
      another source is refused": `{kind:"module", name:"twin@acme", on:true}` writes `twin@acme` into `modules:`.
      With `twin` already enabled from another marketplace, it is refused with "already installed from".
- [ ] `kernel/test/notify.test.ts`, test "a push test reaches only the named transport and reports its answer":
      `testHosts: true`, two fake transports on 127.0.0.1. `test("channel-telegram")` posts once to that one only,
      with `inert` and without `actions`; it returns `{sent: true}`. A transport answering 502 returns `{sent: false,
      reason: /502/}`. `owner_notify` has no rows.
- [ ] `services/board/test/teammates.test.ts`, using the board's existing fake Paperclip (`test/kernel.ts`,
      `fake-states.ts`), one flow test: a catalog with open-loops (teammate `open-loops`, requires intake), intake
      (hidden `inbox-agent` with routines `inbox-scan` paused scheduled and `inbox-lookback` trial, plus a teammate
      agent `notes` with a paused `notes-scan`), and chief-of-staff (teammate, paused `daily-brief`). `POST
      /api/teammates/open-loops/start` resumes `open-loops-sweep` and `inbox-scan`, but neither `notes-scan` (another
      teammate inside the closure, D9) nor `daily-brief`, and runs `inbox-lookback` once. A second call runs nothing new. `GET
      …/trial` lists a task the fake created as `inbox-agent`. `PUT` then `GET /api/teammates/queue` round-trip per
      account. `POST /api/welcome/finish` files one board task (source `welcome`) and creates no chat.
- [ ] `modules/tasks/connections/tasks-mcp/test/server.test.ts` (one case): `fleet_catalog {section: "teammates"}`
      returns a browse row with its description fenced and `untrusted: true`.
- [ ] `ops/test/unattended-install.sh` (lines ~251-285 as of 73e688a92): `/api/welcome` has no `wizard`. Finish with
      `{}` returns `{ok: true}`. The stub records one created issue assigned to Aiden carrying `source:welcome` and
      no chat. Keep the second-finish no-op and the marker assertions.
- [ ] Run each under `perl -e 'alarm shift; exec @ARGV' 600 …`, then `pkill -f "${WT:?}/"`. Expected: all pass.

### Task 14: Deletions and docs (one way)

- [ ] **`wizard` flag:** delete it from `modules/board/schemas/setup_flows.json`, `services/board/src/setup-flows.ts`
      (`SetupFlowPoint.wizard`), `services/board/web/src/api.ts` (`SetupFlowView.wizard`, `WelcomeState.wizard`),
      `modules/channel-telegram/module.yaml`, `modules/slack/module.yaml`, `modules/google/module.yaml` (and their
      comments that mention "the first-run wizard"), and `web/dev/mock-api.ts` (`welcome()`). Grep `wizard` under
      `services/board`, `modules` and `scripts`; expect only prose that names the new onboarding, or nothing.
- [ ] **Aiden's welcome chat:** delete `welcomeText` and the `post` dependency (welcome.ts) and `OPERATOR` (app.ts),
      and replace the "First chat with a new owner" handbook section (Task 12). Grep `\[setup\]` across `modules`,
      `services` and `scripts`; expect no hits.
- [ ] **"Manage AidenHQ from your Claude" moves to Settings, not deleted.** Move `mcpSteps` and `cloudReachable`
      unchanged from `Welcome.tsx` into a "Connect your Claude" section on Settings (`Settings.tsx`, in the
      general/account category; a `SectionCard` holding `Steps` with the commands and the claude.ai line). Delete the
      `mcp` screen from Welcome.
- [ ] **Wizard screens:** delete the `flow` and `summary` screens, the welcome
      dots bar and `welcome-list` CSS. Delete `welcome.css` rules no longer used (stylelint finds the rest).
- [ ] Docs: `docs/design/guided-setup.md` describes the three onboarding screens and Settings' "Connect your Claude". `docs/design/quiet-start.md` §3 replaces "Aiden's tour" with "Onboarding resumes a set-up
      teammate's routines; Aiden's ideas offer the rest". `docs/configuration.md` gains teammate `first` and routine
      `trial`. `docs/design/board-ui.md` gains a short "Onboarding and hiring" paragraph (TeammateSetup is the one
      setup sequence). Update the READMEs of intake, owner-channel ("push test"), agent-builder and chief-of-staff.
- [ ] Run a security review of the new paths before switching them on (CLAUDE.md "Every new path gets a security
      review"): third-party browse text into the board and the Architect, the board-keyed `/v1/notify/test`, the
      qualified install, and `teammateStart` resuming routines as the owner. Each finding gets a fix with a test.

## Mockup vs spec (the spec wins; noted for the reviewer)

- V3NewInstall's HTML still has the "What eats most of your week?" screen: dropped by the owner, not built.
- V3NewInstall's roster shows "Aiden · Morning brief" and "Aiden · Inbox triage" cards. Those aren't catalog
  teammates; Aiden's routines are offered as ideas (Task 12).
- V3Hire-existing's rich match cards (Extend Rhea / Install … / Build with Archie) are rendered as Archie's form through
  `AnswerForm` (spec §5). The form text carries the per-match line.
- V3Hiring's Area labels become department names (D4). Monogram tiles are only for third-party browse rows without a
  kit face. Every official teammate draws its `Face` (file, kit or key-hashed).
- The reach preview shows the real test text, not a Tess-specific draft.

## Review, PR, verification

- [ ] Local Codex review before pushing: `codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`
      (background; read the file). Fix every important finding. Re-runs: `--base <last reviewed sha>` at `low`.
- [ ] PR title: `feat(board): onboarding and hiring`, opened with label `ship:stop` until verification is done. The body
      lists the D-decisions, the flagged contract gaps (D1, D4, A1-A4, D5's deviation, D15) and "what this phase removes".
- [ ] Board checks: `cd services/board && npx tsc -p tsconfig.build.json --noEmit && npm run lint && npx vitest run`.
      Also run CI's suites the change touches: `scripts#2`, `kernel`, `services/board`, `modules/tasks/connections/tasks-mcp`,
      telegram, slack-live, owner-channel.
- [ ] UI with the mock API (`node web/dev/mock-api.ts` + `npm run dev:web`). The mock gets fixtures for `/api/teammates`
      (official + one `acme` browse row, one on-team), `/api/teammates/<key>/start|trial` (trial goes running → done
      with 4 found after 3 s; `?empty=1` → none found), `/api/teammates/queue`, `/api/notify/test` (sent; `?slow=`
      delays), `/api/welcome` (no `wizard`), Home `start`, `builder` on `/api/teammates`, and the builder's chat
      answering a description with the form `[Extend assistant, Install twin@acme, Build new]`. Turn the wizard on with
      `GET /__mock?welcome=1` (and `?empty=1`, `?slow=800` for the empty and loading states), then screenshot
      `#/welcome` (first, after setup, reach with Telegram open), `#/` day one, `#/team/hire` (Available, On your team, Area filtered),
      `#/team/hire?chat=…` (form), and a module page, at **1512x982, 1920x1080, 2560x1440, 1024, 768 and 390** wide,
      light and dark, plus one pass with `prefers-reduced-motion: reduce`. Stop vite and the mock after (`pkill -f "${WT:?}/"`).
- [ ] Deploy after merge per the deploy flow; on the instance, run one real onboarding pass with a TEST account only if
      the owner asks (E2E checks stay manual).

## What this phase removes

- Aiden's welcome chat (`welcomeText`, the board posting as `OPERATOR`) and his six-point "First chat with a new owner"
  tour. **Dropped behaviour:** the tour's points 1-4 (what Aiden can do, how he asks, agents and apps, what else to set
  up) are now covered by the onboarding screens and hiring. Point 5 (offering paused routines) moves to ideas.
- The first-run wizard's per-module `wizard` flow screens and the summary screen. The MCP commands screen moves to
  Settings › "Connect your Claude" with the same content, so no behaviour is dropped there.
- The `wizard: true|false` setup-flow field (schema, three module.yamls, board types, mock).
- `POST /api/welcome/finish`'s `{done, skipped}` body and its `identifier` answer.
- `docs/design/quiet-start.md` §3's "Aiden's tour" line.
- Not removed: Modules' own Turn on (it now also installs browse rows by qualified id), `#/setup/<module>` pages
  (unchanged, still the full-page flow), and owner-channel's routing (the push test bypasses it on purpose).
