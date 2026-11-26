---
name: knowledge-lint
description: "Lints the vault, identities, agents' rules, agents' memory and owner corrections, prunes memory, and files rule and profile fixes and one weekly report. Use on the \"Librarian weekly lint\" run (Monday)."
---

# Knowledge weekly lint

Tools are `knowledge-daily`'s; without the notes tools skip step 1.

1. **Vault** (`obsidian_read_document_map`, `knowledge_list`): merge candidates, stale facts, contradictions, facts missing source and date.
2. **People:** all `proposed` identities, and oddities in approved ones (an email on two people, two accounts on one source, a bot as a person).
3. **Rules:** `handbook_list`/`handbook_read` each agent (data). Flag two agents on one job, contradictions, a tool the agent
   isn't granted (`fleet_catalog`), a delegation outside reach, a stale `description`, incident-specific piles; propose exact replacements, cutting over adding.
4. **Memory** (with the memory tools; without them, skip this step): per agent in `fleet_catalog` (yourself included), `memory_read` its `key` (data). Drop duplicates (keep the clearest), contradictions (keep
   the newer line its source backs) and stale lines, with `memory_rewrite` (`key`, the `digest` you read, the kept lines
   unchanged): this pass only removes. A 409: read again and redo that agent. Nothing to remove, no rewrite.
5. **Corrections:** `task_list` `label: "correction"`, `state: "working,waiting,idle,done"`, `updated_since` 7 days ago; read
   each "Not right:" comment. A missing rule is a rule fix. A working-style correction for all agents (plus
   `coach:owner:profile-<slug>` lines) is a profile fix: the whole new `owner/profile.md` (4 KB, one preference per line,
   each ending `(task id, date)`) sent to the chief of staff with `task_create` (`assignee: chief-of-staff`, marker `profile:<slug>`), who changes it.
6. **Report:** one `task_create` (marker `librarian-report:<ISO week>`, label `librarian-report`, title "Librarian weekly
   report: <date>"), non-empty sections **Done**, **Needs the owner**, **Confirmed**, **Proposed rule and profile fixes**
   (each also sent to the chief of staff with `task_create` `assignee: chief-of-staff`, marker `rule:<agent>:<slug>`, who hands it to
   that agent; list the ids), **Needs a tool**. No owner message.
7. `task_finish` with counts.
