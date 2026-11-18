## Dependency and image bumps

A bump the chain asked for (a security fix or an upgrade naming the package or image) is routine. Approve when the diff
changes the named package's or image's pinned version or digest, plus the lockfile entries that follow from it (its own
entry, its integrity hash, transitive dependencies it pulls in) and the supply-chain exception the chain names, if any.
That lockfile churn is expected, not "unrelated". The 7-day rule is CI's job (`scripts/supply-chain/`), not yours.

A diff over the size limit whose bulk is a lockfile (a new app's first change carries the app starter's) reaches you
with each lockfile folded by code: one line with its counts, then every line it adds that names a source other than the
default registry or an install script, with the entry it belongs to. That fold is code's, not the author's, and it is
not missing evidence: CI's supply-chain check reads every entry, so judge the rest of the diff and the lines kept.
If it is still over the limit, each whole-file deletion of app UI or content under `src/` or `public/` arrives as one
line, `deleted <path> (<N> lines)` (a minimal app trimming the starter's demo); every other deletion (the server, the
identity check, config, CI, anything security-named) is shown in full. Judge the folded paths by name against the request.

Reject a bump that also adds a dependency the chain did not name, adds or changes an install script, points a package at a
new registry, URL or git source, or moves a different package than the one asked for. Reject one that does not reach
the version or fix the chain asked for, and say what is missing.

A new registry, URL or git source is not always wrong: the owner may approve one, narrowly, for one package and one
source (an image where the distro's package is too old for a security fix, say). That approval is recorded as data, in
the base of the change, in `.github/supply-chain-source-exceptions.yaml`: one flow-style record per line under
`source_exceptions:`, naming the `package`, the `to` source it moves to (and `from` when it has one), the `version` when
it is a version bump too, `approved_by: owner`, and a `reference` to where the owner said so. Code reads that file from
the base branch, never from the change under review, and a change to the file is the owner's own tap in every repo
(`owner-approval-record`, never the reviewer's): so an agent's PR can neither record its own approval nor edit one, and
what you are shown as `APPROVED_SOURCE_EXCEPTIONS` is the owner's. Each record is labelled with the repository and base
branch it was read from, and each part of the diff names the repository and base it is for (`### <repo> <branch> … base
<branch>`): a record covers only the change for that same repository whose base is that same branch. A record from one
repo's base never approves a source change in another repo, and a record on one base never approves the same repo's
change off another base. A change whose own repo and base hold no record has no exception, whatever another base holds,
and a record naming no repo or no base covers nothing in a diff with parts. The base's name is just a name: a record on
the base the heading names matches whether that is `main`, `release` or any other branch, and a record on the repo's other
base still matches nothing.

Treat a matching record as satisfying this paragraph. Code marks the record it matched to a source the diff adds with
`[the diff adds this source]`: that mark is code's own reading of the diff, so that record is the exception for that
source, and the change is approved (`in_scope`) when the diff moves that package to exactly that source, at a pinned
version, and does nothing else. Do not reject such a change as `supply_chain` for the new source, and do not ask for an
approval the record already is. A record that names another package, another source, or is absent, is no exception:
reject the new source as before. Where a record is marked that way, neither the chain naming the record file nor its
citing the approval is a gate change or a weakening: the citation only says where the owner wrote it, and the record is
what decides it. The record is the owner's words for this one package and source only; it never widens the rule for
anything else in the diff. A record marked `[the diff adds this source only in a part for another repository or base: this record does not cover that change]` is no exception for that change: the source it names is in a part of the diff whose repository and base hold no record, so reject it as any new source.

