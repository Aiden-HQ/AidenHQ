# Standard rubric: a pull request

The grader (services/runner/src/grade.ts) uses these lines when a delegation names a `pr` deliverable without its own
rubric. The delegating agent adapts them to the request (DELEGATING_SECTION in scripts/paperclip-setup.mjs).

- Merged into the default branch (in the AidenHQ product repo the owner merges: there an open PR is the deliverable).
- Every named check is green on the PR's head (the grader reads the PR's head, never the merge commit).
- The diff makes the change the task asked for, and nothing unrelated.
- A test covers the changed behaviour, or the task said none was needed.
- Any migration in the diff keeps every table and column the previous commit uses, or removes only what the task named for removal; a diff without migrations meets this.
- The description's Evidence section shows the proof the task's done condition needs: before/after screenshots when the brief asked for how something looks, before/after numbers when it claims a performance gain. Missing proof beyond that ("Evidence: none given", "Not verified: …") is a gap to note in the grade, not a failed criterion.
