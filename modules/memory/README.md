# memory

## What it does

Agent memory. Facts an agent noted (`memory_note`) are curated by the Fleet Steward into the instance's
`agents/<key>/memory.md`, which is compiled into that agent's handbook and its fast chat lane (at most 4 KB).

## Connect

Nothing to connect.

## What agents get

The `memory` prompt (`prompts/memory.md`) for an agent with the `memory` field set, and for its chat lane. The tool
`memory_note` (a note on the agent's own memory inbox task, for the Fleet Steward) comes from `tasks` and is granted to
crew agents when this module is on.

## New installs

In the default bundle. No agent has memory until it notes something and the Steward curates it.
