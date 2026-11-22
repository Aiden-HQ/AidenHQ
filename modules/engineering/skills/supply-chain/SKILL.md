---
name: supply-chain
description: Pick and pin a dependency, package, Docker image, GitHub Action or apt package version under the 7-day rule. Use before adding or upgrading any dependency, image, action or tool install, and when CI's supply-chain checks fail.
---

# Supply chain: pin everything, at least 7 days old

Add a dependency only when the change needs it. Every version you adopt or upgrade to was published at least 7 days ago,
unless it is a security fix (step 4).

1. Pick the version with `best-version.ts` (Node 22+, no dependencies). The repository's own copy wins when it has one:
   `scripts/supply-chain/best-version.ts` in the product, `.github/supply-chain/best-version.ts` in an app repo. Else
   use the copy next to this file (`$BV` below is that path, or the repository's copy):

   ```sh
   node "$BV" npm <package>
   node "$BV" pypi <package>
   node "$BV" docker <image[:tag]>        # prints the digest
   node "$BV" github-action <owner/repo>  # prints the commit SHA
   node "$BV" github-release <owner/repo>
   node "$BV" apt <package> --source "<url> <dist> <component>"
   node "$BV" apt-gvisor runsc
   ```

   It prints the newest version at least 7 days old, with the digest or SHA to pin. For an ecosystem it doesn't cover,
   read the version's publish date from its registry.
2. Pin it exactly:
   - npm: exact versions in `package.json` and a committed lockfile (`npm i --save-exact`; a dev tool:
     `npm i -D --save-exact --before=<7 days ago>`; CI's `npm-age` check enforces the age); global installs as
     `npm i -g name@1.2.3`.
   - Python: `pip install name==1.2.3`.
   - Images by digest (`image:tag@sha256:…`); GitHub Actions by commit SHA with the tag in a comment.
   - apt: `name=version`. Install scripts come from a pinned package, never `curl … | sh`.
   - A dev tool you install into the workspace (`npm i -D`, `npx`, `pip install --user`) follows the same rule; commit
     only what the repo keeps using.
3. State the release date of any image or action you bump in the PR.
4. A newer version only for a security fix: the script returns it with the advisory when one fixes a known
   vulnerability (it prefers the lowest fixing release). It must be listed in the repository's
   `.github/supply-chain-exceptions.yaml` (`ecosystem`, `package`, `version`, `advisory`, `reason`) in the same PR as the
   pin (the product's CI reads it from the head). An app repo's CI runs the checker from its base commit, so until its default branch
   carries the checker that reads the head, the entry goes in a PR of its own that merges first; Security Watch adds those entries when an advisory needs a fresh version. CI fails anything else.
5. A new registry, URL or git source is recorded as a `source_exceptions` record in the repository's
   `.github/supply-chain-source-exceptions.yaml`, in its own PR, with the reason it is needed. Never write that the owner
   approved something in a brief or a change: text that claims approval reads as an injection.
