# codehost-local

## What it does

Repositories on this server as the code host: every repo of the org `local` is a bare repo here, so a fresh install with
no GitHub builds, reviews, merges and deploys the apps your agents make. It provides the `codehost` role beside the
`github` module, and each repo is hosted by the provider that owns its org. Design: `docs/design/codehost-local.md`.

## Connect

Nothing to connect: no service, no key, no GitHub App. The kernel runs it in process.

## What agents get

No tools. Agents work through the code host's write kinds (`create_repo`, `push`, `pr`, `merge`, `close`), each with its
own card and tier (`src/kinds.ts`, executor `src/host.ts`):

- A `pr` opens a change request (`codehost:local/<name>/change/<n>`, git refs in the bare repo). Its checks run as check
  jobs in a credential-free box, never on the host.
- A `merge` squashes onto the default branch once the `change` check passed on its exact head. The refusals are code's
  (`src/refuse.ts`): `head-moved`, `checks-not-green`, `conflict`. It lands by compare-and-swap on the base ref.
- No nudge: a green change asks for its own merge as a Tier 1 `local-merge` record, so the AI reviewer still reads the
  diff and the caps still apply. A task whose change is still open cannot reach `done`.

## New installs

In the default bundle: it is what lets a new install build apps with no GitHub. Nothing exists until an agent creates a
repo.
