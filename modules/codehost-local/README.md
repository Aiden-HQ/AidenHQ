# codehost-local

The on-server code host (`docs/design/codehost-local.md` in the product repo): every repository of the org `local` is a
bare repo on this server, so a fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. It
provides the `codehost` role beside `codehost-github`; each repository is hosted by the provider that owns its org.

`src/host.mjs` is the runner's side: bare repos under `<data dir>/codehost/<org>/<name>.git`, `createRepo`, `publish`,
change requests as refs (`refs/changes/<n>/{head,base,meta,merged,closed}`, URL `codehost:<org>/<name>/change/<n>`), the
checks receipt in `git notes --ref=checks` on the head, and the squash merge: `landOnMain` pushed without force, so a
moved `main` is redone once and a conflict is refused.

`src/checks.ts` runs a change's named checks for the runner, in the job jail at exactly its head: `secrets` first (pinned
gitleaks over base..head with the base's `.gitleaks.toml`, in a clone of its own, its config outside every folder the
change's code can write), then `tests` (the host's supply-chain scripts, the evidence rule, `npm ci`, lint, test, build) in
another clone. Every check's process group is killed when it ends.
