# AidenHQ modules

The official modules for AidenHQ, a self-hosted platform for creating, running and managing your own AI agents and the
apps they build. The kernel (the rest of this repository) holds the gates, identity, sandbox, metering and audit log.
Everything else is a module: agents, connections, apps, engines, channels. This folder is the official marketplace of
those modules, tested and released with the kernel in one commit.

## Layout

`marketplace.json` lists every module and the default `bundle` a new install gets. Each top-level folder is one module
with a `module.yaml` and a `README.md` (what it does, how to connect it, what agents get, what a new install sees), plus
(as needed) `agents/<key>/AGENTS.md` handbooks, `skills/`, `prompts/`, `connections/<name>/` MCP servers, `apps/` and
services. An instance's own modules are local modules in its instance repo (`modules/<name>/`, [AGENTS.md](AGENTS.md)
"Local modules").

| Folder | What it is |
|---|---|
| `apps-platform` | Apps platform: DevOps Engineer, apps-mcp, the gate, the app starter, the design system. In the default bundle. |
| `board`, `tasks`, `chief-of-staff`, `dispatch` | The owner's board, task tools, Aiden the chief of staff, and the job dispatcher that turns wakes into agent jobs. |
| `agent-builder`, `design`, `fleet-steward`, `maintainer`, `security`, `engineering`, `sessions` | Specialist agents: Agent Architect, UI Designer and UI Reviewer, Fleet Steward, Maintainer, Security Watch and Red Teamer, Engineers, Session. |
| `ai-reviewer`, `grading`, `platform` | AI review of writes, the rubric check on finished work, and the product's own change gate. |
| `engine-codex`, `engine-opencode` | The job engines: Codex on OpenRouter models for Engineer jobs; opencode for long-lived sessions. |
| `github`, `codehost-local` | The code host: GitHub (one sign-in; GitHub's own MCP server read-only, AidenHQ's tools and the code host), or repositories on this server. |
| `ci`, `code-review`, `ship` | Self-hosted CI runners, pull request review, and the lifecycle of every PR through to merge. |
| `owner-channel`, `channel-telegram`, `voice`, `chat-lane` | How messages reach you: `notify` and its routing, Telegram, voice notes, and the fast chat lane (`slack` is an owner channel too, in its advanced part). |
| `models-openrouter`, `model-tools`, `memory` | The OpenRouter key (the gateway prices every model from OpenRouter's list); advisor and fan-out tools; agent memory. |
| `google`, `slack`, `glean`, `jira`, `hubspot`, `primer`, `meetings`, `intake`, `open-loops` | Source connections and the agents built on them. |
| `clickhouse`, `grafana`, `monitoring`, `warehouse` | Data and observability. |

## Connections

How a connection and a module are built, and what every one declares: [AGENTS.md](AGENTS.md).

## Test locally

Each module package is a CI suite of its own (`.github/ci/areas.json`, job `modules`); `node scripts/ci-local.ts` runs the
suites your diff touches. By hand, from the repository root:

```sh
(cd kernel && bun install --frozen-lockfile --ignore-scripts) && (cd scripts && bun install --frozen-lockfile --ignore-scripts)
cd modules/<module>/<package>   # for example modules/ai-reviewer
bun install --frozen-lockfile --ignore-scripts && bun run test && bun run typecheck
```

The exact command per package is its `run` in `areas.json`. Node 24 runs the code; `bun run test` runs `bun test` (Bun 1.4.5), which wants `--parallel`: it starts every test file in its own process, as `node --test` did.

## Licence

All the official modules are MIT, see [LICENSE](LICENSE), whatever the licence of the rest of this repository. Third-party
code keeps its own licence. See [NOTICE](NOTICE) and [LICENSES/](LICENSES/).

## Contributing and security

See the repository's [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
