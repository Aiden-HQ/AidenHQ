# ship

## What it does

Owns the lifecycle of every pull request on the repos it covers: the fleet's own repos (the agents org and the product
repo) and every repo in `maintainer_repos`. One `ship` setting holds per-repo entries and two presets (`cautious`, the
default, and `full`), every knob a per-repo setting with no floor in code (`null` caps are unlimited).

Its watch loop reads a repo's open PRs (one list read) when the github module's change feed reports a change there (a PR
opened, pushed, labelled, reviewed or closed, a check or status finished, main moved), and again after 5 minutes while a PR it
works can move with GitHub quiet (its task's state, a merge's outcome, a wedged check run). It runs every PR through one engine (`round()`). A PR
the code host opened for a task is adopted when first seen and owned by that task; any other PR is a hand-off: a member's `ship`
label or `/ship` comment adopts it. For either, ship repairs a conflict (its no-model repair first), has GitHub update a branch
that is behind (once, before asking for a fix, when it is red behind a green base), wakes the PR's task for red required checks
or code review's findings, and files the merge (`github.merge`) once code review passes. Past a cap (`caps`) the PR holds and its
owner is told: a task's PR wakes whoever asked for the task, a member's PR gets its report comment and its author assigned; a new
push resumes it. Checks whose jobs never started, and check runs wedged after their job finished, are re-run for any PR. Ship
also closes a cancelled, superseded or finished task's leftover PR, files a Dependabot PR's task, and has the Maintainer nudge,
then close, a quiet contributor PR on repos with `contributor_prs`. The pause stops all of it, merges already filed included.
The Fleet page (Fleet sidebar, a module view the `ship` connection serves as `ui://ship/page`) is where it is set: Add repo (a draft panel: the name, a start from Defaults, Cautious, Full or a copy of a listed repo, and the same settings editor; a repo that starts from Defaults follows later changes to them) and, per repo, on or off, preset, which PRs to adopt (`handoff`), `by_tier` (per risk tier: whether the App approves and whether ship merges), a global pause, and the holds. The module's settings are for the advanced options only.

## Connect

GitHub only: ship is available once a GitHub repo is connected (the `github` module); the local code host keeps its own merge path. List repos in `maintainer_repos` (the fleet's own are covered already), then give a repo an entry
in the Fleet page, or ask Aiden.

Without ship, no PR is watched: Engineers merge their own green PRs (`aidenhq merge`, a `github.merge` record).

## What agents get

The `ship` connection. Read: `ship_config`. Write: `ship_configure`. Both need the `ship-admin` role (the Maintainer and Aiden
hold it); the owner's own Fleet page calls them too, and `ship_configure` then only returns the typed settings change (the board files it on his Save). A repo ship doesn't cover yet is the owner's to add from the Fleet page, as one change covering its `maintainer_repos`, `code_review` and `ship` entries. A change that loosens anything (more hand-off, a higher or removed cap, a tier's approve or merge raised) is the owner's, made from the
Fleet page.

## New installs

In the default bundle, quiet: a repo is worked only when it is enabled (`enabled`, on by default for the fleet's own repos; enabling a listed repo applies `cautious`). The Fleet page's controls are Enabled, Preset, Which PRs to adopt (`handoff`) and `by_tier` (approve and merge per risk tier). With `defaults: cautious` it works only the fleet's own repos, as github's PR watch did. A `maintainer_repos` repo is not touched until it has an entry.
