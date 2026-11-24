# Fleet overview: who is working on what

Status: approved by the owner 2026-11-24 (after a Codex design review). Part 3 of three board upgrades adopted from Orca
Bots; parts 1 and 2: `2026-11-24-needs-you-answers-design.md`, `2026-11-24-task-truth-design.md`.

## Why

The owner wants to see at a glance who is working on what. Most of the data is already on the board; it is split or
under-labelled. This part is consolidation, not new views.

## Goals

1. **Sidebar** (`Workspace.tsx` Sidebar/Group, `sidebar.ts`): one compact count per agent group, needs-you first (owner
   attention), else working (`kind === "working"`), replacing today's separate dots; labelled as chat-scoped (a group's
   chats include work delegated to other agents). A chat's handed-out work keeps its one-line summary; part 2's Lineage list
   owns the delegated list.
2. **Fleet page** (`Agents.tsx`): working agents first within their existing groups; the **Now** column gives the linked task
   title more room. The Fleet nav badge (`Shell.tsx`) reads **N active runs** (it counts working sessions).
3. **Agent page Overview** (`AgentPage.tsx`): "Working now" becomes **Open tasks** (it already lists every open task), live
   work first. Needs you and history stay.
4. **Automations live in Settings**: the agent's routine rows (`SettingsAgents.tsx`) show the next run time for enabled
   schedules on active routines and, for event routines, what wakes them (connection, resource, filter) and their pause
   state. Fleet's expanded schedule list moves there; Fleet keeps one **Next run** line. Server: extend the Settings join
   (`app.ts` `settingsData`) with Paperclip's `nextRunAt` and the applied event subscription.

## Non-goals (cut in review)

- An agent-row preview of its latest reply (chat rows already show the latest message; a true latest-agent-reply needs
  server work for little gain).
- Nested workers in the sidebar (duplicates part 2's Lineage list).
- New Needs you / In progress / Planned / Closed lanes on the agent page (Agent Work already has the kernel lanes).

## Behaviour change (owner OK'd)

- Fleet's expanded schedule list moves into the agent's Settings routine rows; Fleet keeps a single next-run line.

## Approaches considered

1. **Consolidate existing views (chosen).**
2. Orca's sidebar (previews, nested workers, counts) plus per-agent grouped lanes: duplicates Lineage, Agent Work and the
   chat rows; rejected.

## Constraints

- Owner taste: dense, colour paired with text, moderate radius, no pill buttons. Browser check at 1512, 1920, 390.
- Minimal tests: the Settings join only.
