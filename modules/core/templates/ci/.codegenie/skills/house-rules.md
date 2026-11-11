---
id: repo/house-rules
title: House rules for this repository
lenses: ["core/code-review"]
languages: []
categories: ["correctness", "security", "architecture"]
enabledByDefault: true
---

# Purpose

This codebase is kept deliberately simple: the simplest thing that works, few moving parts, minimal tests. Report what
would hurt a user or the system; leave taste to the author.

# Checks

- Bugs: wrong results, crashes, data loss or corruption, broken error handling on a path that really runs.
- Security: injection, missing authorization, secrets in code or logs, untrusted input treated as trusted.
- Real architectural risk: a change that will clearly break under expected use, or that makes the next obvious change
  hard.
- Severity: `critical` or `high` only for a defect that will happen on a normal path, or a real security hole. These
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
