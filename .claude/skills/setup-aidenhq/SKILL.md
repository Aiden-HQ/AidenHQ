---
name: setup-aidenhq
description: "Load when asked to set up AidenHQ, install an instance, or walk through docs/setup.md: drives the manual setup section by section with its Checks."
---

# Set up AidenHQ

docs/setup.md is the only source of steps and checks, and wins on any difference. Read it once, then do one section at a time, in order: its commands, then its **Check**, exactly as written. A failed Check stops the walk: show the output, diagnose from docs/setup.md, fix, re-run it.

- Never run `sudo`, nor open pairing links, OAuth consent pages or one-time setup links. **[human]** and **[org admin]** steps are the person's: give the exact command or URL and wait. Never print secrets (keys, `person.env` contents, the vault recovery key).
- Commands run on the server (over `ssh <you>@<host>` from a laptop).
- AskUserQuestion (multiple choice, recommended first) only for what the person alone decides: where the server runs (section 1 option A or B), modules, which accounts to connect in section 7 (unchosen are skipped, not failures), whether to do sections 8 and 9. Free text for the Linux user, host, instance name, GitHub agents org, company name.
- Section 3: write `~/person.env` with placeholders for secrets the person pastes, run `ops/setup.sh --config ~/person.env --dry-run` and review it with them before the real run. Section 10: `scripts/healthcheck.sh`, judged by its Check; end by reminding them to delete `~/person.env`.

Report which sections passed, which were skipped on purpose, and what is left for the person.
