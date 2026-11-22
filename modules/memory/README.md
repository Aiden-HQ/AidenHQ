# memory

## What it does

Agent memory. The Fleet Steward curates lessons and facts from an agent's notes (`memory_note`) and recent work into the
instance's `agents/<key>/memory.md`, which is compiled into that agent's handbook and its fast chat lane (at most 4 KB).

## Connect

Nothing to connect.

## What agents get

The `memory` prompt (`prompts/memory.md`) for an agent with the `memory` field set, and for its chat lane. The tool
`memory_note` (a note on the agent's own memory inbox task, for the Fleet Steward) comes from `tasks` and is granted to
crew agents when this module is on.

## New installs

In the default bundle. No agent has memory until the Steward has learned something from its work.
