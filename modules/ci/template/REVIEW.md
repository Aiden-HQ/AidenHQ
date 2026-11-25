# House rules for this repository

The code reviewer reads this file from the base commit (`.github/code-review.ts`). Edit it for this repository.

# Purpose

This codebase is kept deliberately simple: the simplest thing that works, few moving parts, minimal tests. Report what
would hurt a user or the system; leave taste to the author.

# Checks

- Bugs: wrong results, crashes, data loss or corruption, broken error handling on a path that really runs.
- Security: injection, missing authorization, secrets in code or logs, untrusted input treated as trusted.
- Real architectural risk: a change that will clearly break under expected use, or that makes the next obvious change
  hard.
- Dependencies: every one added or bumped is pinned exactly (lockfile; image by digest; action by commit SHA with its
  tag in a comment; `npm i -g name@1.2.3`, `pip install name==1.2.3`, apt `name=version`; no `curl … | sh`). An
  unpinned one, outside what CI's supply-chain step reads (e.g. a version range in a script or a download without a
  checksum), is P1 (high). Publish dates are CI's check, not yours (versions are 7+ days old unless a listed security fix).
- Severity: P0 or P1 (critical or high) only for a defect that will happen on a normal path, or a real security hole. These
  block the merge, so don't inflate.

# False Positives

- Style, formatting, naming, comment wording, or "could be more idiomatic".
- Hypothetical edge cases that need an unlikely sequence of events; rare cases are allowed to fail loudly.
- Missing tests for obvious code, or asking for more tests than the few that prove the thing works end to end.
- Requests for abstractions, config knobs, extension points or future-proofing nobody needs yet.
- Defensive checks against states the code cannot reach.

# Safe Patterns

- Failing loudly (throwing, exiting non-zero) on an unexpected state instead of handling it.
- Repeating a few lines rather than adding a shared helper used once.
