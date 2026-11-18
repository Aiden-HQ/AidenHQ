# @aidenhq/sdk

Contract types, engine IO, the executor side of write kinds and the contract kit for AidenHQ modules. MIT.

## Releasing

Push a tag `sdk-vX.Y.Z` on a commit of `main`. `.github/workflows/sdk-publish.yml` takes the version from the tag and publishes
with npm trusted publishing (provenance, no token). Pull requests that touch this folder dry-run the same publish.

First version by hand: `node scripts/sdk-pack.mjs && cd kernel/sdk && npm publish --access public`.
