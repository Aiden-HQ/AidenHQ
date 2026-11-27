# tasks

## What it does

The task tools every agent uses to work: read, create, delegate, comment on and close Paperclip tasks, as the calling
agent. It also carries the model tools (`advisor_ask`, `fanout_map`) and `memory_note`.

## Connect

Nothing to connect.

## What agents get

The `paperclip_tasks` connection (22 read, 23 write).

- Read: `task_current`, `task_get`, `task_search`, `task_list`, `task_team`, `task_comments`, `task_files`,
  `task_approvals`, `fleet_status`, `fleet_costs`, `fleet_catalog`, `handbook_read`, `advisor_ask`, `fanout_map`,
  `memory_note` and more.
- Write: `task_create`, `task_delegate`, `task_comment`, `task_update`, `task_amend_rubric`, `task_finish`, `task_wait`, `task_block`,
  `task_cancel`, `task_schedule`, `task_recurring`, `fleet_control` and more.
- By default crew agents hold `task_wait`, `advisor_ask` (with `model-tools`) and `memory_note` (with `memory`).

## New installs

In the default bundle. Nothing runs on its own.
