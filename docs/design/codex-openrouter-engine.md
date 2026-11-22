# The Codex engine (codex-openrouter)

The one engine for Engineer jobs. Codex (`codex exec`, or `codex exec resume <session>`) runs OpenRouter models through the
model gateway, inside the job's agent computer. Code: `modules/engine-codex` (engine@1: `bin/engine`, `src/codex.ts`);
the kernel builds the job in `kernel/src/sandbox.ts` (`buildJob`, `engineState`).

## How a job runs

- **In a box.** `buildJob` writes `job.json` and `docker exec`s the engine in the Engineer's computer (`box: true`; an engine
  that doesn't run in a box is refused). No repo code runs on the host. The box is the boundary, so Codex's own sandbox is
  off (`danger-full-access`, approval `never`).
- **Model.** Provider `or` points at the box gateway's `/api/v1` (`wire_api="responses"`) with the job's run token
  (`AIDENHQ_RUN_TOKEN`); the OpenRouter key never reaches the job. Model is the agent's `model:` or the task's override,
  effort its `reasoning_effort:` (`-c model_reasoning_effort`). The gateway forces Zero Data Retention routing and records
  and caps usage.
- **Off:** ChatGPT connectors, browser and computer use, image generation, memories, hooks and plugins.
- **Events.** `--json` events become engine events (session id from `thread.started`, usage, messages, plan, tool calls);
  `-o` gives the final message.

## Codex home, instructions, skills

`CODEX_HOME` is per task (`state: task`), so no task reads another's transcripts, and `exec resume` finds the task's
sessions. Before every run the kernel removes `AGENTS.md`, `AGENTS.override.md`, `skills`, `config.toml`, `auth.json`,
`hooks.json`, `rules`, `plugins` and `.agents` (the module's `reset`), then places the agent's compiled handbook as
`AGENTS.md` and its module skills as `skills/<name>` (regular files only, read-only), so no run leaves instructions or
skills for a later one. Connections are MCP servers in the Codex home at the box's `/c/<connection>/mcp`; there are no
local stdio servers.

## Web search

A job gets `web_search="live"` unless its agent sets `web_search: disabled` (`web="disabled"`). Every jobcap an agent is
granted applies to its jobs.

## Tools in the box

The `aidenhq` command (`services/computer/images/engineer/bin/aidenhq`) calls the kernel with the job's token. Git writes
(`publish`, `merge`, `close`, `create-repo`, `apply`) are write records the kernel tiers; see
[approvals.md](approvals.md).
