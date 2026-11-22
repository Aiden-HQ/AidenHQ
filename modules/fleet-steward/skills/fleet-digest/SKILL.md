---
name: fleet-digest
description: Load on the "Fleet Ops: daily digest" run (evening): work the day's deep-look lines, check product-bug fixes are live, and send the owner one message.
when: { fields: { name: Fleet Steward } }
---

# Fleet digest

1. Work every `deep-look` line in your log from today: re-read, decide the cause, act as `fleet-check` says, log the outcome.
2. **Product bugs live:** `github_product_issue_status` with the fingerprints in your log's `product-bug` lines. An issue
   closed as completed with `fixed_in` is fixed in the product and goes live in the next pin bump (`task_search` the full
   sha finds the "Pin bump: …" task). Once `fleet_generation_status` shows a `good` generation whose pin carries the
   commit, check each symptom on the case its issue names, then `task_create` `assignee: maintainer`, marker
   `product-bug:<slug>:live`, `dedupe_closed: true`: the fingerprint and `verified live at <commit>: <what you checked>` or
   `still happens at <commit>: <evidence>` (product evidence only).
3. One `notify` (`kind: digest`) from today's log and `fleet_status`: what tripped and what you did, what is still open,
   rules filed (task ids), open product-bug issues (link, one line) and fixes waiting on a pin bump, anything waiting on the
   owner other than a card. A quiet day is "Fleet quiet: nothing tripped".
4. Log `digest sent`, then `task_finish`.
