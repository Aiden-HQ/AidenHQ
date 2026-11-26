---
name: ideas
description: "Offers the owner one next step at a time as an `idea` task with one doing-words-or-Not-now question: a teammate to set up, a paused routine to turn on, a connection they skipped. Use on the welcome task (a new owner finished setup), at the end of each daily brief, and on an idea task assigned to you."
---

# Ideas

One idea at a time, so the owner always knows the one next step that would help most. Home shows the open idea with its two answers. An idea takes two runs, because a question waits only on the task the asking run is working on.

1. **File it** (from the welcome task, or the end of a daily brief). `task_list` `label: "idea"`: one is open, so do nothing more. Otherwise pick the best idea from the sources below, skipping any your memory says the owner answered `Not now` in the last 30 days. `task_create`: label `idea`, assignee yourself, `title` the suggestion in a few plain words ("Set up Rhea, your inbox teammate"), `description` two or three lines of context (what it does for them, what it needs connected). Then finish the triggering task as it says.
2. **Ask it** (the assignment wakes you on the idea task). `notify` `kind: "decision"`, `task` the idea, `text` one line on why, and one question with two options: first the exact words that do it, then `Not now`. Then wait.
3. **The answer.**
   - **Not now:** `task_cancel` the idea, and note in your memory the idea and today's date, so it isn't offered again for 30 days.
   - **A paused routine:** the first option names it in at least 12 characters ("Resume the daily brief"), so the answer is the owner's own words naming it: `fleet_control` `resume_routine`, `task` the idea, `target` the part of the routine's title the option names ("daily brief"), and the answer as `quote`. Finish the idea with one line.
   - **A teammate:** the first option is "Set up <Name>". Reply with the link that sets it up, `#/team/hire?setup=<id>:<key>` (the catalog row's `id` and `key`, copied exactly), and finish. You never install anything yourself: setting up is the owner's own click.
   - **A skipped connection:** the first option is "Connect <Title>"; reply with its setup link (`#/setup/<module>`) and finish.

**Sources of ideas**, best first:
- The teammates the owner chose in onboarding: the welcome task lists them (set up next, best first, then Later). Offer the first Set up next one; never a Later one before the others.
- Teammates not yet on the team (`fleet_catalog` section `teammates`, `on_team: false`), the one that fits what the owner connected and talks about first. Never guess a teammate: only one the catalog lists.
- Paused routines worth turning on (`fleet_status`): the morning brief first; then a weekly look at how the agents work, an evening fleet digest, agents checking in every few hours.
- Connections they skipped (a setup flow still open: `fleet_status`), when a teammate on the team needs it.
