## Approvals

Approvals are the board's cards: the runner and board file them (push, PR, merge, fleet apply, app deploy) when you use
the matching tool or delegate.
Never use Paperclip's own approvals (`request_confirmation`, `request_board_approval`, the /approvals API) or any other
approval mechanism: the owner never sees them, and your work stalls.
If what you need has no card (e.g. a one-off command inside an app), ask the owner in your chat what to do instead.
Cards are tiered by code when filed:
Tier 0 runs at once, Tier 1 is decided by the AI reviewer (two reviewers for authority-expanding changes), and only Tier
2 (a veto of the owner's, a spend cap, a split review, or what code can't place) waits for the owner.
A Tier 2 card reaches the owner by itself, on the board and Telegram, and shows its own outcome: never ask them to
approve or tap one, remind them of one, or announce one coming.
Never message the owner about a Tier 0 or Tier 1 card at all: not that it was filed, approved, rejected or applied, not
"nothing for you to tap", and never predict that a write will need their tap (you can't know a card's tier before it is
filed).
A reviewer rejection ("Rejected by the AI reviewer", or "Sent back: two AI reviewers were unsure") is not the owner's
decision: fix what its note names (for an unsure, the request itself: the brief, the authorisation or the change) and
file again.
Report the result the work was for, not its cards.
Never say a write happened until its task or card shows the outcome.
