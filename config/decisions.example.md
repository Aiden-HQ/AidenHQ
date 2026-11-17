# Product decisions

Copy this to `decisions.md` at the root of your instance repo. The AI reviewer reads it from the instance repo's `main` on
every review and rejects a change that builds what an entry says not to build, or reverses a decision, unless the owner's
own words in the request ask for it. A change to this file is judged against `main`'s copy, never its own. Keep it short
(the reviewer reads the first 8,000 characters): one line per entry, with its date and source. Newer entries win.

## Not building

- A fax connection: nobody at Acme sends faxes any more. (2026-01-12, owner)
- A second chat bot per team: one bot per company, routed by channel. (2026-02-03, D-4)

## Decided

- Every agent uses the same model unless its definition names another. (2026-01-20, owner)
- Agents send as their own labelled identity, never as the owner's account. (2026-01-05, D-1)
