# ship

## What it does

Owns the lifecycle of every pull request on the repos it covers: the fleet's own repos (the agents org and the product
repo) and every repo in `maintainer_repos`. This release holds the foundation: one `ship` setting with per-repo entries and
two presets (`cautious`, the default, and `full`), every knob a per-repo setting with no floor in code (`null` caps are
unlimited), and the adoption store. A fork's PR is ignored until a member hands it off (a member's label or `/ship` comment adopts it and starts its review through code review's existing ask). Rounds, repair, App approval and the merge arrive in later releases. The Fleet page
(Fleet sidebar) edits the settings and shows status.

## Connect

GitHub only: ship is available once a GitHub repo is connected (the `github` module); the local code host keeps its own merge path. List repos in `maintainer_repos` (the fleet's own are covered already), then give a repo an entry
in the Fleet page, or ask Aiden.

## What agents get

The `ship` connection. Read: `ship_config`. Write: `ship_configure`. Both need the `ship-admin` role (the Maintainer and Aiden
hold it). A change that loosens anything (more hand-off, a higher or removed cap, wider approve) is the owner's, made from the
Fleet page.

## New installs

In the default bundle, quiet: a repo is worked only when it is enabled (`enabled`, on by default for the fleet's own repos; enabling a listed repo applies `cautious`). The Fleet page's controls are Enabled, Preset, Which PRs to adopt (`handoff`), Approval policy (`approve`) and Auto-merge (`merge`). With `defaults: cautious` it works only the fleet's own repos, and nothing is adopted until a later release switches the loop on. A `maintainer_repos` repo is not touched until it has an entry.
