# Engineer speed

Why one small app change took an Engineer 42 minutes when the app's owning agent had the full context in about 4, where
the time went, and what changed so the next one is faster. Measured on one real case (2026-11-16) from the Engineer's
Codex session log (timestamps per tool call and per model turn) and the owning agent's Paperclip session log.

## The case

- **Request:** add a feedback button to a dashboard app's header.
- **Owning agent (Paperclip, ~4 min, 07:45–07:49Z):** it confirmed the control had disappeared when an earlier PR rebuilt
  the header, and that the storage and read path still worked. Then it delegated the build.
- **Engineer (App Engineer, runner job in its gVisor box, 42.7 min, 07:49–08:31Z):**
  - change size: 4 files, +268/−40;
  - tool calls: 377 function calls over 301 model turns (counted in the session log: 313 shell commands, 29 GitHub MCP
    reads, 22 image views, 13 `write_stdin` polls). The job log's `command_execution` items alone give the ~311 quoted
    elsewhere;
  - input tokens: 42.9M across the 301 turns, an average of 143k per turn (98.7% cached).
- **After the PR:** code review took 6.5 min and design review 11.8 min, run in parallel; merged 15 min after the PR.

## The question: how did the owning agent get the context in a minute when the Engineer took 30?

**It didn't, and the Engineer didn't take 30 minutes to get it.**

- **The Engineer had the context in 3.5 minutes.**
  - Its brief named the header file, the dialog file, the PR that dropped the control and the endpoint.
  - It opened the header 2 seconds in.
  - By 22 seconds it had confirmed the route and storage were intact.
  - By 1.8 minutes it had read the dropping commit (`git log --all -- <header>`, `git show`).
  - Its first edit came at 07:52:27, 3.5 minutes in.
- **The owning agent did different work.**
  - Its delegator had already handed it the earlier PRs and the endpoint.
  - It checked the live app (`app_view` screenshots, an `app_api` read) and read PR descriptions (`github_issue_read`
    on the earlier PRs), batching about 2 calls per turn.
  - It never opened the code, built, tested or looked at a change.
  - Its 4 minutes compare with the Engineer's first 3.5, not its 42.

**The other 39 minutes went to building, testing and verifying:**

| Phase (wall clock) | Min | What happened |
|---|---|---|
| 07:49:00–07:52:27 | 3.5 | Orient, read the named files, check the history, first rewrite-hold check (13 PR reads) |
| 07:52:27–07:53:43 | 1.3 | The edits themselves |
| 07:53:43–08:14:00 | 20.3 | A jsdom test of the full app opening the Radix dialog, which didn't mount: about 60 calls, 10 throwaway probe scripts, each edit chained to a 25–30 s build |
| 08:14:00–08:23:20 | 9.3 | Serving the app with seeded data (hand-written preview server, started and killed about 8 times) and screenshots at 1440/390 in light and dark |
| 08:23:20–08:25:15 | 1.9 | Local review, rewrite-hold check again (11 PR reads), and context compaction at 08:24:28, then re-reading the diff and AGENTS.md |
| 08:25:15–08:29:40 | 4.4 | The screenshots found the header overflowing at 390 px; fix, then screenshot again |
| 08:29:40–08:31:40 | 2.0 | Full suite (478 pass), commit, PR |

**Per-step cost:**

- **Model time:** 1,789 s of model time over 301 turns, about 6 s per turn.
  - The Engineer averaged 1.25 tool calls per turn and 460 output tokens per turn.
  - The owning agent averaged 2 calls per turn and 1,600 output tokens per turn.
- **Context:** grew from 20k tokens (a 35k-character prompt) to 107k by 2.5 minutes, 171k by 13 minutes and 236k by
  32 minutes, then compacted to 58k.
  - Each turn re-sends the whole context, so the turn count drives both time and cost.
  - The prompt carries the task description twice: as the untrusted task, and again as the authoritative instructions
    when no owner comment exists (about 6.4k characters). Changing which text counts as authoritative is a tiering
    question, left for its own change.

**Friction, all in the box:**

- **`apply_patch`:** it failed 3 times with "command not found" whenever it was chained with a build. Codex intercepts
  `apply_patch` only as the whole command. The edits after that went through about 30 fragile `perl -0pi` and Python
  rewrites. Across the last 31 box jobs, 5 hit this; host jobs never do.
- **`PATH`:** `aidenhq`, `aidenhq-browse` and cargo were off `PATH`.
  - Codex runs `bash -lc`, and `/etc/profile` resets `PATH` to Debian's default, dropping the job env's
    `/opt/aidenhq/bin`.
  - 33 commands prefixed `export PATH=/opt/aidenhq/bin:$PATH`, after about 5 discovery calls.
- **`gh`:** it has no token in the box, so `gh pr list --json files` failed. The rewrite-hold check became one
  `github_issue_read` per PR, done twice: 29 reads, about 3 min.

## What each side started with

| | Owning agent | Engineer |
|---|---|---|
| Prompt | 76k characters: handbook, shared sections, delegator's task (earlier PRs, endpoint, rewrite-hold note) | 35k characters: job rules, App Engineer handbook, the task (files, PR, endpoint, held PRs) twice |
| Repo context | none (never cloned) | full clone; the repo's `AGENTS.md` (read at step 3), which was stale: "server-rendered views", old page files, no header, dialog or pages, no single-test or preview command |
| Tools | `app_view`, `app_api`, `app_status`, GitHub MCP, task tools, warehouse, search | shell (`rg`, `git`, `sed`, node toolchain), GitHub MCP reads, `aidenhq-browse`/`agent-browser`, no `gh` token |
| Git history | PR descriptions only | `git log -S`/`git show` available and used (1.8 min in) |

## What the runner gives a job at start

- the task text, fenced as untrusted, plus the owner's newest comment (or the description again) as instructions;
- the job rules and how-we-build section;
- the Engineer's handbook and the engine's working-habits file (`modules/engine-codex/codex-home/AGENTS.md`);
- full clones of the task's repositories with remote branches fetched.

There is no summary of recent PRs. A job reads the repo's own `AGENTS.md` first, by habit.

## Changes (this PR)

1. **Delegations carry the "where"** (`scripts/paperclip-setup.mjs`, delegating section). When the delegator has
   located the code, the task names:
   - the files and lines;
   - the PR or commit that last changed them;
   - for a restore, the removing commit's `git show <sha> -- <path>`.

   This brief already had most of it; the missing piece was the sha.
2. **Engineers work in fewer, bigger steps** (how-we-build section, which reaches every Engineer job and builder, and the
   engine's habits file):
   - start from the task's pointers and the history of those paths before broad searching;
   - read several files per command, each once;
   - make all of a change's edits in one patch;
   - run the targeted tests once after the edits, and the full suite once before publishing.

   **Test level:** data and API behaviour get a server-level test, and what people see and click is proven in the
   browser run. When a UI harness needs a second workaround, prove that interaction in the browser instead. That
   addresses the 20-minute phase, the largest in this case.
3. **Every app repo has an `AGENTS.md` map:**
   - The app starter's `AGENTS.md` now opens with a Map (route or piece → owning file), the run/test/lint commands
     (including one test file) and a keep-current rule.
   - The delegating section and the DevOps Engineer's handbook require the map, and ask for it to be written or updated
     in the PR that changes screens or routes.
   - The engine habits file tells Engineers to update it.
   - The case's app got a rewritten `AGENTS.md`: the route → file table, the single-test command, a one-line seeded
     preview, the dialog-test pattern to copy, and the dead files marked (separate PR on the app repo).
4. **Design review is scoped to changed screens:**
   - The runner's design-review task now tells the reviewer to review only the screens the PR's changed files render.
   - The reviewer lists the UI files from the PR itself, maps them to routes through the repo's `AGENTS.md` map and
     `feature-map.json`, runs `ui-review --paths` on those routes, and adds a quick look at `/`. Verdict semantics are
     unchanged.
   - The task carries no file names. They are the PR author's text, and a runner-written instruction would make them
     read as instructions (security review). The routes come from the repo's own map.
   - In this case the change was the shared header, so the review already covered just `/` and `/updates`. The saving
     comes on apps with many pages.
5. **Tools in the agent computers** (`services/computer/images/agent-base/Dockerfile`):
   - `apply_patch` is on `PATH` as a symlink to the pinned Codex binary, which runs its patch tool by name. No new
     dependency, and the build checks that it applies a patch.
   - A `/etc/profile.d` line puts `/opt/aidenhq/bin` and cargo back on `PATH` for login shells.

## Tools considered

Searches were 52 of 377 calls (7% of wall time) and plain-text; reads were 56 calls (11%). What is already there: `rg`
(apt in the agent base; Codex vendors its own on the host) and `jq`.

| Tool | Benefit here (evidence) | Supply-chain cost | Decision |
|---|---|---|---|
| `apply_patch` shim | 3 failed edits and about 30 fragile regex edits in this job; 5 of 31 recent box jobs | none (the pinned Codex binary) | **added** |
| Login-shell `PATH` fix | 33 manual `PATH` exports and about 5 discovery calls | none | **added** |
| fd | about 3 `find` calls; `rg --files` covers it | apt, unpinned in sid (versions vanish) or a GitHub release pin | deferred |
| ast-grep | none: every search was a string or identifier | npm `@ast-grep/cli` pinned | deferred until a structural refactor needs it |
| universal-ctags / repo map | small: the task named the files; the `AGENTS.md` map is the repo map | apt | deferred; the map does the job |
| TypeScript LSP / symbol-search MCP | maybe 5–10 of the `rg` + `sed` pairs | new MCP server and process per job | deferred: thin evidence, real upkeep |
| git-delta | none (a human pager) | apt | no |
| A token-backed `gh` (or a PR-files tool) in the box | the 29 one-PR-at-a-time reads of the rewrite-hold check | a credential in the box: a security decision | done after this PR (owner approved): the runner's read-only App token for the task's repos, as host jobs get |

## Expected saving for a change like this one

| Phase | Was | Expected | Why |
|---|---|---|---|
| Orient | 3.5 min | 2.5 min | the map, the pointers and batched reads |
| Tests | 20 min | about 4 min | server-level test, dialog pattern named in `AGENTS.md`, browser proof for the interaction |
| Browser verification | 13.7 min | about 8 min | the preview one-liner in `AGENTS.md`, `PATH` fixed; the overflow catch stays (it was real) |
| Friction and re-reads | about 3 min | about 1 min | `apply_patch`, `PATH` |

Total: about 42 → 20 minutes of job time, with fewer turns and so roughly half the tokens. The review legs (code review
6.5 min, design review 12 min, in parallel) are unchanged for a shared-header change; design review gets faster on
changes confined to one page of a many-page app.
