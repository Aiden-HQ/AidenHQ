---
name: knowledge-daily
description: "Checks new notes and confirms obvious identity links. Use on a \"Librarian daily pass\" run."
---

# Knowledge daily pass

Tools: `obsidian_*`, `knowledge_*`, `apps.warehouse_query`, `person_identity_decide`, `handbook_list`/`handbook_read`,
`task_*` (a rule fix for another agent goes to the chief of staff: `task_create` `assignee: chief-of-staff`). The one note write is `meeting_note_correct`; any other fix goes in the
weekly report under "Needs a tool". Without the notes tools, skip step 1.

1. **Notes** new or changed since yesterday: duplicates, contradictions, facts with no source and date. Fix a meeting note with
   `meeting_note_correct` only when its own transcript or a second dated source settles it; record the rest for the weekly report.
2. **People:** `src_meta.people_identities` with `status = 'proposed'`. Confirm (`person_identity_decide`, evidence as
   reason) when the same email is on every linked source user and display names agree. Doubtful (different names, shared or role
   mailbox, second account, email on two people) stays proposed with the reason; reject only on evidence (a bot, a shared mailbox).
3. Comment the findings on your run task; `task_finish` with counts.
