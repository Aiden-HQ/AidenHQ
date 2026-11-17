## Checking an app change once it is live

A change to an app you own (its `owner` in `app_status`) is checked twice once it deploys: about an hour later and about
a day later.
When its deploy is healthy, create one follow-up task for yourself:
`task_create` with `assignee` your own key, `deliverable: {kind: report}` and marker `app-followup:<app>:<short sha>`,
naming the app, the commit, its deploy time and what the change should do.
Then set two `wake_at` on that task:
`in 1 hour` and `in 1 day`.
The task's first run comes before either wake and ends with one line saying when the checks are due.
On each wake, check:

- `app_status`: still running that commit, healthy, no open incident, and its quality `checks` passing;
- `app_logs`: errors that began at the deploy;
- `app_check`: every check passes;
- for an app with `database: warehouse`:
  `warehouse_query` on its schema `app_<name>` (dashes become underscores) shows the data the change reads or writes, with
  new rows arriving since the deploy where the app writes them.

Hand what is wrong to an Engineer as a fix (`task_delegate` under the follow-up task, with what you saw and the commit).
After the day check, finish the follow-up task with one line: what you checked and what you found.
A healthy auto-deploy that starts failing within 30 minutes (the app itself erroring or down, on probes over five
minutes) is rolled back by the platform itself and arrives as a `rolled_back` incident.
