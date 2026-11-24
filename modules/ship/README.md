# ship

## What it does

Owns the lifecycle of every pull request on the repos it covers: the fleet's own repos (the agents org and the product
repo) and every repo in `maintainer_repos`. One `ship` setting holds per-repo entries and two presets (`cautious`, the
default, and `full`), every knob a per-repo setting with no floor in code (`null` caps are unlimited).

Its watch loop (moved from github's pr-watch) reads the open PRs once a minute. An agent's PR is adopted when first seen. Ship
wakes the task that opened it when the PR conflicts or its checks go red, has GitHub update a branch that is only behind, and
re-runs checks that never started, got wedged, or failed only on the title gate. When `caps.ci_rounds` red rounds pass, or one
check is red on `caps.same_check_heads` heads, the CI breaker tells the asker instead. A green PR has its merge filed
(`github.merge`, on its task). Ship also closes a cancelled or finished task's leftover PR, files a Dependabot PR's task, and has
the Maintainer nudge, then close, a quiet contributor PR on repos with `contributor_prs`. Every other PR is a hand-off: a
member's `ship` label or `/ship` comment adopts it, and ship repairs, reports on and merges it. The pause stops all of it,
merges already filed included.
The Fleet page (Fleet sidebar, a module view the `ship` connection serves as `ui://ship/page`) is where it is set: per repo on or off, preset, which PRs to adopt (`handoff`), `approve` and `merge`, a global pause, and the holds. The module's settings are for the advanced options only.

## Connect

GitHub only: ship is available once a GitHub repo is connected (the `github` module); the local code host keeps its own merge path. List repos in `maintainer_repos` (the fleet's own are covered already), then give a repo an entry
in the Fleet page, or ask Aiden.

Without ship, no PR is watched: Engineers merge their own green PRs (`aidenhq merge`, a `github.merge` record).

## What agents get

The `ship` connection. Read: `ship_config`. Write: `ship_configure`. Both need the `ship-admin` role (the Maintainer and Aiden
hold it); the owner's own Fleet page calls them too, and `ship_configure` then only returns the typed settings change (the board files it on his Save). A repo ship doesn't cover yet is the owner's to add from the Fleet page, as one change covering its `maintainer_repos`, `code_review` and `ship` entries. A change that loosens anything (more hand-off, a higher or removed cap, wider approve) is the owner's, made from the
Fleet page.

## New installs

In the default bundle, quiet: a repo is worked only when it is enabled (`enabled`, on by default for the fleet's own repos; enabling a listed repo applies `cautious`). The Fleet page's controls are Enabled, Preset, Which PRs to adopt (`handoff`), Approval policy (`approve`) and Auto-merge (`merge`). With `defaults: cautious` it works only the fleet's own repos, as github's PR watch did. A `maintainer_repos` repo is not touched until it has an entry.
