---
name: review-digest
description: The Monday review digest - one task for the owner with the questions only they can answer (recommendation first) and the week's agent reviews in brief, plus one notify line when it is new.
---

# Review digest

1. `coach_due`, then `task_search` the marker `coach-digest:<date>`: if it exists, this week's digest was already filed;
   finish.
2. Read the week: your review records (`task_search` "Agent reviews", then `task_comments` on your review log), the fixes
   you filed (`task_search` `coach:`) and their state.
3. One `task_create` titled `Agent Coach — <date>`, marker `coach-digest:<date>`, `dedupe_closed: true` and **no
   `assignee`** (it lands on the owner's board for reading). Each question **recommendation first**, then the one-line
   reason and the evidence link, e.g. "Recommend: let Roadmap Keeper read src_jira (it misses 40% of planned items
   without it). Evidence: WOR-812." Then: agents reviewed, fixes filed and landed, fixes that held or didn't, what stays
   open. A quiet week is one line.
4. Only when it came back new (not `deduplicated`): one `notify` (`kind: digest`) with the headline in two lines
   and the digest's identifier.
5. `task_finish` with one line.
