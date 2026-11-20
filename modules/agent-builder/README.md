# agent-builder

## What it does

The Agent Architect designs, builds and improves agents for you, and reviews the agents you have in trial. Describe an
agent and it designs one from a template (`app-owner`, `digest-writer`, `pr-review-chaser`, `triage-bot`; see
`templates/README.md`). The change reaches the fleet only through the Engineer, behind an approval.

## Connect

Nothing to connect. It tells you through the owner channel, so it needs a channel (Telegram or Slack) to reach you.

## What agents get

- It declares two roles: `architect` (its Engineer tasks may use the trial exception) and `repo-checkout` (a commit of an
  agents-org repo placed in its computer).
- The Architect reads: apps (`app_list`, `app_status`, `app_logs`, `app_view`, `web_view`, `warehouse_query`) and, when
  connected, a narrow read set of Glean, Jira and Slack. It writes only `notify`. It changes nothing itself.

## New installs

In the default bundle. The Architect's heartbeat is off and its `trial-review` routine (weekdays, 17:00 in your timezone)
starts paused while quiet start is on. It does nothing until you ask Aiden for an agent.
