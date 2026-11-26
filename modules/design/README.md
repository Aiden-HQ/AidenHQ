# design

## What it does

Two agents for anything with a screen. The UI/UX Designer makes mockups the Engineer builds from, keeps the design
system, advises, and audits an app when it moves to the starter. The UI Reviewer is a professional product designer you
ask: it opens an app (or a PR's UI) at every width and theme, measures it, and reports design improvements ranked by
impact, the best ones shown as a rendered before|after that a pairwise check confirmed, plus the bugs its checks
confirmed. It runs only on request (you, Aiden or another agent), never on a schedule or on its own for a PR, and it sets
no commit status.

Four parts, one owner each: the engine `ui-review` (capture, measurements, model calls; in the agent computer image), the
UI Reviewer (judgment: which app, how to run it, the fixes, the report; skill `design.ui-review`), the design service (runs
and evidence), and taste (universal rules in the engine; your own preferences in your instance's `library.owner-taste`).

## Connect

Nothing to connect. It works on any code host (`github` or `codehost-local`).

To test apps behind a sign-in, list them in the setting `ui_testing` (`{ apps: [{ name, url, repo?, aidenhq_app?, live_mode }] }`;
`live_mode` read, the default, test-write or any: the most a pass may do) and paste each app's test account into the secret
`ui_logins`. A login is released only to that app's own pass, to the box's `ui-review` process, never to the model. AidenHQ
apps (`aidenhq_app: true`) are always read-only and sign in through the test-user session instead.

## What agents get

- Both agents read apps (`app_list`, `app_status`, `app_view`, `app_check`, `web_view`), read GitHub issues when connected
  and notify you. Each runs in its own computer with a browser; the designer's work is graded.
- The UI Reviewer also gets the `design` connection: `design_run_start`, `design_evidence_put`, `design_run_finish`
  (write) and `design_runs`, `design_run` (read), and for apps `design_apps` (read) and `design_pass_start` (write: files a
  pass for the holder of role `ui-login`). A run's reports and the captures they cite are kept 30 days, except each
  app's latest finished run.

## New installs

In the default bundle. Both agents' heartbeats are off under quiet start, so they act only when a task or a UI change
asks. The design service starts empty and stores nothing until a review runs. `ui_testing.apps` is empty and no login is
set, so no pass runs until the owner adds an app.
