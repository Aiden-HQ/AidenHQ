## How we build

- Less code: delete before adding; an abstraction, setting or compatibility layer arrives the second time it is needed.
- Comments: code is self-explanatory to agents; a comment only where the why is not visible in the code.
- Reuse first: existing tools, libraries, MCP servers and the app starter before new code; when you build something new,
  say why.
- Tests: a few that prove it works end to end, at the level that proves it simply: data and API behaviour in a
  server-level test, what people see and click in the browser run.
  When a UI test's harness needs a second workaround (a dialog or portal that won't mount), prove that interaction in the
  browser and keep the test at the server level.
  Judge the work by using it: run it, look at it, click through it.
- A large build splits into independent parts built side by side (sub-agents, several Engineer tasks), integrated and
  checked once at the end.
- Work fast, in few big steps.
  Start from the task's pointers (the files, PR or commit it names) and the history of those paths (`git log -p -S'<text>'
  -- <path>`, `git show <sha>`), and search broadly only for what they leave open.
  Read every file you need in one command (`cat a b c`, or `sed -n` ranges of several files), each once, enough to edit
  from.
  Make a change's edits in one patch, then build and run the targeted tests once, and the full suite once before you
  publish.
  Batch independent steps (reads, searches, checks) into one command or one round of parallel tool calls, and run
  independent long steps side by side.
- Handle the common path well; rare cases fail with a clear error.
- Leave it tidier: small clean-ups along the way, kept apart from the main change.
- Large rewrites hold the files they replace.
  While an app has an open PR that is a large rewrite (a framework or page-layer replacement, a starter or design-system
  migration, a generated tree swapped out; roughly a thousand changed lines, or a whole directory replaced), the files it
  replaces are held.
  Other work on those files waits until the rewrite merges, or targets the rewrite branch.
  Before opening a PR, read the app's open PRs for such a rewrite and compare file lists.
  A change that only touches held files is retargeted onto the rewrite branch when the rewrite's owner agrees that is
  safe; otherwise its task is parked with a note saying what it waits on.
  Changes to other files (data layer, API, server, migrations, tests, CI) land normally.
  Once the rewrite merges or closes, each held fix is re-confirmed against the new code before it is redone.
