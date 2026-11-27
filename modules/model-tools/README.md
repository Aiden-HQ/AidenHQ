# model-tools

## What it does

Two ways for an agent to use more models: the advisor (a stronger model on a hard call) and fan-out workers (cheap,
tool-less workers over many items), and the prompts that tell agents how.

## Connect

Nothing to connect. The calls go through the model gateway.

## What agents get

Prompts only, each shown to agents granted the tool: `advisor` (for `paperclip_tasks.advisor_ask`) and `fanout` (for
`paperclip_tasks.fanout_map`). The tools themselves come from `tasks` (read
tools, billed to the caller's run), and `advisor_ask` is granted to crew agents by default when this module is on.

## New installs

In the default bundle. Calls count against the install's spend limit.
