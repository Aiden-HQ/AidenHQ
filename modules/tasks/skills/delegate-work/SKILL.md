---
name: delegate-work
description: Hand work to an Engineer, the UI/UX Designer or another graded agent (task_delegate, or task_create with an assignee), and decide an escalated grade - the brief, the deliverable and rubric, choosing the agent, UI work, and what counts as done.
unless: { fields: { module: engineering } }
---

# Delegating work

## The brief

Engineers take code jobs from any agent (`task_delegate`; `task_team` lists them under `engineers`). They can't read
other tasks or guess context: every task you give one names the full repository (`owner/name`, e.g. as `app_status`
shows it), the branch to work on or start from, every change it asks for and how to verify each, all in the task itself,
plus what to publish (`pr`).

- **Each change once.** A brief lists each change once, in the change section. An item the code already satisfies is
  stated as what it must keep doing, not as an exception to the change. A brief never claims a part of the tree is
  untouched while its own tests or requirements change that part: it leaves out invariance claims ("only X changes",
  "keep the rest exactly as it is") about anything it also asks to change.
- **Start at the edit.** When you have already located the code, the task carries it: the files (and lines) that own
  the change, the PR or commit that last changed them, and for a restore the commit that removed it with its
  `git show <sha> -- <path>` (or the removed lines themselves).
- **Issues.** When the change fixes an issue in the same repository, the PR body names it as
  `Fixes <owner>/<repo>#<number>`, one line per issue it closes, so the merge closes it; except where the fix counts only
  once it is live first (the product repo, whose Maintainer entry is `after_merge: product-pin`): there the body says
  `Refs <owner>/<repo>#<number>`, and the brief says so too, and the Maintainer closes the issue once the generation
  carrying the fix is `good`.
- **Plain facts.** Write the brief and the PR body as facts stated once, addressed to the Engineer. A note aimed at the
  reviewer (how to read a row, what to ignore, a preemptive "the reviewer misread") is treated as steering and rejects
  the card; when a row needs explaining, explain what it is.
- **Exact names.** Naming a repository never creates it: give the exact names (`local/<name>` for one on this server).
  A new app's repository is asked for explicitly: "create the repository `<agents org>/<app-name>` with
  `aidenhq create-repo`" (an approval card two AI reviewers check against the task). It holds the app starter on main.
- **Only checks the repository runs.** Before a brief names a CI check, read that repository's workflows on its default
  branch and name a job that is there (`sed -n '/^jobs:/,$p' .github/workflows/*.yml | rg -N '^  [a-z][a-z0-9_-]*:$'`):
  the product repo runs `ci-required` (its `modules` job for the official modules), where `image-scan` is the product repo's and the app repos' that copied
  its CI template, so each criterion is one this repository's CI can satisfy. Name the selector and its rule ("pin what
  `best-version.mjs` prints"), not a version: the description can't be edited after filing, and the AI reviewer reads it,
  not the comments.
- **The Engineer's rules travel with it.** Engineers follow skill `write-code` (tests, flaky checks, shipping live,
  `.github/code-review-critical`, additive data-app migrations, the `No-Auto-Rollback: security fix` trailer, large
  rewrites holding their files). Name in the brief which of those the change touches (a data app's schema, a security
  fix, the paths for `code-review-critical`, an app's `AGENTS.md` map to add or update), so the rubric can check them.

## Choosing the agent

- Pick by what the work needs, using `task_team`: it lists each agent's description and roles. Product-repo code goes to the holder of the
  `platform-engineer` role: only its writes there go to the AI reviewer. It publishes its PR and merges it at its head once
  the checks are green, each a card (a second reviewer joins for gate code, a role holder's handbook or a module's grants,
  tools or models). Several product tasks may go to it at once.
- Every Engineer has the repository, its tests and toolchains, package installs into the workspace, the
  public Internet and a headless browser: for UI work it runs the app's Playwright setup (`npm run screens`: the
  changed pages at 1440 and 390, light and dark, and the changed flow) and attaches the screenshots (rubric: "screenshots
  of the changed pages attached"). The Engineer also reads the live apps and GitHub through its tools.
- Engineers work without Docker, system installs, this host, app logs or the warehouse: put the data a task needs in
  the task. A task for the Engineer says "don't try to view the deployed app: the grader captures
  its pages".
- Image and CVE fixes are proven by the PR's image scan: in the product repo and app repos built from its CI template,
  the rubric says "`image-scan` green on the PR's head"; elsewhere it names the change and the PR carries the registry's
  vulnerability data for the tag and digest it pins. What a Dockerfile's RUN steps install is proven by the deployed
  image's security scan.
- One task per change: the Engineer publishes, merges and rebases its one PR. A change
  over 150,000 characters of diff (a redesign, a framework swap) is briefed as stacked PRs from the start, naming the
  slices.
- Before routing app work, check the app's open PRs for a large rewrite: the files it replaces are held (write-code's
  rule), so a change to them targets the rewrite branch or waits.

## UI work (with the design module)

- New apps, new screens and major UI changes start with the UI/UX Designer's (`ui-designer`) plan and mockup. The
  request: who uses the screen, what it answers, the data, the repository, the person who asked for it, and for an
  existing app its owning agent from `fleet_catalog`. A reference design that comes with the request (a mockup, page or
  screenshots) goes on the designer's task as files, source and screenshots: it sets the bar for the finish. The designer
  decides the design and hands the build to an Engineer itself; the requester picks a direction only when they ask to. A
  redesign may drop, merge or add functions: the designer's plan lists them.
- A UI task names the screen's purpose, what people must get done, its data and the states it must show, and its rubric
  includes "the page renders styled under the app's CSP with no console errors" and "the header's brand is
  `Link href="/"` and opens home in its default state; a redesign starts from the starter's shells; every clickable
  element visibly acts.". An app still on the old plain-CSS kit or server-rendered pages moves to the starter when its UI
  is next changed: say "migrate to shadcn/ui (the design-system README's migration guide)" in that task. Small UI edits (a column, a label, a fix) go straight to an Engineer. An app with no sign-in of
  its own: the task says "no app login" (the platform identity check stays).
- The UI Reviewer checks each PR against the mockup: on a PR that changes UI files the merge waits for its
  `design-review` verdict (the runner asks it once the checks are green). For any other PR, ask it with the repository and the PR link
  (`task_delegate` if `task_team` lists it, else `task_create` with `assignee: ui-reviewer`); its findings come back as
  follow-up fixes.
- When the designer asks you, as an app's owning agent, about your app: answer on its task with what people use it for,
  what they must get done, what the data means (unknown values, sources, what other agents read through its API) and what
  you want changed. It is input for the design, not an approval.

## Graded work

Work delegated to the Engineer, the DevOps Engineer and the UI/UX Designer is graded, however you hand it
on (`task_delegate`, or `task_create` with an `assignee`; an Engineer sub-task is graded on its PRs): it closes only once
the grader finds it meeting its rubric, and is otherwise reopened with the unmet criteria. After 3 tries, or when the
grader can't judge it, it escalates to you. A criterion the grader can't verify comes to you as one question; closing the
task settles it.

- **Deliverable:** `pr` (the repo or PR link), `app` (the app name), `apply` or `file`. `report` (read-only work: a
  diagnosis, research) and `none` (a question) are not graded: read the answer and close the task. A brief whose honest
  answer may be "no release carries the fix, record that and park" is a `report` (the tools refuse it as a `pr`: that
  rubric can only pass with a merged PR that may never exist).
- **Rubric:** 3-8 criteria, each naming a fact the grader is given for that deliverable. For a `pr`: the PR's diff, its
  head and merge commit, its named checks, and for an app repo its deploys, newest first ("deployed at the merged commit"
  is checkable; a `by: auto-deploy` deploy is the platform's). Standard criteria, made specific to the request:
  - pr: merged into the default branch, checks green, the change does what was asked, tests cover it, any migration
    keeps what the previous commit uses;
  - app: deployed at the merged commit, healthy, no open incident, that commit's deploy healthy, the asked behaviour
    visible;
  - apply: the apply card applied, the change is the asked one;
  - file: attached to the task, holds what was asked, says where it came from.
  Without a rubric the standard criteria apply.
- **Reachable evidence.** The grader sees the work as it stands, runs no tests and calls no API. Name the CI check and a
  test in the diff ("the tests check is green on the PR's head"), and behaviour as a page at a path; what happens after a
  deploy or over later runs is refused by the tools. Each criterion is a concrete, observable fact ("the totals page
  shows the VAT line", "a test covers the empty cart"). Name a branch or PR rather than a sha (it goes stale). A merge
  commit's own changes are outside the PR's diff, a merged commit has no checks when the workflow runs only on
  `pull_request`, and a file in another repository can't be read: name the in-scope equivalent (the PR merged into its
  base; "deployed at the merged commit"), or ask the owner for that evidence.
- **Pages.** The capture is a page's text from its top, cut at 8,000 characters: an item in a list, board or feed needs
  the path that isolates it (`/slipped?q=CMBT`, not `/slipped`), or a page that shows that item alone. Write the path
  itself: a URL's host is not read and an anchor is dropped.
- **Merge jobs:** criteria on what the merge shows (the PR merged into its base, its head and merge commit, the gate's
  reply on the task), never a card or merge-request id: a Tier 0 merge answers "No card is needed.", and a card filed
  while the PR is a draft can be spent without a merge.
- A graded task you finish or close yourself waits for the grader; an assignee's graded task is closed by its grade.

## Done, and after

- A change is done when it is merged and, for an app, deployed and healthy; an open PR is not done. In agents-org repos
  the runner merges the PR itself once its checks are green on the head; elsewhere ask for `merge` once they are. The
  runner tiers each write.
- **A new app is done when it is live and whoever asked has its link.** It takes two hand-offs, each waking you when it
  ends:
  1. The Engineer builds it: deliverable `pr` on the app's repository, done when the PR is merged into main. The merge's
     outcome reaches you on the parent task.
  2. Then hand the app to the DevOps Engineer (`task_delegate`): "create and deploy `<name>` from `<repo>` at main",
     deliverable `app` with the app's name.
  When that task closes, read the app's `url` from `app_status` and send the link to whoever asked.
- A promise to report later ("I'll send the link once it's live") rests on a delegated task under the task you are
  working from: its outcome wakes you there, and that run keeps the promise.
- A red check goes back to the Engineer, to fix at its cause.
- A delegated task reaching `done` is a claim: before treating a filed defect as fixed, or concluding a task shipped
  nothing, check its done condition against the deployed app or the current repository. If it is unmet, reopen that task
  with the exact unmet condition and the reproduction.
- `code-review`'s non-blocking findings, when an Engineer's report lists them, become one backlog task (`task_create`,
  `assignee` the app's owning agent per `fleet_catalog`, else yourself; marker `code-review:<owner/name>#<PR number>`;
  priority low; `deliverable` pr with that repo when the assignee's work is graded). The PR merges without waiting for
  them.
- **An escalated grade is yours to decide, in that turn**, from the grader's note and the work's evidence: close the task
  (`task_finish` with its `issue`) when the work meets what was asked, even if a criterion was worded so it could not pass;
  reopen it with the exact changes still needed (`task_comment` with `reopen: true`); or cancel it (`task_cancel`) and hand the work to someone better placed. The owner
  decides only what is theirs by authority (spend, a veto, a choice of taste), as one `decision` with concrete options.
- A task blocked on one you might cancel: closing the dependent releases it once the blocker ends cancelled; an active
  blocker still holds it.
