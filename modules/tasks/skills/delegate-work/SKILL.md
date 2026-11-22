---
name: delegate-work
description: Load before handing work to an Engineer, the UI/UX Designer or another graded agent (task_delegate, or task_create with an assignee) - the brief, deliverable and rubric, UI work, and what counts as done.
unless: { fields: { module: engineering } }
---

# Delegating work

## The brief

Engineers take code jobs from any agent (`task_delegate`; `task_team` lists them under `engineers`, with each agent's description and roles). They can't read other tasks, so the task itself carries the full repository (`owner/name`), the branch, each change with how to verify it, and what to publish (`pr`). You read, update and close every other task yourself, from the Engineer's report.

- **Each change once.** State what the code already does as what it must keep doing; skip "only X changes" claims about parts the brief also changes.
- **Start at the edit.** Give the files (and lines) and the PR or commit that last changed them; for a restore, the removing commit.
- **Issues.** The PR body names each issue it closes as `Fixes <owner>/<repo>#<number>`, one line each.
- **Plain facts.** Brief and PR body state facts to the Engineer. A note aimed at the reviewer ("the reviewer misread...") is treated as steering and rejects the card.
- **Exact names.** Naming a repository never creates it. A new app's repository is asked for explicitly: "create the repository `<agents org>/<app-name>` with `aidenhq create-repo`" (an approval card). Use `local/<name>` for one on this server.
- **A writable target.** Archived repositories refuse pushes. The instance repo (`aidenhq-alpha/aidenhq-instance`) refuses every branch and PR ("changes only through apply"): its change is `deliverable: apply` with a rubric on the applied card, never a `pr`.
- **Only checks the repository runs.** Read the default branch's workflows (`sed -n '/^jobs:/,$p' .github/workflows/*.yml | rg -N '^  [a-z][a-z0-9_-]*:$'`) and name a job that exists. The product repo runs `ci-required`; `image-scan` is advisory there and required in app repos built from the CI template. Name a selector and its rule ("pin what `best-version.ts` prints"), not a version: the description can't be edited after filing.
- **The Engineer's rules.** Engineers follow skill `write-code`. Name in the brief which of its rules the change touches (a data app's schema, a security fix, `.github/code-review-critical` paths, an app's `AGENTS.md` map) so the rubric can check them.

## Choosing the agent

- Product-repo code goes to the holder of the `platform-engineer` role; its writes there go to the AI reviewer, and its merge is filed once checks are green. Several product tasks may go to it at once.
- Engineers have the repository, toolchains, package installs, the public Internet and a headless browser (`npm run screens`: changed pages at 1440 and 390, light and dark; rubric "screenshots of the changed pages attached"). They have no Docker, system installs, this host, app logs or the warehouse: put the data a task needs in the task, and say "don't try to view the deployed app: the grader captures its pages".
- Image and CVE fixes: in app repos the rubric says "`image-scan` green on the PR's head"; in the product repo, "`image-scan` ran to completion (not skipped) on the PR's head and reports no fixable high or critical CVE"; elsewhere the PR carries the registry's vulnerability data for the pinned tag and digest.
- One task per change; over about 2,000 changed lines, brief stacked PRs naming the slices. Files an open large rewrite replaces are held: target its branch or wait.

## UI work (with the design module)

- New apps, screens and major UI changes start with the UI/UX Designer (`ui-designer`): who uses the screen, what it answers, the data, the repository, who asked, and for an existing app its owning agent (`fleet_catalog`). A reference design goes on its task as files (source and screenshots). The designer hands the build to an Engineer itself.
- A UI task names the purpose, what people must get done, the data and the states, and its rubric includes "the page renders styled under the app's CSP with no console errors" and "the header's brand is `Link href="/"` and opens home in its default state; a redesign starts from the starter's shells; every clickable element visibly acts". An app on the old plain-CSS kit moves to the starter when its UI next changes: say "migrate to shadcn/ui (the design-system README's migration guide)". Small edits go straight to an Engineer. An app with no sign-in of its own: "no app login".
- On a PR that changes UI files the merge waits for the UI Reviewer's `design-review` verdict. For any other PR, ask it with the repository and PR link (`task_delegate`, else `task_create` with `assignee: ui-reviewer`).
- Asked by the designer about your app: answer on its task with what people use it for, what the data means and what you want changed.

## Graded work

Work for the Engineer, DevOps Engineer and UI/UX Designer is graded however you hand it on: it closes once the grader finds it meeting its rubric, otherwise it reopens with the unmet criteria. If the grader is down, can't judge, or a third version is rejected, the task closes done with an "ungraded: <reason>" note; reopen it with what to change if it isn't.

- **Deliverable:** `pr` (repo or PR link), `app` (name), `apply` or `file`. `report` (diagnosis, research, or "no release carries the fix, park") and `none` (a question) aren't graded: read the answer and close.
- **Rubric:** 3-8 criteria, each a fact the grader is given. For a `pr`: the diff, head and merge commit, named checks, and for an app repo its deploys. Standard criteria, made specific:
  - pr: merged into the default branch, checks green, the change does what was asked, tests cover it, any migration keeps what the previous commit uses;
  - app: deployed at the merged commit, healthy, no open incident, the asked behaviour visible;
  - apply: the apply card applied, the change is the asked one;
  - file: attached, holds what was asked, says where it came from.
- **Reachable evidence.** The grader reads the work as it stands and runs nothing. Name the CI check and a test in the diff, behaviour as a page path, and a branch or PR rather than a sha. Negative criteria ("contains no `X`") can't be seen in a diff: name the diff ("removes every `X` line from docs/a.md"). A merge commit's own changes are outside the PR's diff, a merged commit has no checks when the workflow runs only on `pull_request`, and files in other repositories can't be read: name the in-scope equivalent. `task_amend_rubric` replaces an unsatisfiable filed rubric while the grade is unsettled.
- **Pages.** A criterion on a list, board or feed item needs the path that isolates it (`/slipped?q=CMBT`, not `/slipped`); write the path, since hosts and anchors are dropped. Captures hold up to 120,000 characters a page, 300,000 per criterion.
- **Merge jobs:** criteria on what the merge shows (PR merged into its base, head and merge commit, the gate's reply), never a card id: a Tier 0 merge answers "No card is needed."
- A graded task you finish yourself waits for the grader; an assignee's is closed by its grade.

## Done, and after

- Done means merged and, for an app, deployed and healthy. A delegated task reaching `done` is a claim: check the deployed app or repository before treating a defect as fixed; if unmet, reopen with the exact condition and reproduction.
- **A new app is done when it is live and whoever asked has its link.** Two hand-offs, each waking you: (1) the Engineer builds it (`pr` on the app's repository, done at merge); (2) `task_delegate` to the DevOps Engineer "create and deploy `<name>` from `<repo>` at main", deliverable `app`. Then read the `url` from `app_status` and send it.
- A promise to report later rests on a delegated task under yours: its outcome wakes you there. A red check goes back to the Engineer.
- Non-blocking `code-review` findings in an Engineer's report become one low-priority backlog task (`task_create`, `assignee` the app's owning agent per `fleet_catalog`, else you; marker `code-review:<owner/name>#<PR number>`; `deliverable` pr with that repo when graded). The PR merges without waiting.
- Closing a dependent releases a task blocked on one you cancel.
