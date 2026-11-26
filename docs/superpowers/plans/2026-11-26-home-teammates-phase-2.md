# Phase 2: IA, Home, Team pages, Ask Aiden

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (native execution). Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** The board opens on Home. Home shows what needs the owner (answered in place), what the team did since the
owner last looked, the owner's world and the teammates with news. Team holds named teammates with their own pages and
chats, Ask Aiden is a ⌘J side panel, and approvals become Needs-you rows. The Chat, Approvals and Fleet sections are gone.

**Architecture:** One new server read, `GET /api/home` (`services/board/src/home.ts`), builds needs, since, world, team and
idea in one SWR-served response, keyed per account. Its two module reads (owner-channel's `notify_recent` ledger and
google's `calendar_today`) go through a new declared point, `board.reads`. Compile puts each read on its connection's
kernel `views` table, so the kernel's existing view route (`kernel/src/views.ts`) passes it as an owner call. One
server predicate, `isTeammate`, read from the compiled config and never from Paperclip metadata, gates every chat
entry point. The web app derives its view from the route (no `savedView`) and builds Home, Team, the teammate page and
Ask Aiden only from the phase-1 kit, reusing today's chat `Conversation` as the chat pane.

**Spec:** `docs/superpowers/specs/2026-11-26-home-and-teammates-design.md` §2, §3, settled #2, #4, #5.
**Index (fixed contracts):** `docs/superpowers/plans/2026-11-26-home-teammates.md`.
**Mockups:** `docs/superpowers/plans/2026-11-26-home-teammates-mockups/` V3Home (1512/1920/390, answered), V3Agent,
V2Team, V2AskAiden, V2PhoneHome.

**Builds on (phase 1, consumed exactly as the index names them):**
- `services/board/web/src/ui/index.ts` exports `Face`, `TeammateChip`, `DecisionRow`, `DetailPane`, `DigestList`,
  `SidePanel`, `Disclosure`, `Kbd`, `SectionCard` (Stepper and OptionCard are phase 3's), plus the tokens `--page-max`,
  `--ease-out`, `--ease-in`, `--enter-y`, `--stagger` and the classes `.enter` (with `--i`), `.lift` and `.press`.
  Props, exactly as phase 1 exports them; never restyle a component in a page:

  | Component | Props |
  |---|---|
  | `Face` | `{seed, src?, kit?: FaceKit, state?, size? (16–96), label}` |
  | `TeammateChip` | `{agent: RosterAgent, state?, size?, job?, href?}`, plus `faceStateOf(agent, needsYou?)` |
  | `DecisionRow` | `{face, who, role?, question, detail?, meta?, overdue?, actions?, receipt?: {text, onUndo?} \| null, active?, onOpen?, i?}` |
  | `DetailPane` | `{open, title, onClose, actions?, children}` |
  | `DigestList` | `{items: {id, face?, text, link?}[], limit?, more?}` |
  | `SidePanel` | `{open, onClose, title, sub?, face?, headerActions?, footer?, children}` |
  | `Disclosure` | `{summary, defaultOpen?, children}` |
  | `SectionCard` | `{title, meta?, count?, action?, flush?, children}` |
  | `Kbd` | none |

  `--page-max` is defined by phase 1, and **applied by this phase** (Task 7: the frame's page container).
- `RosterAgent.teammate?: {job, sample, staff, controls, face: {src: string} | {kit: FaceKit} | null}` on
  `GET /api/agents/roster` (`src` = `/api/faces/<key>`). A face renders as `<Face seed={key} src={face.src}
  kit={face.kit} …/>`.
- The compiled agent (`config/paperclip.yaml` agents, read by `readSources(settingsFiles()).compiled`) carries
  `teammate: {job, sample, staff, controls, face}`.
- The rename is the existing agent change `{kind: "agent", agent: <key>, field: "name", value: <name>}` (owner only),
  with its name rule in `services/shared/teammate-name.ts`.
- Pause (index): pauses **only** the teammate, never its staff.
- `/api/needs-you` items carry `ask.detail?: string`.

## Decisions this plan makes (designer's calls; "Deviations from the index and spec" at the end lists the ones that differ)

1. **`board.reads` point** for the board's own owner-view reads: `{id, connection, tool}`. The tool is any read tool of
   one of the contributing module's own connections (never write or destructive, never a write kind's). There is no
   `<module>_…` name rule, because the owner MCP never serves reads (the name rule exists only because it serves page
   tools side by side). Compile writes `views["read:<id>"] = [tool]` on that connection, the kernel's view route
   refuses `resources/read` of any view not starting `ui://`, and the board calls `read:<id>`. Two reads ship:
   google `calendar_today` and owner-channel `told` → `notify_recent`.
2. **Teammate predicate reads the compiled config** (`compiled.agents[key].teammate`), mapped to Paperclip ids by the
   grants table (`agentIdByKey`, as `/internal/chat` already does), because agents can edit Paperclip metadata.
3. **Every admin account is an owner** (CLAUDE.md, the coordinator's ruling over spec settled #5): every board account
   sees Needs you, Ideas and approvals. The reduced Home (no Needs you, no onboarding) is only for non-admin roles,
   and none reach the board today (`handleApi` 403s role `user`, app.ts ~2619-2625). So this phase builds no reduced
   variant and adds no owner flag. Last-visit and snoozes are still stored per account, which keeps the team version
   open.
4. **Since window per visit.** The first response's `since_from` is pinned by the client and sent back as `?from=` on
   live refetches in the same visit, so the block doesn't empty while the owner reads it. `POST /api/home/seen` is
   monotonic (max of stored and posted, never past now). The first visit (no cursor) looks back 24h. The window is
   capped at 14 days, the ledger's age.
5. **`#/c/<ref>` goes to the task drawer** `#/t/<ref>` (one way to open any task by id). `#/c/` and `#/c/?text=…` open
   Ask Aiden with the text. `#/c/lane:<key>` and `#/c/?to=<id>` go to `#/team`. Every in-app emitter is rewritten, so
   only old links hit the redirect.
6. **Module pages** of a module (today's `#/modules/<name>/<tab>`) live at `#/team/modules/<name>[/<tab>]`. A hidden
   agent's page (today's `#/agents/<key>/<tab>`) lives at `#/team/agents/<key>[/<tab>]`. Neither is in the index's
   route list. They are added as children of the index's `#/team/modules` and `#/team/agents`. Teammate keys can never
   be `hire`, `agents`, `modules` or `m`: parseRoute matches those first, and compile already restricts keys to
   `[a-z0-9-]` (phase 1 adds the four to its reserved list; if it didn't, this phase adds them in `scripts/modules.ts`).
7. **Approvals history** (decided cards, Tier 0 audit rows, live claimed records with their wait, the filters) moves
   to **Insight › Decisions**, `#/insight/decisions`. It is code that moves, not a drop (owner rule: each dropped
   behaviour needs his OK). The route is new and flagged.
8. **Chat list**: `GET /api/chats` stays the one list route. It gains `?agent=<key>&offset=<n>&state=active|settled`,
   a per-agent page with no fleet-wide 20 cap, which finds handed-back chats by their description marker
   (`chatAgent`). The teammate page's chat history and Ask Aiden's history read it, each with an Active / Settled
   filter (`Segmented`). So the Settled list stays reachable per agent. The cross-agent `SettledList` component and
   `GET /api/settled` (its fleet-wide search) are deleted. The unfiltered list stays only for ⌘K's chat entries.
9. **Top bar** follows spec decision 2 exactly. Each old item gets a home:
   - **Spend meter:** moves to the Insight section's label, as a small ticker on "Insight".
   - **Notify me:** becomes a one-line dismissible `Banner` on Home.
   - **Brief and help icons:** stay on their keys (`b`, `?`) and in ⌘K.
   - **Active-runs chip:** becomes Team's live dot.
   - **Pinned app panels:** Apps shows its SubNav only when panels exist.
10. **Hire a teammate** tiles (Home, Team) open Archie's teammate page in phase 2 (`#/team/architect`, which is today's
    "+ New agent" path). Phase 3 points them at `#/team/hire`. Phase 2 doesn't register `#/team/hire`, so no
    half-built page ships.
11. **"You promised"** (in the mockup) is not built (spec: it waits for a structured `due`). **Ideas** show one at a
    time with no "1 of 3 / Next idea": Not now closes the shown one and the next appears. **Waiting-on rows** show age
    and quiet days, not "overdue", because due dates live in prose, not a field. **Sends have no Undo** (the spec wins
    over the answered mockup's "Undo"): the receipt says "Tess is sending it".

## File structure

**Server (`services/board/src`)**
- `home.ts` (create): `buildHome()`, the snapshot, plus its pure helpers (dedupe, since grouping, next-08:00).
- `teammates.ts` (create): `teammateKeys()`, `isTeammate()`, `teammateFor()` (staff → teammate attribution).
- `module-views.ts` (modify): `ReadPoint`, `readPoints()`, `host.read()`.
- `store.ts` (modify ~160-200 schema, new methods): `home_seen` and `home_snoozes` tables.
- `chats.ts` (modify 19-33): `pickAgent` takes only teammates.
- `crew.ts` (modify 146-165): `mentionedAgents` gets a teammate-filtered list from its caller (no signature change).
- `app.ts` (modify): the routes listed in Tasks 3–5; delete `GET /api/settled` (2396).
- `main.ts` (modify 86-87): pass `readPoints(pointsFile)` to the view host.
- `mcp.ts` (modify 502, 526): page opener link `#/team/m/<id>`; the card link stays `#/approvals/<id>`.

**Module / compile / kernel**
- `modules/board/schemas/reads.json` (create); `modules/board/module.yaml` (modify `points:`): `reads`.
- `scripts/modules.ts` (modify ~669-700, call site 1310): `moduleReads()` beside `modulePages()`.
- `kernel/src/views.ts` (modify 24-26): `resources/read` only for `ui://` views.
- `modules/google/module.yaml` (modify `contributes`, `tools.read`, service env): `calendar_today` + `board.reads`,
  `OWNER_TIMEZONE: "${settings.timezone}"`.
- `modules/google/connections/google-workspace-mcp/src/main.ts` (modify, near 124-146): register `calendar_today`.
- `modules/owner-channel/module.yaml` (modify): `requires: [board]`, `contributes: board.reads: told`.

**Web (`services/board/web/src`)**
- `Home.tsx` + `home.css` (create): the Home page, NeedsList, Since, World, Team row, Idea.
- `needs.ts` (create): the needs keyboard model and the snooze/answer/decide actions (pure + hooks).
- `Team.tsx` + `team.css` (create): the Team list.
- `Teammate.tsx` + `teammate.css` (create): the teammate page (chat pane + side column).
- `AskAiden.tsx` (create): the side panel, `openAsk()` event helper, ⌘J.
- `Conversation.tsx` (create by moving out of `Workspace.tsx`): `Conversation`, `Composer`, `MessageView`, `AskView`,
  `LiveRow`, `DetailsPanel`, outbox. `Workspace.tsx` is **deleted**.
- `ApprovalCard.tsx` (create by moving out of `Chat.tsx`): `ApprovalCard`, `Decide`, `BatchBar`.
- `Decisions.tsx` (create by moving `AllApprovals` history and `HistoryRow` out of `Chat.tsx`): Insight › Decisions.
  `Chat.tsx` is **deleted**.
- `App.tsx` (modify): Route type (67), parseRoute (112-175), view state (188-275), keys (595-680), render (744-1030).
- `Shell.tsx` (modify all of 12-250, Palette 270-300): new sections, TopNav, SubNav, BottomBar, palette entries.
- `queries.ts` (modify 25-122): `home`, `agentChatsQuery`, VIEW_QUERIES, `landsOnBoard`, `preloadBoot`.
- `api.ts` (modify ~281-310): `home(from?)`, `homeSeen(asOf)`, `homeSnooze(id, on)`, `chats(agent?, offset?)`.
- `Drawer.tsx` (modify 399, 538, 992): its composers' @-mention crew is teammates only (a chat opened by id lands here).
- `types.ts` (modify): `Home`, `NeedRow`, `SinceItem`, `WorldBlock`, `TeamNews`, `IdeaRow`.
- `Attention.tsx` (modify): failed/idle only, rendered on Team › All agents; the needs tab and its AnswerForm go.
- `AgentPage.tsx` (modify 28-29, 44, 67, 84, 98, 213-233): routes under `#/team/agents`, Chats tab deleted, Chat /
  Give-it-a-task only for teammates (→ `#/team/<key>`).
- `Agents.tsx`, `Modules.tsx`, `ModulePage.tsx`, `ModuleView.tsx`, `Sessions.tsx`, `Costs.tsx`, `Flow.tsx`,
  `Lineage.tsx`, `settings-ui.tsx`, `Settings.tsx`, `SettingsAgents.tsx`, `Apps.tsx`, `TaskTools.tsx`, `AgentWork.tsx`,
  `Welcome.tsx`, `notify.ts`, `sidebar.ts`, `LaneChat.tsx` (modify): links and imports (Task 12 lists each).
- `web/dev/mock-api.ts` (modify): fixtures for every new endpoint.

**Docs**
- `docs/design/board-ui.md` (rewrite), `CLAUDE.md` (line 174), `modules/AGENTS.md` (line 27, 39-42 "Fleet page" →
  "module page under Team"), `modules/board/schemas/pages.json` descriptions (`#/fleet/<id>` → `#/team/m/<id>`),
  `docs/design/sessions.md` (8, 11, 48), `docs/design/agent-and-module-pages.md` (22-69 routes),
  `docs/design/agent-work-board.md` (121, 266), `modules/chief-of-staff/agents/chief-of-staff/AGENTS.md` (25).

---

## Task 1: `board.reads`, the declared owner-view read

**Files:** Create `modules/board/schemas/reads.json`. Modify `modules/board/module.yaml` (`points:`),
`scripts/modules.ts` (after `modulePages`, ~700; call at 1310), `kernel/src/views.ts` 24-26,
`services/board/src/module-views.ts`, `services/board/src/main.ts` 86-87.

**Interfaces**
- Produces (schema): `{ id: string /^[a-z][a-z0-9_]{0,40}$/, connection: string, tool: string }`, additionalProperties
  false; compile adds `module`. `id` is unique across modules, and the board finds a read by `id` (the slot), never by
  module name.
- Produces (compile): `export function moduleReads(reads: Obj[], connections: Obj, kinds: Obj = {}): void`. It fails
  unless:
  - the connection is the module's own;
  - the tool is in `tools.read` or `tools.named` and not in `write`/`destructive`;
  - no write kind routes it;
  - the id is unique.
  
  It sets `c.views = {...c.views, ["read:" + id]: [tool]}`.
- Produces (board): `export interface ReadPoint { id: string; module: string; connection: string; tool: string }`,
  `export function readPoints(file: string): ReadPoint[]` (points file `reads`). `createViewHost` gains
  `reads: () => ReadPoint[]` and the method `read(id: string, args: Record<string, unknown>): Promise<unknown>`.
  The method throws `ViewError(404)` for an undeclared id. It throws `ViewError(502)` on a JSON-RPC error **or a
  result with `isError: true`**: the modules' caller refusals ("Refused: …") arrive as tool results, so treating
  them as data would hide a broken path. Otherwise it returns the parsed JSON of the first text content block.
  The kernel signs these calls `kind: "owner"` with empty `agent`/`key`. Both services' `verifyCaller`
  (`kernel/sdk/src/caller.ts` 31-56) accept that: it checks signature, `aud` and `exp` only. Neither tool reads the
  caller's key.
- Kernel: `views.ts` `resources/read` branch throws `view-refused` unless `view.startsWith("ui://")`.

- [ ] Add the schema and `reads: { schema: schemas/reads.json }` to board's `points:`; update board's description line.
- [ ] `moduleReads` in `scripts/modules.ts`, called right after `modulePages(...)` at 1310 with `points.board?.reads ?? []`.
- [ ] `views.ts`: the one-line `ui://` guard on `resources/read`.
- [ ] `module-views.ts`: `readPoints`, `host.read` reusing the private `send` (pass `{module, view: "read:"+id}` as the point).
- [ ] `main.ts`: `createViewHost({..., reads: () => readPoints(pointsFile)})`.
- [ ] Test (extend `scripts/test/setup-flows.test.ts`, the file that already compiles board points): a module contributing
  `board.reads: [{id: x, connection: own, tool: some_read}]` compiles to `views["read:x"] = ["some_read"]`. A write tool
  is refused with a message naming the read.
- [ ] Test (extend `kernel/test` for views.ts, the file that covers `/v1/views`): with a connection carrying
  `views["read:x"]`, a `tools/call` of the tool passes with an owner assertion, and a `resources/read` of `read:x` is
  403 `view-refused`.

## Task 2: the two reads (google `calendar_today`, owner-channel `told`)

**Files:** Modify `modules/google/connections/google-workspace-mcp/src/main.ts` (register beside
`calendar_list_events`, ~124-131), `modules/google/module.yaml` (`tools.read`, `contributes.board.reads`, service env),
`modules/owner-channel/module.yaml`.

**Interfaces**
- `calendar_today` (read, no args):
  `{ timezone: string; events: { id: string; start: string; end: string; title: string; all_day: boolean }[] }`.
  It covers today in `OWNER_TIMEZONE` (IANA; the instance `timezone` setting) on the primary account, using the existing
  `ws.listEvents(start, end, undefined, 50, undefined)`. It omits declined events and keeps the existing
  normalized-event shape fields only. Not signed in: the SDK's usual "how to connect" error (the board omits the
  block).
- google `contributes.board.reads: [{ id: calendar_today, connection: google_workspace, tool: calendar_today }]`.
- owner-channel: `requires: [board]` (the points rule in `scripts/compiler/points.ts` 35-38 demands it) and
  `contributes.board.reads: [{ id: told, connection: owner_channel, tool: notify_recent }]`.
  - Before adding it, confirm how core modules are enforced (grep `scripts/modules.ts` and `kernel/settings.json` for
    the core/required list; no list named "core" was found while planning).
  - Board is in the default bundle and is the owner UI, so requiring it changes nothing for a real install. If a test
    fixture enables owner-channel without board, add board to that fixture.

- [ ] Register the tool with `annotations: ro`. Add `calendar_today` to `tools.read`. Add
  `OWNER_TIMEZONE: "${settings.timezone}"` to the service env, as owner-channel does.
- [ ] Add one assertion to the google-workspace-mcp fixture test (`test/check.test.ts` or the file that already drives
  fixture mode): with fixtures for today and yesterday, `calendar_today`, called with an **owner-kind caller assertion**
  (empty agent/key, as `views.ts` 32 signs it), returns only today's events in the given zone.
- [ ] Add one assertion to `modules/owner-channel/connections/notify/test/told.test.ts`: `notify_recent` called with an
  owner-kind assertion returns the ledger rows (not a "Refused" result).
- [ ] `node scripts/compile.ts` on the default bundle succeeds, and `config/kernel/connections.json` shows both
  `read:` views.

## Task 3: teammate predicate and every chat entry point

**Files:** Create `services/board/src/teammates.ts`. Modify `src/chats.ts` 19-33, `src/app.ts` `startChat` 916-940,
`/internal/chat` 1243-1275, `POST /api/chats` 1950-1957, `GET /api/lane` 1959, lane POST 1961-1970, comments
2266-2300, and the `GET /api/chats` `agents` list (1877-1879).

**Interfaces**
- `export function teammateKeys(compiled: Compiled | null): Map<string, Teammate>` where `Teammate = { key: string;
  job: string; sample: string; staff: string[]; controls: string[]; face: string | null }`. It is read from
  `compiled.agents[key].teammate`.
- `export function isTeammate(agent: Agent, keys: Map<string, Teammate>): boolean`. The agent's key comes from the
  grants table (`agentIdByKey` inverse), never `metadata`.
- `export function teammateFor(key: string, keys: Map<string, Teammate>): string`. It returns the teammate whose
  `staff` lists `key`, else `key` itself if it's a teammate, else `"chief-of-staff"`. It attributes since rows, cards
  and needs from hidden agents ("Aiden · urgent").
- `pickAgent(text, agents)` is unchanged in shape. Callers pass `agents.filter(teammate)`, so `@Intake` falls back to
  Aiden with the existing note "(No agent called @Intake; sent to Aiden.)".

- [ ] `startChat`: the `named` lookup (919) only among teammates. An explicit non-teammate `agentRef` throws
  `HttpError(400, "<name> works behind <teammate>; ask <teammate> instead")`. This covers the owner MCP `ask`, which
  posts to `/api/chats`.
- [ ] `/internal/chat`: `to` must be a teammate, else `Refused("refused: <key> isn't a teammate; hidden agents work
  through their teammate")`.
- [ ] Lane: `laneAgents` results filtered to teammates in `GET /api/lane`, and lane POST refuses a non-teammate key.
- [ ] Comments: `mentionedAgents(text, ctx.assignees.filter(teammate))`. A mention of a hidden agent is plain text.
- [ ] `GET /api/chats` `agents` list: teammates only.
- [ ] Telegram and Slack owner messages reach agents through Aiden's chat and `/internal/chat` (tasks-mcp `open_chat`,
  `modules/tasks/connections/tasks-mcp/src/tools.ts` 2072). That path is covered above. Grep
  `modules/*/connections/*/src` and `modules/*/service/src` once more for any other caller of `/api/chats` or
  `/internal/chat` and gate it the same way.
- [ ] Test: extend `test/chat-routes.test.ts`. Its fixture gains a compiled-config file **and a grants file**
  (`AIDENHQ_GRANTS_FILE`, keys `chief-of-staff` → `cos`, `engineer-fleet` → `fe`), with `chief-of-staff` a teammate
  and the Fleet Engineer hidden:
  - `POST /api/chats {text:"@Fleet Engineer do X"}` → assigned to Aiden, with the note.
  - `POST /api/chats {agent:"fe"}` → 400.
  - `POST /api/issues/WOR-10/comments {body:"@FleetEngineer look"}` → no delivered part.

## Task 4: per-agent chats

**Files:** Modify `src/app.ts` `GET /api/chats` (1834-1888), `src/paperclip.ts` `labelled` (326-329: add
`offset = 0`), `src/app.ts` 2396 (delete `/api/settled`),
`src/store.ts` (delete `settledList` if nothing else reads it).

**Interfaces**
- `GET /api/chats?agent=<key>&offset=<n>&state=active|settled` (default `active`) →
  `{ chats: ChatRow[]; agents: ChatAgent[]; more: boolean; next_offset: number; stale?: true }`.
  - Open chats come from `openIssues()` with the chat label and `chatAgent(i) === id`.
  - Closed chats come from `labelled(chat, "done,cancelled", "100", offset)` filtered the same way. With `agent`, the
    route keeps reading 100-row pages from `offset` until it holds 25 of that agent's chats or a page comes back
    short, so other teammates' newer chats never hide this one's older ones.
  - `state=active`: open chats that aren't settled. `state=settled`: settled and finished chats, newest first, paged.
  - `more` is true when the last page read was full; `next_offset` (in the response) is the raw offset after it, which
    "Show older" sends as the next `offset`.
  - Rows are built by the existing `row()` with preview, unread and settled.
  - An unknown key returns 404.
  - Without `agent` the route is unchanged.

- [ ] Implement the filter inside the existing handler (one route, one row builder). Serve it under
  `served("chats:"+key+":"+state+":"+offset, …)` (the normalized state and the offset are part of the cache key, so Active,
  Settled and each "Show older" page are cached apart).
- [ ] Delete `GET /api/settled` and `store.settledList`. Keep `settle`/`unsettle`: `state=settled` reads them.

## Task 5: `GET /api/home`, `POST /api/home/seen`, snooze

**Files:** Create `src/home.ts`. Modify `src/store.ts` (schema ~160-182 + methods) and `src/app.ts` (three routes
next to `/api/needs-you`, ~1890).

**Interfaces** (`services/board/src/home.ts`, mirrored in `web/src/types.ts`):

```ts
export type FaceRef = { key: string; name: string; job: string; face: { src: string } | { kit: FaceKit } | null; state: "idle" | "working" | "needs" };
// `face` is the same value the roster route builds (phase 1's helper), never a second derivation.
export type NeedRow =
  | { id: string; kind: "answer"; teammate: FaceRef; since: string; task: { identifier: string; title: string };
      question: string; detail?: string; options: string[]; questions: Question[]; waitSince: string }
  | { id: string; kind: "approval"; teammate: FaceRef; since: string; task: { identifier: string; title: string } | null;
      question: string; card: Approval }
  | { id: string; kind: "open"; teammate: FaceRef; since: string; task: { identifier: string; title: string }; question: string };
export type SinceItem = { teammate: FaceRef; text: string; at: string; task: string | null; kind: "done" | "fyi" | "digest" | "closed" };
export type Home = {
  as_of: string; since_from: string; greeting: { needs: number };
  needs: NeedRow[];
  since: { groups: { teammate: FaceRef; latest: SinceItem; count: number }[]; items: SinceItem[]; total: number } | null;
  world: { waiting_on: { identifier: string; title: string; age_days: number; quiet_days: number }[] | null;
           today: { timezone: string; events: { id: string; start: string; title: string; all_day: boolean; prep?: string }[] } | null };
  team: { teammate: FaceRef; line: string }[];
  idea: { identifier: string; teammate: FaceRef; question: string; options: string[]; waitSince: string } | null;
};
export async function buildHome(d: HomeDeps, viewer: { accountId: string }, from?: string): Promise<Home>;
```

`HomeDeps` = `{ pc, taskStates, records, views (ViewHost), store, compiled: () => Compiled | null, roster: () =>
Promise<RosterAgent[]>, timezone, now? }`. It uses the app's existing helpers (`shownRows`, `askedQuestions`,
`boundQuestions`, `named`, `shownApproval`) passed in, never duplicated.

**Rules (values the spec pins):**
- `as_of = now` is captured **before** any read.
- **needs**:
  - A row is a task with owner attention (`why` ∈ `owner_wait`, `handback`, `card`) plus every
    `records.list("owner", {strict: true})` card.
  - A task whose attention is a `card` (`ref` = `record:<id>`) is that card's row, not a task row (dedupe).
  - A card on no listed task is its own row.
  - Ids are stable: the Paperclip task id for task rows, the card id (`k-…`) for card rows.
  - Kind: card → `approval`; `owner_wait` with an asked question → `answer` (`options` = first question's options,
    may be empty; `detail` = `ask.detail`); `handback`/other → `open`.
  - Tasks labelled `idea` are excluded.
  - Rows snoozed for this account with `until > now` are excluded.
  - Oldest first by `since`.
  - The teammate is `teammateFor(assignee or requester key)`.
- **since**:
  - Window: `from ?? stored cursor ?? now-24h`, clamped to ≥ now-14d.
  - Reads `views.read("told", {days, limit: 50, state: "delivered"})`, paging with `before` while the last row's `at`
    ≥ window, until the window is covered (the 14-day clamp bounds it; no page cap, so nothing in the window is left out
    while the seen cursor moves past it). It keeps kinds `done`, `fyi` and `digest`.
  - Also reads `pc.closedSince(window)`, paged the same way until the window is covered, kept only when `completedAt ?? cancelledAt` ≥ window, the task has an
    `assigneeAgentId` and it is not a `chat`.
  - Deduped by task identifier, the newest item kept. Rows with no task are never merged.
  - Text: unfence the ledger's fenced text, keep the first line, strip markdown marks, ≤200 chars (one helper,
    `oneLine`; reuse `chats.ts` 207 by exporting it). Closed tasks read "Done: <title>" when completed and
    "Cancelled: <title>" when cancelled (`cancelledAt` set).
  - Grouped by `teammateFor(source)`, where `source` is the agent key or `kernel` (→ chief-of-staff). Groups are
    sorted by latest. Groups and `total` count every item in the window; `items` is the newest 200 (the "All N" pane
    says when it shows fewer than `total`).
  - `null` when there are no items or the read is absent or fails (the failure is logged at warn).
- **world.waiting_on**: open tasks labelled `waiting-on`; `age_days` from `createdAt`, `quiet_days` from
  `lastActivityAt`. `null` when the label doesn't exist or no tasks.
- **world.today**: `views.read("calendar_today", {})`, cached 5 minutes in memory. An event's `prep` is the identifier
  of an open task whose description contains the event id. `null` when the read is absent, fails or has no events.
- **team**: each teammate with a since group gets `line` = its latest item's text, in group order.
- **idea**: the oldest open task labelled `idea` whose kernel state waits for an answer, with its question
  and options. `null` when there is none.
- **FaceRef.state**: `needs` if the teammate owns a need row, else `working` if the roster says working, else `idle`.
- **greeting.needs** = `needs.length`.

Store:

```ts
markHomeSeen(accountId: string, asOf: string): string   // stores max(old, min(asOf, now)); returns it
homeSeen(accountId: string): string | undefined
snooze(accountId: string, itemId: string, until: string): void
unsnooze(accountId: string, itemId: string): void
snoozed(accountId: string, now: string): Set<string>     // until > now; prunes expired rows
```

Tables: `home_seen (account_id TEXT PRIMARY KEY, at TEXT NOT NULL)` and `home_snoozes (account_id TEXT, item_id TEXT,
until TEXT, PRIMARY KEY (account_id, item_id))`.

Routes:
- `GET /api/home?from=<iso>`: `served("home:" + (from ?? ""), () => buildHome(...), 2_000)`. The SWR key already
  includes the viewer.
  - `swr.ts` serves a response at most `FRESH_MS` (1.5s) old as it is, and the last good one only when a refresh
    takes longer than `waitMs`.
  - So a `GET` right after `POST /api/home/seen` or `/snooze` could return the old snapshot. Both POSTs call
    `swr.forget("home:")` (add a prefix-forget to `swr.ts` if it has none) so the next read rebuilds.
  - The tests' steps 4–5 rely on that.
- `POST /api/home/seen {as_of}`: zod iso string; returns `{ seen }`; `store.events.emit("home")`.
- `POST /api/home/snooze {id, on: boolean}`: `until` = the next 08:00 in the board timezone after now
  (`nextEight(now, tz)`, in `home.ts`). Returns `{ until }`. `on:false` unsnoozes (the receipt's Undo).

- [ ] Write `home.ts` and the store methods. Register the three routes and add `"home"` to the events names
  (`src/events.ts` 9).
- [ ] Wire the existing watch so `approvals`, `tasks` and `chat` events also emit `home`, so Home refetches live.
- [ ] **E2E test** `test/home.test.ts`, built on `createApp` with `fakeStates`, `fakeRecords`, a fake view host whose
  `read("told")` returns ledger rows and whose `read("calendar_today")` throws, and `session` returning an owner. It
  asserts:
  1. A task whose attention is `card` record A1 appears once, as the `approval` row with id `k-…` A1. A second owner
     card with no task is its own row. An `idea`-labelled waiting task is not in needs but is `idea`.
  2. `since.items` has one item per task: a ledger `done` row and the same task closed in the window dedupe to one.
     A row from hidden `inbox-agent` is grouped under `chief-of-staff`.
  3. `world.today` is null (read failed) and `world.waiting_on` is null (no label). The response still 200s.
  4. After `POST /api/home/seen {as_of}`, a `GET` without `from` has `since: null`. `GET ?from=<since_from>` still has
     the items. Posting an older `as_of` doesn't move the cursor back.
  5. `POST /api/home/snooze {id, on: true}` hides that row, and `on: false` brings it back.

## Task 6: routes, view state and redirects (App.tsx)

**Files:** Modify `web/src/App.tsx` 67 (Route), 112-175 (parseRoute), 188-200 (VIEWS, `savedView` deleted), 252-275
(`setView`), 595-680 (keys), 744-1030 (render). Modify `web/src/queries.ts` 60-122.

**Interfaces**
- `type Route =`
  - `{kind:"home"; card?: string}` (`#/`, `#/approvals/<id>`)
  - `{kind:"tasks"; saved?: string}`
  - `{kind:"sessions"; ref?: string; fresh?: boolean}`
  - `{kind:"apps"; name?: string}`
  - `{kind:"team"}`
  - `{kind:"teammate"; key: string; chat?: string; text?: string}` (`#/team/<key>[/c/<ref>][?text=…]`, text pre-fills the composer)
  - `{kind:"agents"}`
  - `{kind:"agent"; key; tab}`
  - `{kind:"modules"}`
  - `{kind:"module"; name; tab}`
  - `{kind:"page"; id; sub?}`
  - `{kind:"insight"; tab: "costs" | "flow" | "decisions"}`
  - `{kind:"settings"; cat}`
  - `{kind:"task"; ref; focus?}`, `{kind:"run"; id}`, `{kind:"brief"}`, `{kind:"help"}`, `{kind:"design"}`,
    `{kind:"setup"; module; change?}` (unchanged)
- `view` is **derived**: `viewOf(route: Route): View`, where `View = "home" | "tasks" | "sessions" | "apps" | "team"
  | "agents" | "modules" | "page" | "costs" | "flow" | "decisions" | "settings" | "design"`. Overlay routes (`task`,
  `run`, `brief`, `help`, `setup`) keep the page under them. App holds `under: View` = the last non-overlay view
  (initially `home`), so `#/t/…` opens over whatever was showing.
- App keeps `underHash: string` = the last hash whose route isn't an overlay (initially `#/`), updated on every
  non-overlay route. That covers a teammate page, a module page or a saved board, not only a section.
  `closeOverlay(): void` = `go(underHash)`; it never calls `history.back()`, which would leave the board when the
  overlay came from a Telegram or Slack link. It replaces every `go("#/")` that meant "close" (lines 954, 962, 967,
  970, 980, 982, 1186) and the Escape branch at 603.
- `export function redirectOld(h: string): string | null`, called first in `parseRoute`. When it returns a hash,
  `history.replaceState(null, "", "#/" + it)` runs once:

  | old | new |
  |---|---|
  | `c`, `c/`, `c/?text=…` | `` (Home) and `openAsk({text})` after mount |
  | `c/<ref>` | `t/<ref>` |
  | `c/lane:<key>`, `c/?to=…` | `team` |
  | `approvals` | `` |
  | `agents`, `settings/agents` | `team/agents` |
  | `agents/<key>[/tab]` | `team/agents/<key>[/tab]` (`/chats` → `team/<key>`) |
  | `modules`, `settings/modules` | `team/modules` |
  | `modules/<name>[/tab]` | `team/modules/<name>[/tab]` |
  | `fleet/<id>[/sub]` | `team/m/<id>[/sub]` |
  | `reviews[/sub]` | `team/m/code-review[/sub]` |
  | `board[?view=<id>]` | `tasks[?view=<id>]` |
  | `sessions[/<ref>][?new=1]` | `tasks/sessions[/<ref>][?new=1]` |
  | `costs[?…]` | `insight/costs[?…]` |
  | `flow[/<tab>][?…]` | `insight/flow[/<tab>][?…]` |

  `#/approvals/<k-id>` is **not** redirected: it is `{kind:"home", card}`. An unknown hash is Home.

- [ ] Rewrite `parseRoute` with `redirectOld` first, then the new routes. The `team/<key>` regex runs after `team/hire|agents|modules|m`.
- [ ] Delete `VIEWS`, `VIEW_KEY`, `savedView`, the `localStorage` write in `setView`, and the `on-chat`/`chatFull`
  logic (721, 744). `setView` keeps the View Transition.
- [ ] Keys (595-680):
  - The guard `view === "chat"` goes.
  - `a` → `#/team`.
  - The board keys run only when `view === "tasks"`.
  - Add ⌘J/Ctrl J (`toggleAsk()`, works while typing, like ⌘K at 290-300).
- [ ] `queries.ts`:
  - `QUERIES.home = q("home", () => api.home(homeFrom.value), false)` (memory only: needs text). It is the one home
    entry: Home, the top-bar badge and `watchNeedsYou` all read it, so one event means one server build.
    - `export const homeFrom = { value: undefined as string | undefined }` (module-level in `queries.ts`).
    - Home sets it from its first response's `since_from` and clears it on unmount.
    - While Home isn't mounted, polls send no `from`: the badge only needs `needs`, and the cursor has moved anyway.
  - `agentChatsQuery(key)` = `q("chats."+key, () => api.chats(key), chatListForDevice)`.
  - `VIEW_QUERIES`: `home: [home]`, `team: [roster]`, `agents: [roster, agents]`.
  - `VIEW_CHUNKS` adds `home`, `team`, `teammate`, `decisions`.
  - `landsOnBoard()` is true only for `tasks…` / `t/…`.
  - `preloadBoot()` loads `home` when the hash is empty or `approvals/…`, and drops the `aidenhq.view` reads.
- [ ] Watch: `watchNeedsYou` (237) polls `load(QUERIES.home.key, QUERIES.home.fetch, false, true)` (the same entry, never
  a second `api.home()`) and passes `needs` rows, mapped to its `Waiting` shape. The badge
  = `needs.length`. `onOpen` → `#/t/<identifier>` (or `#/approvals/<id>` for a card row). `notify.ts`'s `Waiting`
  gains an optional `href`.
- [ ] **E2E test** `test/web/routes.test.ts` (happy-dom, renders `App` with the fetch stub pattern of
  `phone-drawer-bars.test.ts`):
  - `#/c/WOR-7` lands on `#/t/WOR-7`.
  - `#/fleet/code-review` lands on `#/team/m/code-review`.
  - `#/board` lands on `#/tasks`.
  - Opening `#/t/WOR-7` from `#/team` and pressing Escape returns to `#/team`, not Home.

## Task 7: the frame (Shell.tsx)

**Files:** Modify `web/src/Shell.tsx` 12-250 and the Palette entries (~270-300). Modify `web/src/shell.css` (the
`tn-*`, `bb-*` and `subnav` rules that change). Modify `web/src/sidebar.ts` (keep `panelsOf` only).

**Interfaces**
- `NavView = "home" | "tasks" | "sessions" | "apps" | "team" | "agents" | "modules" | "costs" | "flow" | "decisions" | "settings"`.
- `SECTIONS`:

  | Section | Views |
  |---|---|
  | Home | home |
  | Tasks | tasks, sessions (the latter only when the sessions module is on) |
  | Apps | apps |
  | Team | team, agents, modules, then module pages |
  | Insight | costs, flow, decisions |

- `hrefOf(v)`:

  | View | Hash |
  |---|---|
  | home | `#/` |
  | tasks | `#/tasks` |
  | sessions | `#/tasks/sessions` |
  | apps | `#/apps` |
  | team | `#/team` |
  | agents | `#/team/agents` |
  | modules | `#/team/modules` |
  | costs | `#/insight/costs` |
  | flow | `#/insight/flow` |
  | decisions | `#/insight/decisions` |
  | settings | `#/settings` |

- `pageHref(p) = #/team/m/${p.id}`.
- `TopNav({view, needs, working, onNav, settingsAlert, onPalette, onAsk, askOpen, spend})`:
  - Left: brand → `#/`, then the sections, with a `.tn-badge` count on Home (`needs`, kept at width when 0, as today)
    and a live dot on Team (`working > 0`).
  - Right: Search (⌘K), **Ask Aiden** (`Face` of chief-of-staff at 20px + "Ask Aiden" + `Kbd` ⌘J, `aria-expanded`,
    `aria-controls="ask-aiden"`), then Settings.
  - The spend ticker sits small inside the Insight item (decision 9).
  - Brief, help and Notify me are gone from the bar.
- `SubNav`: sections with more than one view. Team lists Teammates, All agents, Modules, then module pages. Insight
  lists Costs, Flow, Decisions. Tasks lists Tasks and Sessions. Apps shows a SubNav only when `panels.length`.
- `BottomBar` (phone, V2PhoneHome): Home (badge) · Tasks · **Ask Aiden** (center, face) · Team · More. More holds Apps,
  Insight's pages, Settings, module pages, panels and the notification ask.
- Palette:
  - "New chat with Aiden" becomes "Ask Aiden" (`openAsk()`).
  - Agent entries list teammates as "Name · Role" → `#/team/<key>`; hidden agents → `#/team/agents/<key>` with kind
    "Agent".
  - Chat entries come from the cached unfiltered `chats` query (`#/t/<ref>`).
  - Module entries → `#/team/modules/<name>`.

- [ ] Rewrite the constants and the three components. `App` passes `needs` from `QUERIES.home` (`greeting.needs`) and
  `working` from `board.agentsActive`.
- [ ] Apply `--page-max` in the frame: the page container (`.page.wide` and the Home/Team layouts) gets
  `max-width: var(--page-max); margin-inline: auto` with the existing clamp() gutters. Every page then caps at 1920
  and centres at 2560.
- [ ] Tokens only (stylelint). The Ask Aiden button uses the kit `Button` variant phase 1 provides, never a new colour.

## Task 8: Home

**Files:** Create `web/src/Home.tsx`, `web/src/home.css`, `web/src/needs.ts`. Modify `web/src/api.ts`
(`home(from?)`, `homeSeen(asOf)`, `homeSnooze(id, on)`), `web/src/types.ts`.

**Interfaces**
- `export function HomeView(props: { card?: string; session: Session; go: (h: string) => void; onSignIn: () => void; toast: Toast })`.
- `needs.ts`:
  - `export function useNeedsKeys(rows: NeedRow[], opts: { open: (id) => void; done: (row) => void; snooze: (row) => void }): { at: string | null; setAt }`.
    J/K move, Enter opens, E runs `done` (a row's primary action; on a wait that asks several questions it opens the pane's full form, like Enter), S runs `snooze`. Scope (spec: the Needs list):
    - It is bound on `window` only while Home is mounted.
    - Enter, E and S are **inert until J/K (or a click) has selected a row**. The selection shows a `--ring` outline
      and is announced (`aria-activedescendant` on the list).
    - All keys are ignored while typing (INPUT, TEXTAREA, SELECT, contentEditable) or with any modifier.
    - All keys are ignored while focus is inside Ask Aiden (`#ask-aiden`), the DetailPane, a `Dialog` or the ⌘K
      palette.
    - The selection clears when the selected row leaves the list.
  - `export function doneAction(row: NeedRow): "approve" | { answer: string } | "close"`: approval → approve; answer
    with options → the first (recommended) option; open → mark the task done (`api.update(ref, {status: "done"})`).
- Layout (V3Home):
  - The page is `Page` at `--page-max`.
  - Header: date · time (board timezone) and the greeting `h1`.
    - needs 0: "Nothing needs you."
    - needs 1: "One thing needs you; the rest is handled."
    - needs n: "<N in words> things need you; the rest is handled."
    - It is prefixed "Good morning/afternoon/evening, <first name>." from the session.
  - Then a grid: `minmax(0, 1.45fr) minmax(0, 1fr)` from 1100px, one column below. The left is the Needs `SectionCard`
    (title "Needs you" + count + `Kbd` hints J K move · E done · S snooze, hidden under 860px, and a **Select** toggle
    when any approval row exists). The right is Since (`SectionCard` "Since you last looked", meta "Overnight" when the
    window starts before 06:00 today, else "Since <time>"; action "All N →") above Idea.
  - Then "Your world": `auto-fit, minmax(min(100%, 22rem), 1fr)` with Waiting on (meta: `TeammateChip` of open-loops'
    teammate "tracks these") and Today (meta: the meetings teammate if one exists).
  - Then "Your team": `auto-fill, minmax(min(100%, 18rem), 1fr)` with each `team` row's `TeammateChip` + line → `#/team/<key>`,
    plus a dashed "Hire a teammate" tile (decision 10) and the action "See the whole team →".
  - Every block enters with `.enter` and `--i` stagger. Rows are `.lift`, buttons `.press`.
- NeedRow rendering: `DecisionRow` with `face` = `<Face seed={key} src kit state="needs" size={40} label={name}/>`,
  `who` = name, `role` = job, `question`, `detail` (the draft), `meta` = `ago(since)`, `active` = keyboard selection,
  `onOpen` = open the pane, `i` = index (stagger), `receipt` (below), and `actions` by kind:
  - **answer:** for a single-question wait, one button per option (first `primary`), then "Something else…" (opens the
    pane with the free-text answer). A wait that asks several questions shows "Answer" only, which opens the pane with the
    full form: an answer claims the whole wait, so every question is answered together. A row whose options include "Not now" shows it as an option; otherwise a quiet "Not now" button snoozes.
    `detail` (a draft) shows as a quoted block under the question, two lines clamped.
  - **approval:** Approve (`primary`) / Reject… (reason inline, as `Decide` does today), plus the card's `reads`
    line in small text.
  - **open:** "Open" → pane, plus "Mark done".
- Answer path: `api.answer(task.identifier, text, waitSince)` (wait-bound; a 409 → toast "Already answered, or the
  question changed" and refetch). Approval path: `api.decide(card.id, card.digest, d, reason)`. Batch path: `BatchBar`
  (moved to `ApprovalCard.tsx`) over the selected approval rows, with per-card outcomes listed as today.
- Receipt: after an answer or decision the row collapses to one line ("Sent: <option>", "Approved", "Rejected", and
  for an option on a row whose `detail` exists, "<Name> is sending it"), passed as `receipt={{text}}` with **no
  `onUndo`**. A snooze receipt is `receipt={{text: "Hidden until 08:00", onUndo: () => homeSnooze(id, false)}}`.
  Receipts fade on the next refetch.
- `DetailPane({open, title, onClose, actions})` (slide-in, right; full-screen sheet under 860px) for the selected row:
  - question, full `detail`, task link `#/t/<identifier>`, and the `AnswerForm` over all `questions` (multi-question
    asks answer here);
  - for approvals, the full `ApprovalCard a={card} unfold`.
  - `HomeView({card})` from `#/approvals/<id>` opens the pane on that row if it's in `needs`. Otherwise it reads
    `api.approval(id)` and shows `ApprovalCard` (a decided card shows its outcome; a 404 shows "There is no card
    <id>."). Closing the pane replaces the hash with `#/`.
- Since: `SectionCard({title: "Since you last looked", meta, action: "All N →"})` around
  `DigestList({items: groups.map(g => ({id: g.teammate.key, face: <Face …/>, text: g.latest.text, link: g.latest.task && "#/t/" + g.latest.task})), limit: 3})`.
  "All N" opens the pane with the returned items grouped by teammate, and a line "Showing the newest 200 of N" when
  `items` is shorter than `total`.
- Idea: `SectionCard` "Idea for you" with the teammate chip, question, its first option as `primary`, then "Not now" →
  `api.answer(identifier, "Not now", waitSince)`.
- Seen: after a snapshot whose `since` rendered (`useLayoutEffect` on `data.as_of`, then `requestAnimationFrame`, only
  while `document.visibilityState === "visible"`), call `homeSeen(data.as_of)` once per `as_of`. The first response's
  `since_from` goes into `homeFrom.value` (Task 6), so every refetch during this mount keeps the visit's window.
- Answered rows: the client keeps a per-mount set of answered and decided rows, keyed by the row's id **and** its wait
  (`<id>:<waitSince>` for an answer row, the card id for an approval). Their receipts stay, and a refetch that still
  lists the same wait (the kernel hasn't caught up) keeps showing the receipt, never the live buttons again; a new wait
  on the same task (a follow-up question) is a new key and shows its own buttons.
- Live: `useLive(["home", "approvals"], reload, 15_000)`.
- Notify me banner: `notificationsSupported() && Notification.permission === "default"`. It is dismissible, and the
  dismissal is stored in localStorage `aidenhq.notify-ask` inside try/catch.
- Empty and fresh install: `needs` empty shows the all-clear line inside the Needs card. `since`, `world.*`, `idea` null
  → that block is omitted. `team` empty → "Your team" shows only "See the whole team" and the Hire tile.
- Loading: a skeleton shaped like the grid (`Skeleton.tsx`), never a spinner.

- [ ] Build `Home.tsx` from kit components only. `home.css` holds layout (grids, gaps, `clamp()` gutters) and no colours.
- [ ] **E2E test** `test/web/home.test.ts` (happy-dom, renders `App` at `#/` with a fetch stub serving `/api/home`):
  1. The greeting reads "Three things need you; the rest is handled." for three rows.
  2. J, J, E on the approval row posts `/api/approvals/<id>/decide` with that card's digest. The row shows "Approved"
     and no Undo.
  3. S on an answer row posts `/api/home/snooze {on:true}`, and Undo posts `{on:false}`.
  4. With `world.today: null` there is no "Today" heading.
  5. The first render posts `/api/home/seen` with the response's `as_of` exactly once. A refetch sends
     `?from=<since_from>`.
  6. At `#/approvals/k-…d` with the card absent from `needs` and `/api/approvals/k-…d` answering a `rejected` card, the
     pane shows the card's outcome line.

## Task 9: Team list and the teammate page

**Files:** Create `web/src/Team.tsx`, `team.css`, `web/src/Teammate.tsx`, `teammate.css`. Create
`web/src/Conversation.tsx` by moving from `web/src/Workspace.tsx`:
- **Kept:** `usePoll` 57-67, `Pending`/outbox/turns 408-438, `Conversation` 443-817, `dayLabel`/`clock` 818-826,
  `MessageView` 828-932, `NoiseFold` 934-961, `Steps` 963-989, `LiveRow` 991-1049, `DetailsPanel` 1051-1131, `FileRow`
  1133-1146, `Composer` 1148-1330, icons 1331-1349, `AskView` 1351-1370.
- **Deleted:** `ChatWorkspace` 72-120, `Sidebar`, `SettledList`, `Group`, `ChatLink` 122-352, `STARTERS`/`NewChat`
  354-405 (the starters move to `AskAiden.tsx`), `portraitOf`/`Monogram` 43-51 (callers use `Face`).
- **Delete** `Workspace.tsx`, and `AgentAvatar.tsx`/`avatar.ts` if phase 1 hasn't already replaced them with `Face`
  (grep: Agents, AgentPage, ModulePage, Lineage, components.tsx, LaneChat).

**Interfaces**
- `Conversation({refId, row, mobile, crew, prefix, go, onSignIn, toast, reloadList, compact})`.
  - The `panel`/`togglePanel` props go. The Details button always opens `DetailsPanel` over the conversation (today's
    narrow-screen mode), never as a third column. The `PANEL_KEY` localStorage and `PANEL_OPEN_FROM` are deleted.
  - `compact` (Ask Aiden) hides the conversation header's agent name row.
  - Links inside that pointed at `#/c/<ref>` (handed-out tasks, `openChat`) use `#/t/<ref>`.
  - `crew` for @-autocomplete in `Composer` is the teammates only.
- `TeamView({roster, needs})` (V2Team, without the three-state demo strip):
  - A `SectionCard` grid `auto-fill, minmax(min(100%, 20rem), 1fr)` of each teammate (roster entries with `teammate`).
  - Each card shows `Face` at 64 with state (needs from `home.needs` teammates, working from roster), "Name · Role",
    one status line (working on X / N need you / idle since …), a `Rename` button (Rename dialog below), and the small
    "Behind the scenes: <staff names>".
  - The card links to `#/team/<key>`.
  - A Hire tile (decision 10) closes the grid.
- `#/team/<key>` for a key that's in the roster but not a teammate replaces the hash with `#/team/agents/<key>`. An
  unknown key shows `EmptyState` "No teammate called <key>." with a link to Team.
- `TeammateView({agentKey, chat?, text?, go, onSignIn, toast, mobile})` (V3Agent):
  - **Header** `SectionCard`: `Face` at 96 with state, name `h1` · job, `Rename`, a status line (from the roster, as
    `AgentPage` derives it today, 49-63), the description, and on the right **Pause <Name>** and
    **one** `LinkButton` "Advanced: <first controlled module's page title or module name> settings ↗". The link goes to
    that module's `board.pages` entry (`#/team/m/<id>`) if one exists, else `#/team/modules/<name>/settings`.
  - **Chat pane** (left, `minmax(0, 1fr)`): if the teammate is a lane agent → `LaneChat`. Otherwise the chat is the
    route's `chat`, else the newest open chat from `agentChatsQuery(key)` (`Conversation`), else a `Composer`.
    `Composer` placeholder: "Message <Name>: <teammate.sample>", and the send is
    `api.newChat(text, key)` → `go("#/team/<key>/c/<ref>")`. Above the pane, a chat switcher (`Menu`) lists this
    agent's chats, with an Active / Settled `Segmented` filter (`state=`), "Show older" via the response's `next_offset`, and "New chat".
  - **Side column** (right, `minmax(18rem, 24rem)`; stacked under the pane below 1100px), all generic (spec settled #2):
    - "What <Name> does": the agent's `description` (compiled catalog `teammates[].description` via the profile route).
    - "Recent work": the last 5 from `agentTimelineQuery(key)` (existing), "All work →" `#/team/agents/<key>/activity`.
    - "How <Name> is set up": for each `controls` module, its declared settings from `api.settings()` (`SettingRow`
      where `module ∈ controls`) as `Facts` (label = the first sentence of `doc`, value formatted by
      `settings-format.ts`). Footer: "Change any of this by asking <Name>."
    - `Disclosure({summary: "Team behind <Name> (n)"})` (collapsed): each staff agent → `#/team/agents/<key>`.
- Rename: a `Dialog` with one `Input`, checked as you type with `services/shared/teammate-name.ts` (the same rule the
  server uses), then `api.changeSettings([{kind: "agent", agent: key, field: "name", value: name}])`. It shows the
  server's refusal text (a name another agent has, "Aiden") under the field, then "Filed as <id>; applies on the next
  apply" with a link `#/t/<id>`.
- Pause: `api.pauseAgent(key, {paused: true})` for the teammate **only**, never its staff (index: staff may be
  shared, e.g. the Engineer). A failure shows in a `Banner`. When paused the button reads "Resume <Name>".

- [ ] Move the code, delete what's listed, fix the imports (`LaneChat.tsx` imports `Composer` from `./Conversation` and
  uses `Face` in place of `Monogram`/`portraitOf`).
- [ ] `src/agent-page.ts` profile gains `description` and `teammate` (from the compiled catalog) if phase 1 didn't add
  them.

## Task 10: Ask Aiden side panel

**Files:** Create `web/src/AskAiden.tsx`. Modify `App.tsx` (mount once, after `SubNav`/`app-main`), `Settings.tsx`
(its "Ask Aiden" `#/c/?text=` link → `openAsk({text})`), `Agents.tsx` 27-37 (`newAgent` → `go("#/team/architect?text=…")`, pre-filling Archie's composer), `Apps.tsx`
81 ("Ask in Chat" → `openAsk()`), `Welcome.tsx` 93 (`go("#/")` then `openAsk({chat: r.identifier})`).

**Interfaces**
- `export function openAsk(opts?: { text?: string; chat?: string }): void` dispatches `window` CustomEvent
  `aidenhq:ask`. `export function toggleAsk(): void`.
- `AskAiden({mobile, go, onSignIn, toast})` is `SidePanel({open, onClose, title: "Ask Aiden", sub: <job line>, face:
  <Face of chief-of-staff/>, headerActions: <history button>, footer: <starters + Composer>})` inside a wrapper
  `id="ask-aiden"`:
  - Body: the current chat in `Conversation compact`. Current = `opts.chat`, else the newest open chief-of-staff chat
    from `agentChatsQuery("chief-of-staff")`, else nothing.
  - Footer: starters (empty chat only: "What needs me today?", "Who's working on what?", "Brief me on yesterday",
    "Hire a teammate…") and `Composer` with placeholder "Ask Aiden, or @ a teammate".
  - Send with a current chat → `api.comment(ref, text, false, true)`. Without one, or when the text starts with
    `@<teammate>` → `api.newChat(text)`. The server's `pickAgent` routes @teammate and the panel then shows that chat.
    An answer `lane:<key>` (a fast-lane teammate) shows `LaneChat` in the panel.
  - The history view lists `agentChatsQuery("chief-of-staff")` with the same Active / Settled filter. A pick sets the
    current chat, and "New chat" clears it.
  - Behaviour:
    - Non-modal: no backdrop and no focus trap, the page stays usable.
    - Width `clamp(22rem, 30vw, 32rem)`. It pushes nothing (it overlays on the right with `--shadow-lg`). Under 860px
      it is a full-screen sheet.
    - Escape (when focus is inside the panel, or no other overlay is open) closes it.
    - On open, focus moves to the composer. On close, it returns to the element that had focus before opening (stored
      on open).
    - ⌘J toggles. The panel stays open across route changes.
    - Open state in memory only.

- [ ] Build it from `SidePanel` + `Conversation` + `Composer`. No new conversation code.
- [ ] **E2E test** `test/web/ask-aiden.test.ts` (happy-dom, `App` with fetch stub):
  - ⌘J opens the panel (`#ask-aiden` visible) and focus lands in its textarea.
  - Typing in Home is still possible while it's open (a click on a Home button works, no backdrop).
  - Escape closes it and focus returns to the Ask Aiden button.
  - Sending "@Max look at #821" posts `/api/chats {text}` with no `agent` field.

## Task 11: approvals folded in; Insight › Decisions; Attention on All agents

**Files:** Create `web/src/ApprovalCard.tsx` (move `OUTCOME`, `TIER_WORDS`, `forOwner`, `withAI` 15-30, `Decide` 37-71,
`BatchBar` 76-119 and `ApprovalCard` 121-255 out of `Chat.tsx`). Create `web/src/Decisions.tsx` (move `AllApprovals`
309-470 minus its "waiting for you" grid, and `HistoryRow` 471-496, `groups` 263-271, `FILTERS` 258-261). Delete
`web/src/Chat.tsx` (`ApprovalsView`, `OneApproval`, `onYouBeyondCards`). Modify `web/src/Attention.tsx`,
`web/src/Agents.tsx` (render `AttentionStrip` at the top of All agents), `web/src/App.tsx` 793/847 (remove it from Tasks).

**Interfaces**
- `DecisionsView({onSignIn})` keeps the Approvals page's history behaviour: filters (Pending with the AI reviewer,
  Done, Failed, All), live claimed records with their `wait`, Tier 0 runs behind "Show tool calls", each row opening
  the full card. The "Waiting for you" grid and its batch selection are removed (they live on Home).
- `AttentionStrip({onSignIn})`: tabs Failed and Idle only (`counts.failed`, `counts.unexplained_idle` from
  `/api/needs-you`). The needs tab and its inline `AnswerForm` are deleted.

- [ ] Move and delete. Update the importers: `Lineage.tsx` 7 and `Conversation.tsx` import `ApprovalCard` from
  `./ApprovalCard`.
- [ ] Tests: `test/web/approval-card.test.ts` imports from `ApprovalCard`. `test/web/attention-loading.test.ts` keeps
  its loading assertion on the two-tab strip. `test/web/approval-filters.test.ts` is unchanged (it imports
  `conversation.ts`).

## Task 12: every link, emitter and consumer moves

Grep before and after: `grep -rn '#/c/\|#/c"\|#/approvals"\|#/agents\|#/modules\|#/fleet\|#/board\|#/sessions\|#/costs\|#/flow\|"#/"' services/board/web/src services/board/src modules kernel/src docs CLAUDE.md`.
After this task, only `parseRoute`'s `redirectOld` and docs describing the redirect mention the old forms.

| File (line today) | Change |
|---|---|
| `AgentPage.tsx` 1, 44, 67, 84, 98, 219-228 | `#/team/agents…`. Chat/Give-it-a-task only for teammates → `#/team/<key>`. Chats tab (28-29, 213-233) deleted |
| `Agents.tsx` 32, 415, 421 | `#/team/agents/<key>`. Chat button only for teammates → `#/team/<key>`. `newAgent` → `#/team/architect?text=` |
| `ModulePage.tsx` 1, 56, 85, 132, 167, 175, 321, 389, 420 | `#/team/modules…`, `#/team/agents/<key>…`, filed `#/t/<id>` |
| `Modules.tsx` 1, 32, 128, 178, 213, 215 | `#/team/modules…`, filed `#/t/<id>` |
| `ModuleView.tsx` 38 | the sub-path comment and parsing: `#/team/m/<id>/<sub>` |
| `Sessions.tsx` 12, 50, 79, 100, 205, 221, 228 | `#/tasks/sessions…`, `#/team/modules/sessions` |
| `Costs.tsx` 11, 64, 128, 136 | `#/insight/costs`. The 136 fallback replaces with `#/insight/costs`, never `#/` |
| `Flow.tsx` 9, 78, 85, 146, 208 | `#/insight/flow…`, same fallback rule |
| `TaskTools.tsx` 28-29, 61, 87 | `#/tasks?view=` / `#/tasks` |
| `AgentWork.tsx` 49 | card callout → `#/approvals/<id>` (unchanged form, now opens Home's pane) |
| `Lineage.tsx` 66, 143 | `#/t/<ref>` |
| `settings-ui.tsx` 143, 147 | "Approvals" → `#/` ("on Home"). `#/t/<id>` |
| `Settings.tsx` 344 | "<n> waiting on you on Home" → `#/` |
| `SettingsAgents.tsx` 280 | `#/t/<id>` |
| `Apps.tsx` 81 | `openAsk()` |
| `Welcome.tsx` 93 | `go("#/"); openAsk({chat})` |
| `Accounts.tsx` 43 | comment only |
| `src/mcp.ts` 502 | opener text/link `#/team/m/${p.id}` |
| `kernel/src/admin.ts` 174, 477 | `#/approvals` → `#/` ("Home"). 478 (`#/approvals/:id`) unchanged |
| `modules/github/connections/github-mcp/src/client.ts` 724 | `#/team/modules/github/settings` |
| `modules/channel-telegram/.../approvals.ts` 39, 42 | unchanged (`#/approvals/<id>` still resolves) |
| `services/board/src/task-truth.ts` 70 | unchanged |
| `modules/chief-of-staff/agents/chief-of-staff/AGENTS.md` 25 | "the agent's page on the board (Team › All agents › <agent>: Settings and Handbook tabs)"; no literal route |
| `modules/board/schemas/pages.json` | `#/fleet/<id>` → `#/team/m/<id>`; "Fleet page" → "module page under Team" |

- [ ] Tests that import moved or deleted code:
  - `test/web/phone-drawer-bars.test.ts`: its stub adds `/api/home`; the bottom bar assertion now names Home.
  - `test/web/a11y-structure.test.ts` (Agents, Modules): routes in fixtures.
  - `test/chats.test.ts` / `test/chat-routes.test.ts`: `pickAgent` with teammates.
  - `test/web/shell-scroll.test.ts`: section names.
  - `test/mcp.test.ts`: any `#/fleet/` expectation.
  - `kernel/test/accounts.test.ts`: its `#/approvals` redirect expectation follows the `admin.ts` 477 change to `#/`.
- [ ] `Drawer.tsx` 399, 538, 992: pass teammates only as the composers' `crew` (the server filters mentions anyway;
  this keeps the autocomplete honest). Chats opened by id (`#/c/<ref>` → `#/t/<ref>`) now render in this drawer.

## Task 13: mock API fixtures

**Files:** Modify `services/board/web/dev/mock-api.ts` (route table ~517-565, `/__mock` flags).

- [ ] `GET /api/home`: a fixture matching V3Home.
  - **Needs:** a Tess `answer` with `detail` (a chaser draft, options Send / Edit / Not now), a Rhea `answer` with two
    options, and an Iris `approval` card.
  - **Since:** 9 items over 3 teammates. **World:** 4 waiting-on rows and 3 events today.
  - **Team:** Tess, Max and Iris. **Idea:** one, from Tess.
  - Neutral names only (`example.com`).
- [ ] Flags:
  - `?empty=1`: no needs, `since: null`, world nulls, empty team, `idea: null`.
  - `?nocal=1`: `world.today: null`.
- [ ] `POST /api/home/seen` echoes `{seen: as_of}`. `POST /api/home/snooze` returns `{until}` and drops the row from the
  next GET (or restores it on `on: false`).
- [ ] `GET /api/chats?agent=<key>[&state=settled]`: three chats for `chief-of-staff` and two for `reviewer-manager`. A chat detail for
  each (reuse the existing chat fixtures).
- [ ] `POST /api/chats` with a leading `@<name>` returns a chat for that teammate.
- [ ] `/api/approvals/<id>` for one decided (`rejected`) card not in needs.
- [ ] Roster: phase 1's teammate fixtures. Add `state: "working"` on Max so faces show all three states on Team.

## Task 14: docs

- [ ] **Rewrite `docs/design/board-ui.md`.** It is cut to how it works now; keep the parts that still hold (tokens,
  accessibility, lint, Modules).
  - **Priorities:**
    1. Home is the heart: it opens first, gets the most care, and nothing in the frame crowds it.
    2. Teammates and their chats.
    3. Tasks, then everything else.
  - **The frame:**
    - Top bar: Home (needs badge) · Tasks · Apps · Team · Insight, then Search ⌘K, Ask Aiden ⌘J and Settings.
    - SubNav lists, the phone bottom bar, ⌘K.
    - Ask Aiden (non-modal side panel, Escape, focus return).
    - The route table, and the redirect rule (old routes redirect once in `parseRoute`'s `redirectOld`, then the
      views are deleted).
  - **A page:** unchanged, plus "build only from `web/src/ui`; pages compose, never restyle".
  - **Component table:** add Face, TeammateChip, DecisionRow, DetailPane, DigestList, SidePanel, Stepper, OptionCard,
    Disclosure, Kbd and SectionCard, each with one line on when to use it.
  - **Motion:** the one vocabulary:
    - `.enter` fade-up `--enter-y` with `--i × --stagger`;
    - `.lift` hover;
    - `.press` scale;
    - pane slide;
    - collapse;
    - one `prefers-reduced-motion` block.
  - **Layout:** `--page-max` 1920; fluid grids `auto-fill/auto-fit minmax(min(100%, X), 1fr)`; never a narrow column.
  - **Home** (new section): the blocks, the omission rule (no source or no data, no card), the keyboard, snooze until
    08:00 next day per account, receipts without Undo except snooze, `#/approvals/<id>` opening the pane.
  - **Teammates** (new section):
    - user-facing vs hidden;
    - "Name · Role" everywhere;
    - never module names in primary text;
    - the teammate page's generic side column and its single Advanced link;
    - every chat entry reaches teammates only.
  - **Modules:** "a module's page under Team (`#/team/m/<id>`)"; `board.reads` (owner-view reads for Home: declared
    `{id, connection, tool}`, called through the kernel's view route).
  - **Working without an instance:** the mock flags `?empty=1`, `?nocal=1`; check at 1512, 1920, 2560
    and 390, light and dark, Home first.
- [ ] `CLAUDE.md` line 174: "**Board UI follows docs/design/board-ui.md**: Home first, the frame and kit in
  `services/board/web/src`, tokens only, both themes, motion tokens."
- [ ] `modules/AGENTS.md` 27 and 39-42: "Fleet page" → "module page (under Team)".
- [ ] `docs/design/sessions.md` 8, 11, 48. `docs/design/agent-and-module-pages.md` routes (22, 29, 47, 69).
  `docs/design/agent-work-board.md` 121, 266.

## New installs

A fresh install with the default bundle and quiet start, nothing connected:
- **Home:** "Nothing needs you." and the all-clear line.
- **Since:** omitted (no ledger rows). The first-visit window is 24h.
- **World:** omitted. The `waiting-on` label exists only with intake, and there are no tasks yet. With google not
  connected, `calendar_today` errors and the block is omitted.
- **Idea:** omitted. **Your team:** only "See the whole team" and the Hire tile.
- **Team:** lists every teammate of the installed modules (idle faces). Each teammate page shows its description, an
  empty chat with the sample line as placeholder, and "How <Name> is set up" from its modules' defaults.
- **Another owner's local modules:** their agents become teammates through the same `teammate:` block (phase 1) and
  appear here with no board change.
- A module that wants a Home read declares `board.reads`. Nothing in Home names a module.

## Verification (end of phase, one pass)

- [ ] Board, from the worktree (run every suite CI's `services/board` area runs):
  `cd services/board && perl -e 'alarm shift; exec @ARGV' 600 npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint && npm run build`.
  Expected: all green. Then `pkill -f "${WT:?}/"`.
- [ ] `cd scripts && perl -e 'alarm shift; exec @ARGV' 600 npm test && npm run typecheck`. Then `cd kernel && npm test`
  under the same timeout (views.ts). Then `cd modules/google/connections/google-workspace-mcp && npm test`. Then
  `node scripts/ci-local.ts`.
- [ ] UI with the mock API: `node web/dev/mock-api.ts` and `npm run dev:web`. Screenshot via a scratchpad
  playwright-core script at 1512x982, 1920x1080, 2560x1440, 768, 1024 and 390x844 (768 and 1024 straddle the 860
  and 1100 breakpoints), light and dark:
  - `#/` (default, `?empty=1`, `?nocal=1`);
  - `#/approvals/<decided id>`;
  - `#/team`, `#/team/reviewer-manager`;
  - Ask Aiden open over Home;
  - `#/team/agents`, `#/insight/decisions`, `#/tasks/sessions`.
  
  Check:
  - No horizontal scroll at 390; content capped at 1920 and centred at 2560.
  - J/K/E/S work and are inert in the reject reason field.
  - With `prefers-reduced-motion: reduce` emulated, nothing animates.
  
  Kill vite and the mock afterwards.
- [ ] **Codex review before push:** `codex exec review --base origin/main -m gpt-6.2-sol -c
  model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`, run in the background. Fix every important
  finding. A finding judged wrong goes in the PR body with the reason.
- [ ] **PR:** `feat(board): home, team and ask aiden`, opened with the label `ship:stop` until the phase is complete,
  squash-merged.

## What this phase removes

- **Views and routes:**
  - the Chat tab and `#/c/…` (redirected);
  - the Approvals tab and `#/approvals` (→ Home; `#/approvals/<id>` now opens Home's pane);
  - the Fleet section and `#/fleet/…`;
  - `#/agents…`, `#/modules…`, `#/board`, `#/sessions…`, `#/costs`, `#/flow…`, `#/reviews…` as live routes (each
    redirects once).
- **Web code:**
  - `savedView`, `VIEWS`, `aidenhq.view` localStorage, the chat default;
  - `Workspace.tsx` (`ChatWorkspace`, `Sidebar`, `SettledList`, `Group`, `ChatLink`, `NewChat`, `portraitOf`, `Monogram`);
  - `Chat.tsx` (`ApprovalsView`, `OneApproval`, `onYouBeyondCards`; the rest moves);
  - AgentPage's Chats tab;
  - the needs tab of `AttentionStrip` and its place on Tasks;
  - `PANEL_KEY`/`PANEL_OPEN_FROM` (`aidenhq.panel`);
  - the TopNav brief, help, Notify me and spend items (spend moves into Insight's item; Notify me to a Home banner);
  - the "New chat with Aiden" palette action;
  - `AgentAvatar.tsx`/`avatar.ts` if phase 1 left them.
- **Owner decisions:**
  - the cross-agent chat sidebar is dropped;
  - chatting with hidden agents is dropped from every entry point;
  - settled chats stay reachable per agent through the Settled filter.
- **Server:** `GET /api/settled` (its fleet-wide search) and `store.settledList`; non-teammate targets in `startChat`, `/internal/chat`, lane
  sends and @-mentions.
- **Docs:** board-ui.md's "Chat is the heart" and the Fleet sidebar sections; CLAUDE.md's "chat first".

## Deviations from the index and spec (for the owner and the phase-1/3 planners)

None of these changes a fixed index contract. Each one adds to it or chooses where the spec is silent.

1. **New declared point `board.reads`, plus a one-line kernel change.** `views.ts` refuses `resources/read` of
   non-`ui://` views. The point has no `<module>_…` name rule (the owner MCP never serves reads), so the spec's names
   `calendar_today` and `notify_recent` stand. owner-channel gains `requires: [board]`.
2. **The teammate predicate reads the compiled config** (`compiled.agents[key].teammate` via the grants table), not the
   roster or Paperclip metadata, because agents can edit metadata. The `RosterAgent.teammate` contract is unchanged and
   is what the web uses.
3. **Settled by the coordinator:** every admin account is an owner (CLAUDE.md) and sees the full Home. Spec settled
   #5's reduced Home applies only to non-admin roles, which have no board access today, so none is built.
4. **Routes and endpoints beyond the index:**
   - `#/team/agents/<key>[/tab]` (hidden agents' page, today's AgentPage), `#/team/modules/<name>[/tab]`,
     `#/team/<key>/c/<ref>`, `#/tasks/sessions[/<ref>]`, `#/insight/decisions`;
   - `POST /api/home/snooze`, `GET /api/chats?agent=&offset=`.
   - **`#/team/hire` is not registered in phase 2.** Its page is phase 3's. Hire tiles open Archie's page until then,
     and phase 3 repoints them.
5. **Mockup vs spec, spec wins:**
   - no "You promised" block;
   - Ideas show one at a time, without "1 of 3 / Next idea";
   - sends have no Undo (the answered mockup shows one);
   - waiting-on shows age and quiet days instead of "overdue" (due dates aren't structured).
   
   **Mockup vs spec, spec silent:** phone bottom bar per V2PhoneHome (Home · Tasks · Ask Aiden · Team · More).
6. **Moved behaviours (owner rule: each listed):**
   - Approvals history, filters, Tier 0 audit and live claimed records → Insight › Decisions.
   - Failed/idle attention strip: Tasks → Team › All agents.
   - Spend meter: top bar → inside Insight's item.
   - Notify me: top bar → a Home banner.
   - Brief and help icons: top bar → keys `b`/`?` and ⌘K only.
   - Active-runs chip → Team's live dot.
   - Pinned app panels: Apps SubNav only when panels exist.
   - The chat details panel: always an overlay, never a third column (`aidenhq.panel` dropped).
7. **Dropped behaviours:**
   - the cross-agent chat sidebar (chats live per teammate and in Ask Aiden history; ⌘K still lists recent chats);
   - the fleet-wide Settled list and `GET /api/settled` (settled chats stay reachable per agent via `state=settled`);
   - AgentPage's Chats tab;
   - chatting with hidden agents from any entry point (spec).
8. **Chats opened by id** (`#/c/<ref>`, notifications, Lineage, filed-change links) open in the task drawer
   (`#/t/<ref>`), not in a teammate's chat pane, because the link carries no agent. A teammate's own list opens its
   chats in its pane.
9. **Pause** pauses only the teammate (index); no staff, no overlap dialog.
10. **Length:** about 770 non-blank lines, above the brief's 400–700. The phase deletes three views and rewires every
    route, and Task 12's consumer table is most of the excess.
