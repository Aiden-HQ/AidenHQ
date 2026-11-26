# A configurable page per feature

Status: design, not approved. Nothing is built until the owner approves it. Reviewed twice by Codex (Appendix).

Sibling design: [2026-11-27-owner-tasks-design.md](2026-11-27-owner-tasks-design.md) (Aiden's gates). The two share one
contract: the `sentence:` block on a setting (§16 lists where the drafts still differ). Aiden's page is one page of the pattern defined here (§10).

## 1. Why

The owner's words (2026-11-26):

- "Perhaps we should expose each functionality as a separate configurable page in the fleet like maintainer, ship etc
  have. This will help with discovery of the functionality and easy configuration as well."
- "The current settings are too advanced. We need a configuration page closer to what maintainer has."
- For Aiden: "a proper settings page for Aiden where people can set what it does, what it doesn't, other limits etc."

### Fixed decisions (inputs, not reopened)

- A module's features get their own page under Team, like code review. Module settings are for advanced only
  (owner memory note; `modules/AGENTS.md` "Features live on the module's own page").
- Owner taste: Stripe polish and Linear crispness. Settings are plain sentences, editable in place (the code-review
  page's Advanced section and the Maintainer page).
- Generic core, variation in modules, one way per concern, built for every user (CLAUDE.md "Conventions").

## 2. What exists today

**Feature pages** are `board.pages` entries (`modules/board/schemas/pages.json`). Each is a module view: an MCP Apps HTML
resource that the module's own connection serves. The board draws it in a sandboxed iframe at `#/team/m/<id>`
(`ModuleView.tsx`). The owner MCP serves the same view as an MCP App with an opener, `<id with _>_page` (`mcp.ts`).

- A page's write tool proposes a typed change. The owner's Save, in the bar outside the frame, files it through
  `/api/pages/<id>/save`. That route checks the keys (`mayPropose`: the module's own settings, or the page's `settings:`
  list) and calls `fileSettingsChange`, the same function `/api/settings/change` uses. Both land in one kernel settings
  change (`kernel/src/settings-change.ts`). The owner's save is Tier 2, decided at filing.
- Three modules have a page:
  - code review ("Reviews"; 962 lines of `page.html`);
  - ship (448 lines);
  - the Maintainer (165 lines).

  Every label, help text and sentence on them is hand-written in the module's HTML. Ship's Add repo proposes one
  change across `ship`, `code_review` and `maintainer_repos`.

**Settings** are declared in `module.yaml`: `default`, `values`, `type`, `pattern`, `entry`, `when`, `writers` (the agent
roles that may file a change), and the comment above, compiled into `doc`. Core settings are declared in
`kernel/settings.json` (`autonomy`, `spend_*`, `quiet_start` …).

Editors today:

- Settings, by category (Connections, Approvals and autonomy, Spend, Kill switches, Notifications …);
- a module's Settings tab (`ModulePage.tsx`, `SettingItem` rows of raw keys);
- an agent's routine schedules (`SettingsAgents.tsx`) and its rules (`AgentHandbook.tsx`);
- the teammate page's read-only "How X is set up" facts.

Typed changes (`ChangeSchema`, at most 10 per change):

- `setting`;
- `routine`: schedules or model;
- `agent`: model, effort, heartbeat, max_parallel, name;
- `rules`: for a module agent, text appended to its handbook; for a local agent, its whole handbook;
- `module`: on or off.

There is no typed change for per-agent `caps`. Local modules may declare only `name`, `description`, `agents` and
`routines` (`LOCAL_MODULE_KEYS`): no settings and no `contributes`.

**Teammates** (`#/team/<key>`, `Teammate.tsx`) show:

- the chat;
- "What X does" and "Recent work";
- the "How X is set up" facts;
- one Advanced link to the first `controls` module's page or settings.

`TeammateSetup` resumes the teammate's routines and runs its trial before it calls `onDone`.

### Inventory

| Module | Teammate (key) | Page today | Settings today | Functionality with no page |
|---|---|---|---|---|
| chief-of-staff | Aiden (chief-of-staff), Rhea (assistant) | none | `heartbeat_hours` | daily brief, delegation, research, Aiden's limits |
| owner-channel | (controlled by Aiden) | none | `notify_*` (Settings → Notifications) | how the team reaches you |
| intake | none (inbox-agent is Aiden's staff) | none | none | inbox, Slack and Primer triage |
| open-loops | Tess (open-loops) | none | none | follow-ups and chasers |
| meetings | Nora (meetings) | none | none | meeting notes and action items |
| apps-platform | Iris (app-maintainer) | none | `app_login` | apps: build, deploy, incidents |
| security | Vik (security-watch) | none | `app_auditor_url` | CVE triage, red team |
| agent-builder | Archie (architect) | none | none | building agents (Hire's "Describe who you need") |
| maintainer | Mia (maintainer) | Maintainer | `maintainer_repos` (github) | — |
| ship | Sam (ship) | Ship | `ship`, `ship_paused` | — |
| code-review | Max (reviewer-manager) | Reviews | `code_review` | — |
| fleet-steward | none (hidden) | none | `fleet_ops_interval_minutes` | (operator; advanced) |
| design, ci, ai-reviewer, warehouse, monitoring, sessions | none | none (sessions has Tasks › Sessions) | various | plumbing; advanced only |
| google, slack, github, jira, hubspot, glean, grafana, primer, clickhouse, channel-telegram, voice | none | none | URLs and modes | connections: Settings → Connections |

Ten teammates, three pages. Every user-facing feature with no page is run by a teammate, or by hidden staff behind one
(Intake behind Aiden).

## 3. Goals and non-goals

**Goals**

- Every user-facing feature has one page under Team. The page shows what it did, what it needs, and how it works, in
  plain sentences edited in place.
- A module ships a plain settings page **with no HTML**: a short declaration in `module.yaml`, drawn by one renderer in
  the board. Custom HTML stays for rich results (code review, ship, the Maintainer).
- Every edit goes through the one settings-change path, with today's validation, audit and tiering.
- One editor per typed target, everywhere.

**Non-goals**

- New behaviour, or knobs nothing reads. The gates are the owner-tasks design's.
- Rewriting the code review, ship or Maintainer views, or changing what they may propose.
- Connections. They stay under Settings → Connections; a page links to the ones it is missing.

## 4. Approaches

**A. A declared feature page, drawn by the board (recommended).** A `board.pages` entry without a `view` is drawn by the
board itself from the declaration. It has:

- a header with the teammate who runs it;
- What it needs;
- What it did;
- How it works (sentences).

Pages with a `view` stay exactly as today.

- For: one renderer in the board kit, so every plain page looks the same and as good as the board. No HTML or service
  per module (open-loops and chief-of-staff have none). The sentence lives once, on the setting.
- Against: the owner's Claude can't render a React page, so the MCP gets the page as data, not as an MCP App (§9).

**B. Fold features into the teammate page.** `#/team/<key>` gets tabs (Work, Settings, Chat), with no separate feature
page. The owner-tasks draft does this for Aiden alone.

- For: one page per teammate and no second header. It matches "Aiden's settings page" word for word.
- Against:
  - Features with no teammate of their own (Intake's triage, a third-party module's page) need a second host anyway.
  - A teammate with several features becomes one long tab. Aiden alone has brief, task care, triage, notifications and
    limits.
  - It drops the model the owner pointed to ("like maintainer, ship").
  - It crowds the chat-centred teammate page the home overhaul just shipped.

**C. One generic MCP Apps view in the shared kit.** The board serves one `ui://board/feature` HTML (page-kit) that draws
any declaration, in the iframe on the board and as an MCP App in Claude.

- For: one renderer for both hosts.
- Against:
  - Plain pages get the page kit's look, not the board kit's.
  - It adds a bridge per page.
  - It adds a module view for settings that no module service owns.

**Recommendation: A.** It is the least code per module (zero HTML), it gives the best look, and it adds no new save path.
The MCP gap is closed by extending the existing `modules` read, which is cheaper than C's second renderer. B stays
available for Aiden alone if the owner prefers it (§18 Q1): the same declaration renders in either place.

## 5. The unit and how pages are found

**The unit is a feature: one `board.pages` entry.** A module declares zero or more. A feature is what the owner names
when he asks "where do I set …": Follow-ups, Meeting notes, Inbox triage, Chief of staff, Ship, Reviews.

- A page shows the teammate who runs it:
  - an explicit `teammate: <key>` on the page, which compile checks is a teammate of the module or of one that
    `controls` it;
  - else the module's only teammate, or the only teammate whose `controls` include it;
  - if that is ambiguous (chief-of-staff has Aiden and Rhea), compile requires the explicit key.
- A teammate may run several pages.
- A page with no teammate shows the module's name and drops Ask and Pause, like a third-party page today.
- Names are resolved at runtime (owners rename teammates).

**Discovery, without duplicating Team:**

- **Team's sub-nav** lists pages under one group, "What your team does": the title, the teammate's face and name. It is
  today's list of pages after Team's own, regrouped. ⌘K and the phone's More sheet already list pages.
- **The teammate page** replaces its "How X is set up" facts with **X's features**: one row per page, with the title
  and the intro's first sentence, linking to the page. The teammate page stays who and chat; the feature page is what
  and settings. Neither repeats the other's editors. A teammate with no page yet (Iris, Rhea, Vik in phase 1) keeps
  today's "How X is set up" facts and Advanced link, so no teammate loses what it shows today.
- After a hire, `TeammateSetup`'s Done goes to the teammate's first feature page. Routines start before that (they
  start inside setup today). The page is where the owner checks and changes them, not a gate before the first run.
- Pages of modules that are off are not listed. Hiring is how those are found.
- **Home** names no page and its hiring tiles (Next up) are unchanged. They run the same `TeammateSetup`, so a hire
  from Home also ends on the new teammate's first page.

Later, not phase 1: a "Runs Follow-ups" line on Team cards, and Hire's detail pane listing the features a teammate
brings.

## 6. Declaring a page

The entry in `module.yaml` (schema `modules/board/schemas/pages.json`). A page is **either** a custom view
(`view`, `connection` and `tools` together, unchanged, with its `settings:` proposal list) **or** a declared page
(`show`, no `view`). The schema validator has no `oneOf`, so compile (`scripts/compiler/points.ts`) checks the two
shapes. Only custom views enter:

- the kernel's view registration;
- the board's frame and call routes;
- the MCP's opener and app-tool registration;
- the board's page-tool permission scan.

A module with a page lists `board` in `requires` (open-loops and chief-of-staff don't yet).

```yaml
contributes:
  board.pages:
    - id: chief-of-staff
      title: Chief of staff
      icon: brief
      order: 10
      intro: "Aiden is your one point of contact. He answers from what he can read, hands each request to the teammate who owns it, follows it to a verified result and sends your daily brief."
      results: { tasks: { agent: chief-of-staff } }   # optional
      show:                       # the sentences, in order; the only targets this page may save
        - group: "Your brief"
        - routine: daily-brief
        - group: "How Aiden reaches you"
        - setting: notify_transports
        - setting: notify_fyi
        - setting: notify_digest_hours
        - rules: chief-of-staff
```

`show` entries:

- `setting: <key>`: the module's own, a required module's, or a core setting (official modules only);
- `routine: <key>`: the module's own routine (its schedules);
- `rules: <agent>`: a module agent's rules (appended text). A local agent's `rules` replaces its whole handbook, so it
  is never a sentence;
- `group: "<heading>"`.

**Compile checks:**

- Every target exists.
- Each target (a setting, a routine's schedules, an agent's rules) is on at most one declared page (one editor per
  target).
- A setting in `show` declares `sentence:`. An entry whose module is off drops out.
- A third-party or local page shows only targets its module alone declares. Setting keys are global, so the key must
  be declared by no other enabled module and not by the kernel. The board checks the same on every read and save,
  against the enabled catalog.
- Text is capped (title 30, intro 300, sentence 140, label 60), with no `<`.
- Page text is never `${settings.…}`-substituted, so a module's copy can't surface instance values.

**`results`** (optional) in phase 1 is `tasks: { agent: <key> }`: the tasks that agent holds, read through the
board's existing `/api/agents/by-key/<key>/tasks` (open, then a page of history).

- They are drawn as the open ones first (needs you, then working or waiting), then the recently done.
- Each row's second line is the agent's latest status line on that task.
- A link goes to the teammate's work.

Tess's parts (`Chasing: <person>, <thing>`) are the tasks she holds. A part with a chase draft or a delivery report
waits on the owner, so it shows as needs you, and its status line says which. "Delivered" is that line, not a task
state. A label filter and handed-out tasks are not in phase 1.

A module with its own service may later add `read: <board.reads id>`. It is deferred until a second module needs it; the
apps page is the likely first.

### The sentence, declared on the setting

The sentence lives once, beside the setting it describes. Every surface renders the same words: the page, the teammate
card, the MCP and the module's Advanced row. The owner-tasks design names the same block; this is its full shape.

```yaml
settings:
  # fyi messages (news to read later): send, or mute (they still show on the board's chat). Decisions, results and
  # alerts are never muted.
  notify_fyi:
    default: send
    values: [ send, mute ]
    labels: { send: "sent to you", mute: "muted (it still shows on the board)" }
    sentence: "News to read later is {value}. Decisions and alerts always are."
```

- `sentence:` has exactly one `{value}`. `labels:` maps each value to its phrase (a value without one shows as is).
  `values` keeps its shape, so no validator changes.
- The control follows the type:
  - `values` → an inline select;
  - a number → a number field;
  - a list → chips with Add;
  - a boolean → a select of its two labelled phrases.
- **A map setting** (`type: object`) may declare `fields:`, each with its own `sentence`, `values` and `labels`. The page
  renders one sentence per field. This is how the owner-tasks design's `owner_rules` (`reply: alone`, `message: ask` …)
  becomes one sentence per action class.
  - Its edit is a `setting` change with a `field`: `{ kind: setting, key: owner_rules, field: reply, value: ask }`.
  - The kernel validates the field and value against the declaration for every caller (the compiled catalog then
    already carries `type` and then also `fields`). It merges the field into the map read from main at write time, so two edits of
    different fields never overwrite each other.
  - The map belongs to one page as a whole.
  - A map without `fields` (`ship`, `code_review`) is never a sentence; it stays in its custom view.
- A routine declares `sentence:` with `{schedule}` ("Aiden sends your daily brief {schedule}."). Its words come from
  `cronText`. Its slot is a new small picker:
  - "every day", "weekdays" or "every N hours", at a time;
  - "Custom", which falls back to the raw cron and timezone fields that `SettingsAgents.tsx` has today.
- A `rules` entry has a fixed sentence ("Your rules for Aiden"): a text area, collapsed while empty.
- Core settings get the same fields in `kernel/settings.json`.
- Under each sentence, the setting's `doc` is the help: one faint line.

## 7. Every sentence binds a real knob

A sentence nothing reads is a fake knob, so phase 1 adds none. Every sentence in the mocks maps to an existing typed
change, or to the owner-tasks design's gates:

| Page | Sentence | Typed change | Read by | Status |
|---|---|---|---|---|
| Follow-ups | Tess sweeps your open loops {every 2 hours, 9–19, weekdays} | `routine` schedules of `open-loops-sweep` | Paperclip's schedule | exists; deleted if owner-tasks lands (its sweep goes) |
| Follow-ups | Your rules for Tess | `rules open-loops` | `agents/open-loops.md`, appended to her handbook | exists |
| Chief of staff | Aiden sends your daily brief {weekdays 8:30} | `routine` schedules of `daily-brief` | Paperclip | exists |
| Chief of staff | Messages go to {Slack, then Telegram} · News to read later is {sent} · one digest at {9, 13, 18} | `setting notify_transports`, `notify_fyi`, `notify_digest_hours` | owner-channel's `notify` | exists; **moves** from Settings → Notifications |
| Chief of staff | How much they do alone {Act, ask on judgement calls} | `setting autonomy` (core) | `computeTier` | exists; **moves** from Settings with owner-tasks phase 1 |
| Chief of staff | Spend {$20} a task · {$50} a day | `setting task_usd`, `spend_day_usd` (core) | the gateway | exists; **moves** with owner-tasks phase 1 |
| Chief of staff | Reply for you {alone} · write to others {ask me first} · quiet hours · {30} a day | `setting owner_rules` (map, `fields`), `contacts`, `quiet_hours`, `send_cap_day` (core) | `kernel/src/rules.ts` → `computeTier` | **new, owner-tasks** phase 1, each shipped with its enforcement |
| Chief of staff | Your rules for Aiden | `rules chief-of-staff` | his handbook | exists |

The first draft had a new `open_loops_quiet_days` ("chase after {2} quiet working days"). It was dropped: its only reader
would be the sweep routine that the owner-tasks design deletes. So was `heartbeat_hours` ("he checks every {4} hours"):
it is the fleet-wide default, not Aiden's own, so the sentence would misstate what it changes. It stays Advanced.
Per-agent `caps` get no typed change; the install's `task_usd` and spend limits are the knobs.

## 8. The page

The mock (not committed; in the design session's scratchpad, `feature-pages-mock/`): `feature-pages.html`, with screenshots `tess-1512.png`,
`aiden-1512.png` and `tess-390.png`. It is built from the board kit (`PageHeader`, `SectionCard`, `ListRow`,
`StatusDot`, `Disclosure`, `ChangePreview`). The one new primitive is the inline sentence slot.

```
┌ (face) Follow-ups                                        [Ask Tess] [Pause] ┐
│        ● Run by Tess · Follow-up chaser · next sweep at 13:00                │
│ Tess keeps track of what people owe you … (intro)                            │
├────────────────────────────────────────────┬─────────────────────────────────┤
│ What Tess did                              │ What Tess needs                 │
│ Jonas Weber · signed contract  Needs you › │ ● Slack, Google and Intake are on│
│ Priya S. · Q3 hiring plan      Delivered › │   (or: "Needs Slack · Connect") │
│ Leo M. · vendor answers        Watching  › ├─────────────────────────────────┤
│ …                       All 9 in Tasks ↗   │ How Tess works                  │
│                                            │ Tess sweeps your open loops     │
│                                            │ [every 2 hours, 9–19, weekdays▾]│
│                                            │ ▸ Your rules for Tess           │
│                                            │ Model, effort, grants  Advanced↗│
└────────────────────────────────────────────┴─────────────────────────────────┘
            [ 1 change · overrides.routines.open-loops-sweep.schedules  Discard  Review and save ]
```

- **Header.** It has:
  - the title and the teammate's face;
  - "Run by Name · Job", linking to the teammate page;
  - a status line derived from live state (next run, working on N, paused, on events only);
  - Ask <name>, which opens Ask Aiden addressed to the teammate;
  - Pause, the teammate's existing pause.
- **What it needs** is derived, never declared:
  - the module's and its required modules' sign-ins and setup flows that aren't connected, each with its one Connect
    (`ConnectButton`);
  - a required module that is off;
  - routines paused by quiet start, with one "Turn on" (the existing teammate start).

  When everything is met, one quiet line.
- **What it did** comes from `results`. The empty state says when the first result comes, from the next run, or what is
  missing.
- **How it works** is the `show` list. A click on a value edits it in place. Edits collect into one bar at the bottom:
  the count, the instance.yaml paths, Discard, and Review and save.
  - Review opens `ChangePreview` with a page-scoped submit (below).
  - The bar holds at most 10 edits (the schema's cap); an eleventh asks to save the first ten.
  - While a filed change to one of the page's targets is in flight, its sentence shows `ChangeProgress` and its slot is
    locked (`useFiled`, as `SettingItem` does today).
- **Advanced ↗** goes to the module's Settings tab, which now lists only targets no page shows. The agent's model,
  effort and grants stay on All agents.
- Fluid like every board page: two columns above about 1000 px, one below. It is checked at 1512, 1920, 2560, 1024, 768
  and 390.

## 9. Edits, permissions and the owner's Claude

- **One path, page-scoped.** `ChangePreview` gains a `submit` prop. On a declared page it posts to
  `/api/pages/<id>/save`, which for a declared page accepts:
  - `setting`, whose key or map field is in `show`;
  - `routine` with `field: schedules`, whose routine is in `show`;
  - `rules`, whose agent is in `show`.

  It refuses anything else, then calls `fileSettingsChange`. Custom-view pages keep today's check (`mayPropose` with
  their `settings:` list).
- **Validation and audit.** The kernel checks everything again (`kernel/src/settings-change.ts`). The audit is the
  existing one: the settings task, the instance-repo commit and the `kernel.apply` record.
- **Tiers.** The owner's save is Tier 2, decided at filing as his account. The owner MCP's `change_settings` is also an
  owner save, through his OAuth credential. An agent's change goes through `/v1/settings/agent`: allowed only for a
  setting whose `writers` names a role it holds, tiered on its merits, and a loosening stays the owner's.
- **Permissions.** Every signed-in admin is an owner today, so every admin edits. `writers` is about agents, not people.
  For the later team version, people's write rights are a new field when that version is built; nothing here assumes
  one owner.
- **Untrusted text.** A third-party module's `intro`, sentences and labels are its words:
  - the board renders them as text nodes, never HTML or links;
  - result rows link only to board routes built from validated task ids;
  - the MCP fences them like any module's text;
  - a page can save only its own module's targets, and the owner sees the whole change outside the page before Save.
  The owner's preview (`ChangePreview`) always shows the canonical key and value (the instance.yaml lines) beside the
  module's label, so a misleading label can't hide what is saved.
- **Reads.** `/api/pages`, which the navigation loads, stays compact: id, title, icon, kind, teammate. A new
  `/api/pages/<id>` resolves one page: its sentences with live values and allowed values, what it needs and its results.
  The board page and the MCP share it, and the navigation never carries rules text or results.
- **The owner's Claude.** The existing `modules { name }` read adds `pages` (the compact rows). With `page: <id>`, it
  returns that page's detail. That is the data Claude needs to answer and to call the existing `change_settings`. There
  is no new tool. Custom-view pages keep their MCP App opener.

## 10. Aiden's page (aligned with the owner-tasks design)

Aiden's page is the chief-of-staff module's declared page `chief-of-staff` ("Chief of staff"). Its `show` grows by phase:

1. **This design's phase 1:**
   - "Your brief": the `daily-brief` routine;
   - "How Aiden reaches you": `notify_transports`, `notify_fyi`, `notify_digest_hours`;
   - `rules: chief-of-staff`.
2. **Owner-tasks phase 1**, each control shipped in the same change as its enforcement:
   - "What the team does for you": `care`, `care_labels`, `autonomy`, `owner_rules` (a map with `fields`), `contacts`,
     `company_domains`;
   - "Limits": `quiet_hours`, `send_cap_day`, `task_usd`, `spend_day_usd`, `spend_month_usd`.
3. **Owner-tasks phase 2:** the `records` and `publish` rows of `owner_rules`, as their hooks land.

Results: the tasks Aiden holds, including the ones he is following through someone else
(`tasks: { agent: chief-of-staff }`). Intake's triage gets its own page later,
"Inbox triage" (intake module, run by Aiden), whose sentences are its scan schedules.

The owner-tasks draft places this section in Aiden's teammate page ("How Aiden's team works"). Both designs use the same
declarations, so the place is one choice for the owner (§18 Q1). If he picks the teammate page, the teammate page
renders the `chief-of-staff` page's `show` with the same component, and the sub-nav entry links there.

Each move deletes the old editor in the same change. `notify_*`, `autonomy` and the spend limits leave Settings, which
keeps one line per category that links to the page.

- Settings → Notifications keeps what isn't a setting: the browser's notification permission and the test send.
- `notify_digest_hours` shows under General today; its General row becomes the link.
- `notify_attention`, `notify_blocked` and `notify_daily_cap` are operator knobs. They stay on the module's Advanced
  tab.

## 11. One editor per target

The board builds one index from the declared pages' `show`: target → page. A custom view's `settings:` list is
permission to propose, not an editor claim, so it never enters the index: ship's Add repo may propose `code_review`
without owning it. The custom views' own editors are named explicitly: code review's `code_review`, ship's `ship` and
`ship_paused`, and the Maintainer's `maintainer_repos`. They enter the same index as named entries, so their generic
rows become links to their pages too.

Every other editor of an indexed target shows a link instead ("On the Chief of staff page ↗"):

- Settings categories;
- the module Settings tab (`ModulePage.tsx`);
- an agent's routine schedule editor (`SettingsAgents.tsx`);
- its Your rules (`AgentHandbook.tsx`).

A target no installed page shows keeps its generic editor, so turning a module off or removing a page never strands a
setting. A setting's `when` still decides whether it shows, on the page as anywhere.

Custom views keep their own editors (code review's Advanced sentences, the Maintainer's drawer). A page is never both
a view and declared. The kit gets the sentence slot's CSS, so a view's hand-written sentences look the same.

## 12. New installs

- Only installed modules' pages are listed. A fresh install has Aiden's "Chief of staff" (chief-of-staff is in the
  default bundle). Tess (open-loops) is not in the bundle: her "Follow-ups" appears when onboarding or Hire installs
  her.
- A hire whose teammate has no page ends where it does today, on the teammate page.
- Quiet start: a page of a teammate not yet set up says in What it needs what is paused, with one "Turn on" that runs
  the existing start (routines resumed, trial once). Hire and onboarding run that same start before Done, so the page
  describes, and lets him change, what is already running. It is not a gate before the first run.
- Empty results say when the first result comes, or what to connect for one.
- Optional modules missing (GitHub, Slack): their sentences drop out, and What it needs names a module only when it is
  required.
- Third-party modules declare `board.pages` with `show` and appear with no board change.
- Local modules can't declare pages today (`LOCAL_MODULE_KEYS`). Phase 3 allows a data-only `board.pages` entry whose
  `show` holds its own routines (local agents have no rules sentence). The agent-builder templates then gain one page
  each.

## 13. Migration order

**Phase 1, the smallest useful step: the renderer, two pages, the editor index.**

- **Schema and compile** (`modules/board/schemas/pages.json`, `scripts/compiler/points.ts`, `scripts/modules.ts`,
  `kernel/settings.json`):
  - a declared page: `show`, `intro`, `teammate`, `results.tasks`;
  - on settings, routines and core settings: `sentence` and `labels`;
  - `requires: [board]` on open-loops and chief-of-staff;
  - the compile checks in §6.
- `services/board/web/src/settings-format.ts`: `cronText` learns stepped hour ranges. Today
  `0 9-19/2 * * 1-5` comes back as the raw cron; it should read "every 2h, 9:00 to 19:00, weekdays". The picker offers
  the same form.
- Not in phase 1: the `setting` change's `field` and the `fields` block. They ship with the first map setting that
  declares them, `owner_rules` in owner-tasks phase 1 (`kernel/src/settings-change.ts`, the board's
  `settings-change.ts`, and `type`/`fields` in the compiled catalog).
- **Board:**
  - `FeaturePage.tsx` (new): the declared page at `#/team/m/<id>`. Custom-view pages still render `ModuleView`;
  - `sentence.tsx`: the inline slots;
  - `ChangePreview`'s `submit`;
  - the save route's declared-page check;
  - the `/api/pages/<id>` detail read, with `/api/pages` kept compact;
  - only custom views registered in the frame, call, MCP opener and permission-scan paths;
  - the sub-nav group;
  - the schedule picker;
  - `Teammate.tsx` feature rows, replacing `SetUp` for teammates that have a page;
  - the target → page index in `Settings.tsx`, `ModulePage.tsx`, `SettingsAgents.tsx` and `AgentHandbook.tsx`.
- **MCP:** `modules { name }` gains `pages` (`services/board/src/mcp.ts`).
- **Pages:**
  - chief-of-staff "Chief of staff" (§10 step 1; `notify_*` moved off Settings → Notifications);
  - open-loops "Follow-ups" (the sweep schedule, rules, `results.tasks: { agent: open-loops }`).
- **Docs:** `docs/design/board-ui.md` "Modules" and "Teammates", `modules/AGENTS.md` "Features live on the module's own
  page", `docs/configuration.md` (`sentence`, `labels`, `fields`, `show`).

**Phase 2:**

- meetings "Meeting notes": the scan and actions schedules, rules, `meeting-action` tasks;
- intake "Inbox triage";
- security "Security": four routines;
- Rhea's "Research": rules;
- apps-platform "Apps", with `results.read` added then;
- the Team-card line and Hire's feature list;
- the owner-tasks sentences on Aiden's page, as that design lands.

**Phase 3:**

- local modules' data-only pages;
- the agent-builder templates.

The custom views stay as they are. Converting one to a declared page is that module's own later decision.

## 14. Keep in sync (touched pairs)

- The board's IA (`Shell.tsx`, `Teammate.tsx`, `TeammateSetup.tsx`) → `docs/design/board-ui.md`,
  `docs/design/guided-setup.md` and the distro site pages.
- The owner MCP's `modules` read → `docs/design/guided-setup.md` Part 3 and the distro's `site/prompt.md`.
- The board's kit (the sentence slot) → `services/shared/page-kit.{css,js}`, so custom views can match, plus
  `ModuleView.tsx` `TOKENS` and the `#/design` catalogue.
- Page and setting fields (`show`, `sentence`, `fields`) → `modules/AGENTS.md`, `docs/configuration.md` and
  `modules/agent-builder/` (phase 3).

## 15. Risks

- **Sentence drift.** A setting's meaning changes and its sentence lies. The sentence sits beside the setting in the same
  file, so a reviewer sees both in one diff.
- **Two designs, one page.** The `sentence:` block and the page's `show` are the contract. Either design can land
  first; whichever lands second adds its targets.
- **Long pages.** Aiden's `show` reaches about fifteen sentences by owner-tasks phase 2. Groups and a collapsed rules
  area keep it scannable. Past that, split a page ("Limits") rather than add tabs.
- **Thin pages.** Tess's page has one sentence today and none once her sweep goes. It is still worth having: her results
  are what the owner opens it for, and her rules live there.

## 16. Deltas for the owner-tasks design

These three are for its author; both docs should say the same thing before either is built.

1. **Labelled values.** That draft says "labelled `values`". This one keeps `values` a plain list and adds `labels:`
   (value → phrase), so no validator changes.
2. **Map settings.** `owner_rules` is a map. This doc gives a map setting `fields:` (one sentence per class) and the
   `setting` change an optional `field`, which the kernel merges at write time. That draft has neither yet.
3. **Where the sentences render.** That draft puts them in Aiden's teammate page. This doc puts them on a
   "Chief of staff" feature page, with read-only rows on the teammate page. Either works with the same declarations;
   the owner picks (§18 Q1).

## 17. Dropped behaviours (for the owner's OK)

1. **Settings → Notifications loses `notify_transports`, `notify_fyi` and `notify_digest_hours`.** They move to the
   Chief of staff page, and the category keeps the browser permission, the test send and a link.
2. **Read-only "How X is set up" facts on Aiden's and Tess's teammate pages** become rows linking to their pages.
   Teammates without a page keep them.
3. **The routine schedule and Your rules editors on All agents** become links for routines and agents that a page
   shows (`open-loops-sweep`, `daily-brief`, and Aiden's and Tess's rules).

## 18. Questions only the owner can answer

1. **Where Aiden's settings live** (what users see). Recommended: a "Chief of staff" feature page under "What your team
   does", linked from Aiden's teammate page, like every other feature. Alternative: inside Aiden's teammate page, as the
   owner-tasks draft has it.
2. **Moving Notifications (now), and later Approvals and autonomy and Spend, off Settings** onto Aiden's page, with
   Settings keeping a link. Recommended: yes. They are what Aiden and his team may do and how they reach you.
3. **The sub-nav group name:** "What your team does" (recommended), "Features" or "Pages".

## Appendix. Codex reviews

**Pass 1 (approve with changes).** Taken:

- **Custom pages keep their contract.** `show` no longer replaces `settings:`. A page is either a custom view or
  declared, because ship's Add repo proposes across three modules' settings.
- **A page-scoped save.** `ChangePreview` gets a `submit`, the route checks the kinds and `field: schedules`, and the
  10-edit cap is handled.
- **Corrected §9:** `writers` authorizes agent roles, and `change_settings` is an owner save.
- **One editor per target, not only per setting.** It covers routine schedules and rules (`SettingsAgents.tsx`,
  `AgentHandbook.tsx`). Unclaimed targets keep their editors, and `when` is kept. A local agent's `rules` is never a
  sentence, since it replaces the whole handbook.
- **The local-module contract** is stated (they can't declare pages today; phase 3, data-only).
- **Untrusted text:** rendered as text, links built only from validated ids, page text never substituted.
- **A smaller phase 1:**
  - `results.read`, the stat counts, Hire's preview, the Team-card line and the mixed iframe-plus-sentences layout are
    deferred;
  - the MCP extends `modules` instead of adding tools.
- **The new-install claim corrected.** Setup starts routines before Done, so the page is where the owner checks them,
  not a gate before the first run.
- **The sibling reconciled.** `open_loops_quiet_days` is dropped (its reader, the sweep, is deleted there). `fields` on
  a map setting lets `owner_rules` be edited per action class.

**Pass 2 (approve with changes).** Taken:

- **Map fields made safe.** A `setting` change carries an optional `field`. The kernel validates it for every caller
  and merges it into main's map at write time, so concurrent edits of different fields don't overwrite each other.
  The catalog carries `fields` (it already carries `type`). Both ship with the first map setting.
- **Third-party ownership is sole ownership**, against every enabled module and the kernel, checked at compile and on
  every read and save. The preview always shows canonical keys and values.
- **The two page shapes are enforced in compile code** (the validator has no `oneOf`). Only custom views reach view
  registration, the frame and call routes, MCP openers and the permission scan. The pilot modules require `board`.
- **The sibling's phases.** Its gate settings are now in its phase 1, each shipped with its enforcement; §10 follows.
- **Editor ownership vs proposal permission.** The index is built from declared `show` only, and the custom editors
  are named. The mixed view-plus-`show` phase 3 is cut. Notifications keeps the browser permission and the test send,
  and `notify_digest_hours`' General row becomes a link.
- **Teammate attribution.** An explicit `teammate:` is required when inference is ambiguous. With none, a page has no
  Ask or Pause. Teammates without pages keep Advanced.
- **Navigation stays compact.** `/api/pages/<id>` is the one detail read for the board and the MCP. Teammate rows show
  title and intro only.
- **First-run and controls corrected.**
  - Tess is not in the default bundle.
  - Setup starts routines before Done.
  - A hire with no page ends on the teammate page.
  - `heartbeat_hours` (the fleet default) is dropped from Aiden's page.
  - The schedule slot gets a small picker over today's raw cron fields.

Rejected:

- "Delete Q1's alternative (teammate-page editor), since the Team feature page resolves it." The sibling draft still
  places Aiden's settings on the teammate page, and where they appear is what users see. So it stays a question for
  the owner, with the feature page recommended.
- "Use one durable feature such as Daily brief" as the only phase 1 page (pass 1). Two pages, Tess and Aiden, prove the pattern
  on a teammate with one feature and on one with several, and the owner asked for Aiden's page.
