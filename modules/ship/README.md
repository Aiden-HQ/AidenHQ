# ship

## What it does

Owns the lifecycle of every pull request on the repos it covers: the fleet's own repos (the agents org and the product
repo) and every repo added to Ship (its own list, the keys of `ship.repos`: the Maintainer and code review keep theirs). One `ship` setting holds per-repo entries and two presets (`cautious`, the
default, and `full`), every knob a per-repo setting with no floor in code (`null` caps are unlimited).

Its watch loop reads a repo's open PRs (one list read) when the github module's change feed reports a change there (a PR
opened, pushed, labelled, reviewed or closed, a check or status finished, main moved), and again after 1 minute while a PR it
works can move with GitHub quiet (its task's state, a merge's outcome, a wedged check run). It runs every PR through one engine (`round()`). A PR
the code host opened for a task is adopted when first seen and owned by that task; any other PR is a hand-off: a member's `ship`
label or `/ship` comment adopts it. For either, ship repairs a conflict (its no-model repair first), has GitHub update a branch
that is behind (once, before asking for a fix, when it is red behind a green base), wakes the PR's task for red required checks
or review comments (code review's findings, and any unanswered review thread or conversation comment from a member of the repo:
github's member-comments.ts), and files the merge (`github.merge`) once code review passes. Past a cap (`caps`) the PR holds and its
owner is told: a task's PR wakes whoever asked for the task, a member's PR gets its report comment and its author assigned; a new
push resumes it. Checks whose jobs never started, and check runs wedged after their job finished, are re-run for any PR. Ship
also closes a cancelled, superseded or finished task's leftover PR, files a Dependabot PR's task on repos whose entry sets `dependabot`
(off, failing, all), and nudges, then closes, a quiet contributor PR on repos whose entry sets `quiet_pr_days` (both in fixed
words, as the chosen GitHub actor ([docs/design/github-identity.md](../../docs/design/github-identity.md)), with the Ship footer; a close reads the PR again first). Both run on the product repo (which may
take them from Defaults) and on every repo with an entry, whether or not Ship works the repo's PRs. Pull requests are Ship's:
the Maintainer does issues only. The pause stops all of it, merges already filed included.
The Fleet page (Fleet sidebar, a module view the `ship` connection serves as `ui://ship/page`) is where it is set: Add repo (a draft panel: the name, a start from Defaults, Cautious, Full or a copy of a listed repo, and the same settings editor; a repo that starts from Defaults follows later changes to them) and, per repo, on or off, preset, which PRs to adopt (`handoff`), Dependabot updates, inactive contributor PRs, `by_tier` (per risk tier: whether the App approves and whether ship merges), a global pause, and the holds. The module's settings are for the advanced options only.

## How a PR moves

- **Adoption.** A PR the code host opened for a task is adopted at first sight, owned by that task. Any other PR needs a member
  with write access: a `ship` label or a `/ship` comment (never a bot or the App), whatever the preset; only `handoff: all`, set
  by hand, takes every writer's PR unasked. A green Dependabot PR on a repo whose `dependabot` is `failing` is adopted as is (that setting is its opt-in). Each trigger is consumed
  once; a hold or hand-back is sticky until a newer trigger starts a new generation. The Engineer task (`ship:<repo>/<n>:<generation>`,
  role `platform-engineer`) is filed when a round first needs it, with fixed text, never the PR's words. Cancelling it ends the
  adoption and leaves the PR open.
- **Forks.** A fork is worked only after a member's trigger, which also asks code review for its review. The trigger covers the
  head it was given and ship's own commits; any other new commit holds it until handed off again. Ship pushes to a fork only
  where the author allows maintainer edits; otherwise the PR holds.
- **One decision per pass.** Merge-gate's `decide` returns `wait`, `repair`, `fix_ci`, `fix_review`, `approve`, `enqueue`,
  `merge`, `done`, `stall` or `fail`, and each writer re-decides right before it writes. Nothing moves on a draft, a stop label (`stop_label`, default `ship:stop`), or a hold (assigning anyone never stops it).
- **Repair** (PRs into the default branch: the merge gate waits on any other base before a conflict is looked at). The repo's own
  `actions` run first: each a workflow with `workflow_dispatch`, dispatched on the default branch (the repo's own trusted copy, so
  a PR doesn't change what runs with its secrets) with the PR's number as an input
  (`inputs: { pr: "{pr}" }`); ship follows the run GitHub names, and a failed run moves on to the next step, then to ship's own.
  Then GitHub's update-branch, then on a conflict the `ship-repair` check job: a credential-free box merges the base's live tip in
  (none when the head already holds it), takes the base side of generated paths and lockfiles, runs the discovered generator
  (`.gitattributes` `linguist-generated`, known lockfiles, generated-file headers; the `generated` setting overrides; with
  `generated.ci: <workflow file>` a workflow in the repo's own CI (e.g. `schema-generate.yml`) regenerates them: the box takes their
  base side and runs nothing, and ship merges a head its repair made that way only once that workflow's newest run on it succeeded,
  holding the PR after 30 minutes without it, including when the workflow never ran on that head) and returns the files, which github commits
  as the App. A leftover conflict or a failed generator wakes the
  Engineer once per head. A stacked PR waits on the PR it stands on, then github's `retarget` moves it to the default branch.
- **Fixes.** The task is woken for red required checks (a failure that is red on the base too is a wait), unanswered review
  findings and members' unanswered review comments (never those of the repo's `ignore_authors`, its automation accounts), one wake at a time in the same session. A model fix touching a `protected`
  path puts the PR on hold; the deterministic repair may still regenerate lockfiles.
- **Approval and merge.** Where the target branch's rules or code review's gate require it, the App approves the exact head (never on a PR the App opened: approval needs a person) when
  the head's risk tier has `approve: on`, code review's pass stands on it and checks are green (`observe` writes what it would
  do in the report); an App approval from another head or policy is dismissed. Then ship files `github.merge`, or
  `github.enqueue` where the branch has a merge queue (a queue removal maps to `fix_ci`, `repair`, one re-enqueue or a hold).
  Every write is a kernel record bound to the head, tiered in code; github refuses it when the head moved or ship is paused.
  The task closes once the PR reads merged.
- **Report.** One comment per PR (marker `<!-- aidenhq-ship -->`), edited in place, written by code in fixed sentences: posted
  whenever its status changes (waits included), so a quiet PR is never read as stuck; a PR the fleet opened for a task gets
  one only when a person must act.
- **Hold.** Past a cap, or on a step the settings exclude, the PR goes on hold with the reason; a member's PR gets its author
  assigned. A new head clears a stalled hold.

## Connect

GitHub only: ship is available once a GitHub repo is connected (the `github` module); the local code host keeps its own merge path. Add a repo on the Fleet page (the fleet's own are covered
already); its settings change there or through Aiden. A repo added to Ship is also a listed repo, where the fleet's work may merge
and close (the code host's `listed_repos`: Ship's list and the Maintainer's).

Without ship, no PR is watched: Engineers merge their own green PRs (`aidenhq merge`, a `github.merge` record).

## What agents get

Sam (the `ship` agent) is ship's teammate: he answers the owner about a PR's merge state, holds and the queue, and changes
the settings when asked. The `ship` connection. Read: `ship_config`, `ship_status`. Write: `ship_configure`. Both need the
`ship-admin` role (Sam, the Maintainer and Aiden hold it); the owner's own Fleet page calls them too, and `ship_configure` then only returns the typed settings change (the board files it on his Save). A repo ship doesn't cover yet is the owner's to add from the Fleet page: Add writes only its `ship` entry and Remove drops only that. The Maintainer and code review are separate: adding a repo to Ship never lists it there (the owner does that from their pages), and a repo code review doesn't watch merges by the `unwatched` setting. Ship reads no other module's list. A change that loosens anything (more hand-off, a higher or removed cap, a tier's approve or merge raised, `dependabot: all`, quiet-PR closing turned on, a login added to
`ignore_authors`: its comments stop gating a merge) is the owner's, made from the Fleet page; removing an `ignore_authors` login is
not.

## New installs

In the default bundle, quiet: a repo is worked only when it is enabled (`enabled`, on by default for the fleet's own repos; enabling a listed repo applies `cautious`). The Fleet page's controls are Enabled, Preset, Which PRs to adopt (`handoff`) and `by_tier` (approve and merge per risk tier). With `defaults: cautious` it works only the fleet's own repos, as github's PR watch did. Dependabot tasks and quiet-PR closing are off everywhere until the owner turns them on per repo (or in Defaults); before pull requests moved to Ship, an unlisted product repo took every Dependabot bump, so an install that wants that sets `dependabot: all` on the product repo's entry.
