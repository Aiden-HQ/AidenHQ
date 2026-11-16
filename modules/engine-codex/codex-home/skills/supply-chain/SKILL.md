---
name: supply-chain
description: Pick and pin a dependency, package, Docker image, GitHub Action or apt package version under the 7-day rule. Use before adding or upgrading any dependency, image, action or tool install, and when CI's supply-chain checks fail.
---

# Supply chain: pin everything, nothing newer than 7 days

Unless it is a security fix, never adopt or upgrade to a version published less than 7 days ago.

1. Pick the version with the bundled script (Node 22+, no dependencies; the repo's own copy wins when it has one,
   `scripts/supply-chain/best-version.mjs` or `.github/supply-chain/best-version.mjs`):

   ```sh
   node "$CODEX_HOME/skills/supply-chain/best-version.mjs" npm <package>
   node "$CODEX_HOME/skills/supply-chain/best-version.mjs" pypi <package>
   node "$CODEX_HOME/skills/supply-chain/best-version.mjs" docker <image[:tag]>        # prints the digest
   node "$CODEX_HOME/skills/supply-chain/best-version.mjs" github-action <owner/repo>  # prints the commit SHA
   node "$CODEX_HOME/skills/supply-chain/best-version.mjs" github-release <owner/repo>
   ```

2. Pin it exactly:
   - npm: exact versions in `package.json` and a committed lockfile (`npm i --save-exact`); global installs as `name@1.2.3`.
   - Python: `name==1.2.3`.
   - Images by digest (`image:tag@sha256:…`); GitHub Actions by commit SHA with the tag in a comment.
   - apt: `pkg=version`. Never `curl … | sh`.
3. State the release date of any image or action you bump in the PR.
4. A newer version only for a security fix that the repo's `.github/supply-chain-exceptions.yaml` lists (with its
   advisory), in a PR that lands first. The script already prefers the lowest fixing release when OSV knows of a hole.
