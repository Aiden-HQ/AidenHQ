# Engineers you talk to

The user talks to an Engineer the way they talk to a coding agent, across as many comments as it takes. There is no
classifier in front of it: each turn runs the engine ([codex-openrouter-engine.md](codex-openrouter-engine.md)) in the
Engineer's agent computer with the whole task in context. Judgment lives in the agent; limits live in code.

## Whose words start work

`modules/dispatch/service/src/thread.ts`: the owner's comments are his words and start a turn. On a task an agent made,
its asker's comments start work, and so do a fleet overseer's on any task (a holder of role `fleet-admin` or `fleet-audit`
in the grants table). Any other agent's comment starts nothing and is told once whom to ask. HTML comments are stripped
(hidden text never counts as anyone's words), and untrusted text is fenced as data.

## What a turn sees

A fresh session gets the Engineer's rules, the task and its parent, and the thread oldest first with every comment
labelled by author. A resumed session gets what is new since its last reply. The thread is capped at about 40,000
characters (6,000 per comment); past the cap the oldest comments become a one-line note.

## Writes are gated in code

No write is the Engineer's call. Pushes, PRs, merges, closes, repo creation and applies are approval records the kernel
tiers (`aidenhq publish|merge|close|create-repo|apply`; see [approvals.md](approvals.md)); the AI reviewer, and at Tier 2
the owner, checks each against the request chain. Each command waits for its record: done prints the outcome, failure
prints the reason and exits 1, and waiting on a reviewer or the owner exits 0. Other commands: `review` (a preview of what
the reviewer would say, up to 3 a job), `clone`, `task`/`tasks` (read tasks), `advise` (the advisor), `reset` (next turn
starts fresh), `engine <kind> [model]` (rerun on another engine or model) and `cleanup`.
