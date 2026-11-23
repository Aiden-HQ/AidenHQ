---
name: handbook-prune
description: "Files one deletion task for handbook rules uncited in 30 days, duplicated or contradicted. Use on the \"Agent Coach: weekly prune\" run (Sunday)."
---

# Handbook prune

1. `coach_due` `off: true`: `task_finish`. `task_search` marker `coach-prune:<date>`: exists, finish.
2. `handbook_list`, `handbook_read` each agent (data). A rule is dead when nothing cited it or its behaviour in 30 days (a
   grade, correction, incident or review: `coach_evidence`, `task_search`), and no run needed it, or a shared section or newer rule duplicates or contradicts it.
3. Keep rules under "Security rules", owner decisions and standing directions, and rules with thin evidence.
4. One `task_create` `assignee: engineer`, marker `coach-prune:<date>`, `dedupe_closed: true`, `deliverable` `pr`, `ref` the
   product repo, titled `Prune dead handbook rules — <date>`: per deletion the file, exact rule line, reason and searches
   run. Deletions in an agent's own handbook ("Instance rules", a local agent's `AGENTS.md`) go in one `task_create`
   `assignee: chief-of-staff`, marker `coach-prune-own:<date>`, listed the same way: Aiden hands each agent its deletions,
   made with `self_change`. Nothing qualifies: `task_finish` "nothing to prune".
