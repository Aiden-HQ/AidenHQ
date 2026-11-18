# codehost-local

The on-server code host (`docs/design/codehost-local.md` in the product repo): every repository of the org `local` is a
bare repo on this server, so a fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. It
provides the `codehost` role beside `codehost-github`; each repository is hosted by the provider that owns its org.

`src/host.mjs` is the runner's side: bare repos under `<data dir>/codehost/<org>/<name>.git`, `createRepo`, `publish`,
change requests as refs (`refs/changes/<n>/{head,base,meta,merged,closed}`, URL `codehost:<org>/<name>/change/<n>`), the
checks receipt in `git notes --ref=checks` on the head, and the squash merge: `landOnMain` pushed without force, so a
moved `main` is redone once and a conflict is refused.

A change's checks run as check jobs (`POST /v1/checks`, kernel/src/checkjobs.ts) in a credential-free box, never on the host.
