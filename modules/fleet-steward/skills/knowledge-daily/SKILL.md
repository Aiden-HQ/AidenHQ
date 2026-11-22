---
name: knowledge-daily
description: The daily knowledge pass - check new notes for duplicates, contradictions and missing provenance, confirm obvious identity links, and record the findings.
---

# Knowledge daily pass

## Tools

- **Notes vault:** `obsidian_search`, `obsidian_read`, `obsidian_read_document_map` (the owner's notes), `knowledge_list`,
  `knowledge_index`, `knowledge_search`, `knowledge_read`, and one write: `meeting_note_correct` (fix a meeting note).
- **Warehouse:** `warehouse_query` (read-only SQL): `src_meta.people_identities` and the `src_<source>.users` views.
  `person_identity_decide(source, source_user_id, decision: confirm|reject, reason)` decides one proposed link.
- **Rules:** `handbook_list`, `handbook_read(agent_key)` (read-only); a rule fix for another agent goes to Aiden as a
  `task_create` (`assignee: chief-of-staff`), who hands it to that agent.

No tool edits a knowledge page, an Obsidian note (other than `meeting_note_correct` on meeting notes) or a handbook.
Never look for a way around that: a fix that needs one goes in the weekly report under "Needs a tool".

## Steps

Without the notes tools (no meetings module on), skip step 1.

1. **Notes.** Notes and meetings new or changed since yesterday. Check each for a duplicate of an existing note, a fact
   that contradicts an older one, and a fact with no source and date.
   - A wrong fact in a meeting note: fix it with `meeting_note_correct`, only when the meeting's own transcript or a
     second dated source settles it.
   - Everything else is recorded for the weekly report: page, what is wrong, the evidence, the exact fix.
2. **People.** `warehouse_query` on `src_meta.people_identities` where `status = 'proposed'`. A proposal is obvious when
   the same email is on every linked source user and the display names agree: confirm it (`person_identity_decide`,
   decision `confirm`, the evidence as the reason). Doubtful ones (different names, a shared or role mailbox, a second
   account, an email linked to two people) stay proposed, with the reason in the findings; reject one only when the
   evidence shows it is wrong (a bot, a shared mailbox). Names alone never settle it.
3. One `task_comment` on your run task with the findings list, then `task_finish` with a count summary, e.g. "12 notes
   checked, 1 fixed, 4 findings; 3 proposals obvious, 1 doubtful".
