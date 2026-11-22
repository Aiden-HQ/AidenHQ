# Agent anatomy: modules, memory, shared skills, event routines, sharing

Status: design, approved by the owner 2026-11-22 ("this makes sense ... choose the simplest design to keep code
maintainable while still getting the job done"). Revised 2026-11-23 with the owner's trust decisions (below). It ships as
one product PR plus one instance-repo change: `docs/superpowers/plans/2026-11-23-agent-anatomy.md`.

## Why

Grok Bot (xAI, beta since 2026-08) gives each bot instructions, memory ("facts it knows"), skills ("playbooks"),
routines ("jobs that run on their own") and apps. It lets bots share skills and be shared as templates. The owner
wants the same anatomy here. The research (Claude Code plugins, Codex, Cursor, Gemini CLI, Letta, Mem0, Hermes, Devin,
Copilot Studio, Grok's client and 91 public Grok recipes) is kept outside the repo; this doc carries the conclusions.

Our gaps against that model:
- memory reaches an agent about a day after it learns something (inbox task, daily Steward curation, apply);
- skills exist only in product modules, and an agent cannot add or improve one;
- routines are cron, heartbeat and raw webhooks only, and agents cannot create their own;
- an owner-built agent (`agents/<key>/` in the instance repo) is a second format that cannot be shared;
- every change an agent wants to itself goes through an Engineer job (trust audit, `research/trust-audit.md` #12).

We keep what Grok lacks: git history and rollback for definitions, grants checked in code on every tool call, the
grader, spend limits, a sandboxed box per job, and the AI reviewer on every lasting definition change.

## Decisions 2026-11-23 (owner)

- **A. Agents edit themselves directly.**
  - An agent files its own handbook, skill, routine and owner-profile changes. Each is a typed change, which the kernel
    writes as an instance commit and files as a `kernel.apply` with that agent as requester. The AI reviewer checks it at
    apply (Tier 1).
  - Memory facts are not applies: `memory_note` writes the agent's memory file at once (§2).
  - The Engineer hop for instance definitions is gone, and so is `task_propose_rule`. Product-repo changes (code and
    product module text) stay Engineer PRs.
  - The Librarian's daily curation becomes a weekly lint.
- **B. No trial.** `trial`, `trial_writes` and every trial limit and branch are deleted. A new agent starts with its
  designed grants and is reviewed at apply like any change.
- **C. No per-routine autonomy.** The routine `autonomy` field, routine caps and the provenance trace are deleted. The
  instance-wide `autonomy` switch stays.
- **D. Trust cuts in the same PR:**
  - delete the merit-tier rules in `apply-tier.ts`, path sensitivity (the path inventory) and the stale labels
    (`ownerRequired` among them), keeping the hard refusals and the authority text on the card;
  - a product merge skips the AI reviewer once CI is green and the mandatory code review has a `pass` verdict for that
    head (a timed-out bypass doesn't count);
  - GitHub issue state, labels and thread replies run without the AI reviewer. They stay explicit-only grants, listed
    in the connection's `tools.unreviewed`. Code's refusals (instance details, files not shown) run on every filing
    path, `conn.tool` included;
  - remove `private_reads`;
  - the reviewer eval triggers only on the reviewer's own code;
  - the UI design review is advisory and never holds a merge.
- **E. Memory is simple.**
  - A fact keeps its date and `src`. There are no `conf` levels and no taint rule.
  - The tool rejects instruction-shaped text, including leading imperatives ("from now on…", "always/never…", "send …
    to …"). It also strips secrets, dedupes and tombstones, and caps writes per run.
  - Owner-profile facts change only through an agent-filed apply to `owner/profile.md` (for example, Aiden files one
    when the owner says "remember X"). Only agents with the `fleet-admin` role (Aiden) may file it; others ask Aiden.
    No sentence-matching proof.
- **F. One mechanism per concern, no fallbacks.** Sharing files its record through one generalised `fileKernel`.
- **G. One way.** Each old path is deleted in the same PR:
  - instance `agents/<key>/`, including `memory.md` once memory has moved;
  - the memory inbox;
  - implicit skill selection;
  - the Slack triage poke and its webhook;
  - trial limits;
  - merit tiers.

Engineering calls made with these (simplest to maintain):
- Agent-made routines start active. They are reviewed at apply like any change. "Paused until a test run" is dropped,
  for the same reason as B.
- Every agent-made skill and routine lives in one local module, `library`. A routine's `agent:` may name any agent: a
  routine carries no grants. An agent changes only its own `library` routines, and a key may not collide with a product
  routine.
- Every `self_change` is compiled against the prospective instance tree before a branch is written. Its `kernel.apply`
  is the only record.
- An agent compacts its own memory file when it is full (`memory_rewrite` on its own file). The Steward's existing
  `librarian-weekly` lint only removes lines from other agents' files.
- Routine identity is recoverable. Setup writes a marker with the compiled key into each routine it creates, looks
  routines up by compiled key, and recovers a lost or archived one from its marker. It reconciles triggers on every
  pass.
- A routine's status is set once, on create, from the module that defines it:
  - local and `library` routines start active;
  - routines from an imported (`declared`) module start paused;
  - product-module routines follow quiet start.

  After that, Paperclip owns pause and resume, through the board's live controls. The editable status override is
  gone.
- Agent-made cron routines run at most hourly: exactly one schedule, with a literal minute, checked on the final routine
  after overrides. There is no cron parser. Events cover anything faster.
- A product merge's Tier 0 rests on one exact-head eligibility check, used both when planning and right before the
  merge.
- `self_change` is validated at the instance base it fetched, with the staged compiler's own inputs. The same base goes
  to the code host's compare-and-swap.
- The build starts with a probe of the pinned Paperclip's `/run` for the idempotency key and variables. If either is
  missing, the build stops and reports; no other path is written.
- End-to-end checks that need Docker or the live stack are manual one-off runs. CI runs only the fast tests.
- Chat never mutates memory or files changes. "Remember", "forget" and profile asks are handed to the agent's own job
  through the lane's existing background task.

## Rules for this work

- One way per concern: each part replaces an existing path and deletes it in the same PR. No fallbacks.
- Reuse what exists:
  - The typed-change writer (`settings-change.ts`), which today files an agent's `setting` change as a `kernel.apply`,
    becomes the one path for an agent's change to itself.
  - Paperclip typed cron.
  - The wake path and Dispatch coalescing.
  - The Steward's prune and failure passes.
  - The compiler's skill staging per job.
- Simplest code that does the job. Cut anything not listed here.

## 1. One unit: the module

- A module is a folder with `module.yaml` and any of `agents/`, `skills/`, `routines`, `connections/`, `apps/` and
  `services`. It can be just one agent or just one skill (a unit like a Claude plugin).
- **Owner-built agents become local modules.** The instance repo's `agents/<key>/` path is deleted. An owner-built agent
  is `modules/<name>/` in the instance repo, tier `local`, loaded by the same compiler as product modules.
- Local modules keep today's instance-agent limits, as a closed allowlist of manifest keys: no `roles`, no `services`, no
  connections of their own, no `apps`, no `privileged`.
- Agent keys and routine identity carry over unchanged. Trial does not exist any more (B).
- The Agent Architect's templates, the apply rules and the board's agent edits move to the local-module shape in the
  same change.
- Install is per instance. Use is per agent: an explicit `skills:` list plus connection grants.

## 2. Memory

- **Storage:** one document per agent on the kernel data volume (`<data>/kernel/memory/agents/<key>.json`). It holds
  facts and tombstones together and is replaced atomically on every write. Memory is runtime state: not in git, no apply
  per fact. Backups cover it. `owner/profile.md` stays in git.
- **Fact format:** at most 500 characters, with a date and a `src`. Agents and the handbook read it as Markdown lines:
  `- (YYYY-MM-DD, src: <task id or link>) <fact>`.
- **One write path:** the kernel's `memory.ts` writes the file. The tools are:
  - `memory_note(fact, source)` writes the agent's own file at once, replacing the inbox task. The fact is in the
    agent's handbook from its next job.
  - `memory_forget(match)` removes the agent's own lines and tombstones them.
  - `memory_read` and `memory_rewrite`: an agent reads and compacts its own file; the Librarian role does so for any
    agent.
- **Checks in the tool (code):**
  - one fact, within the length limit, with a required `source`;
  - duplicates and tombstoned facts are refused;
  - secrets are stripped;
  - instruction-shaped text is refused, leading imperatives and "send … to …" included (a lasting rule goes in the
    handbook);
  - at most 10 writes per run;
  - a hard 4 KB cap per file.
- **Owner facts:** only through an apply to `owner/profile.md` filed by a `fleet-admin` agent (Aiden) (A, E).
- **Consolidation:** an agent compacts its own file with `memory_rewrite`. The Steward's existing `librarian-weekly`
  lint removes duplicate, contradicting and stale lines from every file, removals only, so no fact moves between
  agents. A removed fact is tombstoned so it isn't learned again.
- **Loading:** the budget is unchanged. The kernel fills `{{memory}}` from the file when a job starts, and the chat lane
  reads the file each turn. Both put it inside the SDK fence, as data. Legacy `memory.md` lines are imported once per agent, before
  runtime writes start. The import is resumable; its facts and a completion marker land in one write, and each fact
  carries the source `migration:<instance sha>`. Merged, refused and dropped lines are counted. The old inbox tasks are
  cleaned up once, by hand, outside the deploy. A `source` is the job's task by default, else a
  task id or an `https:` link. `owner/profile.md` is already in every handbook and the chat lane.
- **Owner surface:** "remember X" or "forget X" to any agent; in chat these are handed to the agent's job. The agent page shows the file with sources, read-only.
- Memory never grants anything.

## 3. Skills: shared library, enabled per agent

- **Shared skills are skill-only modules.** Agents' skills go in the instance's `library` local module; others come from
  a marketplace. The compiler keeps rejecting same-name skills: no shadowing.
- **Explicit per-agent enablement:** every agent lists its skills in `skills:`. The PR writes lists that reproduce
  today's implicit selection (module membership, connection grants) and deletes implicit selection. One rule gives the
  effective list: `(skills ∪ overrides.agents.<key>.skills.add) − overrides.agents.<key>.skills.remove`. Every agent,
  local or product, is edited through this one override shape. A skill from an available but disabled module is
  dropped; an id no available module provides fails compile. The reviewer's enabler lines come from the compiled lists. Local modules have no `skills` manifest field:
  `skills/` is found by directory.
- **Agents write and improve skills directly:** a typed `skill` change writes `modules/library/skills/<name>/SKILL.md`,
  and a typed `skills` change enables or disables one for the agent itself. Each is filed as a `kernel.apply` (Tier 1 AI
  reviewer). Any agent may change a library skill. Every agent that lists the skill gets the new version on its next job.
- The reviewer brief for a skill change names the agents that enable it, because a shared skill can steer an agent
  through tools it already holds. A skill folder with scripts counts as code for third-party trust.

## 4. Routines

- Keep Paperclip's typed cron and heartbeat, Dispatch coalescing and the Steward's 3-failure pause.
- **New: `event` trigger** on a routine:
  `event: { connection: slack|github, resource: <channel id | owner/repo>, filter: { ... } }`.
  - The kernel's event router fires the routine's run through Paperclip's owner-authenticated `/run`, with the batch
    as variables. Event text never travels in the task: the run reads its batch through a fenced tool, and only the run's
    own task and assignee may read it.
  - A routine may subscribe to any resource its agent's existing read grant on that connection reaches: the same reach
    its read tools have, with the same credential. `*` is allowed only in product routines. There is no owner step.
    The grant and the routine's status are checked again at fire and at batch read.
  - Duplicates: Paperclip's `Idempotency-Key` (the batch id) makes a retried fire one run, and the bounded event queue
    drops a repeated source event id. Filters (event kind, author, label, text match) run in code before
    any model call. A burst within the wake window is one run carrying all its events.
  - A batch is sealed when the 60 s window ends; there is no leading-edge fire.
  - One non-overlapping drain. Intake always answers the source: overflow and cap drops are acknowledged and counted,
    and permanently invalid items are skipped. Transport errors, 429 and 5xx are retried with the same key. A job that
    starts before its batch binding is stored gets a bounded "pending, retry" answer.
  - Caps: 12 runs per routine per hour and 120 in total, counted from dispatch times. Pending events are capped
    separately from retained payloads.
  - Slack and GitHub only in this release. GitHub is polled on the code host's existing loop (an instance has no
    ingress), best-effort, since GitHub can delay its event feed. Only `issues.opened`, `issue_comment.created`,
    `pull_request.opened` and `push` are offered for now.
- **Agents create and change their own routines directly:** a typed `routine` change writes
  `modules/library/module.yaml`, with `agent` set to the filer, and is filed as a `kernel.apply` (Tier 1). Compile lints
  them:
  - at most 20 routines per agent;
  - a schedule runs at most hourly (the cron minute field is a single number);
  - an `event` routine needs a non-empty filter;
  - a routine never adds grants.
- **Quiet in code:** a routine run that ends with no write record and no task created is recorded `quiet`.
- Slack triage moves onto the event trigger. The poke and its webhook are deleted.

## 5. Sharing

- **Publish a module**, including an owner-built agent's local module or `library`, to an existing public git repo with
  a `marketplace.json`. Others add that marketplace (pinned) and install through the existing grants diff and AI review.
- **What is shared:** the portable content of a local module:
  - its agents (definition and handbook);
  - its skills;
  - its routines, which start paused on install.

  The preview lists, with reasons, what isn't shared: `reports_to`, `image`, routines whose agent is outside the module,
  and routines with a literal event resource. A local module has no prompts or settings, so there is nothing to
  parameterise.
- **Never shared:** memory, the owner profile, secrets and setting values. A preview shows the exact payload, its
  effective grants and any scripts. Findings block it. The owner's board save is bound to that preview's digest, source
  commit, destination repo, ref and base tip, and it decides the publish record.
- The destination must be public. A moved tip fails the publish and a new preview is needed (`stale: fail`, no
  refile). Only the owner's verified save can file a publish (`filer: owner`). The owner-decided record's own args and
  target are the durable preview evidence. The code host's existing commit assembly writes the files and the
  `marketplace.json` entry.
- Importers for foreign formats (Grok recipes, Claude plugins) are not in this release.

## Not doing

- bot-to-bot messaging (tasks stay the coordination path);
- org and project memory scopes, memory logs, end-of-task extraction;
- memory confidence levels and taint;
- per-skill eval replay;
- schedules in prose;
- event sources beyond Slack and GitHub;
- foreign importers;
- the trust audit's other items (sticky malice refusal, code-review floors and spend, `delegate_to`).

## Build order

- One product PR, built in parallel lanes in three stages (see the plan).
- Then one instance-repo commit with the pin bump. A second instance commit deletes `agents/*/memory.md` once the apply
  has moved memory.
