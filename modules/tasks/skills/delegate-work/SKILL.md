---
name: delegate-work
description: "Covers handing work to an Engineer, the UI/UX Designer or another agent that ships work (`task_delegate`, or `task_create` with an assignee): the brief, deliverable and rubric, UI work, and what counts as done. Use before delegating any work."
---

# Delegating work

## The brief

Engineers take code jobs from any agent (`task_delegate`; `task_team` lists them under `engineers`). The task itself carries the full repository (`owner/name`), the branch, each change with how to verify it, and what to publish (`pr`): Engineers can't read other tasks. You read, update and close every other task yourself, from the Engineer's report.

- List each open call you could make yourself with the default the worker takes: `Open call: <question>. Default: <choice>, because <reason>.` The worker proceeds on the default and names it in its report; you correct afterwards. A call only the owner makes is settled before the brief goes out: ask it on your task with `task_wait` `for: owner` and the question (options, your recommendation first).
- Code work that spans more than one task has one spec file on the target repository's default branch (the product repo: `docs/superpowers/specs/<date>-<topic>-design.md`), merged before the tasks that read it start. Each brief links it and adds only its own part, so every agent works from the same text.
- State each change once; say what the code already does as what it must keep doing. Leave "only X changes" claims out of a brief that also changes that part (the reviewer rejects the contradiction).
- Give the files (and lines) and the PR or commit that last changed them; for a restore, the removing commit.
- The PR body names each issue it closes as `Fixes <owner>/<repo>#<number>`, one line each.
- Brief and PR body are plain facts addressed to the Engineer; a note aimed at the reviewer is treated as steering and rejects the card.
- A new app's repository is asked for explicitly: "create the repository `<agents org>/<app-name>` with `aidenhq create-repo`" (a card). Use `local/<name>` for one on this server.
- The instance repo (`aidenhq-alpha/aidenhq-instance`) changes only through apply: `deliverable: apply` with a rubric on the apply card, never a `pr`. Archived repositories refuse pushes.
- Name a CI job the repository runs (read its default-branch workflows). The product repo runs `ci-required`; `image-scan` is advisory there and required in app repos built from the CI template. Name a selector and its rule ("pin what `best-version.ts` prints"), not a version.
- Skill `write-code` is the Engineer's rulebook; name in the brief which of its rules the change touches (a data app's schema, a security fix, sensitive-path rules, an app's `AGENTS.md` map) so the rubric lists them.

## Choosing the agent

- Product-repo code goes to the holder of the `platform-engineer` role (`fleet_catalog` lists roles); its writes there go to the AI reviewer and its merge is filed once checks are green. Several product tasks may go to it at once.
- **A bug in AidenHQ itself** (kernel, services, official modules, the board) is the product's to fix, so it goes upstream as an issue, reported as "Reporting a product bug" says, and never to an Engineer. The Engineer builds product code only on an instance that develops AidenHQ itself: the product repo is one of its projects with a GitHub remote it pushes to (never a `local/…` copy). The instance's own apps, repos and local modules go to the Engineer as above.
- Engineers have the repository, toolchains, package installs, the public Internet and a headless browser (`bun run screens`: changed pages at 1440 and 390, light and dark; rubric "screenshots of the changed pages attached"). They have no Docker, host, app logs or warehouse: put needed data in the task,.
- Image and CVE fixes: in app repos built from the CI template the rubric says "`image-scan` green on the PR's head"; in the product repo, "`image-scan` ran to completion (not skipped) on the PR's head and reports no fixable high or critical CVE"; elsewhere the PR carries the registry's vulnerability data for the tag and digest it pins. Packages a Dockerfile `RUN` step installs aren't covered by `image-scan`: the deployed image's security scan (the security agent, `security-watch`) proves them after the deploy; keep that out of the PR rubric.
- One task per change; over about 2,000 changed lines, brief stacked PRs naming the slices. Files an open large rewrite replaces are held: target its branch or wait.

## UI work (with the design module)

- New apps, screens and major UI changes start with the UI/UX Designer (`ui-designer`): who uses the screen, what it answers, the data, the repository, who asked, and for an existing app its owning agent (`fleet_catalog`). A reference design goes on its task as files (source and screenshots). The designer hands the build to an Engineer itself.
- A UI task names the purpose, the data and the states, and its rubric includes "the page renders styled under the app's CSP with no console errors" and "the header's brand is `Link href="/"` and opens home in its default state; a redesign starts from the starter's shells; every clickable element visibly acts". An app on the old plain-CSS kit moves to the starter when its UI next changes: say "migrate to shadcn/ui (the design-system README's migration guide)". Small edits go straight to an Engineer. An app with no sign-in of its own: "no app login".
- The UI Reviewer reviews only on request: ask it for a PR (repository and PR link) or an app (its name or URL) with `task_delegate`, else `task_create` with `assignee: ui-reviewer`. It reports on its own task; its verdict never holds a merge.
- Asked by the designer about your app: answer on its task with what people use it for, what the data means and what you want changed.

## Rubric and deliverable

Work for the Engineer, the app builder (`app-maintainer`) and UI/UX Designer names its deliverable and carries a rubric. The task closes when its agent finishes it; then one check reads the agent's done report against the rubric. When the report shows a criterion not done, you get a wake notice listing it: reopen the task with what to change (`task_comment` with `reopen: true`), or accept it. The agent's done report says plainly what it did and anything it skipped.

- **Deliverable:** `pr` (repo or PR link), `app` (name), `apply` or `file`. `report` (diagnosis, research, "no release carries the fix, park") and `none` (a question) carry no rubric: read the answer and close.
- **Rubric:** 3-8 criteria, each 3-200 characters, a checklist the check reads against the report. Omit it for the standard list of the deliverable's kind. Re-delegating the same task with a corrected rubric replaces it while the task is open.
  - pr: merged into the default branch, checks green, the change does what was asked, tests cover it, any migration keeps what the previous commit uses;
  - app: deployed at the merged commit, healthy, no open incident, the asked behaviour visible;
  - apply: the apply card applied, the change is the asked one;
  - file: attached, holds what was asked, says where it came from.
- **Wording:** each criterion names one thing the report can say it did ("the PR is merged into its base", "a test covers X", "screenshots of the changed pages are attached").
- **Merge jobs:** criteria on what the merge shows (PR merged into its base, head and merge commit, the gate's reply), never a card id.

## Done, and after

- Done means merged and, for an app, deployed and healthy. A delegated task reaching `done` is the agent's report: check the deployed app or repository when it matters, and reopen with the exact unmet condition and reproduction.
- **A new app is done when it is live and whoever asked has its link.** (1) The Engineer builds it (`pr` on the app's repository, done at merge); (2) `task_delegate` to the app builder "create and deploy `<name>` from `<repo>` at main", deliverable `app`. Then read the `url` from `app_status` and send it.
- A promise to report later rests on a delegated task under yours: its outcome wakes you there. A red check goes back to the Engineer.
- Non-blocking code-review findings in an Engineer's report become one low-priority backlog task (`task_create`, `assignee` the app's owning agent per `fleet_catalog`, else you; marker `code-review:<owner/name>#<PR number>`; `deliverable` pr with that repo).
