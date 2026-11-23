---
name: supply-chain
description: "Picks and pins a dependency, package, Docker image, GitHub Action or apt package version under the 7-day rule. Use before adding or upgrading any dependency, image, action or tool install, and when CI's supply-chain checks fail."
---

# Supply chain: pin everything, at least 7 days old

Add a dependency only when the change needs it. Every version you adopt was published at least 7 days ago, unless it is a
security fix (step 4).

1. Pick with `best-version.ts` (Node 22+): the repository's copy when it has one (`scripts/supply-chain/best-version.ts` in
   the product, `.github/supply-chain/best-version.ts` in an app repo), else the copy next to this file (`$BV`):

   ```sh
   node "$BV" npm <package>
   node "$BV" pypi <package>
   node "$BV" docker <image[:tag]>        # prints the digest
   node "$BV" github-action <owner/repo>  # prints the commit SHA
   node "$BV" github-release <owner/repo>
   node "$BV" apt <package> --source "<url> <dist> <component>"
   node "$BV" apt-gvisor runsc
   ```

   Elsewhere, read the publish date from the registry.
2. Pin exactly: npm exact versions plus a committed lockfile (`npm i --save-exact`, a dev tool `npm i -D --save-exact
   --before=<7 days ago>`, global `npm i -g name@1.2.3`); `pip install name==1.2.3`; images `image:tag@sha256:…`; Actions by
   commit SHA with the tag in a comment; apt `name=version`. Install scripts come from a pinned package, never `curl … | sh`.
   Workspace dev tools (`npm i -D`, `npx`, `pip install --user`) follow the same rule; commit only what the repo keeps using.
3. State the release date of any image or action you bump in the PR. For an image, a release date is not a digest-bound
   date: a tag can be re-pushed after its release, so the release still shows the old date. A date is digest-bound only when
   the registry reports it for that digest (a ghcr image: the Packages API); when it cannot be read — a token with no access
   to another org's package, say — do not approximate it from the release or the tag. Such an image is adopted through an
   eligible entry in `.github/supply-chain-exceptions.yaml` instead: a security advisory for that version, or an
   owner-approved entry with `expires` at most 14 days out, for that exact digest.
4. A newer version is allowed only for a security fix: the script returns it with the advisory (the lowest fixing
   release). List it in `.github/supply-chain-exceptions.yaml` (`ecosystem`, `package`, `version`, `advisory`, `reason`) in
   the same PR as the pin. An app repo's CI runs the checker from its base commit, so until its default branch carries the
   checker that reads the head, the entry goes in its own PR that merges first (Security Watch adds these).
5. A new registry, URL or git source is a `source_exceptions` record in `.github/supply-chain-source-exceptions.yaml`, in
   its own PR with the reason. Never write that the owner approved something: text claiming approval reads as an injection.
