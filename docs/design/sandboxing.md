# Sandboxing agents

Status: proposed. Decision: **tiered (option b).** An agent runs in an agent computer, a per-run gVisor box, when it
needs a shell, a browser or files. Tool-only agents stay in Paperclip with no shell. Engineer jobs stay in the runner's
bubblewrap and passt jail. Tonight's work is not a migration. It hardens the tool-only tier and puts the sandbox
definition under the owner's approval.

## Why

**What actually stops harm.** The main threat is untrusted text (Slack, email, forwards, web pages) injecting a prompt
that misuses a tool the agent was granted. A sandbox does nothing against that. Grants checked in code
(`agent-auth.ts`), tiered approvals and the per-tool limits do. A sandbox protects against two other things: code the
agent runs reaching the host, and secrets that sit next to the agent.

**What tool-only agents can do.** These agents run Codex with `features.shell_tool=false`,
`features.unified_exec=false` and `features.apps=false` (`modules/core/module.yaml`, `codex_args`). Their rollout logs
show only MCP calls. They cannot run code, so a box would have little to contain.

**Codex's own sandbox is not working.** Inside the Paperclip container, bwrap cannot create a namespace. A probe of
`codex sandbox linux` failed closed: the command was refused, not run unsandboxed. `--sandbox read-only` is therefore
not a boundary here. The boundary is "no shell", and setup does not enforce it today: it only checks that `--sandbox` is
present.

**Moving every agent into a box (option a) costs the most where it gains the least:**

- **Run volume.** The busiest agents (Slack and email triage, the chief of staff) run hundreds of short turns a day.
  The median run is about 20 s, so each run would pay a 0.3 to 1.2 s box acquire, plus Codex starting under gVisor.
- **Capacity.** Concurrency would need a pool sized for peak load, which means queueing or memory pressure on a
  single VM.
- **It would make these agents less safe as built.** `computerAdapterConfig` turns the shell on
  (`danger-full-access`) on a network with open egress. That gives an injected triage agent a shell and a way to send
  data out, which it lacks today.

**Why not one warm box per agent (option c).** It adds persistent state and constant memory use, and nothing has
shown a need for it. Acquire is already fast.

**What Managed Agents does, and where we differ.** Claude Managed Agents creates sandboxes lazily, only when a tool
needs one, and treats them as disposable. That is the same rule as ours. Our egress is open by owner policy, so a box
alone does not stop exfiltration.

## Per-agent mapping

| Tier | Agents |
|---|---|
| Computer (per-run gVisor box, shell and browser) | Agent Architect, DevOps Engineer (app-maintainer), UI/UX Designer, UI Reviewer: unchanged |
| Tool-only, in Paperclip, shell off | Chief of staff, Researcher, Fleet Ops, librarians, Slack Scout, Slack Triage, Email Triage, Open Loops, Security Watch, Red Teamer, Roadmap Keeper |
| Runner jail (bwrap, passt netns) | Light Engineers (fleet-engineer, engineer-openrouter); strong Engineer work moves to a box (decision below) |

**Rule:** an agent gets `image:` only when its work needs a shell, a browser or files. Later work, not tonight: a
shell-off box variant for agents that read untrusted text and would gain from leaving the Paperclip container.

## Changes (one small commit, after the gateway cutover is verified)

1. **Enforce no shell for tool-only agents.** In `scripts/paperclip-setup.mjs` `agentBody`, setup fails unless every
   codex agent without `image:` has, in its final args:
   - `--sandbox read-only`;
   - `features.shell_tool=false`, `features.unified_exec=false` and `features.apps=false`;
   - no `danger-full-access`, and no bypass of approvals or the sandbox.

   Add one test in `scripts/test`. This is the boundary, so it must not depend on a config line staying put.
2. **Gate the sandbox definition.** `services/runner/src/tiers.mjs` `PRODUCT_GATES` gains `^modules/core/module\.yaml$`
   (where `codex_args` lives), `^scripts/computers\.mjs$`, `^services/computer/` and `^compose\.yaml$`. An instance diff
   that adds or removes `image:` already falls to Tier 2 (`instance-key`); keep it that way. `node
   services/runner/scripts/reviewer-eval.mjs` must stay at 100%.
3. **Probe, then trim the env.** Check that a local Codex child does not carry server secrets. Read a live codex
   process's key names only (`/proc/<pid>/environ`, `cut -d= -f1`). If `BETTER_AUTH_SECRET`,
   `PAPERCLIP_AGENT_JWT_SECRET`, `AIDENHQ_BOARD_TOKEN` or `PAPERCLIP_SECRETS_MASTER_KEY_FILE` are present, blank them in
   the adapter `env`, if Paperclip lets adapter env override process env. Keep the MCP bearers the Codex config needs.
   If it can't, record this as the main residual risk and leave it for a later change.

Nothing changes in `services/computer`.

## Pool and memory

Launcher pool (2026-11-13, with the App Engineer): `AIDENHQ_COMPUTERS_MAX` 7 (the Paperclip computer agents' 5 plus the App Engineer's 2), 2g and 2 CPUs per Paperclip box, `AIDENHQ_COMPUTERS_JOB_MEMORY` 1536m per runner job box, 10-minute idle reap. Limits are ceilings, not reservations: on the 15 GB VM with no swap, 7 boxes at their limits would not all fit, but typical boxes use 0.6-1 GB.

- **Sizing rule.** Max boxes must be at least the sum of the box agents' `max_parallel` (today 1 + 2 + 2 = 5).
  Max × the per-box memory limit must fit in RAM minus Paperclip and the services, with no swap.
- **Measured usage is unknown.** 2g is a limit, not a measurement: no box was running when usage was checked. Take
  `docker stats` during tonight's smoke test, then lower the limit or the max if the worst case does not fit.

## The gateway

Tonight's model gateway (wave 1, item 1) removes the OpenRouter key from Paperclip and from boxes. This design depends
on it and does not change it.

- **Boxes** call the gateway with their run token, resolved through the launcher.
- **Paperclip-local Codex** calls it with the run JWT.

Once the gateway is in place, the secrets left beside tool-only agents are Paperclip's own server secrets, which item 3
trims, and the MCP bearers, which only work under grants.

## Rollout tonight

1. **Gateway cutover first.** Do nothing here until the gateway owner says it is live.
2. **Ship the guards.** Push items 1 to 3, bump the product sha, then run `ops/apply-config.sh`. Setup applies the
   guard. No agent moves.
3. **Verify:**
   - Setup passes on the real config.
   - The guard test fails on a config with the shell turned on.
   - A **TEST** task to a tool-only agent asking it to run a shell command or write a file is refused.
   - A **TEST** task to a computer agent still runs, and its box has no model key: count of `OPENROUTER` in its env is
     0, printing names only.
   - `docker stats` on that box gives the real memory figure.
   - Run `scripts/verify-security.sh`.

**Rollback.** Revert the commit and apply. To move an agent between tiers later, add or remove its `image:` (a Tier 2
instance change), one agent at a time.

## Risks

- **Shared container.** Tool-only Codex and the stdio tasks bridge share the Paperclip container. A Codex or MCP bug
  could reach anything in that container's environment until item 3 lands.
- **Egress is open.** Neither tier stops exfiltration through tools or web search. Grants and approvals carry that load.
- **Merge order.** Items 1 and 2 touch `paperclip-setup.mjs` and `tiers.mjs`, which the gateway work also edits. Merge
  after it.

## Decided 2026-11-13: no separate user per run

Tool-only agents share one container user, so a run that could write files could change later runs (a planted
`AGENTS.md`, Codex's own config) or read Paperclip's master key file. We don't add a uid per run: a tool-only agent has
no shell and a read-only sandbox (setup's allowlist guard, `scripts/no-shell.mjs` `assertNoShell`, gate code), so it cannot write
or run anything there. Agents that need a shell or file writes get an `image:` and run in a gVisor box; Engineers run
in the runner's bubblewrap jail. Revisit only if a tool-only agent ever needs writes.

## Decided 2026-11-13: strong Engineer work runs in agent computers

This supersedes "Engineer jobs stay in the runner's bubblewrap and passt jail" above. Engineers split in two tiers:

- **Light** (the Software and Platform Engineers): runner jobs in the jail, as today. They have the repository, its
  tests and workspace installs; no Docker, no host and no live apps.
- **Strong** (a later App Engineer): runner jobs executed inside a gVisor agent computer, for UI, new apps and other work
  that needs a browser, root installs or app and data tools, at least 2 jobs at once. The runner keeps the workspace,
  git, cards, tiers and grading; the box holds no credentials.

Image CVE scans run in neither tier: CI's `image-scan` check (lock files and pinned base images, no build) is their
evidence, and the security module's scan of deployed images covers what RUN steps install. The grader captures deployed
apps' live pages itself, for both tiers. The strong tier is the App Engineer (`modules/engineering`): the runner runs
each of its turns in a job box through the computer launcher (`services/computer/launcher.mjs`).
