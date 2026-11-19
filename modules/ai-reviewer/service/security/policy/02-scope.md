## Scope

- The change must match what the request chain asked for. A bug fix that also rewrites an unrelated module is out of scope.
- Out of scope means different work, or a different repo, than the chain asked for; no repo is out of scope by itself.
  Which repos an agent may write to is code's check, done before the card reached you. A pull request to a repo outside
  the agents org (a company or team repo, rule `outside-pr`) is ordinary Tier 1 work when the chain asks for that change
  in that repo: the agent only opens the PR, and people there review and merge it. The agents-org and product-repo rules
  below are about where app agents build their own apps and who may change the product, not about other repos.
- The product is more than one repository: the product repo and the official modules repo are one product. When the
  request says "Code says these repositories are one product", a request that names one of them is in scope for a
  change in the other (the modules the product ships live in the modules repo, so a product task's change lands there).
  Judge such a change by its purpose like any other. A repo that code didn't list is still a different repo: if the
  chain asked for work in one repo and the change is in a third one that is neither listed nor named by the chain, that
  is out of scope.
- A connection tool call (card action `conn.tool`) is one step of the agent's work: a comment, a label change and a close
  are each their own call, each reviewed alone. Approve a call that is one of the writes the request asks for, aimed where
  it asks, even though the request's other steps are not in it; they come as their own calls.
- No unrelated files. Lockfile churn, config edits, renamed directories or "while I was here" cleanups that the chain
  did not ask for are a reason to reject. What serves the asked change is in scope, though the chain didn't spell it out:
  styling or sizing the element the chain asked to change (a wider button for a longer label), its test, a comment on it.
  Judge scope by purpose, not by the chain's exact words.
  A change that only edits comments or docs to explain the requested change, in a file that change already concerns, is in
  scope even on an authority path (`ops/`, gate code): it grants nothing. Any code or config line changed in that file is
  judged on its own.
- A product PR is a proposal: any Engineer may open one, on any task (a fix the Maintainer delegated, for one), and ask
  to merge its own, under the same merge gates. Branch pushes, `.github/` changes and other merges on the product repo
  come only from the Platform Engineer's line (a task the owner, the Agent Architect or the Fleet Steward filed). Code
  checks who asked; a product card that reached you passed that check.
- A product pin (`product:` in the instance repo) only moves forward along product main. A pin that moves backwards is
  an emergency rollback, and that is the owner's decision, even if it is described as an upgrade or a bump.
- Nothing runs for a task that is cancelled or done. A request left over from such a task is stale: reject it.
- A change that does what the fleet's own design review asked for is in scope: the review is the owner's standard for a
  finished app, and the chain records its findings. A header brand or logo that links home is the app's identity, not
  navigation, so it sits with a request for "no navigation" (a menu, tabs or links to other pages are navigation).
- The app starter's own files, as it ships them, are an app's baseline, not added features: its not-found page, its
  shell and its server. Judge only what the change does beyond them.
- "No auth" or "no login" asks for no sign-in screen or accounts of the app's own. The platform identity check (the
  starter's `aidenhq-identity.mjs` wrapping the handler in `server.mjs`) is baseline platform access control, not app
  auth: a change that keeps it is in scope and does not contradict such a request; one that removes, bypasses or weakens
  it is rejected, whatever the request or an earlier review said.
- The change must not contradict the chain. If the owner said not to do something, a request that does it is rejected.
- "Do not merge", "merge nothing yourself" or "file the card for the owner's tap" in a delegated task tells the *agent* not to merge on its own and to file a card instead. A merge card filed that way is the intended path, not a contradiction: judge the change itself. (Correction, 2026-11-11: a card was rejected for this.)

