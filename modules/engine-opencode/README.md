# engine-opencode

## What it does

opencode as an engine (`engine@1`, kind `opencode`) for long-lived sessions: one `opencode serve` per session in the standing
session computer, driven over opencode's HTTP API (`prompt_async`, `/event`, `/session/status`, `abort`), with the session's TUI
in tmux behind ttyd. It never emits `final`: a session ends only when the kernel stops its job. Each finished turn emits a `reply` (its last text, unless the turn called `task_comment`), which the job's dispatcher posts on the task once. A stop (SIGTERM) aborts the
turn and exits 143, so a replaced box makes dispatch resume the same opencode session (`spec.session`).

Not the default engine (engine-codex is `default: true`): only an agent that names `engine: opencode` runs on it.

## Connect

Nothing to connect. The models come from `models-openrouter`.

## What agents get

No tools. It provides an `engine` for an agent that names `engine: opencode`.

## New installs

In the default bundle with `sessions`. It runs only when a session job starts.

## How it is set up

It is fully set up from the job alone, with no config file to maintain. `src/config.ts` builds `opencode.json` in the engine's
state folder on every start:

- **Models.** One provider, `aidenhq`, pointing at the model gateway (`model.base_url`, the box's run token as the key). Its models
  are the agent's default plus its `models` list, without OpenRouter's `openrouter/` prefix. The agent's effort becomes the
  default model's `reasoningEffort`. opencode's own hosted models are not listed (`enabled_providers`).
- **Connections, as code.** The engine declares `tools: code`: no MCP server is configured. The kernel generates the job's
  granted tools as typed files in the state folder (`aidenhq-tools/`, `job.json` `tools`), and their index is an instruction
  beside `AGENTS.md`; the agent calls them from scripts through the kernel proxy
  ([code mode](../../docs/design/sessions.md#code-mode-tools-as-files)).
- **Plugins.** `plugins.json` (below), loaded from the image's `/opt/opencode/node_modules`.
- **Skills and instructions.** The kernel places the agent's `skills/` and `AGENTS.md` in the state folder, which is
  `OPENCODE_CONFIG_DIR`: opencode lists the skills (name and description) and loads `AGENTS.md` through `instructions`.
- Self-update, sharing, model-list fetching and plugin self-updates are off; nothing is fetched at run time.

## Checked on opencode 1.19.6

| What | Result |
| --- | --- |
| `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `XDG_DATA_HOME` (session database `opencode/opencode.db`), `OPENCODE_SERVER_PASSWORD`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE` | exist and behave as used here |
| Provider package | `@ai-sdk/openai-compatible` is bundled in the binary: nothing installed |
| Plugins | `plugin: ["/abs/path/to/node_modules/<name>"]` loads with no network and no cache. A bare `name@version` would be installed from npm at start, so the engine always passes the installed path |
| Config dir with only `skills/` | no dependency install and no warning offline (a `package.json` there triggers an npm install of `@opencode-ai/plugin`, so the engine never writes one) |
| Skills | `<config dir>/skills/<name>/SKILL.md` are listed by `GET /skill` and shown to the model |
| Routes | `GET /session/status` (`{}` when idle), `GET /config/providers`, `GET /mcp`, `GET /config`, `GET /experimental/tool/ids`, `GET /event` (SSE), `POST /session`, `GET /session/{id}`, `POST /session/{id}/prompt_async` (204), `POST /session/{id}/abort` |
| Events used | `message.part.updated` (tool part `state.status: running` → a step; text part with `time.end` → words), `message.updated` (assistant with `time.completed` → usage: `tokens.input`, `output`, `reasoning`, `cache.read`) |

## Plugins

`plugins.json` is the one list. The session image installs exactly it (copied to `services/computer/images/session/plugins.json`
by `scripts/sync-shared.ts`) and the engine loads the same names. A plugin goes in only if it needs no credential, sends nothing
to a third party, duplicates no kernel function (waits and schedules, memory, notifications, auth, sandboxing) and has a release
at least 7 days old, pinned exactly. Reviewed 2026-11-25 (weekly downloads from npm):

| Plugin | Version (released) | Licence | Weekly downloads | Source read | Decision |
| --- | --- | --- | --- | --- | --- |
| `@tarquinen/opencode-dcp` | 3.2.1 (2026-11-16) | AGPL-3.0-or-later | 17,484 | no install scripts. One network call: a registry check that self-updates the plugin, switched off by the engine's `dcp.jsonc` (`autoUpdate: false`) | in: prunes stale tool output, which matters for sessions that live for days. Installed, unmodified, in the image; not linked into our code |
| `opencode-pty` | 0.4.0 (2026-09-18) | MIT | 2,211 | no install scripts, no calls out (its web UI bundle is inert) | in: background processes with interactive input |
| `opencode-goal-plugin` | 0.11.4 | MIT | 1,493 | not read | out: a goal and its done-condition are the kernel's |
| `opencode-shell-strategy` | n/a | n/a | n/a | not an npm package (a markdown guide) | out |
| `opencode-scheduler`, `opencode-supermemory`, `*-auth`, `opencode-notifier`, `opencode-wakatime`, `opencode-daytona`, `opencode-helicone-session`, `oh-my-opencode`, `opencode-morph-*`, `opencode-firecrawl`, `@tavily/opencode-plugin` | | | | | out: duplicate kernel waits or memory, bypass the gateway, or are desktop, third-party or paid |

Supply chain: opencode is `1.19.6` (2026-11-17), both plugins are older than 7 days, and every version is exact. `package.json` and `bun.lock` pin the plugins' whole dependency tree (synced into the image, which runs `bun install --frozen-lockfile`), so
`scripts/supply-chain/npm-age.ts` checks every transitive version too.

## Tests

`test/config.test.ts` and `test/engine.test.ts` run anywhere (a stand-in `opencode`, `tmux`, `ttyd` and `setsid` in
`test/bin`). `test/fresh-session.e2e.test.ts` runs the real opencode 1.19.6 and is skipped where it is not on PATH:
`docker run --rm -v "$PWD":/m -w /m aidenhq/computer-session node --test test/fresh-session.e2e.test.ts`.
