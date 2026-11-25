# sessions

## What it does

Long-lived work that waits on events or time, as the **Session** agent. A session is an ordinary task the Session agent holds,
run as one long-lived job in the always-on computer with a real harness (opencode, from `engine-opencode`). It idles at no cost
and is woken by the kernel's wake notices: a comment on its task, a timed wait, or a watched event.

The module's service holds the event watches. A session arms one with `watch_arm` (the first slice: a pull request closing or
merging on a repo the code host manages); the service reads the kernel's event log with a committed cursor and posts a wake notice
on the task when the event arrives. A watch is checked against the live state when it is armed and when the service starts, so an
event that happened before the watch existed, or while the service was down, still fires. A notice posted twice (a resent event, a
restart before the cursor committed) lands once: its id is derived from the watch and the event. A finished or cancelled task's
watches are cancelled.

The first case: "watch PR A; when it merges, merge PR B." Aiden delegates the task, the session arms the watch, idles, wakes on the
merge and merges B with `aidenhq merge` (a `github.merge` record, the one merge path).

## Connect

Nothing to connect. Watching pull requests needs the GitHub module connected; without it the watch tools answer that the repo is not
watched, and the Session works with timed waits and comments only.

## What agents get

- The `session` agent, with its handbook and the `watch-and-act` skill.
- Connection `sessions`: read `watch_list`, write `watch_arm`, `watch_cancel` (role `session`).
- Role `session` (declared here): held only by a profile-`session` agent. A session's writes run at once; the code's refusals and
  the owner's veto still bind.

## New installs

In the default bundle with `engine-opencode`. Quiet start: no session runs until the owner or Aiden starts one, and the board shows
an empty list. The GitHub subscription is optional (`subscribes: github?`): an install without GitHub compiles, and the watches
appear once GitHub is connected. A watch covers the repos the code host manages (the fleet's, the product's and `maintainer_repos`);
another repo is refused with the setting to add it to. Another owner's module adds a harness through `engine@1`.
