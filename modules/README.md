# AidenHQ modules

The official modules for AidenHQ, a self-hosted platform for creating, running and managing your own AI agents and the
apps they build. The kernel (the rest of this repository) holds the gates, identity, sandbox, metering and audit log.
Everything else is a module: agents, connections, apps, engines, channels. This folder is the official marketplace of
those modules, tested and released with the kernel in one commit (from 2026-11-18; from 2026-11-16 until then they lived
in [aidenhq-modules](https://github.com/Aiden-HQ/aidenhq-modules), which takes no new changes).

## Layout

`marketplace.json` lists every module. Each top-level folder is one module with a `module.yaml`, plus (as needed)
`agents/<key>/AGENTS.md` handbooks, `connections/<name>/` MCP servers, `apps/` and a compose file. An instance's own modules are local
modules in its instance repo (`modules/<name>/`, [AGENTS.md](AGENTS.md) "Local modules").

| Folder | What it is |
|---|---|
| `apps-platform` | Apps platform: DevOps Engineer, apps-mcp, the gate, the app starter, the design system. Always installed. |
| `board`, `tasks`, `chief-of-staff` | The owner's board, task tools, and Aiden, the chief of staff. |
| `agent-builder`, `design`, `fleet-steward`, `maintainer`, `security`, `engineering` | Specialist agents: Agent Architect, Designer, Fleet Steward, Maintainer, Security Watch, Engineers. |
| `ai-reviewer`, `grading`, `platform` | AI review of writes, graded "done", and the product's own change gate. |
| `engine-codex` | The coding-job engine: Codex on OpenRouter models, in an agent computer. |
| `github`, `ci` | GitHub: one sign-in; agents read and write as you, labelled as AidenHQ (GitHub's own MCP server, read-only, AidenHQ's tools and the code host); self-hosted CI runners. |
| `channel-telegram`, `chat-lane` | Owner channels and the fast chat lane (`slack` is an owner channel too, in its advanced part). |
| `models-openrouter`, `model-tools` | The OpenRouter key (the gateway prices every model from OpenRouter's list); advisor and fan-out tools. |
| `google`, `slack`, `glean`, `jira`, `primer`, `meetings`, `memory`, `intake`, `open-loops` | Source connections and the agents built on them. |
| `clickhouse`, `grafana`, `monitoring`, `warehouse` | Data and observability. |

## Connections

How a connection and a module are built, and what every one declares: [AGENTS.md](AGENTS.md).

## Test locally

Each module package is a CI suite of its own (`.github/ci/areas.json`, job `modules`); `node scripts/ci-local.ts` runs the
suites your diff touches. By hand, from the repository root:

```sh
(cd kernel && npm ci) && (cd scripts && npm ci)
cd modules/<module>/<package>   # for example modules/ai-reviewer
npm ci && npm test && npm run typecheck
```

The exact command per package is its `run` in `areas.json` (Node 24).

## Licence

All the official modules are MIT, see [LICENSE](LICENSE), whatever the licence of the rest of this repository. Third-party
code keeps its own licence. See [NOTICE](NOTICE) and [LICENSES/](LICENSES/).

## Contributing and security

See the repository's [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
