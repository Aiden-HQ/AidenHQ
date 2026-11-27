# engineering

## What it does

The Engineer: it does the coding jobs, whether apps, the fleet's own setup or the product. The kernel runs each job in
an engineer computer (Codex on OpenRouter models, through the model gateway), and the work is graded.

## Connect

Nothing to connect. It needs a code host (`codehost-local` or `github`), an engine and `dispatch`.

## What agents get

- It reads apps (`app_list`, `app_status`, `app_view`, `app_check`, `web_view`), GitHub when connected, and uses the task
  tools `task_file_upload`, `task_finish` and `task_wait`. Pushes, PRs and merges go through the code host's reviewed
  write kinds, not tools.
- Holds the `platform-engineer` role. Skills: `engineering.write-code`, `engineering.publish`, `engineering.supply-chain`,
  `engineering.build-app`, `engineering.aidenhq-product`, `engineering.fleet-change`, `engineering.dependabot`,
  `engineering.forks`, plus `apps-platform.design-system` and `ship.ship`.

## New installs

In the default bundle. The Engineer starts work only when a task is sent to it.
