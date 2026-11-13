# Agent templates

The Agent Architect starts from the closest template here (an instance agent folder: `agent.yaml` + `AGENTS.md`, in trial) and adapts it. Each has explicit grants and a routine with a done condition.

| Template | Does | Trial grants |
|---|---|---|
| `pr-review-chaser` | Drafts nudges for pull requests waiting on review | github?, slack? read |
| `digest-writer` | Scheduled digest of named sources, posted to its task | slack?, github? read, `warehouse_query` |
| `triage-bot` | Sorts a feed into act, delegate or ignore; after trial files tasks | slack? read (after trial `task_create`, `task_delegate`) |
| `app-owner` | Owns one app's backlog and files improvements to the Engineer (not the app's health: DevOps Engineer) | apps read, `app_requests` (after trial `task_delegate`) |

Apps start from `app/`: Vite + React + shadcn/ui + Tailwind, themed by the design system (`modules/core/design-system/`), served by a dependency-free Node server, with the patterns in place (sidebar and bottom-bar shell, filters that apply in place and live in the URL, a sortable table, details in a sheet, toasts, every state, a strict CSP) and a `/catalog` page. `app/aidenhq-identity.mjs` is the identity middleware every app copies unchanged: it wraps the app's whole handler and gives it `req.user` (docs/design/app-identity.md; `scripts/sync-shared.mjs` keeps it equal to `services/shared/`). CI comes from `ci/`. Every app's health URL answers JSON `{ok: true, checks: []}`: `checks` lists the rules about the app's own data it can evaluate (`{name, ok, count, sample}`; empty by default), which reach the app's owner as quality findings, never as outages (docs/configuration.md, Quality checks).
