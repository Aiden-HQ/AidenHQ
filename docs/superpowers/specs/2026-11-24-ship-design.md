# Ship: every PR, from open to merged

Status: direction approved by the owner, 2026-11-24 (no further design review asked). Owner decisions are marked
**(owner)**; everything else is the designer's call. The research behind it (other teams' bots, merge queues,
post-mortems) lives in the instance repo's product history.

## Why

A PR waits hours to days for review. It collides with generated files, is ejected from the merge queue, loses its approval
on every rebase, and needs a person to rebase, regenerate, re-run and re-queue it each time. Merge queues only rebase: they
eject a PR that conflicts and never run a repo's code generation.

The fleet already takes its own PRs to merge, but that loop lives inside the github module (`pr-watch.ts`, with its
automatic merge filing). It has fixed caps, and nothing takes a PR someone else opened.

The goal: a member hands a PR to the fleet, and it reaches merge with no person in the loop, within the repo's own rules.
On the way it is:
- kept current;
- resolved of conflicts;
- given freshly regenerated generated files;
- fixed for any CI failures it caused;
- answered on every review finding;
- approved by the App;
- merged through the repo's own path.

Safe PRs lose the human now, and every PR eventually **(owner)**.

## Goals

- **One PR lifecycle for every PR.** Fleet-authored and handed-over PRs share one state machine and one set of per-repo
  settings.
- **Every knob is a per-repo setting, with no hard limits in code (owner).** A test repo may run fully unguarded while
  another runs cautious. Guards ship as named presets, never as floors.
- **Deterministic work before any model call.** The model is used only for judgment.
- **A report a code owner can approve from** without opening the diff.
- **Settings an agent can change from the owner's words**, validated and filed as a settings change.
- **An optional module behind one interface.** Nothing in the core needs it.

## Non-goals

- A user-defined rules engine ("if Y then X") **(owner: not now)**.
- Replacing code-owner review. A code-owner-gated PR waits for its human owner, and the report makes that approval quick
  **(owner)**.
- Reviewing code. The code-review module does that; ship reads its verdict.

## Structure (module split)

Each module owns one part of the lifecycle:

| Module | Owns |
|---|---|
| `maintainer` | The issue lifecycle only: triage, validate, dedupe, resolved-check, send fixes to an Engineer, feature labels. It borrows Gardener's rules: be sceptical of confident agent-written reports, and "a wrong close costs more than a miss". |
| `ship` (new) | The PR lifecycle for every PR: adoption, rounds, fix dispatch, App approval, enqueue, confirming the merge landed, metrics, per-repo settings and presets. It absorbs everything `pr-watch.ts` does today. |
| `github` | Typed effects only: push with compare-and-swap on the head, update-branch, approve, enqueue, merge, comment, label. Also `merges.ts` and `merge-gate.ts` as the merge primitive. No PR policy. |
| `code-review` | Unchanged: a gate that ship reads (`review-gate.ts`). |
| `engineering` | Unchanged except for one skill, `ship`, that the Engineer reads on a ship task. |

**Moving pr-watch.ts into ship (one way).** Ship's service takes over every duty of
`modules/github/service/src/pr-watch.ts`:
- the agent-PR loop and automatic merge filing;
- update-branch;
- re-running never-started and wedged checks;
- the title gate re-run;
- the CI breaker;
- Dependabot task filing;
- closing abandoned PRs.

`pr-watch.ts` is deleted in the same PR that switches ship on. The github service keeps the effects ship calls through the
kernel.

**Without ship.** With the module off, no PR is watched: Engineers request merges themselves (`aidenhq merge`, a `github.merge`
record), as they can today. Ship is in the default bundle.

## Design

### 1. Settings (ship module)

Ship's settings live in one setting, `ship`, declared in `modules/ship/module.yaml`:

```yaml
ship:
  defaults: cautious            # applies to every repo ship covers that has no entry of its own
  repos:
    acme/api: { preset: cautious, approve: safe, handoff: label, generated: { globs: ["schema/**"], command: "make generate" } }
    acme/sandbox: full
  paused: false                 # the kill switch: stops every adoption, push, approval and merge; PRs resume where they were
```

**Coverage.**
- Ship covers the fleet's own repos (the agents org and the product repo) and every repo in `maintainer_repos` (the github
  module's list of repos the fleet may merge in).
- An entry for any other repo is refused when the setting is validated.
- Every PR the fleet opens is adopted at open. A handed-over PR is adopted per `handoff`.

**Fields.** Every field may take any value its type allows, including `null` caps **(owner)**.

| field | `cautious` | `full` | meaning |
|---|---|---|---|
| `handoff` | `label` | `all` | `label`: a trusted `ship` label, a `/ship` comment, or the `ship` tool. `all`: every non-draft PR by an author with write access. `none`: fleet PRs only |
| `external` | `member` | `member` | A PR whose author lacks write access, or a fork, starts nothing (ship, code review, CI re-runs) until a trusted member hands it off. `any` admits it like a member's PR |
| `forks` | `replace` | `replace` | A fork's PR is carried on a credited branch in the base repo (`replace`), or skipped (`skip`) |
| `rebase` | `conflict` | `behind` | Update only on a conflict or a failing guard, or whenever the branch is behind |
| `generated` | unset | unset | `{ globs, command }`: generated files and the command that regenerates them |
| `fix` | `[conflicts, ci, review]` | same | What the Engineer may work on |
| `protected` | lockfiles, `.github/**`, test and lint config, CODEOWNERS | `[]` | A fix that touches these is handed back to a person, not pushed |
| `caps` | `{ wakes_per_head: 3, ci_rounds: 3, same_check_heads: 2, reasks_per_head: 2, review_rounds: 3, rounds: 30, usd: 5, silence_min: 15, requeue_on_timeout: 1 }` | all `null` except `silence_min` | Per PR. `null` means unlimited. Past a cap, the PR stalls (§3) |
| `approve` | `safe` | `all` | `off`, `observe` (the report says what it would do), `safe`, `all` |
| `safe` | `{ max_lines: 1200, max_files: 50, deny: [<protected>, "**/migrations/**", "**/auth/**"] }` | n/a | The safe class. It counts substantive lines, excluding generated, lock, test and docs files |
| `merge` | `ready` | `ready` | `off`: stop at ready. `ready`: merge when every gate passes |
| `stop_label` | `ship:stop` | `ship:stop` | While present, the PR is left alone. Removing it resumes the PR |

**Parity with today.** `cautious` carries today's `pr-watch.ts` constants unchanged, so the cutover changes nothing for the
fleet's own PRs:
- `caps.wakes_per_head: 3` (today's `MAX_WAKES`, counting wakes of every cause);
- `caps.ci_rounds: 3` (`BREAKER_ROUNDS`);
- `caps.same_check_heads: 2` (the breaker's same named check red on two heads).

`caps.reasks_per_head: 2` and `caps.requeue_on_timeout: 1` are new and apply to the new paths only. The fleet's own repos
resolve to `defaults`.

**Approval needs a gated repo.** `approve` above `off` needs code review gating that repo. Where it doesn't, the effective
value is `off` and the report says why. This is a dependency, not a floor: gating the repo restores the setting.

**Who may change what.** The validator (`modules/ship/src/settings.ts`) normalises the old and new values to their effective
settings, presets resolved, and compares them:
- **Loosening goes to the owner.** That is any change that:
  - admits more PRs (`handoff`, `external`, `forks: replace`);
  - lets ship do more without a person (`approve`, `merge`, a wider `fix`);
  - raises or removes a cap;
  - widens `safe` or narrows `protected`;
  - sets or changes `generated.command` (it runs repo code);
  - clears `paused`.

  The comparison is enforced when the settings change is applied, not only when it is filed.
- **Everything else** is an ordinary settings change.
- Spelling the same policy differently (`full` versus `{ preset: full }`) is the same change.

**Agent-editable.** The settings tools are `ship_config` (read the effective settings per repo) and `ship_configure(repo,
change)`. They are built like `modules/code-review/service/src/config-tool.ts`:
1. Apply the change to the raw entry and validate the whole result.
2. Refuse a stale edit: the raw value it was read from must still be current.
3. File one typed settings change (`POST /v1/settings/agent`).

They are granted to the Maintainer and to Aiden's delegate. For example, "ship everything on acme/sandbox, no limits"
becomes `acme/sandbox: full`, filed on an owner card.

### 2. Adoption

**One durable record per adoption.** Ship's state, `data/ship/state.json` (atomic rename), holds one record per PR:

```
{ repo, number, generation, trigger: { kind: "fleet"|"label"|"comment"|"tool"|"all", event, actor }, task, status }
```

Status is one of `working`, `waiting`, `stalled`, `queued`, `merged`, `handed_back` or `stopped`.

**Triggers.**
- A fleet PR is adopted at open, and its task is the task that opened it.
- A handed-over PR needs a trusted trigger: a label or comment event by a role in the repo's trusted roles (the
  `agent-build` trust rule in `github-mcp/src/maintainer.ts`), or the `ship` tool. The App never counts.
- Each trigger is consumed once, by its event id.

**Generations and hand-back.**
- Hand-back and stall are sticky. A label left on the PR, or `handoff: all`, never re-adopts it.
- Only a fresh trusted trigger (re-adding the label, a new `/ship`) starts a new generation.
- Every write carries its generation, and a write from an older generation is refused.

**Task.**
- A handed-over PR gets one task with the marker `ship:<repo>/<n>` and fixed text, never the PR's own words. It goes to the
  role `platform-engineer`, the Engineer's.
- If the PR already has a task (the fleet's own, or Dependabot's), that task is reused.
- Task creation is reconciled by its marker after a crash, so one adoption never files two tasks.

**Authorship stays separate.** Adoption is not authorship:
- github keeps opener provenance: which task opened a PR (`pr-tasks.json`, read through a typed op). Merge credit and grading
  read it, as today.
- Ship's adoption records live in ship's own state.
- Closing an abandoned PR and deleting its branch apply only to PRs a fleet task opened. Cancelling a ship task for a
  handed-over PR ends the adoption, and never closes the PR or touches its ref.
- Dependabot tasks that github filed move to ship at the cutover (task ownership transferred in the migration), so ship may
  close them.

**Admission before spend.**
- For a repo ship covers, code review starts its automatic reviews only once ship admits the PR. Code review asks ship's
  `GET /v1/admitted?repo&pr`:
  - no ship module installed (or ship off) means admitted;
  - ship installed but unreachable means deferred, and the start is retried later.
- The same admission governs code review's backfill of mandatory reviews, work already queued, and Dependabot filing.
- Handing off an unchanged head starts its review exactly once.
- For `external: member`, nothing runs on an external PR until a member hands it off: no ship work, no code review, no CI
  re-runs **(owner)**.

### 3. Rounds

Rounds follow Alcora's design (vinext):
- Each finished check suite, submitted review, new comment from a trusted person, or reviewer verdict on the head is a
  **round**.
- Each round wakes the PR's task. Waking the same task means the same Engineer session and computer continue across rounds
  of one PR.

On each pass ship takes one decision from merge-gate's `decide`, which is extended to return actions: `wait`, `repair`,
`fix_ci`, `fix_review`, `approve`, `enqueue`, `merge`, `done`, `stall`, with the reason. Each writer recomputes `decide` right
before it writes, so there is one readiness rule for both the watcher and the executor.

1. **Stopped:** the stop label, `paused`, closed, a draft, or a person assigned to the PR (assigning a person pauses the
   loop). Nothing happens.
2. **Queued** (the PR is in the repo's merge queue): nothing touches the branch, and ship reads the merge group's checks.
3. **`repair`** (conflicting, or behind under `rebase: behind`):
   - First GitHub's update-branch, with `expected_head_sha`.
   - On a conflict, the task runs `aidenhq ship repair <pr>` in its computer, a script with no model. It merges the base,
     takes the base side for every conflicted path in `generated.globs`, and runs `generated.command`.
   - If nothing is left conflicted and the tree is clean, it commits and pushes (§4).
   - It reverts any whitespace-only lockfile change it produced.
   - Leftover conflicts go to the Engineer in the same task.
4. **`fix_ci`** (red on the PR's own head):
   - Each failed check is compared with the same check on the default branch's latest completed run, by check name and
     failure signature: the first failing test or error line.
   - The same signature on main means `pre-existing`: wait for main, say so in the report, and spend no round. A different
     or unknown signature is the PR's.
   - A check whose job never started is re-run once.
5. **`fix_review`:** open important findings on the head (review-gate `findings`). The Engineer verifies each finding:
   - A real one is fixed, with a test where it fits.
   - Anything else is declined with evidence through `code_review_resolve`.
6. **The Engineer's rules on every fix round** (the `ship` skill):
   - Never weaken a check to get green.
   - Push one commit per round.
   - A fix that touches `protected` paths stalls the PR.
   - Before declaring it done, run an independent reviewer sub-agent on the diff, without telling it what the fix was
     meant to do. Repeat until it reports no findings, within the round cap.
7. **Reviewer handling:**
   - Re-ask a reviewer about the exact head at most `reasks_per_head` times.
   - A reviewer silent for `silence_min` minutes is re-asked.
   - Ship never posts while a reviewer's trigger is still pending on that head.
8. **`approve`** (§5), then **`enqueue` or `merge`** (§6).

**Stall.** Past any cap, or on a step the settings exclude:
- the PR's status becomes `stalled`;
- the report says what was tried and what is left;
- the PR's author (or the repo's first code owner) is assigned once.

A fresh trigger resumes the PR.

**Stacks.** A PR based on another open PR waits until its base merges, so stacks merge bottom-up. Ship then retargets it to
the default branch with update-branch.

### 4. Writes: typed effects, compare-and-swap, scope guard

Every write is a kernel record, tiered in code (`computeTier`). github executes it; ship only files it. Every record carries
`{ repo, number, generation, expected_head }`, and github refuses it if any of these hold:
- the PR number doesn't match the target (scope guard);
- the PR's head has moved from `expected_head`;
- the generation is stale (ship answers the generation check).

| Effect | How github runs it |
|---|---|
| Push to an adopted PR's branch | `github.push` gains a target `{ pr: { repo, number }, expected }`. The runner resolves the PR's current head repo, ref and SHA, refuses a fork, and pushes with `--force-with-lease=<ref>:<expected>`. The code host's push planner (`plan.ts`) allows this one adopted ref, and the foreign-head tiering stays. A repo whose rules require signed commits needs the runner's commit-signing key (an instance setting). Without one, the repair stalls with "signing key needed". |
| Fork replacement | The fork's commits go to `ship/<n>` in the base repo, opened as a PR that credits the author (`Co-authored-by`) and links the original. The original head is stored with it, and the original is closed only if its head is unchanged when the replacement merges. The App can't approve its own replacement PR, so a replacement waits for a person's approval. |
| Update branch | Existing, with `expected_head_sha`. |
| Approve | `github.approve`: the reviewer App's review with `commit_id` set to the head (§5). On a new head, its earlier review is dismissed. |
| Enqueue | `github.enqueue`: `enqueuePullRequest` with `expectedHeadOid`. |
| Merge | `github.merge`, bound to the head. Today's automatic filer needs a completed PR record from the same task, which a handed-over PR lacks. Ship's merges and enqueues are filed by the PR's task instead, carrying adoption evidence `{ generation, adoption }` that github validates against ship. Foreign-head tiering stays: a head the runner didn't push still goes to the AI reviewer. |

**Generation and attempt are separate.** Each enqueue or merge also carries an `attempt` id. After an ejection at the same
head, ship files a new attempt in the same generation, without renewing the hand-off, and it never overrides a rejected
record. `kernel/src/writes.ts` dedupes on `(generation, attempt)`.

**Queue membership is reconciled separately.** `mergeCalls` only proves direct merge calls. Ship reads the PR's queue entry
before every action, and these cases are handled explicitly:
- a dequeue after a hand-back;
- a pause that races an enqueue;
- an enqueue whose answer was ambiguous.

There is no second receipt store. The report and the metrics read the kernel's record outcomes.

A merge or enqueue whose answer is ambiguous (a timeout, a 5xx after the call) is reconciled first: did it merge, at which
head, and is it queued? It is retried only if the PR is still eligible and not merged. `merges.ts` already keeps every call's
token for this (`mergeCalls`).

### 5. Approval

**Identity.** GitHub refuses an approval from the account that opened the PR, and the code host opens the fleet's PRs, so
approvals come from a separate reviewer identity: a second GitHub App, the setting `github_reviewer_app` (github module,
optional, created once by the owner).
- Without it, ship approves only PRs the code host didn't open.
- Fleet PRs then wait for a person wherever GitHub requires a review.
- The reviewer App is never a code owner, so a code-owner requirement still needs the human owner **(owner)**.
- Which requirement remains is read from GitHub's view of the PR (its review decision and the requested teams), not
  inferred from CODEOWNERS paths.

**Evidence.** Code review's verdict endpoint exposes the review it rests on: the reviewed head, and whether it was a
completed review or an exhausted or skipped one. Approval needs a completed review of the candidate SHA itself, not an
earlier head's open-only review. Before an enqueue or merge, `decide` reads each approval's author, commit and dismissal
state (the merge-gate query gains them).

The reviewer App approves the exact head when all of these hold:
- checks are green on it;
- code review completed a review of that exact head and it passed (not a bypass, not "ungated", not exhausted);
- no changes are requested;
- the stop label is absent;
- `approve` allows it: `safe` needs the PR inside the safe class, `all` takes any PR.

Right before every enqueue or merge, `decide` re-checks the head and the approval evidence: the App's or a person's approval
on the current head. This holds even where GitHub requires no reviews.

Other cases:
- **A PR outside the safe class under `safe`:** a person's approval on the current head is required, and the PR waits as
  "waiting for required review".
- **A repo where GitHub still requires a review after the App's:** the PR waits as "waiting on code owner" when CODEOWNERS
  names the files, otherwise as "waiting for required review" **(owner)**.
- **`observe`:** posts nothing on GitHub. The report says "would approve", or "would not" with the reason. It needs code
  review on the repo to say either.
- **`approve` other than `off`:** the validator requires the repo to be gated by code review (a mandatory combo).

### 6. Merge

`merges.ts` stays the only merge executor.

**The merge path.** `mergePath()` picks it from the branch's rules (`GET /repos/{r}/rules/branches/{b}`):
- **Queue required:** enqueue. Ship then reads the PR's queue entry until it merges or leaves the queue. A removal comes back
  as one of:
  - a group failure: back to `fix_ci` on the merge group's failure;
  - a conflict: back to `repair`;
  - a timeout: re-enqueue, up to `caps.requeue_on_timeout` per head;
  - a person dequeued it: stopped until a fresh trigger.

  Stop, pause and stall also dequeue a queued PR.
- **No queue:** the direct merge, bound to the head, with the repo's merge method (`mergeMethod`). Native auto-merge isn't
  used, since it would be one more pending action to cancel.

**When it counts as merged.** The PR reads merged at the bound head and its merge commit is on the default branch. Only then
is the task closed.

**Waits, not failures.** `decide` answers `BLOCKED` with a review requirement as a wait. `DIRTY` and `BEHIND` on a ship PR
return `repair`.

### 7. The report

There is one App comment per PR, edited in place (marker `<!-- aidenhq-ship -->`). Code renders it from the adoption record,
the kernel's record outcomes and code review's verdict. The model contributes only a one-line summary per fix. It shows:
- **State:** working, waiting on (checks, a code owner `@team`, main), queued, ready, merged, or stalled.
- **What ship did:** commits rebased; generated files regenerated, with the globs and the command; the check fixed; findings
  answered (fixed, or declined with the reason).
- **Risk facts:** substantive lines and files; areas touched (CODEOWNERS owners); protected or denied paths hit; the
  safe-class verdict and why; code review's verdict and its open findings.
- **What it waits on**, and who can unblock it.

### 8. Metrics

Flow facts (`flow.ts`): `ship.adopted`, `ship.round` (with its kind and cost), `ship.stalled` (with the reason) and
`ship.merged`. The Fleet Steward's flow report shows, per repo:
- merges per adoption;
- rounds per merge;
- cost per merge (the ledger by task subject);
- time from hand-off to merge;
- stalls by reason.

Revert tracking (`ship.reverted`) comes after the pilot.

## New installs

- **Default bundle:** ship is in it. With `defaults: cautious` it covers only the fleet's own PRs, exactly like today's
  pr-watch with its constants as settings. No other repo is adopted until the owner lists one (quiet start).
- **Without GitHub:** ship has nothing to watch.
- **Without code review on a repo:** `approve` stays `off`. The validator refuses `observe`, `safe` and `all` there.
- **Without the ship module:** no PR is watched, and Engineers request merges by hand.
- **codehost-local:** gets adoption, repair and merge through the same records. `github.approve` and merge queues exist only
  on GitHub.

## Security

Each new path gets a security review before it switches on (CLAUDE.md "Every new path gets a security review"):
- **Pushing to a branch the fleet didn't create:** same-repo refs only, compare-and-swap on the head, and a trusted trigger
  checked again before the first write. A fork never receives a push.
- **The App approving:** bound to the head, gated in code by the repo's `approve` setting, and re-checked at merge. Never
  triggered by the App's own label or comment.
- **Untrusted text:** a PR's title, body, comments and check output never reach a task's text. The Engineer reads them as
  fenced data. Instructions come from the base branch only.
- **Repo code:** `generated.command` runs only in the task's computer, as every Engineer build does.

## Left to the builder

Exact record shapes, the state file's layout, and these end-to-end tests:
- a labelled PR adopted, regenerated and merged;
- an external PR untouched (and unreviewed) until a member labels it;
- a cap reached, the PR stalled and a person assigned;
- a code-owner PR approved by the App and left waiting;
- a merge-queue ejection looped back;
- a restart between filing the task and saving the adoption;
- a contributor's push during a repair refused by the lease;
- cancelling a handed-over task leaves the contributor's PR and ref intact.

**Rollout (owner).** No separate cutover test. Ship is dogfooded on AidenHQ's own repos (the product repo, the distro, the
instance repo, the agents org) from the moment it replaces pr-watch, and breakage is fixed forward. The pilot repo follows
once hand-offs ship.
