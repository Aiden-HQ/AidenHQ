# Phase 1: Kit and teammates data

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native execution, one review at the end of
> the phase). Steps use checkbox (`- [ ]`) syntax. Build in your own worktree from `origin/main`; never `git stash`.

**Goal:** Ship the board's new design kit (motion and layout tokens, Face, TeammateChip and nine more components, all on
`#/design`) and the data behind named teammates: the `teammate:` block from the module format through compile, Paperclip,
the catalogs and the board roster; faces served by the board; rename as a typed settings change; the owner question's
`detail`; and the ten default teammates, including two new thin agents (Nora, Sam). The existing UI keeps working on the
new data. Phase 2 replaces the IA.

**Architecture:** A teammate is an ordinary agent with a `teammate:` block. Compile validates the block, copies faces to
`config/faces/`, and carries the block into `paperclip.yaml`. Setup copies it into Paperclip metadata. The board reads
the metadata into `RosterAgent.teammate`, and it reaches agents through `fleet_catalog` and the module catalog. One shared
rule (`services/shared/teammate-name.ts`) decides whether a name is allowed. Compile, the board and the kernel all
import or sync it, and the rename itself rides the existing `kind: "agent"` settings change.

**Spec:** `docs/superpowers/specs/2026-11-26-home-and-teammates-design.md` (§1, §6, "Settled during review" #1, #3).
**Index:** `docs/superpowers/plans/2026-11-26-home-teammates.md` (cross-phase contracts). Mockups:
`docs/superpowers/plans/2026-11-26-home-teammates-mockups/` (Face.dc.html is the character kit; V3Home, V2AskAiden,
V3NewInstall, V3Hire and V2Team show the components in use).

**Builds on:** nothing earlier in this project. Phases 2 and 3 consume the interfaces listed under "Produces".

## Contract notes (read first; reported to the controller)

- **C1. Rename shape (decided).** Renaming uses the existing `kind: "agent"` member of `ChangeSchema`, which already
  carries `{agent, field, value}`. A second `kind: "agent"` member with the index's `{key, name}` would collide in the
  discriminated union.
  - The shape is **`{kind: "agent", agent: <key>, field: "name", value: <name>}`**.
  - The kernel's existing apply path writes it to `overrides.agents.<key>.name` with no new code.
  - Phase 2's rename UI sends this shape.
- **C2. `staff:` and `controls:` entries may end in `?`.** The spec defaults name agents and modules a default install
  may not have: `ci`, `design`, `fleet-steward`, `inbox-agent`. An entry ending in `?` is dropped when its agent or module
  is off, the same convention `delegate_to` uses. One without `?` must exist. Compiled output never carries the `?`.
- **C3. Faces (decided; the contract is extended).** `services/board/web/public/crew/` is deleted entirely, and no old
  portrait ships as a face file.
  - `teammate.face` is one of two things:
    - a **file name** of an image the module ships in the agent's own folder; the board draws state as a ring and dot
      over it;
    - a **kit spec** object that the module picks (`FaceKit`, Task 2).
  - With no `face`, the kit derives every feature from the hash of the agent key.
  - The ten roster agents declare kit specs matching the mockup characters (Face.dc.html's character map). Each spec sits
    in the agent's own module, so the core never knows agent keys.
  - Compile validates both forms.
  - The board's roster face is `{src: "/api/faces/<key>"} | {kit: FaceKit} | null`.
  - The `Face` props are `{seed, src?, kit?, state?, size?, label}`.
  - No module ships a file yet. The `/api/faces/<key>` route and its hardening are built anyway, because modules may ship
    files.
- **C4. Rhea's `controls`.** The spec's "chief-of-staff's research routines" isn't a module, so Rhea takes the default
  (`[chief-of-staff]`).
- **C5. Grants stay explicit.** A teammate's config tools for the modules it controls are written as grants in
  `module.yaml`. Compile does not auto-grant from `controls`. Settled #1 reads as if granting were implied; this plan
  doesn't build that.
- **C6. Name rule is stricter than "unique among teammates".**
  - A teammate's name must not match, case- and punctuation-insensitively (the `norm` in
    `services/board/src/chats.ts`), any other agent's name or key, hidden agents included.
  - The reason: today `pickAgent` and tasks-mcp's `assignee`/`to` lookups match every agent by name or key.
  - Names are ASCII letters, digits, space and `.'-`, 1–24 characters and at most 4 words, which is what `pickAgent` can
    address.
- **C7. Pause (decided; phase 2).** Pause stops only the teammate itself, never its staff, and the button says "Pause
  Max". Staff such as `engineer` are shared, so pausing them would stop other teammates' work. Phase 2 builds it this
  way.

## File Structure

**Kit (board web)**

| File | Change | Responsibility |
|---|---|---|
| `services/board/web/src/ui/tokens.css` | Modify | Add motion and layout tokens and the face palette tokens |
| `services/board/web/src/ui/ui.css` | Modify | Add `.enter`/`.lift`/`.press`, the face keyframes and the styles of the new components |
| `services/shared/face-kit.ts` | Create | `FaceKit` type, its enums and `faceKitProblem()`: the one spec rule (compile imports it) |
| `services/board/src/face-kit.ts` | Create (synced copy) | The board's copy (the web kit imports its enums) |
| `services/board/web/src/ui/face-kit.ts` | Create | Drawing tables (ported from Face.dc.html), `kitFromSeed(seed)` |
| `services/board/web/src/ui/Face.tsx` | Create | Kit face (from a spec or a seed) or shipped-image face, three states |
| `services/board/web/src/ui/TeammateChip.tsx` | Create | Face plus "Name · Role"; `faceStateOf(agent)` |
| `services/board/web/src/ui/DecisionRow.tsx` | Create | A needs row: who, question, detail, inline actions, receipt |
| `services/board/web/src/ui/DetailPane.tsx` | Create | Slide-in detail pane |
| `services/board/web/src/ui/DigestList.tsx` | Create | Top-N digest lines with "All N" |
| `services/board/web/src/ui/SidePanel.tsx` | Create | Non-modal right panel (Ask Aiden) |
| `services/board/web/src/ui/Stepper.tsx` | Create | "Step 1 of 3 · label" with progress bars |
| `services/board/web/src/ui/OptionCard.tsx` | Create | Radio or checkbox card |
| `services/board/web/src/ui/Disclosure.tsx` | Create | Show/hide with collapse motion |
| `services/board/web/src/ui/Kbd.tsx` | Create | A key cap |
| `services/board/web/src/ui/SectionCard.tsx` | Create | Card with a header (title, meta, count, action) |
| `services/board/web/src/ui/Tile.tsx` | Modify | `Monogram` takes `initials`/`tone` (moved in from `avatar.ts`); it stays for apps |
| `services/board/web/src/ui/index.ts` | Modify | Export the new parts |
| `services/board/web/src/Design.tsx`, `design.css` | Modify | A catalogue section for every new part, in both themes |
| `services/board/web/src/AgentAvatar.tsx`, `avatar.ts` | **Delete** | Replaced by `Face` |
| `services/board/web/public/crew/` | **Delete** | All 12 portraits; none move (C3) |
| `services/board/web/src/{components,AgentPage,Agents,ModulePage,LaneChat,Workspace,Lineage}.tsx` | Modify | Agent faces are `Face` |
| `services/board/web/src/styles.css` | Modify | Remove `.avatar.portrait`, `.agent-face`, `.mono` rules |
| `services/board/web/legacy-classes.json` | Modify | `agent-face` → "Face from ./ui" |
| `services/board/web/src/types.ts` | Modify | `RosterAgent.teammate`, `Assignee.seed/face`, `AgentProfile.teammate`, `NeedsYou` `ask.detail`; `avatar` removed |
| `services/board/web/dev/mock-api.ts` | Modify | Teammate roster fixtures, `/api/faces/<key>`, `ask.detail` |

**Teammates data**

| File | Change | Responsibility |
|---|---|---|
| `services/shared/teammate-name.ts` | Create | `teammateNameProblem()`: the one name rule |
| `services/board/src/teammate-name.ts` | Create (synced copy) | The board's copy |
| `scripts/sync-shared.ts` | Modify | Register both copies (beside `url-setting.ts`, ~line 143) |
| `scripts/modules.ts` | Modify | `teammate` parse and validate, `LOCAL_AGENT_FIELDS`, `OVERRIDABLE.agents.name`, faces, catalog `teammates[]`, team strip |
| `scripts/compile.ts` | Modify | Sync `config/faces/` in place |
| `scripts/paperclip-setup.ts` | Modify | `display()` carries `teammate`, drops `avatar`; `writeCatalog()` adds `teammate` |
| `compose.yaml` | Modify | Board mounts `config/faces` read-only |
| `services/board/src/{paperclip,activity,board,agent-page}.ts` | Modify | Teammate and face from metadata; `avatar` removed |
| `services/board/src/app.ts` | Modify | `GET /api/faces/<key>`; `/api/needs-you` `ask.detail` |
| `services/board/src/settings-change.ts` | Modify | `field: "name"` on the agent change |
| `kernel/src/settings-change.ts` | Modify | `name` in `checkTyped` `case "agent"` |
| `kernel/src/idle.ts`, `kernel/src/task-state.ts`, `kernel/sdk/src/task-state-types.ts` (+ synced board copy) | Modify | Owner question `detail` |
| `modules/owner-channel/connections/notify/src/{mcp,notify,kernel}.ts` | Modify | `detail` on notify, through to the wait |

**Roster defaults**

| File | Change | Responsibility |
|---|---|---|
| `modules/meetings/module.yaml`, `modules/meetings/agents/meetings/AGENTS.md` | Modify / Create | Nora: the `meetings` agent, `meeting-scan` and `meeting-actions` routines, `ops-key` |
| `modules/intake/module.yaml`, `modules/chief-of-staff/module.yaml` | Modify | Give up meeting work and `ops-key` |
| `modules/ship/module.yaml`, `modules/ship/agents/ship/AGENTS.md` | Modify / Create | Sam: the `ship` agent |
| Eight teammate `AGENTS.md` files | Modify | `name:`, and `teammate:` with a kit `face:` spec; `avatar:` removed |
| Handbooks, skills, prompts, agent-facing tool strings | Modify | Old display names → role plus key |
| `modules/chief-of-staff/test/evals/assistant/cases/meeting-*.json` | Move | → `modules/meetings/test/evals/meetings/cases/` |
| `docs/configuration.md`, `modules/AGENTS.md`, `docs/design/board-ui.md`, module READMEs | Modify | The block, rename and the kit list |

---

## Task 1: Motion, layout and face tokens

**Files:** Modify `services/board/web/src/ui/tokens.css` (motion block ~143–151, space block ~121–125); Modify `ui/ui.css`
(add after the reduced-motion block ~274).

**Produces:**
- **Tokens.** `--page-max: 1920px` (defined only: phase 2 applies it to its pages, so no existing page changes width at
  2560). Also `--enter-y: 6px`, `--stagger: 35ms`, `--lift-y: -2px`, `--press-scale: 0.97`, `--pane-w: clamp(360px, 30vw, 560px)`
  and `--grid-min: 280px`.
  - `--ease-out` and `--ease-in` already exist; keep them.
- **Classes.**
  - `.enter`: fade-up from `--enter-y` over `--medium` `--ease-out`, with delay `calc(var(--i, 0) * var(--stagger))`.
  - `.lift`: on hover, `translateY(var(--lift-y))` and `--shadow-hover`.
  - `.press`: `:active` scale `--press-scale` over `--instant`.
  - `.ui-grid`: `grid-template-columns: repeat(auto-fill, minmax(min(var(--grid-min), 100%), 1fr))`.
- **Face palette tokens.** These are illustration colours, the same in both themes, and they live only in tokens.css:
  - `--face-bg-0…9` and `--face-shirt-0…9`: the ten `bg`/`shirt` pairs from Face.dc.html, in its order (aiden, tess,
    nora, max, sam, mia, iris, archie, vik, rhea).
  - `--face-skin-0…9`: the ten skin colours, in the same order.
  - `--face-hair-0…8` and `--face-brow-0…8`: the nine distinct hair and brow pairs (0 `#2b2d42` for aiden and vik,
    1 tess, 2 nora, 3 max, 4 sam, 5 mia, 6 iris, 7 archie, 8 rhea).
  - Per-accessory and per-body fill and stroke tokens, taken from the mockup.
  - `--face-ink`: pupils and outline.
  - `--face-blush`.

- [ ] Add the tokens and classes. Reduced motion needs nothing new: the global block in ui.css makes every animation
  instant.
- [ ] `cd services/board && npm run lint` passes (no hex outside tokens.css).

## Task 2: Face (kit spec or seed, shipped-image mode, states)

**Files:** Create `services/shared/face-kit.ts` (and its synced copy `services/board/src/face-kit.ts`), `ui/face-kit.ts` and `ui/Face.tsx`; Modify `ui/ui.css`.

**Interfaces, Produces:**
```ts
// services/shared/face-kit.ts (the contract; module.yaml and AGENTS.md write it in snake_case as shown)
export const HAIRS = ["short", "spiky", "long", "curly", "bun"] as const;
export const ACCESSORIES = ["none", "headset", "glasses", "round-glasses", "cap", "hard-hat", "earrings", "pencil", "headband"] as const;
export const BODIES = ["none", "tie", "notepad", "badge", "shield"] as const;
export interface FaceKit {
  hair: (typeof HAIRS)[number];
  accessory: (typeof ACCESSORIES)[number];
  body: (typeof BODIES)[number];
  skin: number;        // 0–9
  hair_color: number;  // 0–8 (brow follows)
  palette: number;     // 0–9 (background + shirt pair)
}
export function faceKitProblem(v: unknown): string | undefined;  // strict: these six keys, all required, enums and integer ranges
// services/board/web/src/ui/face-kit.ts
export type FaceState = "idle" | "working" | "needs";
export function kitFromSeed(seed: string): FaceKit;  // FNV-1a; each field from its own bits; accessory/body "none" ≈ 40%
// services/board/web/src/ui/Face.tsx
export function Face(props: { seed: string; src?: string | null; kit?: FaceKit | null; state?: FaceState; size?: number; label: string }): JSX.Element;
//   src wins (image + overlay); else kit; else kitFromSeed(seed). blink 4.3s or 5.1s from the seed.
```

- **Port Face.dc.html's character kit as tables.**
  - Each enum value maps to the mockup's SVG paths, copied verbatim (viewBox 0 0 100 100).
  - `long` and `curly` carry their back-hair path.
  - Accessory mapping: `headset` is Tess's, `pencil` Nora's, `glasses` Max's, `cap` Sam's, `earrings` Iris's, `hard-hat`
    Archie's, `headband` Vik's and `round-glasses` Rhea's.
  - Body mapping: `tie` is Aiden's, `notepad` Nora's, `badge` Mia's and `shield` Vik's.
  - The palette, skin and hair indexes follow the token order in Task 1.
  - With these specs the ten characters reproduce exactly.
- **Seed.** The agent's definition key, so a face is stable across renames. It is used only when no `kit` or `src` is
  given.
- **State, drawn by the kit:**
  - **Working.** The body bobs (`translateY` 0 → -1.8 → 0, 1.1s) and the pupils look side to side (2.6s), as CSS keyframes
    on `<g>` with `transform-box: fill-box`, never SMIL (SMIL ignores reduced motion). Green dot `var(--working)`.
  - **Needs.** Brows raised (mockup paths), the "o" mouth and an amber ring pulsing in opacity 1.4s, in `var(--warn)`.
  - **Idle.** A grey dot (`var(--faint)`).
  - **Blink.** Every state blinks, with duration `blinkMs` from the seed (4.3s or 5.1s).
- **Shipped-image mode** (`src` set):
  - `<img src={src} alt="">`, cropped to a circle, inside a wrapper drawing the same ring and dot as an overlay (no eyes
    or brows).
  - `onError` falls back to the kit face (`kit`, else the seed's) for that render, never a broken image.
- **Sizes and accessibility.**
  - Sizes run 16–96; any other `size` is clamped. Today's rows draw faces at 18 (Lineage, the crew dot) and 22
    (`.crew-av`).
  - Below 28px the dot hides, the ring stays, and the face itself still reads at 18–24px.
  - `role="img"` with `aria-label` `"${label}, ${idle|working|needs you}"`. The state is never colour alone: the label
    carries it.
- Colours are `style={{ fill: "var(--face-…)" }}`. ESLint's colour rule allows var(); no hex in TSX.

- [ ] Write `face-kit.ts` and `Face.tsx`, and add the `.ui-face*` keyframes to ui.css.
- [ ] Run `node scripts/sync-shared.ts` after creating `services/shared/face-kit.ts`.
- [ ] On `#/design`, check light and dark:
  - the ten roster specs × 3 states at sizes 24, 40 and 96 match the V2Team render;
  - six seed-only faces look like the same family (Task 5).

## Task 3: TeammateChip and the nine components

**Files:** Create the nine component files listed in File Structure; Modify `ui/index.ts`.

**Interfaces, Produces.** Phases 2 and 3 build on these exact props:
```ts
export function faceStateOf(a: RosterAgent, needsYou?: boolean): FaceState;  // working|queued → working; needsYou → needs; else idle
export function TeammateChip(props: { agent: RosterAgent; state?: FaceState; size?: number; job?: boolean; href?: string }): JSX.Element;
// "Name · Job" (agent.teammate.job; a hidden agent shows its name only); href makes it a link; seed = agent.key ?? agent.id;
// src/kit from agent.teammate?.face ({src} | {kit} | null)

export function DecisionRow(props: {
  face: ReactNode; who: string; role?: string;           // "Tess", "Follow-up chaser"
  question: ReactNode; detail?: string;                   // detail: a quoted block (a draft), clamped to 4 lines
  meta?: ReactNode; overdue?: boolean;                    // right-side age / "5 days quiet" (overdue = danger text)
  actions?: ReactNode;                                    // the caller's buttons (answer options, Approve/Reject, Open)
  receipt?: { text: string; onUndo?: () => void } | null; // collapsed row after an answer; Undo only when given
  active?: boolean; onOpen?: () => void; i?: number;      // keyboard focus ring, row click opens the pane, enter stagger index
}): JSX.Element;
export function DetailPane(props: { open: boolean; title: ReactNode; onClose: () => void; actions?: ReactNode; children: ReactNode }): JSX.Element | null;
export function DigestList(props: { items: { id: string; face?: ReactNode; text: ReactNode; link?: { label: string; href: string } }[]; limit?: number; more?: { label: string; href: string } }): JSX.Element;
export function SidePanel(props: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; face?: ReactNode; headerActions?: ReactNode; footer?: ReactNode; children: ReactNode }): JSX.Element | null;
export function Stepper(props: { steps: string[]; current: number; label?: ReactNode }): JSX.Element;      // current is 0-based
export function OptionCard(props: { type: "radio" | "checkbox"; name: string; value: string; checked: boolean; onChange: (checked: boolean) => void; title: ReactNode; sub?: ReactNode; badge?: ReactNode; media?: ReactNode; disabled?: boolean }): JSX.Element;
export function Disclosure(props: { summary: ReactNode; defaultOpen?: boolean; children: ReactNode }): JSX.Element;
export function Kbd(props: { children: ReactNode }): JSX.Element;
export function SectionCard(props: { title: ReactNode; meta?: ReactNode; count?: number; action?: ReactNode; flush?: boolean; children: ReactNode }): JSX.Element;
```
- **DetailPane** slides in from the right (`--pane-w`, `--medium` `--ease-out`; it exits with `--fast` `--ease-in`).
  - It is non-modal: no backdrop, the page stays usable.
  - Escape closes it, and focus returns to the element that opened it.
  - On a phone it is full screen.
- **SidePanel** follows the same rules: `aside` with `aria-label`, Escape, focus return, and a full-screen sheet at
  phone width. Its header holds face, title, sub and `headerActions` (history, close); its footer slot holds the composer.
- **DigestList** shows `limit` (default 3) rows. `more` renders "All N →" in the header row's style.
- **OptionCard** is a real `<input>` inside a `<label>` (keyboard, `--ring` on focus); the checked state has an accent
  border and a check mark.
- **Disclosure** is a `<button aria-expanded>` with a `grid-template-rows` 0fr → 1fr collapse transition.
- **SectionCard** matches the cards on V3Home: a header with the title, an optional `count` badge, muted `meta` and a
  right-aligned `action`. `flush` drops the body padding for row lists.
- The look comes from the mockups (V3Home: DecisionRow, SectionCard, DigestList; V2AskAiden: SidePanel; V3NewInstall:
  Stepper, OptionCard; V3Agent: Disclosure). Styles go in ui.css under one comment header per part.

- [ ] Build the components, export them all and `FaceState`/`faceStateOf` from `ui/index.ts`.
- [ ] `npx tsc -p tsconfig.build.json --noEmit` and `npm run lint` pass.

## Task 4: Agent faces on the existing UI (AgentAvatar deleted)

**Files:** Delete `web/src/AgentAvatar.tsx` and `web/src/avatar.ts`. Modify:
- `ui/Tile.tsx`: `initials` and `tone` move here.
- `components.tsx` ~5–20: the `Avatar` for a crew member is `<Face seed={a.seed} {...faceProps(a.face)} …>`; "You" keeps
  `.avatar-me`.
- `AgentPage.tsx` ~85.
- `Agents.tsx` ~207 and ~327.
- `ModulePage.tsx` ~175.
- `Workspace.tsx` ~42–50, ~245 and ~380: `portraitOf` becomes `faceOf(crew, keyOrName) → { seed, face }`; `Monogram` becomes
  a thin wrapper over `Face`, renamed `AgentFace`.
- `LaneChat.tsx` ~72 and ~86.
- `Lineage.tsx` ~95, ~111 and ~162.
- `styles.css` ~183, plus the `.agent-face`/`.mono` rules.
- `legacy-classes.json`.

| Consumer | Seed source | Face (`{src}` / `{kit}` / null) |
|---|---|---|
| Agents page row, ModulePage agent row | `RosterAgent.key ?? id` | `teammate?.face` |
| AgentPage header | `AgentProfile.key` | `teammate?.face` |
| Crew avatar (`components.tsx`), Workspace, LaneChat, Lineage (by name) | `Assignee.seed` (looked up by id, then by name) | `Assignee.face` |
| Not found in crew (a deleted agent) | the display name | none |

`faceProps(face) → { src?: string; kit?: FaceKit }` is one helper exported from `ui/Face.tsx`, and every consumer uses it.

- [ ] Replace each consumer; grep `AgentAvatar\|portraitOf\|/crew/\|\.avatar\b` in `web/src` and find only `avatar-me`.
- [ ] The states the Agents page already knows map through `faceStateOf` (working/queued → working). The `needs` state
  arrives with phase 2's Home.

## Task 5: `#/design` catalogue and board-ui.md

**Files:** Modify `web/src/Design.tsx` (beside the existing sections, ~line 40 onward) and `design.css`; Modify
`docs/design/board-ui.md` ("A page" table and the "Motion" section).

- [ ] Add one section per new part, in both theme columns:
  - **Face:**
    - the ten roster kit specs × 3 states × 3 sizes;
    - six seed-only faces;
    - one shipped-image face (`/api/faces/acme-bot` from the mock, a neutral fixture SVG), proving the overlay mode.
  - **TeammateChip:** with and without job, and as a link.
  - **DecisionRow:** the three mockup rows (a draft with Send/Edit/Not now, a two-option answer, an approval), one
    receipt with Undo and one without.
  - **DetailPane** and **SidePanel:** each opened by a button.
  - **DigestList:** with "All 9".
  - **Stepper:** at step 1 of 3.
  - **OptionCard:** two radio cards and two checkbox cards.
  - **Disclosure**, **Kbd** (`J K E S ⌘K ⌘J`) and **SectionCard**.
  - **Motion:** demos of `.enter` (a staggered list with a Replay button), `.lift` and `.press`.
- [ ] board-ui.md:
  - Add the ten parts to the "Need / Use" table: a teammate gets `TeammateChip`, an owner decision `DecisionRow`, and so
    on.
  - Add the motion tokens and classes to "Motion".
  - Add one line on the face palette, the only illustration colours, which stay in tokens.css.
  - Add one line on faces: a module picks a kit spec or ships an image; with neither, the face comes from the seed.
  - The full IA rewrite is phase 2.

## Task 6: `teammate:` through compile

**Files:** Create `services/shared/teammate-name.ts` (+ copy `services/board/src/teammate-name.ts`; it and `face-kit.ts`
are registered in `scripts/sync-shared.ts` next to `url-setting.ts` ~line 143). Modify `scripts/modules.ts` at these places:

| Where | Change |
|---|---|
| `OVERRIDABLE` (~36) | Add `name` |
| `LOCAL_AGENT_FIELDS` (~47) | Add `teammate` |
| Product agent `put` (~983) | Drop `avatar`; add `teammate` |
| Local agent `put` (~979) | Add `teammate` |
| Override loop (~1221–1240) | Validate `name` |
| After `delegate_to` (~1210) | Resolve and validate staff, controls and faces |
| Team template (~1846) | Strip `teammate`; refuse a teammate as a template |
| Catalog (~1344) | Add `teammates[]` |
| Return (~1415) | Add `faces` |

Modify `scripts/compile.ts` (~105, ~161).

**Interfaces, Produces:**
```ts
// services/shared/teammate-name.ts
export function teammateNameProblem(name: unknown, key: string, agents: Record<string, { name: string }>): string | undefined;
//   agents: every compiled agent (hidden ones included). undefined = ok. Rules (C6): string; /^[A-Za-z][A-Za-z0-9 .'-]{0,23}$/;
//   ≤4 words; norm(name) (lowercase, non-alnum → space, trimmed: chats.ts norm) differs from norm(name) and norm(key) of every
//   other agent. Messages: "a name is 1 to 24 letters, digits, spaces, . ' or -", "Tess is already an agent's name",
//   "open loops is an agent's key".

// scripts/modules.ts
export interface Teammate { job: string; sample: string; staff: string[]; controls: string[]; face: string | FaceKit | null; first?: number }  // compiled: face "<key>.<ext>" | kit spec | null
function teammateOf(raw: unknown, where: string): { job: string; sample: string; staff: string[]; controls?: string[]; face?: string | FaceKit; first?: number };  // shape only
// compile() result gains: faces: Record<string, string>   // "<key>.<ext>" → absolute source path
// catalog entries gain:   teammates: { key: string; name: string; job: string; sample: string; description: string;
//                                     department: string /* resolved id, "general" without one */; face: string | FaceKit | null; first: number | null }[]
```

- [ ] **Shape check, `teammateOf`.**
  - Unknown keys fail.
  - `job` is a 1–40 char plain string and `sample` 1–140.
  - `staff` and `controls` are lists of `^[a-z0-9][a-z0-9-]{0,62}\??$`.
  - `face` is either a bare file name `^[a-z0-9][a-z0-9._-]{0,60}\.(svg|png)$` or a map, which `faceKitProblem` (shared)
    must accept.
  - `first` (optional) is the onboarding rank, an integer 1–99; lower comes earlier. Open-loops' Tess declares `first: 1`.
  - Product agents read it from AGENTS.md frontmatter `teammate:`; local agents from the `module.yaml` entry.
- [ ] **Cross-checks, enabled agents only, after `delegate_to`.**
  - **staff.** Each entry is an enabled agent other than itself and has no `teammate` (staff are hidden). A trailing `?`
    entry is dropped when the agent is off (C2).
  - **controls.** Each entry is an enabled module; `?` is dropped when off. The default is `[own module]`.
  - **face as a file** (a kit spec needs no more checks).
    - `realpath(join(agentDir, face))` stays inside the agent's own folder and the file is ≤ 200 KB.
    - A PNG starts with the PNG magic bytes.
    - An SVG starts with `<svg` or `<?xml` and contains none of `<script`, `<foreignObject`, `<!ENTITY`, `javascript:`,
      `on[a-z]+=`, `@import`, an `href`/`xlink:href` not starting `#`, or `url(` not starting `url(#`.
    - Every failure names the agent and the file.
  - Compiled `a.teammate = { job, sample, staff, controls, face, ...(first ? { first } : {}) }`, where `face` is the kit spec, `` `${key}.${ext}` `` for
    a file, or null.
  - For a file, also set `` faces[`${key}.${ext}`] `` to its absolute path. With no shipped files today, `faces` is `{}` and
    `config/faces/` exists but is empty.
  - The face file check is one function, `faceFileProblem(agentDir, face)`; the catalog step below reuses it for
    disabled modules.
- [ ] **Names.**
  - An `overrides.agents.<key>.name` on an agent without a teammate block fails: "only a teammate is renamed".
  - After the overrides, run `teammateNameProblem` for every teammate against all the other compiled agents, so default
    names are checked too and a hand-edited instance.yaml can't break `@name`.
- [ ] **Teams (~1846).** Strip `teammate` from a member's copy (replacing today's `avatar: __`). A template that has a
  `teammate` fails: "a teammate can't be a team's template".
- [ ] **Catalog `teammates[]` (~1344), for every module in `all`, enabled or not.**
  - For a product module, read each agent's `AGENTS.md` frontmatter (`name`, `description`, `teammate`). For a local one,
    read the `module.yaml` entry.
  - `name` is the compiled (overridden) name when the agent is enabled, else the frontmatter name.
  - `department` is the agent's `department:` id, checked against the registry (`general` when absent or unknown).
  - `face` is the kit spec, `` `${key}.${ext}` `` or null, as in the compiled form.
  - `first` is the declared rank, or null.
  - **Faces for every official teammate, enabled or not.** A disabled module's face file passes the same
    `faceFileProblem` check and is added to `faces`, so `config/faces/` holds it and `/api/faces/<key>` serves it. Hiring
    and onboarding draw faces for modules that are off.
  - A disabled module whose AGENTS.md is missing, whose block fails `teammateOf`, or whose face file fails the check is
    skipped with a `warnings` entry and never fails the compile. A bad face file drops only the face (`face: null`), not
    the entry. The index's review focus is "a broken unselected module: apply still succeeds".
  - `agents: string[]` stays.
- [ ] **`scripts/compile.ts`.**
  - `syncFaces(join(cfgOut, "faces"), out.faces)`: `mkdirSync` (recursive), write each file whose bytes differ, and delete
    files not in the map.
  - Never remove the directory itself, because the board bind-mounts it and a recreated directory would leave the
    container on the old inode.
  - Without `--stage`, also `mkdirSync(config/faces)` before compose (beside `grants`, ~100) so Docker never creates it as
    root.
- [ ] `scripts/sync-shared.ts`: register `"services/shared/teammate-name.ts": ["services/board/src/teammate-name.ts"]` and
  `"services/shared/face-kit.ts": ["services/board/src/face-kit.ts"]`, then run `node scripts/sync-shared.ts`.

## Task 7: Paperclip metadata, fleet_catalog and portraits

**Files:** Modify `scripts/paperclip-setup.ts` `display()` (~245–255) and `writeCatalog()` (~400–425). Move the
portraits. Modify `compose.yaml` board volumes (~250).

- [ ] **`display()`.** Delete the `avatar` check and output. Add the following, and fail like `department` when a
  `teammate` is present but not compiled (no `job`):
  ```ts
  ...(a.teammate ? { teammate: { job, sample, staff, controls, face } } : {})
  ```
  Paperclip metadata is then exactly the compiled `Teammate`.
- [ ] **Portraits (C3).**
  - Delete `services/board/web/public/crew/` (all 12 SVGs); none move.
  - Remove every `avatar:` line from the agent frontmatter: architect, app-maintainer, chief-of-staff, reviewer-manager,
    ui-designer, ui-reviewer, fleet-steward, inbox-agent, maintainer and open-loops.
  - The ten teammates' kit specs are written in Task 11. Hidden agents get the seed face.
- [ ] **`writeCatalog()`.** Add each agent's `...(a.teammate ? { teammate: { job, sample, staff, controls } } : {})`. The
  face stays out, since agents don't need it.
  `name` is already there and is the current name. `modules` already spreads `config/modules.json`, so `teammates[]`
  reaches `fleet_catalog` with no change in `tasks-mcp` (its `fleet_catalog` passes `static.agents` and modules
  through).
- [ ] **`compose.yaml` board.** Add `- ${AIDENHQ_CONFIG_DIR:-./config}/faces:/config/faces:ro # teammates' faces
  (GET /api/faces/<key>)` and env `BOARD_FACES_DIR: /config/faces`.

## Task 8: Board roster, faces route and data types

**Files:** Modify:
- `services/board/src/paperclip.ts` ~34: metadata gets `teammate?: unknown`, loses `avatar`.
- `activity.ts` ~60–70 and ~122–128: `identity()` becomes `identity()` + `teammateOf()`.
- `board.ts` ~40–80: `Assignee.avatar` becomes `seed`/`face`; `withAvatar` becomes `withFace`.
- `agent-page.ts` ~7–20 and ~83.
- `app.ts`: the route beside `frame` in `routeApi` (~2634).
- `web/src/types.ts` ~20, ~174 and ~194–215.

**Interfaces, Produces:**
```ts
// services/board/src/activity.ts
export type RosterFace = { src: string } | { kit: FaceKit } | null;   // src: "/api/faces/<key>"
export interface RosterTeammate { job: string; sample: string; staff: string[]; controls: string[]; face: RosterFace }
export function teammateOf(a: Pick<Agent, "metadata">): RosterTeammate | undefined;   // the one parser; board.ts and agent-page.ts use it
// RosterAgent: + teammate?: RosterTeammate; − avatar
// Assignee:    + seed: string (definition key, else Paperclip id); + face?: RosterFace; − avatar
// AgentProfile:+ teammate?: RosterTeammate; − avatar
```
- [ ] Implement the parser once and validate the metadata types:
  - a string `face` becomes `{src: "/api/faces/<key>"}`;
  - a map that `faceKitProblem` (the synced copy) accepts becomes `{kit}`;
  - anything else becomes `null`.
- [ ] **`GET /api/faces/<key>`.** Build it now even though no module ships a file yet, because modules may (C3).
  - It is handled in `routeApi` before the JSON route table, behind the same account gate as every route.
  - The key matches `^[a-z0-9][a-z0-9-]{0,62}$`. The board looks for `${BOARD_FACES_DIR ?? "/config/faces"}/<key>.svg`,
    then `.png`; neither found is a 404.
  - Headers: `SECURITY_HEADERS`, `content-type` `image/svg+xml` or `image/png`,
    `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, and
    `cache-control: private, max-age=300`.
  - The UI uses it only as `<img src>`.
- [ ] **Security review (new path, before it switches on).** It serves module-supplied SVG on the board origin.
  - Confirm it is reachable only signed in.
  - Confirm that opening it directly runs no script, because of the CSP sandbox.
  - Confirm that compile's SVG check refuses each listed pattern.
  - Confirm that a path like `../` can't match the key regex.
  - Fix each finding with a test in Task 12.

## Task 9: Rename: `name` on the agent settings change

**Files:** Modify:
- `services/board/src/settings-change.ts`: `ChangeSchema` agent member (~23), `checkChange` agent branch (~200–210),
  `describe` (~220).
- `kernel/src/settings-change.ts`: `checkTyped` `case "agent"` (~156–164).
- `kernel/src/settings-change.ts` apply: no change needed; `set([...fieldsOf(ch.agent), ch.field], ch.value)` already
  writes `overrides.agents.<key>.name`.

**Interfaces, Produces (C1):** `{ kind: "agent", agent: string, field: "name", value: string }`.

- [ ] **Board.** Add `"name"` to the field enum. In `checkChange`:
  - Refuse when the agent has no `teammate` in the compiled config ("only a teammate is renamed").
  - Refuse when it is a team record or member (`a.team || a.member_of`).
  - Run `teammateNameProblem(value, ch.agent, compiled.agents)`.
  - `describe`: `rename ${old} to ${value}`.
  - The owner MCP's `change_settings` uses the same schema, so it renames too.
- [ ] **Kernel `checkTyped`.** Do the same three checks, importing `../../services/shared/teammate-name.ts`. Also refuse
  when `self` is set: an agent never renames a teammate, only the owner's board session or MCP does.
- [ ] Routing is unaffected: routing uses keys and descriptions, and setup PATCHes the Paperclip name on the next apply
  (`agentBody` reads `a.name`).

## Task 10: Owner question `detail`

**Files:** Modify:
- `modules/owner-channel/connections/notify/src/mcp.ts` ~16–28: the schema gets
  `detail: z.string().min(1).max(2000).optional()` with the describe text "the text the decision is about, e.g. the
  draft to send; shown beside the question".
- `notify.ts` ~176–178: pass `detail` to `d.wait`, and put it in the channel message and the chat mirror as a quoted
  block under `text`, so the owner's phone shows the draft. When the wait routes to the Steward or the chief of staff
  instead of the owner, `detail` is folded into the question text they receive (a quoted block after it, within the 1500
  cap).
- `kernel.ts` ~32–36: `wait(task, assertion, question, detail?)` sends `detail`.
- `kernel/src/idle.ts` ~321–392: accept `detail` (string, trimmed, ≤2000; a `detail` without `question` is a 400) and
  record it in the `work.waiting` fact's `data`.
- `kernel/src/task-state.ts` ~234–240: `waitDetail` beside `waitQuestion`, and `...(waitDetail ? { detail } : {})` in
  `extra`.
- `kernel/sdk/src/task-state-types.ts` ~25: add `detail?: string`, then sync-shared.
- `services/board/src/app.ts` ~1904: `ask = { question, ...(state.detail ? { detail: state.detail } : {}), questions, waitSince }`.
- `web/src/types.ts` ~700: `ask?: { question: string; detail?: string; questions: Question[]; waitSince: string }`.

- [ ] Implement the passthrough. Contract: `/api/needs-you` items' `ask.detail`.
- [ ] Tess uses it: in her `AGENTS.md` step 4 (the chase), the owner's decision is a `notify` `kind: decision` with
  `detail` holding the draft and one question whose options are `Send` and `Not now`; any other answer (Edit) is the new
  text. Send still files `slack_send_message_draft` through the write gates. Replace the old step text; don't add beside
  it.

## Task 11: Roster defaults, Nora and Sam

**Files:** the module and handbook files in File Structure.

- [ ] **Teammate blocks.** Each gets `name: <default>` in frontmatter plus the block below. Samples come from the
  V3NewInstall cards.

  | key (module) | name | job | sample | staff | controls |
  |---|---|---|---|---|---|
  | chief-of-staff | Aiden | Chief of staff | "Four things need you. The rest is handled." | [inbox-agent?, fleet-steward?] | [chief-of-staff, owner-channel] |
  | open-loops | Tess | Follow-up chaser | "Jonas Weber still owes you the signed contract (5 days). Chaser drafted for you to send." | – | default |
  | meetings (meetings) | Nora | Meeting notes | "Leadership sync: 4 actions, 2 are yours, due Friday." | – | default |
  | reviewer-manager | Max | PR reviewer | "PR #812: 2 findings, one real bug. Fix suggested." | – | [code-review] |
  | ship (ship) | Sam | Release manager | "Invoices export v2 merged at 06:10." | – | [ship, ci?] |
  | maintainer | Mia | Repo maintainer | "3 bugs triaged, 1 fix merged this week." | – | default |
  | app-maintainer | Iris | App builder | "Hiring pipeline board, fed by recruiter emails." | [engineer?, ui-designer?, ui-reviewer?] | [apps-platform, design?] |
  | architect | Archie | Agent Architect | "Board prep: a one-page brief the day before." | – | default |
  | security-watch | Vik | Security | "1 high CVE in an image you run. Fix PR ready." | [red-teamer?] | default |
  | assistant | Rhea | Researcher | "Weekly metrics digest, every Monday." | – | default (C4) |

  Tess (`open-loops`) also declares `first: 1`, so onboarding starts with her. The others declare no rank.

  Each one's `face:` kit spec (C3) reproduces its Face.dc.html character:

  | agent | hair | accessory | body | skin | hair_color | palette |
  |---|---|---|---|---|---|---|
  | chief-of-staff (Aiden) | short | none | tie | 0 | 0 | 0 |
  | open-loops (Tess) | long | headset | none | 1 | 1 | 1 |
  | meetings (Nora) | long | pencil | notepad | 2 | 2 | 2 |
  | reviewer-manager (Max) | spiky | glasses | none | 3 | 3 | 3 |
  | ship (Sam) | short | cap | none | 4 | 4 | 4 |
  | maintainer (Mia) | bun | none | badge | 5 | 5 | 5 |
  | app-maintainer (Iris) | curly | earrings | none | 6 | 6 | 6 |
  | architect (Archie) | short | hard-hat | none | 7 | 7 | 7 |
  | security-watch (Vik) | short | headband | shield | 8 | 0 | 8 |
  | assistant (Rhea) | long | round-glasses | none | 9 | 8 | 9 |

  Write each spec in frontmatter as `face: { hair: short, accessory: none, body: tie, skin: 0, hair_color: 0, palette: 0 }`.

  `engineer` is a team template on some instances. Staff may name a team record: it is still a hidden agent.
- [ ] **Nora.** Create `modules/meetings/agents/meetings/AGENTS.md`.
  - Frontmatter: `name: Nora`; `title: "Meeting notes and your action items from them."`; `description:` (routing) "Meeting
    notes from transcripts and Google Meet documents: matches them to the calendar, publishes them to the notes vault,
    and files the owner's own action items as deduplicated tasks."; `reportsTo: chief-of-staff`; the `teammate` block.
  - The mission is 10–20 lines; how-to stays in the skills, linked.
  - The `Type: Meeting` task-description format that `meeting-actions` says comes from "your mission" moves into
    `modules/meetings/skills/meeting-actions/SKILL.md` itself.

  In `modules/meetings/module.yaml`:
  ```yaml
  agents:
    meetings:
      skills: [ meetings.meeting-notes, meetings.meeting-actions ]
      department: intake
      model: ~deepseek/deepseek-flash-latest
      reasoning_effort: high
      timeout_sec: 3600          # the scan's runs read whole transcripts (the Researcher's limit today)
      max_parallel: 2
      web_search: disabled       # reads untrusted transcripts, like Intake: no web out
      connections:
        ops_mcp: [ obsidian_search, obsidian_read, obsidian_read_document_map, transcripts_scan, source_read, source_register_drive_document, meeting_match, meeting_resolve, meeting_publish, source_mark_failed, sync_cursor_get, sync_cursor_set ]
        google_workspace: [ calendar_list_events, calendar_get_event, drive_read_file, drive_list_meeting_documents ]
        apps: [ app_view, source_new, source_ack ]   # app_view: every crew agent (agents.test.ts); no web_view (web_search off)
        owner_channel: [ notify ]
        paperclip_tasks: [ task_current, task_get, task_comments, task_search, task_list, task_create, task_comment, task_finish ]
      roles: [ ops-key ]
  ```
  - `meeting-scan` moves to `agent: meetings`.
  - `meeting-actions` moves from `modules/intake/module.yaml` (~61–70) into meetings' `routines:` with `agent: meetings`
    and `when:` removed. Its routine key and title stay.
  - The `ops-key` role description now names Nora's agent.
  - The module description now reads "Nora (meeting notes) …".
- [ ] **Give the meeting work up.**
  - `chief-of-staff` module: remove `ops-key?` from `requests` (~13).
  - `assistant`:
    - Remove `meetings.meeting-notes` from `skills`, and `ops-key?` from `roles`.
    - From `ops_mcp?` remove `transcripts_scan, source_read, source_register_drive_document, meeting_match,
      meeting_resolve, meeting_publish, source_mark_failed, sync_cursor_get, sync_cursor_set`. It keeps the reads,
      `meeting_note_correct` (task-replies' corrections) and the `voice_note_*` tools.
    - Remove "meeting notes" from the Researcher's `title` and `description`, and `max_parallel`'s comment about the
      scan.
  - `intake`: remove `meetings.meeting-actions` from `inbox-agent` skills and the `meeting-actions` routine, and drop
    "meeting action items" from the module and agent descriptions.
  - `paperclip_ops_key` is reissued to the new holder by `ensureOpsKey` (setup ~315–327). Nothing else to do.
- [ ] **Sam.** Create `modules/ship/agents/ship/AGENTS.md`.
  - Frontmatter: `name: Sam`; `title: "Talks about and sets up how your pull requests ship."`; `description:` "Ship's
    teammate: answers the owner about a PR's merge state, holds and the release queue, and changes ship's per-repo
    settings when the owner asks (one reviewed settings change; a loosening is the owner's own save)."; `reportsTo:
    chief-of-staff`; the `teammate` block.
  - The mission: ship's service is the engine; Sam reads `ship_status`/`ship_config` and changes settings with
    `ship_configure`.

  In `modules/ship/module.yaml`:
  ```yaml
  agents:
    ship:
      skills: []
      department: engineering
      model: ~deepseek/deepseek-flash-latest
      reasoning_effort: high
      timeout_sec: 1200
      connections:
        ship: [ ship_config, ship_status, ship_configure ]
        apps: [ app_view, web_view ]   # every crew agent (scripts/test/agents.test.ts ~155)
        owner_channel: [ notify ]
        paperclip_tasks: [ task_current, task_get, task_comments, task_search, task_list, task_comment, task_handoff, task_finish, task_team ]
      roles: [ ship-admin ]
  ```
  - Aiden's, the Maintainer's and the Engineer's `ship` grants and `ship-admin?` stay unchanged; `ship-admin` already
    has several holders. Aiden routes ship talk to Sam by Sam's description.
  - Run `scripts/test/agents.test.ts` against both new agents: the web/app_view rule (~155) and the own-part rule
    (~210). Sam holds `task_handoff` and Nora doesn't, so the own-part section reaches only Sam.
- [ ] **Old display names in agent-facing text.**
  - Rule: name the teammate by its role with the key the first time, e.g. "the follow-up chaser (`open-loops`)", "the PR
    reviewer (`reviewer-manager`)", "the app builder (`app-maintainer`)", "the security agent (`security-watch`)", and
    "the chief of staff" for Aiden.
  - Roles that are also jobs stay as they are: "the Agent Architect", "the Researcher", "the maintainer".
  - Scope:
    - `modules/*/agents/*/AGENTS.md`, `modules/*/skills/*/SKILL.md`, `modules/*/prompts/*.md` and `scripts/prompts/*.md`.
    - Routine descriptions and comments in `modules/*/module.yaml`.
    - Agent-facing strings in `modules/tasks/connections/tasks-mcp/src/tools.ts` (~2072, ~2087) and
      `modules/apps-platform/apps-mcp/src/{mcp,executor}.ts` (the error and description strings).
    - `services/board/src/app-watch.ts` `HOW`.
  - Grep: `Follow-up Tracker|Reviewer Manager|DevOps Engineer|Security Watch|\bAiden\b`. Keep the Gmail label "Aiden",
    "AidenHQ" and the product's own name for itself.
  - Leave `modules/ai-reviewer/test/reviewer-cases/*`, evals and code comments alone.
  - Tests that assert handbook text and must move with it: `scripts/test/{chief-of-staff-handbook,intake-handbook,agents,official-modules}.test.ts`,
    `services/board/test/{answers,approvals-read,asks,relay}.test.ts`, `modules/apps-platform/apps-mcp/test/policy.test.ts`,
    `modules/code-review/test/engine.test.ts` and `kernel/test/settings-change.test.ts`.
- [ ] **Evals.** Move `modules/chief-of-staff/test/evals/assistant/cases/meeting-{injection-asks-to-post,publish-owner-action}.json`
  to `modules/meetings/test/evals/meetings/cases/`, with an `eval.json` modelled on the assistant's.
  - Its `why` reads "meeting notes moved from the Researcher to the meetings agent".
  - If the eval loader needs more than a new folder, or `scripts/test/ci-areas.test.ts` then demands a suite for
    `modules/meetings`, delete the two cases instead (owner: deleting tests is fine) and say so in the PR body.
  - The reviewer eval is not triggered: no file in `REVIEWER_CODE` (`modules/github/service/src/evalgate.ts:5`) changes.
    `kernel/src/settings-change.ts` importing `services/shared/` stays inside the kernel suite's paths, as
    `url-setting.ts` already does.
- [ ] **Docs.**
  - `docs/configuration.md`: the `teammate:` block, `face` rules, `overrides.agents.<key>.name` and the name rule.
  - `modules/AGENTS.md`: "Agent anatomy" gets one line ("a user-facing agent declares `teammate:`; no block = hidden"),
    and "Local modules" lists `teammate` among a local agent's fields.
  - READMEs of meetings, ship, intake and chief-of-staff: what each agent now owns.

## Task 12: End-to-end checks (minimal)

Use each area's existing setup. Run every suite under `perl -e 'alarm shift; exec @ARGV' 600 …`, then
`pkill -f "${WT:?}/"`.

- [ ] `scripts/test/teammates.test.ts` (new; fixture modules in a temp dir, the style of `agents.test.ts`):
  1. A product module agent with a `teammate` and a `face.svg`, a local agent with a kit-spec face, and
     `overrides.agents.<key>.name: "Nova"`. Assert:
     - compiled `paperclip.agents[k].teammate` deep-equals `{job, sample, staff, controls, face: "<k>.svg"}`;
     - the local agent's `face` is its kit spec;
     - `faces` has the file;
     - the catalog `teammates[]` holds the renamed name;
     - a disabled module's teammate is listed too, with `department`, `face` and `first`, and its face file is in
       `faces`;
  2. Refusals, one `assert.throws` each, by message:
     - a duplicate name (two teammates both "Tess", case-insensitive) and a name equal to another teammate's key;
     - a rename of a hidden agent;
     - `staff` naming a teammate, and `staff` naming a missing agent without `?`;
     - `controls` naming an off module without `?`;
     - a `face` outside the folder (`../x.svg`), a `face` > 200 KB, and an SVG with `<script` or `onload=`;
     - a kit spec with an unknown accessory, an unknown key, and `skin: 12`.
  3. A disabled module with a broken `teammate` block: compile succeeds and a warning names it.
- [ ] `scripts/test/official-modules.test.ts`: compiling every official module yields exactly the ten teammates above,
  keyed and named as in the Task 11 table, each with its kit spec. No `public/crew` reference remains. `meeting-scan` and `meeting-actions` run as `meetings`, and `ops-key` has one
  holder.
- [ ] `scripts/test/paperclip-setup.test.ts`: `display()` output carries `teammate` and no `avatar`.
- [ ] `services/board/test/settings-change.test.ts`: a rename of `open-loops` to "Nova" is accepted and described.
  Refused: "aiden" (taken, case-insensitive), "Engineer" (a hidden agent's name), "reviewer manager" (a key), renaming a
  hidden agent, and 25 characters.
- [ ] `kernel/test/settings-change.test.ts`: the same accept and refuse cases, plus an agent caller (`self`) refused.
  Applying the accepted change writes `overrides.agents.open-loops.name`.
- [ ] `services/board/test/faces.test.ts` (new, the app harness of `module-views.test.ts`):
  - signed in, an svg written into a temp `BOARD_FACES_DIR` serves with the CSP sandbox header and `image/svg+xml`;
  - an unknown key gets 404;
  - `..%2F` gets 404;
  - signed out gets 401.
- [ ] `kernel/test/idle.test.ts` (or `task-state-int.test.ts`): an owner wait with `detail` shows `detail` in the task's
  state; a `detail` without `question` gets 400.
- [ ] Suites to run: `cd scripts && npm test && npm run typecheck`; `cd kernel && npm test && npm run typecheck`;
  `cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint && npm run build`;
  `cd modules/owner-channel/connections/notify && npm test && npm run typecheck`; `cd modules/tasks/connections/tasks-mcp && npm test`;
  `cd modules/apps-platform/apps-mcp && npm test`; `cd modules/code-review && npm test`; then `node scripts/ci-local.ts`.

## Task 13: Review, PR, visual check

- [ ] **Mock API** (`web/dev/mock-api.ts` ~65–75, 172, 318, 551):
  - The roster fixtures become the ten teammates (key, name, `teammate` block) plus hidden Engineer, Intake and UI
    Designer.
  - The ten teammate fixtures carry their kit specs.
  - One extra local teammate fixture (`acme-bot`) has `face: {src: "/api/faces/acme-bot"}`, served from a neutral SVG in
    `web/dev/`.
  - The `ASK` fixture (~37) gets a `detail` (a draft), and `/api/needs-you` passes it through.
  - Remove the `avatar` fields.
- [ ] **Visual check.** `node web/dev/mock-api.ts` and `npm run dev:web`; screenshot `#/design`, `#/agents` and one
  agent page at 1512×982, 1920×1080, 2560×1440 and 390 wide, light and dark. Then emulate `prefers-reduced-motion:
  reduce` and confirm the faces are still. Kill both processes afterwards.
- [ ] **Codex review.** Run it in the background and read the file:
  `codex exec review --base origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`.
  Fix every important finding. A re-run after fixes uses `--base <last reviewed sha>` at `low`.
- [ ] **PR.** `feat(board): design kit and named teammates`, squash, opened with label `ship:stop` until the phase is
  complete.
  - The body lists C1–C7, the security review of `/api/faces`, and every file the diff deletes.
  - Before merging, list what the diff removes outside its scope.

## What this phase removes

- `services/board/web/src/AgentAvatar.tsx` and `services/board/web/src/avatar.ts` (`initials`/`tone` move into
  `ui/Tile.tsx`).
- `services/board/web/public/crew/` (all 12 SVGs, none moved).
- The `avatar:` frontmatter field on all ten agents that had it.
- `avatar` in the following:
  - `scripts/modules.ts` (~983, ~1846) and `scripts/paperclip-setup.ts` `display()`;
  - `services/board/src/{activity,board,agent-page,paperclip}.ts`;
  - `web/src/types.ts` and `web/dev/mock-api.ts`.
- The `/crew/<avatar>.svg` path, plus `portraitOf` and `Monogram` (Workspace) as portrait lookups.
- The CSS `.avatar.portrait`, `.agent-face` and `.mono` (now in `legacy-classes.json`).
- The Researcher's meeting scan:
  - the `meetings.meeting-notes` skill;
  - the scan's `ops_mcp` write grants;
  - `ops-key?` and the `chief-of-staff` `requests: ops-key?`.
- Intake's `meeting-actions` routine and its `meetings.meeting-actions` skill.
- Old default display names in agent-facing text: Follow-up Tracker, Reviewer Manager, DevOps Engineer, Security Watch
  and Aiden (as the agent's name), replaced by role plus key. "Agent Architect", "Researcher" and "maintainer" stay,
  because they read as roles.
