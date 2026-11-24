# ship

## What it does

Owns the lifecycle of every pull request on the repos it covers: the fleet's own repos (the agents org and the product
repo) and every repo in `maintainer_repos`. This release holds the foundation: one `ship` setting with per-repo entries and
two presets (`cautious`, the default, and `full`), every knob a per-repo setting with no floor in code (`null` caps are
unlimited), and admission: a PR from a fork or from an author without write access starts nothing (no code review) until a
trusted member hands it off. Rounds, repair, App approval and the merge arrive in later releases. The board's Ship page
(Fleet sidebar) edits the settings and shows status and metrics.

## Connect

Needs the `github` module. List repos in `maintainer_repos` (the fleet's own are covered already), then give a repo an entry
in the Ship page, or ask Aiden.

## What agents get

The `ship` connection. Read: `ship_config`. Write: `ship_configure`. Both need the `ship-admin` role (the Maintainer and Aiden
hold it). A change that loosens anything (more hand-off, a higher or removed cap, wider approve) is the owner's, made from the
board's Ship page.

## New installs

In the default bundle. With `defaults: cautious` it covers only the fleet's own repos, and nothing is adopted until a later
release switches the loop on. No other repo is touched until you list it.
