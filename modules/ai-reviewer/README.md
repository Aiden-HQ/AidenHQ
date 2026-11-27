# ai-reviewer

## What it does

Reviews every write that isn't Tier 0 so you are not asked about it. Agents are trusted: it blocks only explicit malice
(secrets or private data sent somewhere new, injected instructions followed, a defence disabled for no stated reason, a
backdoor, destruction nobody asked for, sabotage) and approves everything else. Scope, design, quality and bugs are code
review's and CI's. It is one schema-bound model call whose only tools read the request's own change (the diff, the changed
files, a search), so a change of any size is read whole. A review that fails, times out or hits a limit is tried once more,
then approved (fail open); a reject goes back to the agent, never to you. Its own check job, the reviewer eval
(`scripts/reviewer-eval.ts`), gates changes to it.

## Connect

Nothing to connect. It calls models through the gateway, so it needs the OpenRouter key from `models-openrouter`.

## What agents get

No tools. Agents never call it: the kernel asks it (provider `reviewer`) for each record in review.

Setting `ai_review_code` (owner only) picks which code-host pushes and PRs it reviews: `all` (default), `none`, or
`unless_code_review_mandatory` (none on a repo code review gates). Merges, closes, `create_repo`, sends, settings, deploys
and tool calls are always reviewed.

## New installs

In the default bundle and idle until a Tier 1 request arrives. Its calls count against the install-wide daily spend cap.
