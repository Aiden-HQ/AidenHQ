# The codex-openrouter engine

(Since lean core: the engine is `modules/engine-codex`; the gateway is the kernel's, `kernel/src/gateway/`; the job sandbox is the kernel's `kernel/src/sandbox.ts` (`layout()`), and jobs run through its `/v1/jobs`; the crew's Codex args are `providers.engine[].crew.args` in `modules/engine-codex/module.yaml`. The private-read endpoints and ports in the table below are the original design; agents now reach every connection through the kernel's tool proxy at `/c/<connection>/mcp`.)

Status: built 2026-11-13. The primary engine for runner jobs (the Software and Platform Engineers, light: no private reads).

## What it is

`codex-openrouter` runs the Codex CLI (`codex exec`, or `codex exec resume <session>`) against OpenRouter models through
the model gateway. It is the `codex` engine with a different model provider:

- **Provider.** `-c model_provider="or"` with `model_providers.or` = the gateway's `/api/v1`, `wire_api="responses"`,
  `env_key="AIDENHQ_GATEWAY_KEY"`. That is the same provider wiring Paperclip-hosted agents use (the crew args in
  `modules/engine-codex/module.yaml`). The key is the job's `modelToken` (kind `agent`, the Engineer's id, the task id, a TTL of
  the job timeout plus an hour), exactly what the `openrouter` engine gives opencode. The OpenRouter key never reaches
  the job. `shell_environment_policy.exclude` keeps the key and the read tokens (`*_MCP_TOKEN`) out of every command
  Codex runs; the smoke run confirmed none is visible to a tool call.
- **Sandbox.** Codex's own sandbox, as for `codex`: `workspace-write`, writable roots = the task folder, the job's
  gcloud dir and `sandbox.extra_writable_roots`. Around the whole run, the host sandbox below, in the pasta network jail.
  The gateway's loopback port joins the ports the jail forwards.
- **Model and effort.** `-m <model>` (the OpenRouter id, no `openrouter/` prefix) and
  `-c model_reasoning_effort="<effort>"` (low, medium, high, xhigh). The gateway passes `reasoning.effort` through to
  OpenRouter, which maps it per model.
- **Sessions and output.** Same as `codex`: `--json` events (`thread.started` gives the session id), `-o <last message>`.
- **Usage.** The gateway records and caps it (kind `agent`), so the runner does not self-report it from the log, as with
  `openrouter`.

## Private reads: per Engineer, not per engine

Private reads (Grafana, Slack, Glean and ClickHouse, now private jobcaps; the job's gcloud session; the `aidenhq` commands
that read other tasks) used to follow the engine kind (`codex` and `claude` got them). They now follow the Engineer: an
agent definition opts in with `private_reads: true`, setup stores it as `metadata.privateReads`, and the runner's
`pickedEngine` sets `reads` on the job's engine from it (`observes(engine)`). A job with no assigned Engineer, or an
Engineer without the flag, gets none. Every engine can carry them (opencode too, as remote MCP servers).

Owner decision, 2026-11-13: the Software and Platform Engineers are **light** Engineers, with no private reads: Primer
and web search only. A separate strong App Engineer will opt in later. Any engine may get private reads because the
gateway forces Zero Data Retention routing on every OpenRouter call (`provider.zdr = true` in `kernel/src/gateway/lib.ts`)
and OpenRouter ZDR is approved for all data.

**Web search.** A light job gets `web_search="live"` (package docs). A job with private reads gets none, so private data
can't leave through search queries: Codex `web_search="disabled"`, Claude Code without `WebFetch`/`WebSearch`, opencode
with `webfetch`/`websearch` denied. (Its shell still has the network; this closes the model's own search channel.)

Each read endpoint is read-only in code. Each is published on host loopback only, with a token of its own.

| Read | Endpoint | How writes are refused |
|---|---|---|
| Grafana | `:3124/mcp` | Read-only OAuth scopes (`grafana:read`, `grafana:query`), a read-tool allowlist and a never-list for create, update and delete |
| Slack | `:3125/mcp/read` | A route of its own built with `readOnly()`. That removes the draft tool, the only write, and blocks send and post |
| Glean | `:3126/mcp/read` | A token of its own. The whole allowlist is search and read |
| ClickHouse | `:3127/mcp` | A read-tool allowlist. `checkQuery` allows one SELECT-family statement and blocks table functions, SETTINGS and OUTFILE |
| Primer | `:3123/mcp/read` | `readOnly()`: get, list and find only. Publishing is the `primer.publish` write kind (the kernel calls primer-mcp's executor for an approved record) |

ClickHouse's guard is a query policy, not a database-level read-only user. That risk is unchanged from the `codex`
engine.

## The host sandbox: an allowlist (every engine)

Jobs used to run under `bwrap --dev-bind / /` with a list of masked paths: a job could read anything not on the list
(other tasks' folders, the product checkout, logs, the home directory). Now `layout()` in `kernel/src/sandbox.ts` binds only:

- read-write: the task folder, the engine's state (this engine's Codex home; opencode's and Claude Code's dirs for the
  others; the host's `~/.codex` for `codex`, whose login lives there), the job's gcloud dir and the run's last-message
  file;
- copy-on-write: the shared build caches (`sandbox.extra_writable_roots`), each an overlay of the host dir with the
  task's own layer (`<work_dir>/.cache-layers/<task>`), so a job's writes never reach another's (read-write and shared
  when bwrap can't mount overlays, before 0.11; the runner logs a warning);
- read-only: `/usr` (merged-/usr links recreated), `/etc`, `/opt`, the home's toolchains (`~/.local/bin`, `~/.local/lib`,
  `~/.cargo`, `~/go/bin`, … plus `sandbox.read_only_roots`), node's own prefix, the runner's wrappers
  (`services/runner/bin`), and `/run/systemd/resolve` for DNS;
- the clones' `core.hooksPath` (`<work_dir>/.guard-hooks`, the pre-push refusal), read-only;
- an empty tmpfs for `/tmp` and the home; the host's `/dev` and `/sys` (a fresh `--dev` breaks the jail's route setup);
- its own PID and IPC namespaces (`--unshare-pid --unshare-ipc`) with a fresh procfs (`--proc /proc`): no other
  process is visible, so neither the runner's `/proc/<pid>/environ` nor the host's root through `/proc/1/root`. The
  network jail's route setup needs no host procfs; pasta joins the namespace from outside by bwrap's reported pid.

`gcp.hidden` paths that fall inside an allowed path are still masked. Everything else does not exist in the job: other
tasks, the product checkout, the services' data, the secrets, the runner's state db and logs, the Docker and tailscaled
sockets, `/run/user/<uid>`. `/etc` is read whole: its secrets (`shadow`, ssh host keys) are root-only already. A test
runs a real bwrap job (where bwrap works) and checks it reads its own task folder but not a sibling's or the product
checkout, another process's environment or `/proc/1/root`; `scripts/verify-security.sh` probes the same live.

## Instructions, skills, MCP servers

Each task gets a runner-owned `CODEX_HOME` at `<state_dir>/codex-openrouter/<task id>` (setting
`engines.codex-openrouter.home`).

- **Persistent, per task.** `exec resume` finds the task's sessions; no task reads another's transcripts.
- **Not writable by tool calls.** It is not a writable root of Codex's sandbox.
- **Refreshed every start.** `AGENTS.md` and `skills/` are copied from `modules/engine-codex/codex-home/` (the engine's `seed`), and `config.toml`,
  `auth.json`, `hooks.json`, `rules/`, `plugins/` and `.agents/` are removed, so no run leaves instructions, config or
  skills for a later one. The skills' resources come from the product at the same time: the design system
  (`modules/apps-platform/design-system/`) and `best-version.mjs`, since a job can no longer read the product checkout.
- **Nothing from the host leaks in.** Everything is set with `-c`; the host's home is not in the job at all.

The product's `codex-home` contains:

- `AGENTS.md`: short global guidance for code jobs. The runner's prompt carries the job rules, so this file adds only
  the habits a repo can't tell the model (read the repo's own AGENTS.md or CLAUDE.md first, minimal tests, no new
  dependencies without the supply-chain check).
- Codex skills (`skills/<name>/SKILL.md`, Codex's native mechanism, loaded on demand by description):
  `aidenhq-product` (layout, build and test commands, sync-shared, CI),
  `supply-chain` (pinning, the 7-day rule, `best-version.mjs`), and
  `design-system` (building UI with `modules/apps-platform/design-system/`).

**MCP servers.** The agent's jobcaps (Primer; the four private reads for an Engineer with `private_reads`), each at the
kernel's `/c/<connection>/mcp` with the job token (`AIDENHQ_JOB_TOKEN`), each with `default_tools_approval_mode="approve"` (the same as
`codex`). There are no local stdio servers. A stdio MCP server is a child of Codex, outside the tool sandbox, so any
server that executes repository code (a language server does) would escape the write boundary.

Codex also installs its bundled system skills (`skills/.system`: skill-creator, skill-installer, openai-docs, imagegen,
review-agent). They are harmless here (image generation is off; skill-installer can't write the home), and 0.166 has
no switch to drop them.

**Turned off** (as for Paperclip's Codex agents): `apps` (ChatGPT connectors), browser and computer use, image
generation, `memories`, `hooks`, and remote and recommended plugins (code fetched unpinned from a marketplace). Plugins
remain a native mechanism to adopt later, pinned in the product the way skills are. Web search is live for light jobs and off with private reads (above).

## Language servers: skipped

Codex has no native LSP client. These bridges were checked:

- `isaacphi/mcp-language-server`: its last release was v0.1.1, 2025-05.
- `@mizchi/lsmcp`: last published 2025-08.
- `lsp-mcp-server`: a small single-maintainer package.
- Serena (`oraios/serena`): mature and active.

None fits our rules. Serena downloads language servers at run time, unpinned. It brings a large Python dependency tree,
starts a web dashboard, and offers edit tools. Like any stdio MCP server it would run outside Codex's tool sandbox. The
job already runs `tsc`, linters and tests in its shell, which covers most of what an LSP adds. If we revisit this,
Serena in read-only mode inside `codex sandbox`, with pinned language servers, is the candidate.

## Engine identity

Engines were keyed by the Paperclip adapter (codex_local, claude_local, opencode_local), one engine each. An Engineer
now names its engine in `module.yaml` (`engine: codex-openrouter`), and setup stores it as `metadata.engine`. Every
consumer uses `metadata.engine` if set, otherwise the adapter's engine: the runner's picker, the board, the tasks
bridge and setup's persona list.

OpenRouter Engineers keep `adapter: opencode_local`, because Paperclip never runs runner agents. The adapter only
holds the `openrouter/<model>` ids and Paperclip's OpenRouter model list. The task's effort override is stored as
`modelReasoningEffort`, the same key as for `codex`. Setup now also writes an agent's `reasoning_effort` into a runner
agent's adapterConfig, so the Settings page's effort reaches the runner.

**Fallback.** `openrouter` (opencode inside `codex sandbox`) stays a supported engine. Set an Engineer's `engine:` back
to `openrouter`, as an instance override (`overrides.agents.<key>.engine`, an owner-tier change), and its jobs run on
opencode again (and set `engines.default: opencode` in runner.yaml for jobs with no Engineer). Words that name OpenRouter
models (`openrouter`, `glm`, `openrouter:<model>`, a bare `org/model`, "use Kimi") resolve to `codex-openrouter`; only
`opencode` names the fallback engine. The tasks bridge's `openrouter` means OpenRouter models: the Engineer that runs
them, on whichever OpenRouter engine it is set to. A switch of engine starts a new session (sessions are kept per
engine). opencode now gets the effort too (`--variant`, low to high).

**Effort.** The Software and Platform Engineers run DeepSeek (`~deepseek/deepseek-flash-latest`) at medium. A future
"strong" Engineer is the same engine at xhigh.

## Cross-check (Codex, architecture level)

Applied: per-task Codex homes (transcripts), removing planted config/hooks/rules on every start, an explicit
`shell_environment_policy.exclude` rather than relying on Codex's default, one resolver for an Engineer's engine
(`metadata.engine ?? adapter`), no silent swap between the two OpenRouter engines. Covered by the allowlist sandbox:
the host's `~/.codex` and `~/.agents/skills` are not in the job. Not done: revoking a job's token when the job ends
(it is stateless and expires at the job timeout plus an hour; unchanged from `openrouter`). A repository's own
`.codex/config.toml` (which could add a stdio MCP server) is loaded only for trusted projects, and the per-task home
trusts none.

## Smoke run (2026-11-13, on the host, through `runAgent`)

- Light codex-openrouter job (DeepSeek, medium) in a copy of a real task clone: listed its folder, committed in the
  clone, could not read a sibling task or the product checkout, saw 4 processes in `/proc`, no gateway key or read
  token in its environment, Primer only, the three product skills; exit 0. The gateway logged its calls as kind
  `agent`, component `Engineer jobs`, the Software Engineer's id. `exec resume` of the session answered from it.
- With `reads: true`: Primer, Slack and Glean listed (23 tools), a Slack search returned results, no web search tool.
- The request on the wire (a local listener in place of the gateway): `POST /api/v1/responses`, model
  `~deepseek/deepseek-flash-latest`, `reasoning: {effort: "medium"}`, `Authorization: Bearer ahqj_…` (the job token).
- The opencode fallback with `--variant medium` ran under the same allowlist, Primer only.

## Risks

- A model provider that mishandles the Responses API's tool calls fails the job loudly. The gateway logs the call, and
  `openrouter` is the fallback.
- Prompts with private data go to third-party model providers under ZDR. That is approved, and enforced in the gateway.
- Light Engineers' shells still reach the Internet (package registries need it); what they hold is the task's code
  and Primer, not private data.
- A `codex` job binds the host's `~/.codex` (its login and every `codex` session) read-write, as before: only
  codex-openrouter's homes are per task.
- The allowlist can miss a toolchain a repository needs (a runtime installed outside the defaults): the job fails loudly
  and `sandbox.read_only_roots` adds it.
- ClickHouse's read guard is a query policy, not a read-only database user (unchanged).
