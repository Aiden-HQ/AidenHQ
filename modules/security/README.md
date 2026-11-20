# security

## What it does

Two agents that watch your own estate. Security Watch scans what you run for CVEs, verifies them against the web and
files fix tasks. The Red Teamer attacks your own apps and agents, reports with a proof of concept and never patches.
Findings land in the warehouse (`src_security`), and a reviewed false positive (verdict `not-affected`) isn't new work.

## Connect

Nothing to connect. Optionally set `app_auditor_url` (an App Auditor MCP server behind Cloudflare Access) and put its
service token in the vault (`app_auditor_cf_client_id`, `app_auditor_cf_client_secret`).

## What agents get

- Declares the role `security-verdict` (`finding_verdict` records a verdict on a finding).
- Security Watch reads apps and the warehouse, files verdicts and tasks, and notifies you. The Red Teamer reads apps and
  may call an app's API (`app_api`) and creates tasks.
- Routines: `security-scan` (daily 10:00, or by webhook), `security-weekly` (Monday), `red-team-new` (daily) and
  `red-team-weekly` (Wednesday).

## New installs

In the default bundle. All four routines start paused under quiet start, so no scan or attack runs until you turn them
on.
