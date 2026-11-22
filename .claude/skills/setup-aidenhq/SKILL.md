---
name: setup-aidenhq
description: Load when asked to "set up AidenHQ", "install my instance", "install AidenHQ on my server" or "walk me through docs/setup.md": drives the manual setup section by section with its Checks.
---

# Set up AidenHQ

docs/setup.md is the only source of steps and checks; this skill drives it and docs/setup.md wins on any difference. Read it top to bottom once, then do one section at a time, in order: run its commands and then its **Check**, exactly as written.

- A failed Check stops the walk: show the output, diagnose from docs/setup.md, fix, re-run the Check.
- Never run `sudo`, and never run or open pairing links, OAuth consent pages or one-time setup links. Steps marked **[human]** and **[org admin]** are the person's: give the exact command or URL and wait.
- Never print secrets (keys, `person.env` contents, the vault recovery key).
- Commands run on the server; from a laptop, use `ssh <you>@<host>`.
- Ask with AskUserQuestion (multiple choice, recommended first, room for their own answer) only what the person alone can decide: where the server runs (section 1 option A cloud or own hypervisor, B Proxmox), which modules, which accounts to connect in section 7 (unchosen ones are skipped, not failures), whether to do the optional sections 8 and 9 now. Free text only for the Linux user, host address, instance name, GitHub agents org and company name.
- Section 0: list the missing [org admin] items and who supplies them. Section 3: write `~/person.env` with placeholders for secrets the person pastes themselves, run `ops/setup.sh --config person.env --dry-run` and review it with them before the real run. Section 10: run `scripts/healthcheck.sh` and judge it by that section's Check; finish by reminding the person to delete `~/person.env`.

Report which sections passed, which were skipped on purpose, and what is left for the person.
