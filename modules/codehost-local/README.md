# codehost-local

The on-server code host (`docs/design/codehost-local.md` in the product repo): every repository of the org `local` is a
bare repo on this server, so a fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. It
provides the `codehost` role beside `codehost-github`; each repository is hosted by the provider that owns its org.

The kernel runs it in process (it has no service):

- `src/kinds.ts`: the write kinds themselves (`create_repo`, `push`, `pr`, `merge`, `close`: the same actions as
  codehost-github's, each with its args schema, floor and card, and this module's own in-process executor, so there is no
  service URL, no key and no GitHub App). `kernel/src/main.ts` registers them, and a `codehost.<action>` naming a `local/*`
  repo routes to them (`kernel/src/codehost.ts`).
- `src/host.ts`: the executor of those kinds, tiered by the same `plan.ts` rules, and a repo's clone into a job's workspace. A `pr` opens a change
  request (`codehost:local/<name>/change/<n>`, git refs in the bare repo); a `merge` squashes it onto the default branch once
  its `change` check job passed on its exact head.
- `src/snapshot.ts`: a repo's tree at a commit, for check jobs and an Engineer's repo-checkout.
- `src/apply.ts`: a kernel apply landed on the instance repo's bare repo.

A change's checks run as check jobs (kernel/src/checkjobs.ts) in a credential-free box, never on the host: the kernel asks for
the `change` recipe when a change is opened, and again when a base moves under an open change.

**No nudge.** A green change asks for its merge itself: the kernel's `localmerge.ts` files the same Tier 1 `local-merge` record
an Engineer's `aidenhq merge` would, as the task's own agent, once per head and base, so the AI reviewer still reads the diff
and the caps still apply. It is never asked for a done or cancelled task, nor for a change whose checks are red or still
running. And a task whose own change is still open cannot reach `done`: the finish gate refuses it, green-but-unmerged most
of all, so the merge card is never approved on an already-closed task (AidenHQ#709).

**The merge's refusals** are code's (`src/refuse.ts`), with a test each in `test/refuse.test.ts`: a head that isn't the
change's current head (`head-moved`), a required check missing, red or still running past the wait on that head
(`checks-not-green`), and a base that conflicts, including a base ref that moves during the merge (`conflict`). It lands by
compare-and-swap on the base ref, so a base that moved refuses instead of landing unchecked, and the task branch goes.
