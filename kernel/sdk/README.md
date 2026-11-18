# @aidenhq/sdk

The code AidenHQ modules share, one copy on npm. MIT. Entry points: `types`, `engine-io`, `kit`, `progress` (engines),
`caller` and `fence` (every module server: the kernel's caller assertion and the untrusted-text fence), `executor` (write
kinds), `reviewer` (reviewer@1), `source-store` (source writers; `pg` is a peer dependency) and `vendor/proxy`,
`vendor/oauth` (vendor connections; the MCP SDK, zod and pino are peer dependencies).

A module depends on an exact version (`"@aidenhq/sdk": "X.Y.Z"`). Our own scope is exempt from the 7-day rule, so a module
may pin a version the day it is published.

## Releasing

Push a tag `sdk-vX.Y.Z` on a commit of `main`. `.github/workflows/sdk-publish.yml` takes the version from the tag and publishes
with npm trusted publishing (provenance, no token). Pull requests that touch this folder dry-run the same publish. The pack
step (`scripts/sdk-pack.mjs`) compiles with this folder's own TypeScript: `npm ci` here first.
