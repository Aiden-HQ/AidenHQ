# codehost-local

The on-server code host (`docs/design/codehost-local.md` in the product repo): every repository of the org `local` is a
bare repo on this server, so a fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. It
provides the `codehost` role beside `codehost-github`; each repository is hosted by the provider that owns its org.

The kernel runs it in process (it has no service):

- `src/host.ts`: the executor of its write kinds (`create_repo`, `push`, `pr`, `merge`, `close`: the same actions as
  codehost-github's, tiered by the same `plan.mjs` rules), and a repo's clone into a job's workspace. A `pr` opens a change
  request (`codehost:local/<name>/change/<n>`, git refs in the bare repo); a `merge` squashes it onto the default branch once
  its `change` check job passed on its exact head.
- `src/snapshot.ts`: a repo's tree at a commit, for check jobs and an Engineer's repo-checkout.
- `src/apply.ts`: a kernel apply landed on the instance repo's bare repo.

A change's checks run as check jobs (kernel/src/checkjobs.ts) in a credential-free box, never on the host.
