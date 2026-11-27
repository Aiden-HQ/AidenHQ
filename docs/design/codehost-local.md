# On-server code host (`codehost-local`)

A fresh install with no GitHub builds, reviews, merges and deploys agent-made apps, with every repository kept on the
server. Module: `modules/codehost-local` (README there). The kernel runs it in process: it has no service and no token.
Setup's local instance repo (`local/aidenhq-instance`, a bare repo at `$HOME/aidenhq-instance.git`) is the same
shape: a change is a `kernel.apply` record whose card carries the exact diff, landed as one new commit on `main`.

## 1. Pieces

| File | Role |
|---|---|
| `src/host.ts` | Executor of the write kinds `codehost-local.{push,pr,merge,close,create_repo}` (registered by the kernel while the module is enabled), change-request refs, the squash merge, Flow facts, churn, a repo bundle for clones |
| `src/git.ts` | Hardened git (no hooks, fsmonitor, `ext::` transport, global or system config; literal pathspecs), where each repo's bare dir is, `ingest` of a job's bundle |
| `src/snapshot.ts` | A repo's tree at a commit as a tar with no `.git`, for check jobs and an Engineer's `repo-checkout` |
| `src/apply.ts` | The kernel apply land on the instance repo (read, land by compare-and-swap, write a settings change) |
| `checks/tests.sh`, `checks/history.sh` | The `change` check job's recipe (a copy of `github`'s, kept by `scripts/sync-shared.ts`) |
| `kernel/src/codehost.ts` | `hostOf`, `routeKind`, the broker's `snapshot` op for `local/*`, `localFacts` |
| `kernel/src/localmerge.ts` | The auto-merge pass (section 5) |

## 2. The code host role

- `codehost-local` and `github` each declare `provides: [ codehost ]`; `engineering` and `design` require `codehost`
  (any provider). The default bundle (`modules/marketplace.json`) carries both, so a repo is hosted by whichever provider owns
  its org.
- **One host per repo, decided by its org** (`hostOf` in `kernel/src/codehost.ts`): `codehost-local` owns the org `local`;
  `github` owns every other org. A write names an action (`codehost.push|pr|merge|close|create_repo`) and `routeKind` turns it
  into the owning host's kind; a write naming repos on two hosts is refused. A new repo named without its org goes to the
  GitHub fleet org once `github_fleet_org` is set, else to `local`; an existing repo keeps its host.
- **Where fleet repos go** is one setting: `github_fleet_org` (the github module's; compile writes it to the kernel's modules
  file as `repos.fleet_org`, read per call). Unset, the handbooks name only `local`. Set while GitHub is disconnected, a
  `create_repo` there refuses "GitHub isn't connected" rather than landing in `local`. The kernel treats `local` as an
  agents org too while `codehost-local` is enabled (`kernel/src/main.ts`).
- Tiering is `modules/github/service/src/plan.ts`'s, shared: `codehost-local` adds no tiering of its own beyond the rule
  `local-merge` (Tier 1; `LOCAL_ORG` is `local` there). The product repo is always on GitHub.
- Bound by the owner: a local agents-org merge goes to the AI reviewer at Tier 1 (`local-merge`); both providers run together;
  a feature is offered in full or not at all.

## 3. Repos on the server

- Bare repos at `<data dir>/codehost/local/<name>.git`, written only by the kernel (`bareOf` in `git.ts`; a name that is not a
  plain `local/<name>` is refused). The instance repo stays where setup made it (`AIDENHQ_INSTANCE_REMOTE`, passed to the host
  as `sources`). The data dir is in the sandbox's `hidden` list, so no job can read or write a repo directly.
- **Create repo** (`codehost-local.create_repo`, name `local/[a-z][a-z0-9-]{0,62}`): `git init --bare -b main`, then a first
  commit with a README on `main` (`update-ref` against the zero sha, so it fails if the repo exists).
- **A job never lets host git touch its workspace** (the GitHub code host the same: it has no clone op, and its job
  workspaces mount is read-only). An Engineer's box clones with `aidenhq clone <org/name>` (the kernel runs it in the box at
  the job's start for each repo the task names, `boxes.ts`) from a git bundle the kernel serves (the broker's `bundle` op, `codehost.ts`: Engineer jobs only, only repos its dispatcher's clone grant covers;
  every branch of a `local/…` repo, the default branch of a GitHub one), and the same command on a clone it has fetches a fresh
  bundle into `origin/*`. Its commits come back as a bundle
  its box wrote (`aidenhq publish|apply`, at `.aidenhq/bundles/<sha>.bundle`); `ingest` reads that one regular file (never
  through a symlink, inside that task's folder: `kernel/sdk/src/box-bundle.ts`, which the GitHub code host reads it with too), verifies it and fetches it with every object checked into
  `refs/ws/<task>/<branch>`, and the branch must be at the sha the request names.
- Planning reads a push into a throwaway repo (the real one's objects as alternates), so a refused request writes nothing.
  What the rules refuse on repo and branch alone (the instance or product repo, a branch namespace) is refused before anything
  is read in. A push to the default branch must be a fast-forward; other branches move by compare-and-swap.

## 4. Change requests: refs and kernel records, no database

A change request is the local counterpart of a PR. Its state is git refs in the bare repo, written only by the kernel; its
words, diff and decisions are kernel records.

| Ref | Holds |
|---|---|
| `refs/changes/<n>/head` | the change's current head |
| `refs/changes/<n>/base` | the default branch's tip when the head last moved |
| `refs/changes/<n>/opened` | the default branch's tip when it was opened, never moved by a push: a review.s base commit |
| `refs/changes/<n>/meta` | blob `{ title, body, branch, base, task, opened_at, draft }` |
| `refs/changes/<n>/merged` | the squash commit, once merged |
| `refs/changes/<n>/closed` | written when the change is closed |

`n` is the highest existing number plus one, taken under a per-repo lock inside the kernel. State is `merged` when the
`merged` ref exists, `closed` when `closed` exists, else `open`. URL: `codehost:local/<name>/change/<n>`.

- **Kinds:** the same actions, args, floors and path-based tiering as `github`'s. `pr` publishes a branch and opens the change
  for it, or moves the open change of that branch to its new head; `merge` names the change with its approved `head`; `close`
  writes the `closed` ref. Cards carry the diff (`git diff base...head`), the reviewer also reads each changed file at
  the head, read from the repo and workspace, never from the args.
- Apps-mcp's `/internal/open-prs` and `/internal/pr-states` answer for `local/*` from these refs (read-only mount, section 6).

## 5. Checks and merge

**Checks run as the kernel's `change` check job**, in a credential-free box on the change's snapshot (never on the host):
`checks/tests.sh` runs the secret scan (gitleaks with the base's config), the supply-chain checks (the product's
`scripts/supply-chain`, at `/opt/aidenhq/supply-chain` in the box) before anything is installed, then `bun install --frozen-lockfile --ignore-scripts`, the repo's lint, tests and build. The
scripts are the recipe's own copies, never the change's, so a change cannot loosen its checks. The kernel starts the job when
a change is opened and again when a base moved under an open one; the receipt is signed by the kernel and keyed to the exact
head and base. A missing or partial receipt counts as not passed; a running check reads as pending; a check that could not run
(no box, no snapshot) is `missing` and is asked for again, never red.

**No nudge: a green change asks for its merge itself** (`kernel/src/localmerge.ts`, a pass every 60 s). It files the same Tier 1
`local-merge` record an Engineer's `aidenhq merge` would, as the task's own agent, once per head and base, so the AI reviewer
still reads the diff and the caps apply. It never asks for a done or cancelled task, a task without an assigned granted agent,
a change with red or running checks, or one with no checks. A task whose own change is still open cannot reach `done`: the
finish gate refuses it, so the merge card is never approved on an already-closed task.

**The merge executes** (`host.ts` `merge`) only for an approved record, and waits up to 30 minutes for its checks to finish.
Code refuses with a reason each: `head-moved` (the change's head is not the record's), checks not green on that head, and a
conflict. It lands as a squash: `merge-tree` of the change against the current default branch, then one new commit
(`<title> (change <n>)`, committed as `AidenHQ`) with the base as its parent, written by compare-and-swap on the base ref, so a
base that moved during the merge is refused rather than overwritten (the task asks again and its checks rerun on the new base).
Afterwards it writes the `merged` ref and deletes the task branch. The merge's result carries the `merged-prs:` line.
The apps platform deploys `main` of a registered app as it does today.

**Not carried over locally:** merge trains and Actions re-runs, Dependabot (GitHub services), the image scan (a later build;
owner). The only required check is the `change` job.

## 6. Apps platform reads through the role

- apps-mcp mounts `<data dir>/codehost` read-only at `/codehost` (`modules/apps-platform/apps-mcp/src/codehost.ts`, active only
  while `codehost-local` is enabled in the compiled catalog) and only reads it: an app's branch for deploys, and the change refs
  for the board's PR reads and previews.
- **Previews:** `withLocal` makes the open changes (`refs/changes/*`) the previews' source for `local/*` apps; no comment is
  posted (the preview's URL and status stay on its row), and `/internal/open-prs` returns each change's `preview_url`, which
  the board's Fleet Ops open-PR row shows. The derived app, its sandbox and its removal on merge or close run unchanged.
- A job's `repo-checkout` and the check jobs read repos through the kernel's broker `snapshot` op, granted to a module by
  `codehost: snapshot:` in its `module.yaml` (`local/*` for this module); `clone` and the GitHub-only ops (fetch, head, read, comment, commit, runner_token) do not exist for `local`.

## 7. GitHub later

Connecting GitHub (one sign-in) and setting `github_fleet_org` (an owner change, applied) points new fleet repos at that
org; the `github` code host runs from the start. Local repos keep their host; new repos go to the GitHub org. Moving an existing repo to GitHub is not offered. Product
contributions (the Platform Engineer's product PRs, upstream issues) need GitHub and stay off until it is connected; instance
changes keep working locally through `kernel.apply`.
