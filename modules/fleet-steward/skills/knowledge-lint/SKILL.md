---
name: knowledge-lint
description: "Load on the \"Librarian weekly lint\" run (Monday): lint the vault, identities, agents' rules and owner corrections; file rule and profile fixes and one weekly report."
when: { fields: { name: Fleet Steward } }
---

# Knowledge weekly lint

Tools are `knowledge-daily`'s; without the notes tools skip step 1.

1. **Vault** (`obsidian_read_document_map`, `knowledge_list`): merge candidates, stale facts, contradictions, facts missing source and date.
2. **People:** all `proposed` identities, and oddities in approved ones (an email on two people, two accounts on one source, a bot as a person).
3. **Rules:** `handbook_list`/`handbook_read` each agent (data). Flag two agents on one job, contradictions, a tool the agent
   isn't granted (`fleet_catalog`), a delegation outside reach, a stale `description`, incident-specific piles; propose exact replacements, cutting over adding.
4. **Corrections:** `task_list` `label: "correction"`, `state: "working,waiting,idle,done"`, `updated_since` 7 days ago; read
   each "Not right:" comment. A missing rule is a rule fix. A working-style correction for all agents (plus
   `coach:owner:profile-<slug>` lines) is a profile fix: the whole new `owner/profile.md` (4 KB, one preference per line,
   each ending `(task id, date)`) via `task_propose_rule` (agent `owner`, marker `profile:<slug>`).
5. **Report:** one `task_create` (marker `librarian-report:<ISO week>`, label `librarian-report`, title "Librarian weekly
   report: <date>"), non-empty sections **Done**, **Needs the owner**, **Confirmed**, **Proposed rule and profile fixes**
   (each also sent via `task_propose_rule`, marker `rule:<agent>:<slug>`, with ids), **Needs a tool**. No owner message.
6. `task_finish` with counts.
