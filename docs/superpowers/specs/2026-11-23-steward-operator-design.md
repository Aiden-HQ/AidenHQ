# The Fleet Steward is the fleet's operator

Status: design, approved by the owner 2026-11-23. Ships as three product PRs and one instance change (Delivery, below).

## Why

Over 24 hours an outside operator session (with the owner's authority) settled every fleet issue the fleet didn't:

- an unanswered delegator question that needed an owner decision;
- 3 tasks stuck after their PRs merged (the grader credited the wrong deliverable);
- graduation deadlocked for 2 days (the old baseline's kernel bug), and its issue closed "owner decision" silently;
- HubSpot "success" while paging dropped most records;
- the brief flagging a 4x spend spike unexplained, and a stale "needs merge";
- a red-team DM sent "high" when it was medium and already routed;
- a daily reminder for a third-party wait that nobody chased;
- fleet PRs reworking code the owner had just decided to remove (owner decisions lived only in the operator's notes).

Root causes: the Steward watches and routes but doesn't operate; owner decisions aren't where agents read; the detector
watches task state, not outcomes; messages to the owner aren't checked or filtered; the fleet lacks a few powers.

## Owner decisions (2026-11-23)

- The Steward owns all fleet operations. Aiden is the owner's chief of staff and owner communication only.
- The Steward stays on DeepSeek Flash high and consults the Sol advisor (`advisor_ask`) before judgement calls.
- Steward powers, without the owner (Tier 1, AI reviewer, logged): pause or resume looping or wasteful work, stop a run,
  restart or roll back services, close or rebind verified work, drive each fix to production.
- One owner-decisions record that agents read before asking. Detector outcome checks. One rule for messages to the owner.
- Graduation keeps its upgrade test; a stall is settled by hand-graduating under a code check, never by the owner.
- The outside operator audits; each miss becomes a Steward eval case and a source fix. After a week with no misses it drops
  to a daily audit. No shadow mode.

## Design

It follows the Conventions: one way, roles not keys, mission in handbooks and how-to in skills, cross-agent rules in a module
prompt, typed tiered writes, and the old path deleted in the same PR.

### 1. Owner decisions

- A heading "Owner decisions" in the instance's existing `owner/profile.md`, which is already compiled into every crew
  handbook and chat lane (4 KB cap, `scripts/handbook.ts`).
- The profile's section (`scripts/prompts/profile.md`) says its decisions are standing rules agents follow and read before
  asking anyone. It never changes grants or approvals.
- Aiden (`fleet-admin`) records the owner's decisions with `self_change(kind: profile)`: the whole file, the superseded
  entry replaced in place (git keeps history). The operator seeds it.

### 2. One owner for fleet operations

- `kernel/src/escalate.ts` sends every judgement that isn't the owner's conversation to role `fleet-settle` (the Steward),
  as a "Settle: <task>" task. The Steward's own asks go to the chief of staff ("Decide for the owner: <task>"); the chief of
  staff's go to the owner. Named delegators and direct owner conversations are unchanged.
- The Steward's comment on the asking task is the answer: the task-state answer rule ends the wait and the comment wakes the
  agent. `notify`'s decision path routes the same way.
- Existing `to:chief_of_staff` markers stay valid.
- The detector's notices (a component down, a critical alert, a gate jammed two hours) are the Steward's own check tasks
  (`toSteward` in the fleet-steward service). The chief of staff's notice tasks are deleted.
- The board's app incident and resource tasks stay with the chief of staff, so an install without the Steward keeps them; the
  Steward's detector raises the same apps as its own incidents.
- The shared prompts change with it:
  - `asking.md`: read the owner's decisions first; the Steward settles questions.
  - `deciding.md`: Aiden brings the owner only the calls that are truly theirs.

### 3. The Steward as operator

- Its handbook is the mission. The procedure lives in `fleet-check`:
  - agents' questions and disputes, answered from the owner's decisions after `advisor_ask`;
  - each incident owned until it is resolved live: service restored, the repair filed, merged and deployed, the original
    symptom rechecked (a rollback restores service and keeps the repair open);
  - verified work settled (`task_rebind`, `task_finish`);
  - pausing and resuming what it owns, stopping runs, restarting services and rolling back.
- `fleet-digest` adds the daily interruption pass. Every message (`notify_recent`) and card (`fleet_owner_cards`) that
  reached the owner gets a disposition, and each needless one gets a repair at its producer.
- The Coach reviews the Steward too (the self-exclusion in `coach.ts` is gone).
- The handbook rules that forbade operating are removed; the security rules stay.

### 4. Powers

- **`fleet_operate`** (fleet_steward connection) is the kernel's typed write `kernel.fleet_op` (`kernel/src/fleet-ops.ts`).
  - Floor 1: the AI reviewer reads each one. Only the requester's role `fleet-settle`, from the kernel's identity, files it.
    The planner and the executor both check it.
  - Ops: `pause_routine`/`resume_routine`, `pause_agent`/`resume_agent` (never the chief of staff or the Steward),
    `stop_run` (the task's running jobs end and the task stays open, with a note), `restart_service` (a compiled module
    service, recreated under the apply lock by `composeRecreate`) and `rollback` (`target: last_good`: the kernel picks the
    newest good generation before the current one and launches `aidenhq-apply --generation <n>`, the path
    `ops/rollback.sh` takes).
  - It extends the kernel's old module-only pause op (`POST /v1/routines/pause`, role `kernel.routines`), which is deleted
    with its role.
  - The Steward resumes only its own pauses (`fleet_pauses` in kernel.db). A target found running again drops the row.
  - The detector no longer pauses anything: a failing routine is an incident, and each open Steward pause is a
    `routine:paused:<target>` incident (`GET /v1/work?pauses=1`) until it is resumed.
- **`task_rebind`** (tasks) moves a graded task's deliverable on the grader's own path (`POST /grades/rebind`). The rubric
  is kept, the kind stays, and the row is graded again at once. The grading service checks role `fleet-settle` from the
  signed caller assertion.
- **`fleet_owner_cards`** (fleet_steward connection) is a paged read of the Tier 2 cards (`GET /v1/work?owner_cards=1`).
- **`github_release_graduate`** (github, destructive, so every call is a Tier 1 record) graduates a maintained repo's
  pre-release only when code verifies, on GitHub's records:
  1. the tag is the next pending pre-release after latest and isn't marked rejected;
  2. its release run (the tag run its notes name) passed and published;
  3. the latest completed graduation run failed before the candidate stage: its `reject` job ran, opened its "didn't
     finish" issue for the tag naming that exact run, and marked the candidate neither `graduation: failed` nor
     `graduation: incomplete <run>` (graduate.mjs `onFailure`'s own verdict). A failed `select` is no verdict (it also
     checks the candidate's own assets).

  It is granted to the Maintainer, which owns distro issues. The Maintainer's owner-decision example no longer names
  graduation.

  It is a tool in the github module's process (which holds the owner's token) rather than a `/v1/codehost/:op` op: the
  caller is an agent through the github connection, so the connection's write record is the one tiered path.

None of these is a new non-security gate that would ship in observe mode. Each check is an authority check (who may file,
whose pause, which repo) or a release-safety refusal, so each enforces from day one.

### 5. Detector outcome checks (PR B)

- Spend: today's billed spend over 2x the prior 7 complete UTC days' average, once a priced baseline exists, with the top
  components and subjects (`spend:spike`).
- Completeness: a source writer's own total checked against what it fetched (`source:<source>:<scope>:incomplete`).
- Graduation stall: the distro files its failure issue after 24 hours (PR C), and the Maintainer settles it with
  `github_release_graduate`.

### 6. Messages to the owner

One rule in the owner-channel module's `notify` prompt, for every agent that holds `notify`:

- re-read the live state before sending;
- say why it matters;
- send only what the owner can act on;
- a wait on a third party is a chaser task for the responsible agent.

The Steward's daily interruption pass enforces it.

## Security review

- **Role bypass.** `fleet_operate` is granted by tool to the Steward alone. Its kind refuses any requester without
  `fleet-settle` at plan and again at execute. The role comes from the kernel's identity, never from args. `task_rebind`
  checks the tasks bridge's grant role and, in grading, the signed assertion's roles and tool.
- **Args reaching scripts.** The kind's schema restricts `target` to `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`. A service must be one
  the compiled modules file lists, and it is passed to compose as an argument, never as shell text. A rollback takes no
  generation from the caller.
- **Stale ownership.** A resume needs the Steward's own row and a target that is paused now. A target someone resumed drops
  the row.
  - Remaining gap: the owner resumes and re-pauses by hand before the Steward looks again. Then the Steward could resume
    the owner's pause. It is rare, visible on the board and reversible, and it goes through the AI reviewer.
- **Graduation spoofing.** Every fact is read from GitHub with the owner's token: the release list, the tag run, its jobs
  and the graduation run's jobs. The caller supplies only the repo, which must be maintained, and the tag. Latest only
  moves forward: the tag must be the next one after latest. The checks re-run when the approved record executes.

## New installs

- "Owner decisions" starts empty. The profile's section reads the same with or without decisions.
- Quiet start is unchanged. The detector files nothing until the owner turns the Steward on, but the questions agents ask
  still reach the Steward as tasks (it is in the default bundle).
- An install that removed `fleet-steward` has no `fleet-settle` holder. An agent's question then fails loudly (its
  `task_wait` errors) instead of going somewhere unseen. Turning the module back on restores the path.
- The Steward's powers need no setup. `restart_service` lists only the services compile wrote. `rollback` needs a good
  generation before the current one, and says so when there is none.
- `github_release_graduate` reaches only repos in `maintainer_repos`, and only an agent that names it (the Maintainer) holds
  it. An install that doesn't maintain the distro never uses it.
- The spend check waits for a priced baseline (PR B).
- Another owner's modules plug in unchanged: their agents ask through the same escalation, and their services restart
  through the same compiled list.

## Delivery

- **PR A** (product): sections 1–4 and 6, plus this note.
- **PR B** (product): section 5's detector and work-read checks.
- **PR C** (distro): the graduation stall files its failure issue after 24 hours.
- **Instance**: "Owner decisions" seeded in `owner/profile.md` after A deploys.
