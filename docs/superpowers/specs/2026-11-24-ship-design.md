# Ship: every PR, from open to merged

Status: direction approved by the owner, 2026-11-24 (no further design review asked). Owner decisions are marked
**(owner)**; everything else is the designer's call. The research behind it lives in the instance repo's product history:
other teams' bots, merge queues and post-mortems.

## Why

A PR waits hours to days for review, collides with generated files and is ejected from the merge queue. It loses its
approval on every rebase, and a person has to rebase, regenerate, re-run and re-queue it each time. Merge queues only rebase:
they eject a PR that conflicts and never run a repo's code generation. The fleet already takes its own PRs to merge, but that
loop lives inside the github module (`pr-watch.ts` and its automatic merge filing). Its caps are fixed, and nothing takes a PR
someone else opened.

Goal: a member hands a PR to the fleet and it reaches merge with no person in the loop, inside the repo's own rules. On the
way it is kept current, its conflicts are resolved and its generated files regenerated. CI failures it caused are fixed,
review findings answered, the App approves it where approval is required, and it merges through the repo's own path. Safe
PRs lose the human now; every PR does eventually **(owner)**.

## Goals

- **One PR lifecycle for every PR.** Fleet-authored and handed-over PRs share one state machine and per-repo settings.
- **Every knob is a per-repo setting, with no hard limits in code (owner).** A test repo may run fully unguarded and another
  cautious. Guards ship as named presets, never as floors.
- **Deterministic work before any model call.** The model is used only for judgment.
- **Zero configuration for a typical repo.** Checks, rules, generated files and the generator are discovered. A setting is
  asked for only when discovery is ambiguous.
- **A report a code owner can approve from** without opening the diff.
- **Settings editable from the owner's words or a Fleet page**, with the same validation for both.
- **An optional module behind one interface.** Nothing in the core needs it.

## Non-goals

- **A user-defined rules engine** ("if Y then X") **(owner: not now)**.
- **Replacing code-owner review.** A code-owner-gated PR waits for its human owner **(owner)**.
- **Reviewing code.** The code-review module does that; ship reads its verdict.
- **Hosts other than GitHub (owner: GitHub only for now).** `codehost-local` keeps its own loop (`kernel/src/localmerge.ts`).
- **Credited replacement PRs for forks.** A fork is adopted on a member's trigger; nothing else.

## Structure (module split)

Each module owns one part of the lifecycle:

| Module | Owns |
|---|---|
| `maintainer` | The issue lifecycle only: triage, validate, dedupe, resolved-check, send fixes to an Engineer, feature labels. It borrows Gardener's rules: be sceptical of confident agent-written reports; "a wrong close costs more than a miss". |
| `ship` (new) | The PR lifecycle for every PR: adoption, rounds, fix dispatch, approval, the merge path, confirming the merge landed, metrics, per-repo settings and presets, and the Fleet → Ship page. It absorbs everything `pr-watch.ts` does today and the Maintainer watcher's `contributor_prs` nudge/close duty. |
| `github` | Typed effects only: commit with compare-and-swap, update-branch, approve, enqueue, merge, comment, label. Plus `merges.ts` and `merge-gate.ts` as the merge primitive. No PR policy. |
| `code-review` | Unchanged: a gate ship reads (`review-gate.ts`), and the ask path ship calls on a fork hand-off. |
| `engineering` | Unchanged except for one skill, `ship`, that the Engineer reads on a ship task. |

**Moving pr-watch into ship (one way).** The ship service takes over every duty of
`modules/github/service/src/pr-watch.ts`:

- the agent-PR loop and automatic merge filing;
- update-branch;
- re-running checks that never started or got wedged;
- the title-gate re-run;
- the CI breaker;
- Dependabot task filing;
- closing abandoned PRs.

`pr-watch.ts` is deleted in the same PR that switches ship on, and so is the Maintainer watcher's PR pass. github keeps the
effects ship calls through the kernel.

**Without ship.** No PR is watched. Engineers request merges themselves (`aidenhq merge`, a `github.merge` record), as they
can today. This is confirmed to work before ship replaces pr-watch. Ship is in the default bundle.

## Design

### 1. Settings (ship module)

One setting, `ship`, declared in `modules/ship/module.yaml`:

```yaml
ship:
  defaults: cautious           # the fleet's own repos with no entry of their own
  repos:
    acme/api: { preset: cautious, approve: safe }
    acme/sandbox: full
    acme/legacy: off
  paused: false                # the kill switch: no adoption, push, approval or merge; PRs resume where they were
```

**Coverage.** Ship covers:

- the fleet's own repos: the agents org and the product repo;
- every repo in `maintainer_repos`, the github module's list of repos the fleet may merge in.

An entry for any other repo is refused at validation. `defaults` applies only to the fleet's own repos. A maintained repo
outside them is adopted only once it has an explicit `ship` entry, so quiet start holds: listing a repo in
`maintainer_repos` alone never lets a `/ship` adopt anything there.

**Fields.** Every field may take any value its type allows, including `null` caps **(owner)**.

| field | `cautious` | `full` | meaning |
|---|---|---|---|
| `handoff` | `label` | `all` | `label`: a trusted `ship` label, a `/ship` comment, or the `ship` tool. `all`: every non-draft PR by an author with write access. `none`: fleet PRs only |
| `rebase` | `conflict` | `behind` | Update only on a conflict or failing guard, or whenever the branch is behind |
| `generated` | discovered | discovered | `{ globs, commands }` overrides; see §3 |
| `fix` | `[conflicts, ci, review]` | same | What the Engineer may work on |
| `protected` | lockfiles, `.github/**`, test and lint config, CODEOWNERS | `[]` | A model fix touching these goes on `hold`. Deterministic repair may still regenerate lockfiles |
| `caps` | `{ wakes_per_head: 3, ci_rounds: 3, same_check_heads: 2, review_rounds: 3, rounds: 30, usd: 5, requeue_on_timeout: 1 }` | all `null` | Per PR; `null` means unlimited. Past a cap the PR goes on `hold` |
| `approve` | `safe` | `all` | `off`; `observe` (the report says what it would do); `safe`; `all` |
| `safe` | `{ max_lines: 1200, max_files: 50, deny: [<protected>, migrations, auth, config, infra globs] }` | n/a | The safe class (§5) |
| `merge` | `ready` | `ready` | `off`: stop at ready. `ready`: merge when every gate passes |
| `stop_label` | `ship:stop` | `ship:stop` | While present, the PR is left alone; removing it resumes |

**`full` is unguarded at the ship layer.** The host's rules, human code-owner requirements and the kernel's authority still
apply.

**Parity with today.** `cautious` carries today's `pr-watch.ts` constants unchanged:

| setting | today's constant |
|---|---|
| `wakes_per_head: 3` | `MAX_WAKES`, counting wakes of every cause |
| `ci_rounds: 3` | `BREAKER_ROUNDS` |
| `same_check_heads: 2` | the breaker's same named check red on two heads |

The fleet's own PRs behave the same after the move.

**Loosening goes to the owner.** The validator (`modules/ship/src/settings.ts`) compares the effective settings before and
after the change, with presets resolved. A change is a loosening if it:

- admits more PRs (`handoff`);
- lets ship do more without a person (`approve`, `merge`, a wider `fix`);
- raises or removes a cap;
- widens `safe` or narrows `protected`;
- clears `paused`.

A loosening goes through the signed owner-save path. Everything else is an ordinary settings change. Spelling the same policy
differently is the same change.

**One card for a new repo.** `ship_configure(repo, change)` builds one owner card for a repo that isn't covered yet. The card
writes all three entries together: the repo's `maintainer_repos` entry, its `code_review` entry if approval needs gating, and
its `ship` entry. This uses a cross-module settings grant. The tools are
`ship_config`, which reads each repo's effective settings plus the discovered facts, and `ship_configure`. They are granted to
the Maintainer and to Aiden's delegate.

**Fleet → Ship page.** A module view declared in `module.yaml`, never board code; the board's view host is lane H.

- **Settings:** per repo, on or off with a preset, `handoff` (label, all or none), `approve` (off, observe, safe or all) and
  `merge` (off or ready). Globally, `paused`.
- **Read-only facts:** the discovered checks, generator and current blockers.
- **Validation:** the same as the English edits.

### 2. Adoption

**One durable record per adoption.** `data/ship/state.json`, with atomic rename, holds:

`{ repo, number, generation, trigger: { kind, event, actor, head }, task, hold?: { reason, at }, counters }`

**Statuses.**

- Only `hold` is stored. It covers stall, hand-back and stop, is sticky, and carries its reason.
- Everything else is derived from `decide` and the kernel's records each pass: working, waiting, queued, merged.

**Triggers.**

- A fleet PR is adopted at open. Its task is the task that opened it.
- A handed-over PR needs a trusted trigger: a label or comment event by a role in the repo's trusted roles (the `agent-build`
  trust rule in `github-mcp/src/maintainer.ts`), or the `ship` tool. The App never counts.
- Each trigger is consumed once, by its event id.
- A `hold` and a hand-back are sticky: a label still on the PR, or `handoff: all`, never re-adopts it. A fresh trusted trigger
  starts a new generation. A stale ship pass re-reads the PR before it files anything.

**Task.**

- One task per adopted PR, filed through the kernel module-task API with the `source` idempotency key
  `ship:<repo>/<n>:<generation>`, so a crash or a retry never files two. A live task is reused: the fleet's own, or
  Dependabot's.
- It goes to the role `platform-engineer`, the Engineer's.
- The task text is fixed, never the PR's own words.

**Authorship stays separate.** github keeps opener provenance: which task opened a PR (`pr-tasks.json`, through a typed read).
Merge credit and grading read it, as today. Closing an abandoned PR and deleting its branch apply only to PRs a fleet task
opened. Cancelling a ship task for a handed-over PR ends the adoption and never closes the PR or touches its ref. Dependabot
tasks that github filed move to ship in the move's data migration, with task ownership transferred.

**Forks (owner).** An external PR is a fork. Nothing runs on it until a member triggers it, under any `handoff` mode:
- **Trigger.** A member's `ship` label or `/ship` comment adopts the fork PR. Only members' triggers count: write access, by the
  existing trusted-role check.
- **Review.** Adoption calls code review's existing ask path, so the review starts too. Code review's `forks: manual` holds
  every fork until then. `aiden review` still triggers a review alone.
- **After adoption.** Ship reviews, reports, approves and merges the fork like any other PR.
- **Pushes.** Ship pushes repairs only when the PR allows maintainer edits (`maintainer_can_modify`), as the App. Otherwise a
  needed push becomes a `hold`, with a note asking the contributor to enable edits or rebase.
- **No replacement PRs.**

### 3. Rounds

**A round is a settled head:** every check on the head has finished, and code review's verdict for it has arrived (Alcora's
idea in its simplest form). Recovery comes before settlement: a conflicting head, where GitHub runs no checks, gets
`repair`, and a check whose job never started gets its re-run, without waiting for the head to settle. Code review's verdict
is waited for only where approval needs it (§5). Each pass, ship takes one decision from merge-gate's `decide`. `decide` is extended to return
actions:

`wait`, `repair`, `fix_ci`, `fix_review`, `approve`, `enqueue`, `merge`, `done`, `hold`, with the reason.

Each writer recomputes `decide` right before it writes: one readiness rule. The PR's task is woken only for `fix_ci`,
`fix_review` or repair leftovers. Waking the same task means the same Engineer session and computer continue across rounds of
one PR.

1. **Stopped.** Stop label, `paused`, closed, draft, `hold`, or a person assigned to the PR (assigning a person pauses the
   loop): nothing.
2. **Queued.** In the repo's merge queue: nothing touches the branch. Ship reads the merge group's checks.
3. **`repair`.** Conflicting, behind under `rebase: behind`, or behind where the rules require up-to-date branches.
   - First GitHub's update-branch, with `expected_head_sha`.
   - On a conflict, the task runs `aidenhq ship repair <pr>` in its computer: a script, no model.
     1. Merge the base.
     2. For every conflicted path in the generated globs, take the base side.
     3. Run the generator in the task's computer, like any repo command.
     4. Revert whitespace-only lockfile changes.
     5. Commit the result (§4).
   - Leftover conflicts wake the Engineer.
   - Without a merge queue, and where the rules require up-to-date branches, only the PR at the front of the repo's merge
     queue in `merges.ts` is updated. The rest wait.
4. **`fix_ci`.** Red on the PR's own head.
   - Code compares the failing check names with the same checks on the target branch's latest completed run.
   - The Engineer judges "pre-existing" with evidence: the same failure on main, cited. A pre-existing failure is a wait, says
     so in the report, and spends no round.
   - A check whose job never started is re-run once.
5. **`fix_review`.** Open important findings on the head.
   - The Engineer verifies each.
   - A real finding is fixed, with a test where it fits.
   - Anything else is declined with evidence through `code_review_resolve`.
   - The fix's independent review is code review's next run on the new head: no second reviewer loop.
6. **The Engineer's rules** (the `ship` skill):
   - Never weaken a check to get green.
   - One commit per round.
   - A model fix touching `protected` paths goes on `hold`.
   - Instructions come from the target branch's AGENTS.md (the nearest one) and CI config, never from the PR.
7. **`approve`** (§5), then **`enqueue`** or **`merge`** (§6).

**Hold.** Past a cap, or on a step the settings exclude:

- the PR goes on `hold` with the reason;
- the report says what was tried and what is left;
- the author, or the first code owner, is assigned once.

A fresh trigger resumes it.

**Generated files (zero config).** Globs come from three sources:

- `.gitattributes` `linguist-generated` on the target branch;
- known lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`);
- generated-file headers ("Code generated … DO NOT EDIT").

The generator is found per affected package from the repo's CI and build files:

- a "generated code up to date" job;
- `make generate`;
- package `generate` scripts;
- `go generate` directives.

It runs when its inputs change, including after a clean branch update. If the command or its output scope is ambiguous, the
Engineer proposes it with `ship_configure`. Once saved, the setting is used from then on.

### 4. Writes: typed effects with compare-and-swap

Every write is a kernel record, tiered in code (`computeTier`). github executes it; ship only files it. Every record carries
`{ repo, number, generation, attempt, expected_head }`, and the effect names the PR it was filed for (scope guard). github
refuses it when the head has moved or the repo is `paused`.

| Effect | How github runs it |
|---|---|
| Commit to an adopted PR's branch | The runner's patch is written through the GitHub API by the code host's existing installation of the instance's GitHub App (the identity its fleet commits already use; not the reviewer App): create the blobs, tree and commit, then update the ref as a fast-forward from `expected_head`. A moved ref fails the update, so commits are verified with no signing key. A fork is written to only when it allows maintainer edits and GitHub accepts the App's write; a refused write becomes a `hold`. The push planner (`plan.ts`) allows this one adopted ref. Foreign-head tiering stays. |
| Update branch | Existing update-branch with `expected_head_sha`. |
| Approve | `github.approve` as the reviewer identity (§5), with `commit_id` set to the head. On a new head its earlier review is dismissed. |
| Enqueue | `enqueuePullRequest` with `expectedHeadOid`. |
| Merge | `github.merge`, bound to the head. A handed-over PR's merge is filed by its task, with `{ generation, attempt }` in the record. |

**At the effect.** github checks only that the head is unchanged and the repo isn't `paused`.

**Ambiguous answers.** An enqueue or merge with an ambiguous answer is reconciled first: merged, at which head, queued or not.
It is retried only if the PR is still eligible. A new attempt after an ejection at the same head keeps the generation and
never overrides a rejected record.

There is no second receipt store. The report and the metrics read the kernel's record outcomes.

### 5. Approval

**When approval is needed.** Approval evidence is needed only where GitHub's rules for the target branch require a review, or
where the repo is gated by code review. Otherwise the trusted hand-off, or the fleet's own authorship, is enough. This keeps a
solo owner's repo and fleet PRs merging.

**Identity.**

- GitHub refuses an approval from the account that opened the PR, and the code host opens the fleet's PRs. Approvals therefore
  come from a separate reviewer GitHub App: the optional setting `github_reviewer_app` (github module).
- The setting is offered only where a rule needs an eligible reviewer the App can be.
- The reviewer App is never a code owner, so a code-owner requirement still needs the human owner **(owner)**.
- When the author is the only code owner and no eligible reviewer exists, the report says so.

**Evidence.**

- Approval needs a completed code-review pass. Code review's verdict endpoint exposes the reviewed head and the kind of run:
  completed, exhausted or skipped.
- The verdict carries to a later head when the PR's own patch is unchanged: a base merge, or a regeneration of generated paths
  only. A model-fix push needs a fresh review.
- Before an enqueue or merge, `decide` reads each approval's author, commit and dismissal state.

**When ship approves.** It approves the exact head when:

- the required checks are green;
- the evidence above holds;
- no changes are requested;
- `approve` allows it (`safe`: inside the safe class; `all`: any).

`observe` posts nothing and puts "would approve" or "would not: <reason>" in the report.

**The safe class.** Counts substantive lines and files; generated, lock, test and docs files are not counted. It is out of the
safe class when:

- it is over `max_lines` or `max_files`;
- it touches a `deny` glob;
- it changes generated files without the source they come from.

**Waits.** A requirement left after the App's review is read from GitHub's view of the PR: its review decision, the requested
teams, last-push approval and unresolved conversations. It shows as "waiting on code owner @team" or "waiting for <the actual
blocker>".

### 6. Merge

`merges.ts` stays the only merge executor. `merge-gate.ts` changes:

- **Checks:** it judges only the checks the target branch's rules require. No required checks means green, confirmed from the
  rules, not inferred from missing evidence. The rollup, reviews and changed files are paginated.
- **Rules:** it reads the actual target branch's rules (`GET /repos/{r}/rules/branches/{b}` plus classic protection).
- **Base branch:** a PR whose base isn't the default branch is reported as "unsupported base", never as failed.
- **Waits:** `BLOCKED` with a review requirement is a wait. `DIRTY`/`BEHIND` on a ship PR return `repair`.

**The path.** `mergePath()` picks it from the rules.

- **Merge queue required:** enqueue, then follow the queue entry until it merges or leaves. A removal is mapped:

  | Removal | Then |
  |---|---|
  | Group failure | `fix_ci` on the merge group's failure |
  | Conflict | `repair` |
  | Timeout | Re-enqueue, up to `caps.requeue_on_timeout` per head |
  | A person dequeued it | `hold` |

- **Otherwise:** the direct merge, bound to the head, with the repo's method (`mergeMethod`). Native auto-merge is not used.

**Landed** means the PR reads merged at the bound head and its merge commit is on the target branch. Only then does the task
close.

### 7. The report

One App comment per PR, edited in place (marker `<!-- aidenhq-ship -->`). Code renders it from the adoption record, the
kernel's record outcomes and code review's verdict. The model's only text is a one-line summary of each fix.

- **State:** derived, or the `hold` reason.
- **What ship did:** rebased; regenerated `<globs>` with `<command>`; fixed `<check>`; answered N findings (fixed, or declined
  with the reason).
- **Risk facts:**
  - substantive lines and files;
  - areas touched (CODEOWNERS owners);
  - protected or denied paths hit;
  - the safe-class verdict and why;
  - code review's verdict and open findings.
- **What it waits on**, and who can unblock it.

### 8. Metrics

Flow facts (`flow.ts`): `ship.adopted`, `ship.round` (kind, cost), `ship.hold` (reason), `ship.merged`. The Fleet Steward's
flow report shows, per repo:

- merges per adoption;
- rounds per merge;
- cost per merge, from the ledger by task subject;
- time from hand-off to merge;
- holds by reason.

Revert tracking comes after the pilot.

## New installs

Ship is in the default bundle. With `defaults: cautious` it covers only the fleet's own PRs, exactly like today's pr-watch,
with its constants now settings. No other repo is adopted until the owner turns one on (quiet start), in one action: Fleet →
Ship, or "ship acme/api" in words. That action uses `cautious`, discovers rules, checks and the generator, and shows the first
blocker. Code review, the reviewer App and a generator override surface only when a repo needs them.

## Security

Each new path gets a security review before it switches on (CLAUDE.md "Every new path gets a security review"):

- **Writing to a branch the fleet didn't create:** a fast-forward compare-and-swap on the head, after a member's trigger. A
  fork only when it allows maintainer edits.
- **Approving:** bound to the head, gated in code by the repo's `approve`, re-checked at merge, never triggered by the App's own
  label or comment.
- **Untrusted text:** a PR's title, body, comments and check output never reach a task's text, and the Engineer reads them as
  fenced data. Instructions come from the target branch only.
- **Repo code:** the generator runs in the task's computer, as every Engineer build does.

## Rollout (owner)

There is no separate cutover test. Ship is dogfooded on AidenHQ's own repos from the moment it replaces pr-watch: the product
repo, the distro, the instance repo and the agents org. Breakage is fixed forward. The instance repo goes through its Apply
path. The pilot repo follows once hand-offs ship.

## Left to the builder

Exact record shapes and the state layout.

End-to-end tests:

- a labelled PR adopted, regenerated and merged;
- a fork untouched until a member labels it, then reviewed and merged;
- a cap reached, then `hold` with a person assigned;
- a code-owner PR approved and waiting;
- a queue ejection looped back;
- a contributor push during a repair refused by the compare-and-swap;
- cancelling a handed-over task leaves the PR and its ref intact;
- a repo with zero required checks merges.

The ported pr-watch tests also run.

## Not handled (fails loudly)

Cut to keep ship simple **(owner: handle the common path, fix rare cases when they show up)**. Each one surfaces as a
`hold`, a refused write or an error in the report, never silently:
- **Stacks and other non-default bases.** Not retargeted or merged. They report "unsupported base" until a person retargets
  them.
- **A merge-rate limit per repo.** `paused` is the only kill switch.
- **Dequeuing.** Ship never removes a PR from the merge queue. A pause or hold stops new actions, and anything already queued
  finishes in the queue.
- **Checks at execution time beyond the head and `paused`.** A policy change, retarget or hand-back racing a claimed write can
  still land that one write.
- **Sandboxing the generator.** It runs like any repo command in the task's computer, and its output is committed as is.
- **A settings revision check at apply time.** The last writer wins, and the card shows the change.
- **Forks without maintainer edits.** Any push they need becomes a `hold`.
- **A contributor rewinding the branch during a repair.** The ref update is a fast-forward from `expected_head`, and GitHub's
  ref API has no atomic old-SHA check. A rewind to an ancestor within the seconds between ship's read and its write could
  be overwritten. The next pass shows the result in the report.
- **Generator commands are ordinary settings (owner).** Changing one isn't a loosening. Its output is committed to the PR
  and reviewed like any other change.
