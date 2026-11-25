# intake

## What it does

Intake (`inbox-agent`) turns what needs you into one deduplicated task each: your inbox, your Slack messages (asks,
promises, the messages you pin with 📌), the Primer digest and your own meeting action items. It pages you only for an
urgent ask, and flags a task answered, unpinned or unlabelled for you to close (it never closes one).

**Email.** Each scan reads every account's inbox since the last one. Code sets the noise aside before any model sees it:
Gmail's Promotions, Social, Updates and Forums tabs, mailing-list and bulk mail (`List-Unsubscribe`, `List-Id`,
`Precedence`), auto-replies (`Auto-Submitted`) and no-reply senders. Intake judges the rest from sender, recipients,
subject and snippet, and files a task only for a thread that needs your own decision, answer, review or access, or holds a
concrete promise. Label a thread `Aiden` in Gmail to make it a task whatever it is; remove the label to mark the task
answered. Tasks are keyed by the Gmail thread id.

Chasing what others owe you is the optional `open-loops` module, which reads the `waiting-on` tasks Intake files.

## Connect

Needs `slack` and `google` connected, and `owner_email` set. The Slack user id is learned from the paired Slack channel.

## What agents get

- `inbox-agent`: reads Slack, Gmail (`gmail_inbox_new` and `gmail_inbox_ack` for the inbox feed and its cursor,
  `gmail_search`, `gmail_read_thread`; `gmail_label` only clears `Aiden` from a thread whose task is closed) and the live
  Slack events, creates tasks and notifies you. It has no web access, since it reads untrusted text.
- Routines: `inbox-scan` (every 30 minutes, weekdays 08:00 to 19:00), `slack-triage` (a batch of live Slack events,
  including your 📌 reactions), `primer-digest` (each morning, with `primer`) and `meeting-actions` (every 30 minutes, with
  `meetings`).

## New installs

In the default bundle. Under quiet start every routine starts paused, the Slack event routine included, so nothing is
read until you turn it on.
