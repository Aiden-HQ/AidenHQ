# Home and Named Teammates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution) to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat-first board with a Home (needs you, since you last looked, your world, your team), named
teammates (user-facing vs hidden agents, faces, rename), a Team area with marketplace-first hiring, onboarding that
starts with one teammate and sets up push delivery, and one design system every page uses.

**Architecture:** Teammates are real agents marked by a `teammate:` block in the module format, carried by compile into
Paperclip metadata, the catalog and the board roster. The board gets a new IA (Home default, Team, Ask Aiden side
panel) built only from `services/board/web/src/ui` components. Three phases, one squash-merged PR each, deployed in
order.

**Tech Stack:** TypeScript (Node 24), React 19 + Vite (board web), scripts/modules.ts compile, Paperclip, kernel
(kernel/src), module MCP services.

**Spec:** `docs/superpowers/specs/2026-11-26-home-and-teammates-design.md` (read it first). Mockups (HTML sources +
renders) are design references, attached as files: `docs/superpowers/plans/2026-11-26-home-teammates-mockups/`
(V3Home, V3NewInstall, V3Agent, V3Hire, V3Hiring, V2Team, V2AskAiden, V2PhoneHome, Face; PNGs at 1512/1920/390).

## Phases (each a separate plan file and PR, in this order)

1. `2026-11-26-home-teammates-phase-1.md` — kit + teammates data (PR `feat(board): design kit and named teammates`)
2. `2026-11-26-home-teammates-phase-2.md` — IA, Home, Team pages, Ask Aiden (PR `feat(board): home, team and ask aiden`)
3. `2026-11-26-home-teammates-phase-3.md` — onboarding, hiring, push test (PR `feat(board): onboarding and hiring`)

Phase N+1 starts from main after phase N merged.

## Cross-phase contracts (fixed; every phase uses these exact names)

- **Module format** — agent `teammate:` block: `{ job: string (1–40), sample: string (1–140), staff?: string[] (agent
  keys), controls?: string[] (module names; default [own module]), first?: number (onboarding rank; lower = recommended first), face?: string (file name inside the agent's own
  folder, .svg|.png, ≤200 KB) | FaceKit (a character spec for the parametric kit: hair, accessory, skin, hair colour,
  palette; enums defined in phase 1) }`. No face → features hashed from the key. The ten roster agents declare kit
  specs matching the mockup characters. Product modules: AGENTS.md frontmatter; local modules: module.yaml agent entry
  (`LOCAL_AGENT_FIELDS` += `teammate`). The old `avatar:` field and `services/board/web/public/crew/` are deleted;
  no old portrait is kept.
- **Override** — `overrides.agents.<key>.name` (string 1–24, unique among teammates case-insensitively).
- **Compiled agent / Paperclip metadata** — `teammate: {job, sample, staff, controls, face: "<key>.<ext>" | null}`;
  faces copied to `config/faces/<key>.<ext>`.
- **Catalog** — `config/modules.json` entries keep `agents: string[]` and add `teammates: {key, name, job, sample,
  description, department, face, first}[]` (faces copied for every official teammate, enabled or not).
- **Board roster** — `RosterAgent.teammate?: {job: string; sample: string; staff: string[]; controls: string[];
  face: {src: string} | {kit: FaceKit} | null}` (`src` = `/api/faces/<key>`). Board serves `GET /api/faces/<key>`.
- **Settings change** — rename reuses the existing agent change: `{kind: "agent", agent: <key>, field: "name",
  value: <name>}` (owner only; name rule in `services/shared/teammate-name.ts`: unique vs every agent name and key,
  ASCII letters/digits/space/.'-, 1–24 chars, ≤4 words).
- **Owner question** — optional `detail?: string` (≤2000) on the owner-wait question shape, passed through
  `/api/needs-you` (`ask.detail`).
- **UI kit exports** (`services/board/web/src/ui/index.ts`, phase 1): `Face`, `TeammateChip`, `DecisionRow`,
  `DetailPane`, `DigestList`, `SidePanel`, `Stepper`, `OptionCard`, `Disclosure`, `Kbd`, `SectionCard`; motion and
  layout tokens in `tokens.css` (`--page-max: 1920px`, `--ease-out`, `--ease-in`, `--enter-y: 6px`,
  `--stagger: 35ms`); classes `.enter` (fade-up with `--i` index stagger), `.lift` (hover lift), `.press`.
  - `Face(props: {seed: string; src?: string; kit?: FaceKit; state?: "idle"|"working"|"needs"; size?: number (16–96); label: string})`
  - `TeammateChip(props: {agent: RosterAgent; state?: FaceState; size?: number; job?: boolean; href?: string})`
- **Pause** (phase 2) pauses only the teammate, never its staff (staff may be shared, e.g. the Engineer).
- **Routes** (phase 2): `#/` Home, `#/team`, `#/team/<key>`, `#/team/hire`, `#/team/agents`, `#/team/modules`,
  `#/team/m/<page>`, `#/apps`, `#/tasks`, `#/insight/costs`, `#/insight/flow`, `#/settings/...`.
- **Home API** (phase 2): `GET /api/home` → `Home` (defined in phase 2), `POST /api/home/seen {as_of}`.

## Global Constraints

- Product CLAUDE.md "Conventions" is the full rulebook (one way, no fallbacks, generic core, variation in modules).
- Build in your own worktree from origin/main; never in the main checkout; never `git stash`; clean up after merge.
- Tests minimal: a few end-to-end checks per phase that prove the feature works; no unit tests for obvious code.
- Run tests under a hard timeout (`perl -e 'alarm shift; exec @ARGV' 600 …`), `pkill -f "${WT:?}/"` after each run,
  never leave vite/mock-api running; report a blocker after ~20 min without progress.
- Board: `npx tsc -p tsconfig.build.json --noEmit` must pass; stylelint tokens-only rule holds (raw colours/px font
  sizes only in tokens.css).
- UI checked at 1512, 1920, 2560 and 390 wide with the mock API (`web/dev/mock-api.ts` gets fixtures for every new
  endpoint); light and dark; `prefers-reduced-motion` off switch.
- Copy: plain words, "Name · Role"; never module names in primary text (secondary small text only).
- Before each push: local Codex review (`codex exec review --base origin/main -m gpt-6.2-sol -c
  model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`), fix important findings.
- PR titles are Conventional Commits; squash merge; open with label `ship:stop` until the phase is complete.

## Review Focus

- A user renames a teammate to a name another teammate has, or to "Aiden": refused with a clear message.
- An instance where Google/Slack aren't connected: Home omits Today/since blocks instead of erroring or showing empty
  cards; onboarding's Tess setup asks for the connections.
- A deep link from Telegram to `#/approvals/<id>` for an already-decided card still shows the card and its outcome.
- Two tabs open on Home: the since cursor never skips items that arrived during a visit.
- A third-party marketplace with a broken unselected module: apply still succeeds; hiring shows the rest.
