# codehost-local

The on-server code host (`docs/design/codehost-local.md` in the product repo): every repository of the org `local` is a
bare repo on this server, so a fresh install with no GitHub builds, reviews, merges and deploys agent-made apps. It
provides the `codehost` role beside `codehost-github`; each repository is hosted by the provider that owns its org.

`src/apply.ts` lands a kernel apply on the instance repo's bare repo on this host.

A change's checks run as check jobs (`POST /v1/checks`, kernel/src/checkjobs.ts) in a credential-free box, never on the host.
