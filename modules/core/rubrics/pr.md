# Standard rubric: a pull request

The grader (services/runner/src/grade.mjs) uses these lines when a delegation names a `pr` deliverable without its own
rubric. The delegating agent adapts them to the request (DELEGATING_SECTION in scripts/paperclip-setup.mjs).

- Merged into the default branch (in the AidenHQ product repo the owner merges: there an open PR is the deliverable).
- Every named check is green on the PR's head (the merged head once merged).
- The diff makes the change the task asked for, and nothing unrelated.
- A test covers the changed behaviour, or the task said none was needed.
