---
name: design-doc
description: The layout of a new agent's design doc on Primer, as a filled example to copy. Use when you write a design for review on Primer.
---

# An agent's design doc

`template.md` here is a complete design doc for an example agent (Review Chaser). Copy it, keep its layout, headings and
tables, and replace every example value with the agent you designed:

1. The three header lines, with the agent's name.
2. **At a glance**: name, its job in one line, what wakes it, schedule, whom it reports to.
3. **How each run works**: one Mermaid `flowchart LR` from what wakes it, through each run's steps, to its output and
   escalation, then the same steps "In words". Keep every label in double quotes, decisions as `{"…?"}` with `-- "yes" -->`
   edges, and short labels; check that each node is connected.
4. **What it can read and change**.
5. **Schedule and cost**: runs a month, cost a run, cost a month (for the owner's information).
6. **Onboarding plan**, **Examples** (the test cases: what happens, and what a good result contains) and **Open decisions**, each
   with the recommended choice in bold and why in a few words.

Write it in plain words for the person, as in the example: no file names, YAML, tool names or grants. Keep it short
(well under 80,000 characters) and publish it with `primer_create_document` (`format: markdown`).
