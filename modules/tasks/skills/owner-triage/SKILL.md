---
name: owner-triage
description: "First-pass triage of the owner's tasks, by the agent that files them: check for the same ask before filing, place each new task in Today, Tomorrow or This week with a one-line reason, and close it on the source's evidence (with a link) once it is answered, delivered or merged. Also the one-off re-triage pass over the owner's open backlog. Use whenever you file, update or close a task for the owner."
---

# Owner triage

The owner sees only what needs them, already sorted. You filed the task, you read its source, so you sort it and you close
it. The owner can move or reopen anything; their move always wins (a placement is accepted only while the task is in New).

## Before filing: the same ask

Look for an open owner task with the same person and the same ask before you `task_create`: `task_search` the person's
name and the ask's key words (a Slack thread, a meeting action and a pin about one commitment are one task). A match:
file with `related_markers: ["<its marker>"]`, which returns that task (`deduplicated: true`) and files nothing new; when it
is yours, one `task_comment` with the new source link. The new source is recorded on a survivor you filed, so the thread's
answer still finds it; a survivor another agent filed is its filer's to record (route the source to it below). A match the
owner made is theirs: file nothing and leave it to them. A search that failed or returned an error is not a "no match":
file as usual.

## Placing a new task

Right after `task_create` (not on `deduplicated: true`), `task_schedule` with `issue`, `column` and a one-line `reason`
naming the fact that decided it (the task shows it):

- **Today** (`today`): a deadline today or tomorrow, someone blocked on the owner now, or a meeting today it belongs to.
- **Tomorrow** (`tomorrow`): a direct ask waiting on the owner's reply with no date.
- **This week** (`later`): the owner's own promise or meeting action with no date this week, a deadline later this week,
  a pinned read, and a `waiting-on` task ("Owed by <person>; the chaser follows it").
- A stated date after this week: This week, with the date in the reason.
- Unsure: leave it in New. New is for what you can't place.

## Closing on evidence

When the source shows the ask finished, close the task yourself, once: `task_finish` with `issue` and a comment that
names what happened and cites the link. Evidence is the source itself:

- the owner's own reply in the thread that answers the ask (its permalink);
- the promised thing delivered (the message, file, issue or doc link);
- the PR it waits on merged (the PR link); a newer task that covers it (its identifier);
- the owner unpinning or unlabelling after answering.

A message that only says "on it", a removed pin with no answer, or a read that failed is not evidence: leave the task open.
A duplicate you filed is `task_cancel` with "Duplicate of <identifier>". The close is the record: one call, no separate
"answered" comment. The owner sees each close on Home with one-tap Reopen; a task they reopened closes again only on new evidence after the reopen.

A task another agent filed is closed by that agent (or a fleet settler): when your source shows it finished, do not force it.
`task_create` one task for the agent in its `filed_by` (`assignee` that key, marker
`owner-triage:evidence:<identifier>:<date>`), naming the task, the evidence link and the source to record with `task_update`
(it is the filer), so it records the source and closes it; a fleet settler closes it directly.

## Reports

A report you file for the owner to read (a weekly review, a digest, a summary) carries the label `report`, which keeps it
off their task columns; its `notify` is how they find it. After filing the new one, close your previous open report of the
same kind with `task_finish` (`issue`) "Superseded by <new identifier>". A question in it that only the owner can answer
also goes out through your asking section, never only in the report.

## The re-triage pass (Fleet Steward)

On the "Owner tasks: re-triage" run, over every open task the owner holds that an agent filed (`task_list`: each row's
`filed_by` names its filer, `user` for the owner's own, so skip those; then `task_comments` on each): close the ones whose
comments or source already cite delivery, an answer or a merge (the link
is the evidence); cancel the later of two tasks for the same person and ask ("Duplicate of <identifier>"); place the rest
still in New by the rules above, with `later`/`backlog` for owner commitments with no near date ("Later: no date, nothing
waiting"). List owner tasks whose next step an agent can prepare (research, a data pull, a draft) in one `task_create` for
the chief of staff (`assignee: chief-of-staff`, marker `owner-triage:prep:<date>`). Then one `notify` (`kind: digest`,
`dedupe_key: owner-triage:<date>`) with the counts: closed, merged, placed per column, moved to Later, handed to agents.
