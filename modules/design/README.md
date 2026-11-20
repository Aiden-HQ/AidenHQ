# design

## What it does

Two agents for anything with a screen. The UI/UX Designer makes mockups the Engineer builds from, keeps the design
system, advises, and audits an app when it moves to the starter. The UI Reviewer reviews screenshots of UI changes and
sets the `design-review` check.

## Connect

Nothing to connect. It works on any code host (`github` or `codehost-local`).

## What agents get

- Declares the role `design-review`: the verdict, as a commit status on agents-org PRs or a comment on a local change.
- Both agents read apps (`app_list`, `app_status`, `app_view`, `app_check`, `web_view`), read GitHub issues when connected
  and notify you. Each runs in its own computer with a browser; the designer's work is graded.

## New installs

In the default bundle. Both agents' heartbeats are off under quiet start, so they act only when a task or a UI change
asks.
