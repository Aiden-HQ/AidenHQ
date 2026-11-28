# General settings redesign

Status: approved by the owner (2026-11-28).

## Intent

General Settings has grown into a catch-all.
- About 40 module settings sit in one "General" list, and some are also editable on their module's page.
- "Kill switches" groups settings by type (every on/off setting).
- "Instance" shows a raw table of every setting.
- Many rows are titled from internal keys.
- Many settings matter to maybe 1% of users.

The goal is simple code, simple UX and less to maintain: categories by what the owner wants done, one place per
setting, and rarely used settings deleted.

## Decisions (owner, fixed)

### Structure

```
You
  Profile         owner_name · owner_email · timezone · time_format
  Notifications   browser alerts (board-owned) · notify_transports (order) · notify_fyi
                  summon (on/off) · summon_signature
Agents
  Autonomy        autonomy (with the tier explainer)
  Spend           spend_day_usd · spend_month_usd · task_usd
Connect
  Connections     (tiles, unchanged)
  Accounts        (unchanged)
System
  Updates         version · auto_update · Update now
  Board access    exposure
  Backups         backup_repository
  ▸ Advanced      computers_max (collapsed)
```

### Module settings live on their module's page only

- Each module's own settings are edited on that module's page: a feature page where one exists, otherwise its module
  Settings tab. They no longer appear in general Settings.
- Every setting our instance customises stays a setting.
- Examples: ai_review_code, app_login, ci_runner_repos, ci_org_runner_group, ci_review_model, github_orgs, github_fleet_org, jira history_projects, primer_*,
  grafana_source and the vendor URLs, slack_post_channels, search_summaries, product_repo, telegram_muted,
  telegram_exclude_chats, code_review.

### Removed

Each becomes a constant in code, is written only at install, or goes entirely:

| Setting | Becomes |
|---|---|
| company_name, instance_name, quiet_start | Install-time only; no UI |
| check_computers_max | Constant |
| heartbeat_hours (chief-of-staff) | Constant 4 h; the per-agent heartbeat on an agent's tab stays |
| fleet_ops_interval_minutes, release_window_minutes, churn_exclude, upstream | Constants |
| telegram_decide | Always all; deleted |
| notify_attention, notify_daily_cap, notify_blocked | Deleted with their code |
| notify_digest_hours | Constant 9 / 13 / 18 |
| telegram_backfill_days, hubspot_history_days, history_days (jira), monitoring_retention, ci_review_models | Constants |

### Pages removed

Kill switches, the Instance all-settings table, and the General catch-all.

### Layout

Follows `docs/design/board-ui.md` and the settings-page rules in `modules/AGENTS.md`:
- one card per page; one row per setting (title, one-line description, control flush right);
- segmented choices for 2–4 values; every setting has a `title:`;
- one Save/Discard bar; Advanced collapsed;
- checked at 1512, 1920, 820 and 390 px, light and dark.

## Builder's calls

- How a removed setting's code path collapses: keep the default behaviour, delete the branch.
- Whether a key the instance repo still sets for a removed setting is ignored or refused by compile. Prefer refusing
  with a clear message, and remove it from our instance's `instance.yaml` in the same deploy.
- The exact module page that becomes each moved setting's home.
