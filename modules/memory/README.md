# memory

## What it does

Agent memory. Each crew agent keeps one memory document of facts and lessons, each with its date and source, stored by the
kernel (`<data>/kernel/memory/agents/<key>.json`, at most 4 KB). The kernel reads it into the agent's handbook when a job
starts, and the fast chat lane reads it each turn; both fence it as data.

## Connect

Nothing to connect.

## What agents get

The `memory` prompt (`prompts/learned.md`) for every crew agent, and for its chat lane. The tools come from `tasks` and are
granted to crew agents while this module is on: `memory_note` (save a fact at once), `memory_forget`, `memory_read` and
`memory_rewrite` (compact your own memory). The kernel refuses instruction-shaped facts, strips secrets, refuses duplicates
and forgotten facts, and allows 10 changes per job. The Fleet Steward's weekly lint removes duplicate, contradicting and
stale lines from every agent's memory.

## New installs

In the default bundle. Every agent starts with an empty memory ("Nothing yet.") and fills it as it works.
