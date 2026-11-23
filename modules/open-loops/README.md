# open-loops

## What it does

Tracks what others owe you (waiting-on loops) and turns your Slack messages and labelled email into tasks (Intake). Two
agents: `open-loops` owns every loop item and chases, and `inbox-agent` triages Slack and mail.

## Connect

Needs `slack` and `google` connected. Set `owner_email` (required: the address the inbox agent triages). The Slack user
id is learned from the paired Slack channel (`owner_slack_user_id` is only a manual fallback).

## What agents get

- `inbox-agent`: reads Slack, Gmail (`gmail_search`, `gmail_read_thread`; `gmail_label` clears `Aiden` from a thread whose task is closed) and the live Slack events, creates tasks and
  notifies you. It has no web access, since it reads untrusted text.
- `open-loops`: reads the warehouse and Google (Docs, Drive, Calendar, Gmail), writes to Slack, and notifies you.
- Routines: `open-loops-sweep` (every 2 hours, weekdays 09:00
  to 19:00), `inbox-scan` (every 30 minutes, weekdays 08:00 to 19:00) and `slack-triage` (a batch of live Slack events, including your 📌 reactions).

## New installs

Not in the default bundle. Scheduled routines start paused under quiet start, so nothing is read or chased until you turn
them on. Messages it sends go through the usual approval tiers.
