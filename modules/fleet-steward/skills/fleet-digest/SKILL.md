---
name: fleet-digest
description: "Works the day's deep-look log lines, gives every owner interruption of the day a disposition and a repair, verifies product-bug fixes live and sends the owner one digest message. Use on the \"Fleet Ops: daily digest\" run (evening)."
---

# Fleet digest

1. Work today's `deep-look` log lines as `fleet-check` says; log the outcome.
2. `github_product_issue_status` for your log's `product-bug` fingerprints. Closed with `fixed_in` goes live in the next pin
   bump ("Pin bump: …" via `task_search` on the sha). Once `fleet_generation_status` shows a `good` generation carrying
   it, check each symptom on the case its issue names (the reproduction is in the filing brief, `task_search` the fingerprint, or for a `link sent` slug in the report's `evidence` on Fleet issues; none found: say verification is blocked), then `task_create` `assignee: maintainer`, marker `product-bug:<slug>:live`, `dedupe_closed: true`, the fingerprint in the description:
   `verified live at <commit>: <check>` or `still happens at <commit>: <evidence>`.
3. **The day's interruptions.** Everything that reached the owner since the last digest: `notify_recent` with `state: delivered`
   (every message, from any agent; page back with `before` set to the last row's `cursor`
   until you pass the last digest) and `fleet_owner_cards` (the cards that went to them; page with `next` back to the last digest). Give each one
   a disposition in your log, `interrupt · <source> · <what> · needed|needless · <repair>`: needed when it was theirs to act on
   (a card only they decide, a credential, a security trade-off) and still true when it was sent. A needless one gets one
   repair at the agent that produced it (the rule fix, or a product bug for code that sends it): why didn't an agent settle it,
   and why didn't the agent that owns the problem fix it itself. A wait on a third party the owner was reminded of becomes a
   chaser task for the responsible agent.
4. **Spend, from the gateway's counters** (never `fleet_status.summary.spend` or `fleet_costs`: both read the board's usage
   rollup, which understates by about a quarter). On the `prometheus` datasource run `query_prometheus`,
   `queryType: range`, `stepSeconds: 86400`, from `<today−6>T00:00:00Z` to `<today>T00:00:00Z`, for
   `sum by (kind) (aidenhq_gateway_spend_usd_today)`; each point is the previous UTC day's final value. Per day, `check`
   plus `ci-code-review` is CI/check spend, `agent` is agent work, the rest is fleet overhead. Cross-check yesterday with
   `aidenhq_gateway_install_spend_usd{period="day"}` at the same boundary (the counter the caps enforce; where it is higher,
   the excess is in-flight reservations, not billed spend). One line: "Spend: $X yesterday (check $A / agent $B / other
   $C), $Y/day over 7 days." Without a `prometheus` grant (no grafana or monitoring module) say spend is unavailable and
   why, never zero and never the rollup.
5. One `notify` (`kind: digest`): what tripped and was done, open items, rules filed, open product-bug issues, fixes waiting on a
   pin bump, anything waiting on the owner but a card, the spend line, and the day's interruptions (counted, needless ones with their repair).
   Quiet: "Fleet quiet: nothing tripped".
   Each item listed as waiting on the owner is checked first: its task or detector key against live state (a generation, an
   ingest run, the host) and against "Owner decisions". One that is already done or that a decision settles is left out and
   settled the way `fleet-check` settles verified work: the evidence goes on its task (finished where you may close it), an
   agent waiting on the owner for that answer is left untouched and handed to the chief of staff (the evidence and its task
   id in the handoff) to answer from the decision or the live evidence, and a skipped source's open key goes through `fleet-check`'s source triage.
6. Log `digest sent`; `task_finish`.
