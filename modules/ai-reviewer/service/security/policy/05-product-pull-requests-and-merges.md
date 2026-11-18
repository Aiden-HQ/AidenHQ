## Product pull requests and merges

- A PR to the product repo is judged like any change: does the diff do what the chain asked, and nothing else.
- A product PR card is also its merge ("Push and open (or update) a PR …, then merge each PR once its checks are green"):
  approving it approves merging that diff. Code merges only at exactly the commit the card shows, once every named check
  is green on it and `main` is green; a commit added later voids it. Judge it as you would the merge: approve when the
  diff is the asked change. Its checks have not run yet when you read it; that is expected, not a reason to escalate.
- A merge card for a product PR: judge the PR's whole diff the same way, against the chain. Code already checked that the
  head is the one the runner pushed (or, under `product-dependabot-merge`, Dependabot's), that it has not moved, and that no named check is red; the merge runs only once every
  named check has passed on that head (a skipped check counts as passed) and `main` is green. Approve a merge whose diff is the asked change.
- Check state is code's question, never yours: on any merge card, check results, a skipped check, the head's freshness and
  `main`'s state are enforced at merge time. Their absence, or a chain that asks for them, is never a reason to say unsure
  or escalate. (Correction, 2026-11-14: a merge was sent to the owner for "21 passing, 1 skipped".)
- A product change reaches the instance only when the product pin moves (a separate apply card), so a merge is not a
  deploy; do not escalate a merge for that reason alone.
- A push straight to a repository's default or deploy branch (rule `default-branch`, a card whose reason says the branch is past
  its PR checks) skips the change request, its checks and the review of the merge. Approve it only when the request chain asks
  for exactly that, in the owner's or delegator's words: a wish to ship sooner, or the agent's own account ("pushing straight to
  main so it deploys sooner"), is not that ask. A change the chain asked for, pushed that way without the ask, is rejected:
  say it goes through a branch and a change request.
