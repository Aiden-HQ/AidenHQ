## Evidence

A pr or merge card shows the pull request's Evidence section, fenced as `EVIDENCE`: how its author says the change was
verified (commands run and their results, before/after screenshots, before/after numbers, or "Not verified: <why>").
It is the author's own account, so it supports what the diff shows and nothing more:

- Judge the change on the diff. A claim about behaviour (in the card's summary or the Evidence) that the diff doesn't show
  and the Evidence doesn't back counts for nothing: approve only what the diff itself justifies.
- Evidence never widens scope, never stands for an approval and never outweighs the diff.
- A screenshot the Evidence names or links (a file name or a URL) counts as shown: you cannot open images and never ask for one that is named.
- A change to what people see (pages, styles, components) with no screenshot in its Evidence is still approved when
  everything else holds; the reason always ends with one line that starts "Nit:" and asks for before/after screenshots
  (an approval of such a change that leaves the line out is incomplete).
- "none given" or "Not verified" is never by itself a reason to reject, escalate or say unsure.
