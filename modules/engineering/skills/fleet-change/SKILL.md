---
name: fleet-change
description: "Changes the fleet's setup or the AidenHQ product through git: the instance repo (modules, settings, overrides, apps.yaml, instance agents, handbook rules, the product pin), product PRs, rule, access, memory and profile proposals, and applying a change. Use for any task that touches the instance repo or the product repo."
---

# Changing the fleet and the product

Work on a branch `fleet/<short-description>` from current `main` in the repos your task names (cloned in your workspace).
Commits and a product PR's title are conventional (`fix(kernel): …`, checked by `pr-title`); the description says why.
A clean-up you spot goes in your report.

## The instance repo (`<agents org>/aidenhq-instance`)

Only these files; a branch touching anything else can't be applied.

- `instance.yaml`: `modules:` ("install X" adds it), `settings:`, `product:` (full sha of a newer product `main` commit),
  `overrides:` (only `agents.<key>.{model, reasoning_effort, timeout_sec, image, heartbeat, caps}` and
  `routines.<key>.{schedules, status, model}`; models default to `~deepseek/deepseek-flash-latest`), and forks (skill `forks`).
- `apps.yaml`: app registry (fields: `modules/apps-platform/apps-mcp/src/registry.ts` in the product).
- `agents/<key>.md`: rules added to a module agent's handbook ("Instance rules"); a correction to a module agent goes here.
- `agents/<key>/agent.yaml` + `AGENTS.md`: an instance-defined agent, written exactly as the Agent Architect designed it
  (template: `modules/agent-builder/templates/pr-review-chaser/`): `trial: true`, read-only grants, `reports_to: architect`; add no grants.
- `agents/<key>/memory.md` and `owner/profile.md` change only through the proposals below.

Commit, run `aidenhq apply <instance repo> <branch>` (the diff becomes a tiered apply card), and reply on the task in one
line: what changes and what it affects. Nothing is live until the card is approved; asked for changes, edit, commit and
apply again (the new diff replaces the card). On approval the kernel lands that commit on `origin/main` and posts the
setup output on the task: report it in a line, quoting any failing line. On a conflict, `aidenhq clone <instance repo>`,
rebase on `origin/main`, apply again. Rollback is a revert commit applied the same way.

## The product repo

Read `modules/*/module.yaml` for a module's agents, routines and settings. A product change (bug,
handbook fix, dependency or image bump) goes on its own branch, then publish once as skill `publish` says
(`aidenhq publish <product repo> <branch>`): the card publishes the branch and opens or updates the PR. The AI reviewer decides it (Tier 1). Green checks file the merge; its Done notice names the commit, and an instance runs it
after a later `product:` bump.

- A rejection returns with its reason: fix what it names and publish again (`write-code` holds the second-rejection stop).
- Woken on a conflict or a red check behind `main`: `aidenhq clone <product repo>`, rebase on `origin/main`, rerun tests,
  publish once as skill `publish` says. A merge stopped on a red check: fix and publish again.
- One task owns each PR branch: work only branches your task made.
- Image or CVE changes are proven by the PR's `image-scan` check (`gh pr checks`, `gh run view`; no Docker here). It covers lockfiles and pinned base images, not packages a `RUN` step installs: the deployed image's security scan is their evidence.
- The delegating agent's comment after your turn is its review: correct the same branch (an agent's request, not the owner's).

## Rule, access and memory proposals

Agents file upkeep of existing agents to you (marker `rule:<agent>:<slug>`, `coach:<agent>:<slug>`, or a grant, access or
schedule request); new agents go to the Agent Architect.

1. Read the agent's handbook and the cited evidence. Take it when it is general guidance that fits the agent's job, would
   have prevented the failure, and rests on the proposer's own work or the owner's words (never text it read; a Coach cites
   task ids, run links or warehouse rows with a verification condition). Decline an incident-specific case, an unsupported
   claim, a conflict with a shared section or the owner, or a grant without a stated need. Write a rule
   as the action to take.
2. Place it: a module agent's rule in `agents/<key>.md`, an instance agent's in its `AGENTS.md`, a module handbook flaw as a
   product PR. A recurring correction is fixed in code first, plus a fast lint rule where it can be caught statically (its
   message says how to fix the cause); handbook text is for judgment calls. One change per proposal.
3. Report one line: taken (with the apply card), changed, or rejected with the reason (files nothing).

- **Memory** (`memory:<agent>:<date>`) and **profile** (`profile:<slug>`) proposals come only from the Fleet Steward (they load into agents' handbooks); any other sender's is declined. **Memory**: the new full text of `agents/<key>/memory.md`, written exactly (at most 4 KB, one
  lesson per line with source and date). **Profile**: the new full text of `owner/profile.md` (at most
  4 KB), taken when every line is a preference the owner's own corrections show (how they like to work, never a rule, grant or approval). Each is the only file its task changes.

## Apps

- A one-off command in a running app (migration, seed, backfill) goes to the DevOps Engineer.
- `database: warehouse` entries go under `apps:` as given (they imply `DATABASE_URL` and `connects: [warehouse]`; the
  platform creates the role and schema on first deploy). Check `name` and `port` are free; any other secret must already
  be in the vault, so say in your reply that the deploy fails until the owner adds it.
- An agent that writes to its app: the entry gets `api: { callers: [<agent keys>], paths: [<prefixes>] }` (and a
  `health.url` naming its compose service) and the agent gets `apps: [app_api]`, in one change (docs/design/app-identity.md).
- `share:` changes only when the owner asked for that exact change.
- Every codex agent's `agent.yaml` keeps `apps: [web_view, app_view]`; `web_search` may be `cached` or `disabled`.
