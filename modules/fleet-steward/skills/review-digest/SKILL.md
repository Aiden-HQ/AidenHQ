---
name: review-digest
description: Load on the "Agent Coach: weekly digest" run (Monday): file one owner-facing task with the questions only they can answer and the week's agent reviews.
when: { fields: { name: Fleet Steward } }
---

# Review digest

1. `coach_due`, then `task_search` marker `coach-digest:<date>`: if it exists, finish.
2. Read the week: your review records (`task_search` "Agent reviews", `task_comments` on that log), the `coach:` fixes you
   filed (`task_search`) and their state.
3. One `task_create` titled `Agent Coach — <date>`, marker `coach-digest:<date>`, `dedupe_closed: true`, **no `assignee`**
   (it lands on the owner's board). Each question recommendation first, then the one-line reason and evidence link, e.g.
   "Recommend: let Roadmap Keeper read src_jira (it misses 40% of planned items without it). Evidence: WOR-812." Then:
   agents reviewed, fixes filed and landed, which held, what stays open. A quiet week is one line.
4. Only when new (not `deduplicated`): one `notify` (`kind: digest`) with the headline in two lines and the digest's identifier.
5. `task_finish` with one line.
