# Agent templates

The Agent Architect starts from the closest template here (an instance agent folder: `agent.yaml` + `AGENTS.md`, in trial) and adapts it. Each has explicit grants and a routine with a done condition.

| Template | Does | Trial grants |
|---|---|---|
| `pr-review-chaser` | Drafts nudges for pull requests waiting on review | github?, slack? read |
| `digest-writer` | Scheduled digest of named sources, posted to its task | slack?, github? read, `warehouse_query` |
| `triage-bot` | Sorts a feed into act, delegate or ignore; after trial files tasks | slack? read (after trial `task_create`, `task_delegate`) |
| `app-owner` | Owns one app's backlog and files improvements to the Engineer (not the app's health: DevOps Engineer) | apps read, `app_requests` (after trial `task_delegate`) |
