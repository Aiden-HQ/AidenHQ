---
name: fleet-digest
description: The evening fleet digest - work the day's deep-look lines, check that product-bug fixes are live, and send the owner one message on what tripped, what was done and what is still open.
---

# Fleet digest

1. Work every `deep-look` line in your log from today: read again, decide the cause, act as the `fleet-check` skill says,
   and log the outcome.
2. **Product bugs live:** `github_product_issue_status` with the fingerprints in your log's `product-bug` lines. An issue
   closed as completed with `fixed_in` (the commit that closed it) is fixed in the product; the release train carries it
   live in its next pin bump (`task_search` on the full sha finds the "Pin bump: …" task). Once `fleet_generation_status`
   shows a `good` generation whose pin carries the commit, check each symptom on the case its issue names, then
   `task_create` with `assignee: maintainer`, marker `product-bug:<slug>:live`, `dedupe_closed: true`: the fingerprint and
   `verified live at <commit>: <what you checked>` or `still happens at <commit>: <evidence>` (product evidence only).
3. Read today's log lines and `fleet_status`. Send one `notify` (`kind: digest`): what tripped today, what you did
   about each, what is still open, rules you filed (task ids), the product-bug issues still open (link and one line each)
   and the fixes waiting on a pin bump, and anything waiting on the owner other than a card. Short; group alike items. A
   quiet day is one line ("Fleet quiet: nothing tripped").
4. Log one line `digest sent`, then `task_finish`.
