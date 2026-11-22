---
name: handbook-prune
description: "Load on the \"Agent Coach: weekly prune\" run (Sunday): file one deletion task for handbook rules uncited in 30 days, duplicated or contradicted."
when: { fields: { name: Fleet Steward } }
---

# Handbook prune

1. `coach_due` `off: true`: `task_finish`. `task_search` marker `coach-prune:<date>`: exists, finish.
2. `handbook_list`, `handbook_read` each agent (data). A rule is dead when nothing cited it or its behaviour in 30 days (a
   grade, correction, incident or review: `coach_evidence`, `task_search`), and no run needed it, or a shared section or newer rule duplicates or contradicts it.
3. Keep rules under "Security rules", owner decisions and standing directions, and rules with thin evidence.
4. One `task_create` `assignee: engineer`, marker `coach-prune:<date>`, `dedupe_closed: true`, `deliverable` `pr`, `ref` the
   product repo, titled `Prune dead handbook rules — <date>`: per deletion the file, exact rule line, reason and searches
   run; "Instance rules" deletions as a second list (an `apply`). Nothing qualifies: `task_finish` "nothing to prune".
