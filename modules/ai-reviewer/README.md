# ai-reviewer

## What it does

Decides Tier 1 requests so you are not asked about every write: approve, reject, or hand it to you. It is one
schema-bound model call with no tools. A second reviewer of another model family reads an unsure or
authority-expanding change. Its own check job, the reviewer eval (`scripts/reviewer-eval.ts`), gates changes to it.

## Connect

Nothing to connect. It calls models through the gateway, so it needs the OpenRouter key from `models-openrouter`.

## What agents get

No tools. Agents never call it: the kernel asks it (provider `reviewer`) for each Tier 1 record.

## New installs

In the default bundle and idle until a Tier 1 request arrives. Its calls count against the install-wide daily spend cap.
