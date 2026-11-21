---
name: write-code
description: How code is written, tested and published here, in any repository - start, scope, tests, checks, PR text and size, dependencies, apps. Load before changing code or opening a PR.
---

# Writing code

## Start from the repository

- Read the repository's own `AGENTS.md` / `CLAUDE.md` (and `CONTRIBUTING.md`) first and follow it over this skill: it
  holds that repository's layout, commands and conventions. In an app repo it maps each screen and route to the files
  that own it and gives the run, test, lint and local-preview commands; when your change adds, moves or removes one of
  those, update the map in the same PR, and write one when the repo has none (the app starter's `AGENTS.md` is the
  model).
- The AidenHQ product repository: skill `aidenhq-product`. UI for AidenHQ apps and the board, and every new app: skill
  `design-system`. Adding or bumping a dependency, image, action or tool: skill `supply-chain`. App code standards:
  `references/apps.md`.

## Work fast, in few big steps

- Start from the task's pointers (the files, PR or commit it names) and the history of those paths
  (`git log -p -S'<text>' -- <path>`, `git show <sha>`), then search broadly only for what they leave open.
- Read every file you need in one command (`cat a b c`, or `sed -n` ranges of several files), each once, enough to edit
  from. Make a change's edits in one patch, then build and run the targeted tests once.
- Batch independent steps (reads, searches, checks) into one command or one round of parallel tool calls, and run
  independent long steps side by side.
- A large change with independent parts, a rewrite or a diff too big for one PR: `references/large-changes.md`.

## Keep it simple

- Less code: the smallest change that does the job. Delete before adding. Reuse what the repository, its libraries,
  existing tools, MCP servers and the app starter already have before writing new code; when you build something new,
  say why. An option, setting, abstraction or compatibility shim arrives the second time it is needed.
- Handle the common path well; rare cases fail with a clear error.
- Code explains itself to the next agent: a comment only where the why is not visible in the code.
- Leave it tidier: small clean-ups along the way, kept apart from the main change. Where the AI reviewer judges the
  change (Tier 1), list the small clean-ups you spot in your reply instead of including them.
- When something goes wrong, fix what caused it, so it stays fixed.
- Build what was asked and ship it live: a change is on for everyone when it merges. A feature flag, "ship dark" switch
  or off-by-default toggle is there only when the request asks for one.
- A triage or diagnosis task ships its classification and the evidence for it. A defect it turns up outside the
  task's ask goes in the report, and in its own task when it needs fixing; this branch keeps to the ask.

## Tests

- A few tests that prove the change works end to end, at the level that proves it simply; the build and those cover the
  rest:
  - data and API behaviour: a server-level test;
  - what people see and click: a Playwright flow in the app's `e2e/`;
  - a component's logic: a Vitest + Testing Library test next to it.
  The app starter has all three ready.
- When a UI test's harness needs a second workaround (a dialog or portal that won't mount), prove that interaction in
  the browser and keep the test at the server level.
- Use the standard tools of the framework and its ecosystem (Vitest, Testing Library, Playwright Test with its
  `webServer`, the app's `npm run preview`) rather than a script of your own, with the repo's test and preview commands
  as its `AGENTS.md` gives them.
- Install a package's dependencies (`npm ci`, or its lockfile's equivalent) before its build, `tsc` or tests: "tsc: not
  found" means that step was skipped.
- While you iterate, run the one test file you are working on. Run the full suite of each package you changed once,
  before you publish and before you say it works.
- A long build or test command must never be piped through `tail`, `head` or another filter that withholds its
  output: the run shows no progress and is stopped as stalled after about 35 minutes. Let its output stream, or write
  it to a log file and read the end of that file, and give it a timeout short enough that the run ends before the stall
  window.
- Judge the work by using it: run it, look at it, click through it.
- Image CVE scans are the PR's `image-scan` check (lock files and pinned base images, no build; advisory in the product repo, findings as its error annotations), not a local step.

## Checks

- A flaky test gets its root cause fixed in the same change; when the cause can't be found, delete the test and record
  why in the commit.
- A red check is re-run only when its log shows an infrastructure failure (runner lost, network), and the PR says so.
  The one sanctioned exception is the reviewer eval gate's single re-run of its failed cases (model variance, measured
  on its receipt).
- A PR's `code-review` check fails on critical or high findings: fix those on the branch. Its other findings (in the
  same PR comment) are not this change's work: list them in your reply under "Non-blocking code-review findings" with
  the PR link, so they become one backlog task.
- When a check refuses a PR, read its complaint and fix that cause before filing again.
- A rejection of a change names a defect: fix it and publish the changed branch, because the same commits stay rejected. When a
  second rejection of the same change names nothing still wrong with the current head (it repeats the first note after that
  defect was fixed, or names nothing this change can fix), the run stops republishing: comment on the task with both rejection
  ids, then `task_wait` (`for` the delegator) to ask whoever delegated the task to clarify what the change must do or to accept
  it as it stands, quoting what the two notes said and what it would change if they agreed. It publishes the next head once
  that answer arrives. A note that names a defect still present is answered by a changed branch, not by a wait.
- Aiden's code review findings: the merge waits on each important one until it is answered on its thread. Find them in the
  merge's wait reason or the review (`github_pr_threads`), then answer each with `github_pr_thread_reply`: after fixing it,
  `fixed: <what changed, commit>`; for one you judge wrong, `disputed: <reason, file:line>`.

## Publishing

- What you write in a repository is public. Code, comments, docs, commit messages, branch names and PR text stay free of
  AidenHQ, Paperclip, task numbers (PEN-…), the runner and local paths. The app starter's default "Powered by AidenHQ"
  footer is fine to keep; the app's owner may remove it.
- Commit as you go; commit subjects and the PR title are Conventional Commits (`fix(scope): …`): `aidenhq publish` takes
  the title from the branch's first commit, or `--title`, and a squash merge makes it the commit.
  The description is plain, for the repository's reviewers, with no internal names and no "Generated with" footer. It says why, and when the task names issues, it carries the `Refs …` lines the
  task gives, and for each issue it closes `aidenhq publish … --fixes <owner>/<repo>#<n>` writes the `Fixes …` line into the body.
- PR text, commit messages and code comments state facts about the change. Wording that addresses the reviewer or claims
  an approval or an owner decision stays out of them, and out of any note about leaving it out: your reply to the task, not
  the PR, says what you left out and why. The AI reviewer also reads that reply, as context for judging whether the change
  does what the task asked, never as part of the request: the reply never widens, narrows or authorises the change. It
  states the change, its evidence and what was left out — never a predicted verdict on the change. Non-blocking
  code-review findings still go in the reply under "Non-blocking code-review findings", as Checks requires: a finding is
  not a verdict.
- A `file` deliverable: attach the file to the task with `task_file_upload` (`{issue, name, type, data}` with the bytes
  as base64, or `text` for a text file), then name it in the finishing comment. `task_files` confirms it is there.
- The description ends with `## Evidence`:
  - the commands you ran with their results (tests, build, typecheck);
  - for a change people see, before/after screenshots (they land in `.aidenhq/out/`: name each file and what it shows);
  - for performance work, before/after numbers;
  - "Not verified: <why>" for anything you did not check.
  The AI reviewer and the grader read that section; without it the runner adds "Evidence: none given".
- Size: one PR stays under about 1,500 changed lines (the CI code review gate refuses a diff much over ~2,000). Plan a
  bigger change as ordered, stacked PRs from the start (`references/large-changes.md`).

## Repository files that are the app's own

- `.github/code-review-critical` lists, one glob per line, the paths `code-review` reviews at normal depth (the rest gets
  light review). When you scaffold an app, or add code that reads the owner's data, handles sign-in or identity, takes
  public input, takes payments or sends messages out, add those paths to it in the same PR. Every line stays unless the
  task says to remove it. Template syncs leave the file alone: it is the app's own.
- A data app (one with `database: warehouse`) migrates its schema by adding: new tables, columns that are nullable or
  have a default, and indexes. A column or table being replaced stays until a later release removes it, once the running
  code no longer reads it. The previous commit then still runs on the new schema, so the platform can roll a bad deploy
  back safely.
- A security fix to an app carries the commit trailer `No-Auto-Rollback: security fix`: the platform's post-deploy watch
  then raises an incident for it instead of rolling it back.
