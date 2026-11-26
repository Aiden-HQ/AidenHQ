# agent-builder

## What it does

The Agent Architect designs, builds and improves agents for you, and onboards each new one on its first work. Describe who
you need (the hiring page's "Describe who you need", or a chat) and it first looks in your team and every marketplace you
added (skill `hiring`): it answers with Extend one of your teammates, Install a listed one (you install it from the hiring
page), or Build new. Building new, it designs a named teammate with a face, as a local module of your instance repo (`modules/<name>/`), from a template (`app-owner`, `digest-writer`, `pr-review-chaser`, `triage-bot`; see
`templates/README.md`). The change reaches the fleet only through the Engineer, behind an approval.

## Connect

Nothing to connect. It tells you through the owner channel, so it needs a channel (Telegram or Slack) to reach you.

## What agents get

- It declares two roles: `architect` (the tasks it files may run on the product line) and `repo-checkout` (a commit of an
  agents-org repo placed in its computer).
- The Architect reads: apps (`app_list`, `app_status`, `app_logs`, `app_view`, `web_view`, `warehouse_query`) and, when
  connected, a narrow read set of Glean, Jira, Slack and Primer. It reads `fleet_catalog` (teammates and modules, third-party text fenced) and writes `notify` (its questions are forms) and, with Primer
  connected, its design docs and its replies to their review there (skill `design-doc`, and Primer's `primer-docs`). It
  changes nothing in the fleet itself.

## New installs

In the default bundle. The Architect's heartbeat is off while quiet start is on. It does nothing until you ask Aiden for an
agent.
