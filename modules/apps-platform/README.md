# apps-platform

## What it does

Where the apps your agents build live and run. The DevOps Engineer (`app-maintainer`) deploys, restarts, rolls back
and watches them. It also holds the app starter, the design system and the gate that shares an app with other people
(their sign-in is set by `app_login`).

## Connect

Nothing to connect. Sharing apps beyond the owner needs the instance's edge and a login mode (setting `app_login`, below).

## What agents get

The `apps` connection (apps-mcp). Which agents get which tools is set on each agent.

- Read: `app_list`, `app_status`, `app_logs`, `app_view`, `app_page_canary`, `app_check`, `web_view`,
  `warehouse_query`, `source_new`, `app_requests`, `app_roles`.
- Write (kernel records the kernel executes): `app_deploy`, `app_restart`, `app_rollback`, `app_create`,
  `app_run_request`, `app_api`, `source_ack`, `person_identity_decide`, `finding_verdict`, `app_request_reply`,
  `app_role_set`. Destructive: `app_remove`.
- The `app-maintainer` agent is graded and runs on app incidents and in-app requests (two webhook routines fired by
  apps-mcp and the kernel).

Setting `app_login`: `access` (Cloudflare Access on every gate host), `password` (the gate signs people in with their
AidenHQ account) or `header-jwt` (a front door's signed identity header).

## New installs

Always installed (core requires it). No apps exist yet. The incident and request routines are webhooks, so quiet start
does not pause them, but nothing fires until an app exists. The `app-maintainer` heartbeat is off under quiet start.
