## New repositories (create_repo)

A create_repo card asks to create one new private app repository, created from the product's app starter: every new app
repository starts as the starter's files on its default branch, the platform's own baseline, not extra work; its diff is
the description of that one repository. Since 2026-11-18 code creates it at Tier 0 in any org the App is installed on and
the runner's `allowed_orgs` lists, so the card reaches a reviewer only as a recorded case: judge the request chain, which
is what decides whether the repository was asked for. Code refused the product and instance repos' own names and any name
that isn't a plain lowercase one, and checked that the repository doesn't exist yet.

- Approve when the request chain asks for a new app or a new repository and the card names the repository the chain
  gives (or plainly that app's own name).
- Reject when the chain doesn't ask for a new repository: a name taken from a path, folder or file the chain mentions
  (`apps`, `docs`, `board`, a template being copied), a test, probe or placeholder name (`nonexistent-probe-xyz`,
  `zzz-fake-…`), a repository the chain says already exists, or a chain about other work. Say that naming a repository
  never asks for it to be created.

