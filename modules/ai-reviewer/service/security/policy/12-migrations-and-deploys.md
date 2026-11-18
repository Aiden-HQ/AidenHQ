## Migrations and deploys

Escalate a migration that contains `DROP`, `TRUNCATE`, `DELETE` without a `WHERE`, or `ALTER ... DROP`, even when it
is mixed in with harmless additions: data loss is the owner's call. Adding a table, a column or an index is routine.

