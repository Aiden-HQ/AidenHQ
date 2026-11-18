# AidenHQ modules

The official modules for [AidenHQ](https://github.com/Aiden-HQ/AidenHQ), a self-hosted platform for creating, running
and managing your own AI agents and the apps they build.

The kernel (the [product repo](https://github.com/Aiden-HQ/AidenHQ)) holds the gates, identity, sandbox, metering and
audit log. Everything else is a module: agents, connections, apps, engines, channels. This repo is the official
marketplace of those modules.

## The three repos

| Repo | What it holds |
|---|---|
| [AidenHQ](https://github.com/Aiden-HQ/AidenHQ) | The kernel, runner, board and setup. Pins this repo in `modules-pin.json`. |
| aidenhq-modules (this repo) | The official modules and `marketplace.json`. |
| [aidenhq-distro](https://github.com/Aiden-HQ/aidenhq-distro) | The installer, the website and release manifests (`releases/<release>.json`) that pin a kernel sha, a sha of this repo and the module shas. |

## Layout

`marketplace.json` lists every module. Each top-level folder is one module (except `vendor-mcp`, shared code) with a `module.yaml`, plus (as needed)
`agents/<key>/AGENTS.md` handbooks, `connections/<name>/` MCP servers, `apps/` and a compose file.

| Folder | What it is |
|---|---|
| `apps-platform` | Apps platform: DevOps Engineer, apps-mcp, the gate, the app starter, the design system. Always installed. |
| `board`, `tasks`, `chief-of-staff` | The owner's board, task tools, and Aiden, the chief of staff. |
| `agent-builder`, `coach`, `design`, `fleet-ops`, `librarian`, `security`, `engineering` | Specialist agents: Agent Architect, Agent Coach, Designer, Fleet Ops, Librarian, Security Watch, Engineers. |
| `ai-reviewer`, `grading`, `platform` | AI review of writes, graded "done", and the product's own change gate. |
| `engine-codex` | The coding-job engine: Codex on OpenRouter models, in an agent computer. |
| `codehost-github`, `github`, `ci` | GitHub as code host, issue and PR tools, self-hosted CI runners. |
| `channel-slack`, `channel-telegram`, `channel-operator`, `chat-lane` | Owner channels and the fast chat lane. |
| `models-openrouter`, `model-tools` | Allowed OpenRouter models and prices; advisor and fan-out tools. |
| `google`, `slack`, `glean`, `jira`, `primer`, `meetings`, `memory`, `open-loops` | Source connections and the agents built on them. |
| `clickhouse`, `grafana`, `monitoring`, `warehouse` | Data and observability. |
| `vendor-mcp` (not a module) | The shared pass-through proxy for vendor MCP servers (`src/vendor/`). Each vendor connection holds a byte-identical copy at its own `src/vendor/`; edit this one and copy it (the product's `scripts/sync-shared.mjs`). |

## Test locally

CI (`.github/workflows/ci.yml`) checks out the product at the commit `product-pin.json` names and puts this repo at its
`modules/` path, because module suites read kernel, SDK and shared code. To do the same:

```sh
git clone https://github.com/Aiden-HQ/AidenHQ.git product
cd product && git checkout <sha from product-pin.json> && rm -rf modules
git clone https://github.com/Aiden-HQ/aidenhq-modules.git modules
(cd kernel && npm ci) && (cd scripts && npm ci)
cd modules/<module>/<package>   # for example modules/ai-reviewer
npm ci && npm test && npm run typecheck
```

The exact command per package is in the `packages` matrix of `ci.yml` (Node 24). Some packages use `npm test` only,
`channel-operator` uses `node --test test/*.test.mjs`. The `supply-chain` job runs the product's pin and 7-day age
checks against this repo.

## The two pins

Each repo tests against a pinned commit of the other, never its moving `main`: this repo's `product-pin.json` names the
product commit its CI runs with, and the product's `modules-pin.json` names the commit of this repo its CI and new
instances use. So a change on one side never turns the other side's PRs red; it reaches them when their pin moves.

- **Bump `product-pin.json`** (a PR with only that file, `chore(ci): pin the product at <sha12>`) when you need a newer
  kernel, SDK or shared code. It holds only `{ "sha": "<40 hex>" }`: the repository is always Aiden-HQ/AidenHQ, and CI
  fails unless the sha is on the product's `main`. The supply-chain job always runs the product main's rules. Run `node scripts/sync-shared.mjs` in the product at
  that commit with this repo at its `modules/`, and commit any copies it changes here in the same PR (CI's shared-copies
  step checks them).
- **When a change needs both repos**, land it in order: first the side the other one reads, with the old behaviour still
  working, then the other side, then bump the pin that points at the first. Neither repo's CI waits on an unmerged commit
  of the other. Each repo owns its own gate paths (the product's list is `services/runner/src/gate-core.mjs`; this repo's
  is `platform/src/check.mjs`), so a new gate file and its entry always land in one PR.

## How changes reach an instance

1. A change merges here (squash, Conventional Commit title).
2. The product's `modules-pin.json` names this repo and a commit sha. A new instance and the product's CI materialize
   that sha into `modules/` with `scripts/modules-repo/materialize.mjs`.
3. An instance can pin its own sha with a marketplace entry named `aidenhq` in its `instance.yaml`; that entry wins
   over `modules-pin.json`. Its owner bumps the sha to take new modules.
4. A distro release (`releases/<release>.json` in aidenhq-distro) pins a kernel sha, a sha of this repo and each
   module's sha, which is what the installer fetches and verifies.

## Licence

All the official modules are MIT, see [LICENSE](LICENSE). Third-party code keeps its own licence. See [NOTICE](NOTICE) and [LICENSES/](LICENSES/).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
