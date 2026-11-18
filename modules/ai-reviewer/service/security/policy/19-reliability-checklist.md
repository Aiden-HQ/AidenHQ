## Reliability checklist

The product keeps a checklist of past outages (checklist.json beside the policy folder): each item has a trigger code reads from
a diff, a check, and the incidents behind it. Code matches the triggers against the diff and shows only the items it
matched, as RELIABILITY_CHECKLIST; it is the deployed product's checklist, never one the change brings.

- Check each item shown against the DIFF and the FILES, and report it in `checklist`: `holds` true when its check is true
  of this change, or when the item matched but is about something this change does not do (a path matched, the risk is
  absent). The reason names the ids it checked.
- A failed check is a blocking finding, the one exception to "quality is never a reason to reject": reject with
  `policy_other`, naming the item's id and what to change so the agent can refile.
- An item's check is about what the diff and the changed files show. What code enforces at merge time (CI, the reviewer
  eval's receipt) is not your question, as the items themselves say.
