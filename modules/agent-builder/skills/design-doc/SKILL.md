---
name: design-doc
description: "Provides the layout of a new agent's design doc on Primer as a filled example to copy (template.md). Use when writing an agent design for the owner's review on Primer."
---

# An agent's design doc

Copy `template.md` here (a complete doc for an example agent, Review Chaser), keep its headings, tables and layout, and
replace every example value with your agent:

1. Three header lines, with the agent's name.
2. **At a glance**: name, job in one line, what wakes it, schedule, whom it reports to.
3. **How each run works**: one Mermaid `flowchart LR` from the wake through each step to output and escalation, then the same
   steps "In words". Quote every label, write decisions as `{"…?"}` with `-- "yes" -->` edges, keep labels short, connect every node.
4. **What it can read and change**.
5. **Schedule and cost**: runs a month, cost a run and a month.
6. **Onboarding plan**, **Examples** (what happens, what a good result contains) and **Open decisions**, each with the recommended
   choice in bold and why in a few words.

Write in plain words for the owner: no file names, YAML, tool names or grants. Stay well under 80,000 characters and
publish with `primer_create_document` (`format: markdown`).
