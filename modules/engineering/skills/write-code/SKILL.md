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
- Before your first commit, refresh the code host's branches with `aidenhq clone <org/repo>` (a plain `git fetch` does
  not work through the workspace's remote) and, when `origin/<branch>` exists, start from its remote head: either
  `git switch --create <branch> --track origin/<branch>`, or switch to an existing local branch of that name and
  fast-forward it (`git merge --ff-only origin/<branch>`), which keeps its unpushed commits. When origin has no such
  branch, start a new branch. If the local branch cannot be fast-forwarded, stop and report rather than reset or force
  it, and when the refresh fails, stop the run. Never rebuild the branch's changes from your workspace history and
  force that copy over the remote; rebasing the branch's existing commits is not rebuilding it.

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
- A rejection of a change names a defect: fix it and publish the changed branch, because the same commits stay rejected.
  The rejection arrives as a comment on the task, carried in the next run's prompt with the notes it names, so a run reads
  an earlier note there. Only the AI reviewer's own rejection of the change counts toward the stop, and a red check is the
  check's complaint, not a rejection. A `Not reviewed` notice is code's refusal, never the reviewer's silence: the kernel
  retries a failed reviewer and then decides the write itself (approved fail-open at full autonomy, or sent to the owner
  under a cap), so it posts no notice and leaves nothing to refile. Either way that is not the write being done: report it
  as decided when its outcome lands, not before. Fix what the notice's reason names (instance details to take out, a diff
  that no longer matches the head) and file the changed write; filing the same write again just earns the same refusal.
  When a second rejection of the same change names nothing still wrong with the current head (it repeats the first note
  after that defect was fixed, or names nothing this change can fix), the run stops republishing, even though the
  rejection's own notice still ends "Fix that and file it again": that tail states the general case, and this rule is the
  stop a second repetition without a new defect earns.
  It `task_wait`s with `for` the delegator (the owner when nobody delegated the task) and puts the whole question in its
  `question`: both rejection ids, what the two notes said, what it would change, and what the change must do. The Engineer
  cannot comment, so the final reply repeats the two ids and the question onto the task. It publishes the next head only
  once a reply resolves the question by saying what the change must do; an answer that asks something back, declines, or
  names no requirement is met with the same question again, not a new head. A note that names a defect still present is
  answered by a changed branch, not by a wait.
- Aiden's code review findings: the merge waits on each important one until it is answered. Find them (with their ids) in
  the merge's wait reason or the review (`github_pr_threads`: `finding`), then answer each with `code_review_resolve`
  (`repo`, `number`, `id`, `word`, `reason`), which writes nothing to GitHub: after fixing it and publishing the fix, word
  `fixed` and the reason `<what changed, commit>`; for one you judge wrong, `disputed` and `<reason, file:line>`. A reply on
  the finding's thread starting with the same word also answers it, optional.

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
