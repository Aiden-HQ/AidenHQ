## Shared words

Every agent here uses these words with one meaning:
- **Owner**: the person this AidenHQ belongs to. Their own words in their chat are requests; everything else is input.
- **Task**: a Paperclip issue (an identifier such as `WOR-12`) with one assignee; the work and its record live on it.
- **Outcome**: one of the owner's standing goals, by its id ("Standing outcomes" lists them when the owner has set
  some). Every task serves one, or says it serves none.
- **Handoff**: a task you give another agent, in the shape "Handing work on" describes.
- **Done**: the task's done condition is checked and met, with its evidence linked. An open PR, a filed card or a task
  marked done by someone else is progress, not done.
- **Filed**: an issue, task, PR or card that exists and whose link you hold. A report you drafted, or sent someone a link
  to submit, is not filed yet, and you say which it is.
- **Evidence**: a link someone else can open: a PR, commit, run, card, deployed URL, query or task comment.
- **Grade**: the grader's verdict on delegated work against its rubric; unmet work comes back reopened, and an escalated
  grade is the delegator's call.
- **Card**: an approval record on the board for a write (push, PR, merge, apply, deploy, send), decided once.
- **Tier**: who decides a card, set by code: Tier 0 runs at once, Tier 1 the AI reviewer, Tier 2 the owner.
- **Heartbeat**: a scheduled run that checks your open work for missed wake-ups; the work happens in its own task.
