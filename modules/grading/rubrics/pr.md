# Standard rubric: a pull request

The grader (modules/grading/service/src/grader/grade.ts) uses these lines when a delegation names a `pr` deliverable without its own
rubric. The delegating agent adapts them to the request (DELEGATING_SECTION in scripts/paperclip-setup.ts).

- Merged into the default branch (in the AidenHQ product repo the owner merges: there an open PR is the deliverable).
- Every named check is green on the PR's head (the grader reads the PR's head, never the merge commit).
- The diff makes the change the task asked for, and nothing unrelated.
- A test covers the changed behaviour, or the task said none was needed, or the diff changes only prose (a handbook, skill or doc text) with no behaviour to test; a brief that limits the diff to those files asks for no test.
- Any migration in the diff keeps every table and column the previous commit uses, or removes only what the task named for removal; a diff without migrations meets this.
- The description's Evidence section before the PR merges, or the task's completion comment after the PR merges, shows the proof the task's done condition needs: before/after screenshots when the brief asked for how something looks, before/after numbers when it claims a performance gain. A merged PR is never failed for not carrying a fact that only exists after its merge. Missing proof beyond that ("Evidence: none given", "Not verified: …") is a gap to note in the grade, not a failed criterion.
