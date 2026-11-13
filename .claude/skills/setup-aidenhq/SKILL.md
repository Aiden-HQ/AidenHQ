---
name: setup-aidenhq
description: Walk a person through installing their own AidenHQ instance from SETUP.md, running the setup scripts and each step's Check. Use when asked to "set up AidenHQ", "install my instance", "install AidenHQ on my server" or "walk me through SETUP.md".
---

# Set up AidenHQ

SETUP.md is the only source of steps and checks. This skill drives it; it does not restate it. Read the section
before you run it, and if SETUP.md and this skill ever disagree, SETUP.md wins.

## Rules

- Do one SETUP.md section at a time, in order. Run the commands the section gives and then its **Check**, exactly as
  written there. Never invent a check of your own.
- A failed Check stops the walk. Show the person the output, diagnose from SETUP.md and
  [docs/setup.md](../../../docs/setup.md), fix, re-run the Check. Do not continue past a failure.
- Never run `sudo`, and never run or open pairing links, OAuth consent pages or one-time setup links. Steps marked
  **[human]** and **[org admin]** in SETUP.md's intro are the person's: give the exact command or URL and wait.
- Never print secrets (keys, `person.env` contents, the vault recovery key, setup links beyond handing them over).
- Ask only for decisions only the person can make, with AskUserQuestion: multiple choice, recommended option first,
  room for their own answer. Do not ask what SETUP.md or the machine already answers.
- Commands run on the server. If you are on a laptop, run them over `ssh <you>@<host>`.

## Walk

1. **Orient.** Read [SETUP.md](../../../SETUP.md) top to bottom once. Ask (multiple choice) where the server will
   run (own hypervisor or cloud as in section 1 option A, Proxmox as option B) and which modules to install; ask
   for free-text only where there is no sensible choice: the Linux user, host address, instance name, GitHub agents
   org name, the company name.
2. **Section 0, "What you need before you start".** List which table rows are [org admin] items still missing and
   say who must supply them. Offer to continue with what is available.
3. **Section 1, "Create the VM"** and **section 2, "Get the product checkout"**: help with the commands the
   chosen option lists; their Checks are the gate.
4. **Section 3, "Run `ops/setup.sh`"**: help write `~/person.env` from the person's answers (placeholders for
   secrets, which they paste in themselves; never echo them). Run `ops/setup.sh --config person.env --dry-run`
   first and review its output with the person; then the real run (anything needing `sudo` is handed over). Run
   every Check in that section's table.
5. **Sections 4 to 6** (secrets, board sign-in, Paperclip): hand over the human parts, run the Checks.
6. **Section 7, "Connect your accounts"**: ask which accounts to connect (Google, Telegram, Slack, others). Do the
   chosen subsections only; the unchosen ones are skipped, not failures.
7. **Section 8, "GitHub App"** and **section 9, "Your first agent"**: optional. Ask whether to do them now.
8. **Section 10, "Health check"**: run `scripts/healthcheck.sh` and `scripts/verify-security.sh` and judge them
   by that section's Check text. Finish by reminding the person to delete `~/person.env`.

Report at the end: which sections passed their Check, which were skipped on purpose, and what is left for the
person.
