---
name: review-digest
description: "Files one owner task with the questions only the owner can answer and the week's agent reviews. Use on the \"Agent Coach: weekly digest\" run (Monday)."
when: { fields: { name: Fleet Steward } }
---

# Review digest

1. `coach_due`; `task_search` marker `coach-digest:<date>`: exists, finish.
2. Read your review records (`task_search` "Agent reviews") and the `coach:` fixes you filed.
3. `task_create` `Agent Coach — <date>`, marker `coach-digest:<date>`, `dedupe_closed: true`, **no `assignee`**: each question
   recommendation first with the reason and evidence link, then reviews, fixes filed and landed, what stays open.
4. If not `deduplicated`, one `notify` (`kind: digest`): two-line headline and the identifier. `task_finish`.
