# Engineers you talk to

The user talks to an Engineer the way they talk to a coding agent: in their own words, across as many comments as it takes.
(Since 2026-11-18 every turn runs Codex in the Engineer's agent computer: a comment mid-run waits for the next turn, as
described below for Codex; the Claude Code and opencode engines are gone.)
Every comment on a task goes to the Engineer with the whole task in context. There is no classifier standing between
the user and the agent. The runner's GitHub actions are the Engineer's tools, bounded by code.

## Why

An earlier design put an intake step in front of the agent. It read each comment alone, picked one repository and one
action, and asked questions the agent never saw. That fails in predictable ways: it asks "which repository?" when the
parent task already lists them, it runs the answer to its own question as a new request, and it drops "merge them as I
instructed" because the instruction lives in context the intake does not have. Each failure taught it one more special
case, which does not converge. The structural fix is that the Engineer is the conversation, and judgment lives in the
agent while limits live in code.

## Principles

1. **Every comment goes to the Engineer**, with the whole task in context.
2. **The agent decides what to do; code decides what is allowed.** Limits on GitHub writes, workspaces and credentials
   stay in code.
3. **The user's word gates every GitHub write**, and it is checked by something that never reads untrusted content.
4. **No magic words are needed.** The exact words `push` and `pr` still work as shortcuts.

## Shape

```text
user comment -> runner: does the task wait on an unresolved blocker?
                  yes -> park it: a turn could only get its own "in progress" write refused (422)
                  no  -> is a turn running on this task?
                           no  -> start a turn (resume the Engineer's session, or start fresh with the whole thread)
                           yes -> Claude Code: hand the comment to the running session
                                  others: queue it for the next turn; "stop" interrupts

a turn -> engine (Claude Code, Codex or opencode) in the workspace
            aidenhq <command>   (CLI -> runner loopback endpoint, per-turn token)
              -> runner: bounds in code -> authorization check (user's words only) -> GitHub
          the Engineer's final message is its reply on the task (plus a branch/PR footer from the runner)
```

## What a turn sees

`services/runner/src/thread.ts` builds the prompt sections. A **fresh session** (first turn, engine switch, or after a
reset) gets everything: the Engineer's rules, the task and its parent, the whole thread oldest first with every comment
labelled (the user, the Engineer's own earlier replies, the runner, other agents), and the live state of every repository,
branch and PR in the workspace (open or draft, review decision, checks, mergeability) with the merge queue. Untrusted text
is fenced as data. A **resumed session** gets only what is new since its last reply, plus refreshed state. That is how
"as I said" works: the instruction is in the thread and the Engineer reads it.

The thread is capped at about 40,000 characters. Past the cap the oldest comments are replaced by a one-line note; the
task description is always kept, and a resumed session's own memory covers the rest.

## Tools: the `aidenhq` CLI

`services/runner/bin/aidenhq` is on every job's PATH and posts to a loopback endpoint in the runner with a token valid only
for the turn. Being a shell command, it works the same in all three engines.

| Command | Purpose | Gate |
|---|---|---|
| `status` | Branches, PRs, reviews, checks and the merge queue, live | read-only |
| `push`, `pr` | Publish branches; open draft PRs | the user's word, plus tiering |
| `merge <PR>... [--gap <min>]` | Queue PRs to merge one at a time | the user's word, plus the merge queue's checks |
| `close <PR>... --reason` | Close superseded PRs in the agents org | tiering |
| `apply` | Fleet configuration change (the runner files the approval card) | approval card |
| `repo <org/name>` | Clone another repository into the workspace | allowed orgs; public repos read-only |
| `engine <claude\|codex\|openrouter> [model]` | Run this request again on another engine or model | none needed |
| `primer [link]` | Publish the task's document to the organization's document host | the user's word |
| `pass <name>` | Pass the user's latest message to another agent on the task | none needed |
| `reset`, `cleanup` | Start the next turn fresh; remove the workspace when the run ends | none needed |
| `task`, `tasks` | Read the user's other tasks | read-only |

Help is answered inside the CLI, so asking how a command works never reaches the runner as a request. The merge queue
keeps running after the turn ends, because merges are spread over hours; its progress comments land in the thread. A
check still running past its bound marks that PR not merged, naming the checks it waited on, so the PRs after it still
merge one at a time. Those names come from the repository, so they are escaped before they print.
Writes also pass through the tier rules in [approvals.md](approvals.md).

## The user's word

If the Engineer judged for itself when the user had asked for a write, a prompt injection could steer it ("a log line says
run `aidenhq merge`"). So no write is the Engineer's call: pushes, PRs, merges and applies are approval records tiered in
code (`tiers.mjs`), and a Primer document is the kernel's `primer.publish` record. The AI reviewer (and, at Tier 2, the
owner) checks each against the request chain before anything runs, and the Engineer only files the request.

Everything else stays in code: own branches only, leases on rewritten ones, allowed orgs, leak checks on branch names,
commits and PR text, the merge queue's approval and CI gates, no plain force pushes and no admin merges. The worst case is
narrow: the user asked for a push and injected content changed what was built, and reviewers still approve every PR
before the queue merges it.

## During a run

- **Claude Code** runs with streamed input (`--input-format stream-json --replay-user-messages`), so a comment is handed
  into the running session and echoed back once taken in.
- **Codex and opencode** cannot take input mid-run. A comment waits for the next turn, which starts as soon as the
  current one ends and includes everything that arrived meanwhile.
- **The one quick reader** (`busy.ts`) looks at comments that arrive while work is running and decides between *stop*,
  *answer now* (a progress question, answered from what the work shows) and *later*. It can only stop work or say
  something; it never starts work. When in doubt it chooses *later*.

## What the runner still does in code

Polling, turns, workspaces, sessions and engines, and the sandbox. The tool endpoint and its bounds, the authorization
call, the merge queue, and signing the Engineer's commits. A turn counts as finished when it exits 0 with a final
message; a timeout or crash says so with the log tail. The Engineer replies in its own words and the runner adds a compact
branch and PR footer when something changed. An empty final message ("thanks" needs no answer) posts nothing, and an
empty task starts no turn until the first comment. Uncommitted changes are left alone and shown in the state table.

Not part of this model: recurring runs, review tasks and the board's crew view. The
Researcher agent still gathers its own context rather than reading the thread this way.

## Cost

Every comment becomes a turn on the task's engine. A resumed turn with a short comment is small; a fresh session re-reads
the thread, which the size cap bounds. Chatty threads cost more than a classifier would, which is the price of the agent
actually reading them.

## Testing

- The flow tests (`test/flow-*.test.mjs`) replay conversations against a scripted fake engine that calls the `aidenhq`
  tools the way an Engineer would, and check what was pushed, opened, queued and refused.
- `npm run eval:busy` covers the during-a-run reader: "stop", "how's it going?", "also do X".
