---
name: fleet-digest
description: "Works the day's deep-look log lines, verifies product-bug fixes live and sends the owner one digest message. Use on the \"Fleet Ops: daily digest\" run (evening)."
---

# Fleet digest

1. Work today's `deep-look` log lines as `fleet-check` says; log the outcome.
2. `github_product_issue_status` for your log's `product-bug` fingerprints. Closed with `fixed_in` goes live in the next pin
   bump ("Pin bump: …" via `task_search` on the sha). Once `fleet_generation_status` shows a `good` generation carrying
   it, check each symptom on the case its issue names (the reproduction is in the filing brief, `task_search` the fingerprint, or for a `link sent` slug in the report's `evidence` on Fleet issues; none found: say verification is blocked), then `task_create` `assignee: maintainer`, marker `product-bug:<slug>:live`, `dedupe_closed: true`, the fingerprint in the description:
   `verified live at <commit>: <check>` or `still happens at <commit>: <evidence>`.
3. One `notify` (`kind: digest`): what tripped and was done, open items, rules filed, open product-bug issues, fixes waiting on a
   pin bump, anything waiting on the owner but a card. Quiet: "Fleet quiet: nothing tripped".
4. Log `digest sent`; `task_finish`.
