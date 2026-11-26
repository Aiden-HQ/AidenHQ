# design

## What it does

Two agents for anything with a screen. The UI/UX Designer makes mockups the Engineer builds from, keeps the design
system, advises, and audits an app when it moves to the starter. The UI Reviewer is a product designer you ask:
it reviews a pull request or an app and reports verified bugs and ranked design improvements. It runs only on request
(you, Aiden or another agent), never on a schedule or on its own for a PR, and it sets no commit status.

## Connect

Nothing to connect. It works on any code host (`github` or `codehost-local`).

## What agents get

- Both agents read apps (`app_list`, `app_status`, `app_view`, `app_check`, `web_view`), read GitHub issues when connected
  and notify you. Each runs in its own computer with a browser; the designer's work is graded.

## New installs

In the default bundle. Both agents' heartbeats are off under quiet start, so they act only when a task or a UI change
asks.
