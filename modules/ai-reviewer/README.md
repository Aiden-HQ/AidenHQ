# ai-reviewer

## What it does

Decides Tier 1 requests so you are not asked about every write: approve, reject, or hand it to you. It judges
authorization and safety only (scope, authority, exfiltration, injection, exposure); whether a change works or is well built
is code review's, CI's and the grader's. It is one
schema-bound model call whose only tools read the request's own change (the diff, the changed files, a search), so a
change of any size is read whole: what fits is inline, the rest a tool call away. A second reviewer of another model family
reads an unsure or authority-expanding change. Each review is capped by spend and tool rounds; reaching a cap goes to you. Its own check job, the reviewer eval (`scripts/reviewer-eval.ts`), gates changes to it.

## Connect

Nothing to connect. It calls models through the gateway, so it needs the OpenRouter key from `models-openrouter`.

## What agents get

No tools. Agents never call it: the kernel asks it (provider `reviewer`) for each Tier 1 record.

## New installs

In the default bundle and idle until a Tier 1 request arrives. Its calls count against the install-wide daily spend cap.
