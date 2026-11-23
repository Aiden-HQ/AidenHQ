# Agent templates

The Agent Architect starts from the closest template here and adapts it. Each is a local module (`module.yaml` +
`agents/<key>/AGENTS.md`, which goes to `modules/<name>/` in the instance repo) with its designed grants and one routine
with a done condition.

| Template | Does | Grants |
|---|---|---|
| `pr-review-chaser` | Drafts nudges for pull requests waiting on review | github? read, slack? write (drafts) |
| `digest-writer` | Scheduled digest of named sources, posted to its task | slack?, github? read, `warehouse_query` |
| `triage-bot` | Sorts a feed into act, delegate or ignore and files tasks | slack? read, `task_create`, `task_delegate` |
| `app-owner` | Owns one app's backlog and files improvements to the Engineer (not the app's health: DevOps Engineer) | apps read, `app_requests`, `task_delegate` |
