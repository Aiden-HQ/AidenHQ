# platform

## What it does

The product's own gate. The platform check runs on every push, PR and merge (it raises or denies, never lowers; it always
enforces), the owner-approval records change alone. It also holds the `contract` check job for modules, the daily fork
switch-back routine and the prompts agents use to improve the system (`improving`, `improving-fleet-steward`).

## Connect

Nothing to connect.

## What agents get

No tools. The prompts go to agents that hold `task_create`, and the Fleet Steward one only when `fleet-steward` is on.

## New installs

In the default bundle. The `fork-switchback` routine (daily, 06:30 in your timezone) starts paused under quiet start.
