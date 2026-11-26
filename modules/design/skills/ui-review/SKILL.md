---
name: ui-review
description: "How the UI Reviewer reviews an app or a PR's UI on request: run the app on seed data, capture every page at every width and theme with the `ui-review` engine, review it as a designer, show the top fixes rendered and proven, and report with evidence. Use for any request to review, critique or improve how an app looks and feels."
---

# Reviewing a UI

The engine `ui-review` (in your computer) captures, measures and asks the model with the prompts it ships; you choose the
app, run it, read what it finds, implement the top fixes and write the report. Work in `/workspace/review` (one folder per
run: `captures/`, `report.json`, `report.md`).

## Run the app

- **A repo or a PR:** `repo-checkout <org/name> <sha>`, then start it as its `AGENTS.md` or README says, on seed, fixture or
  demo data and a local port (never a real database). For a PR, check out the base and the head, one after the other, each
  on its own port.
- **No repo (a URL):** review the URL as given. A live URL gets passive capture and hover only; the route check and any
  click run only on a local build (`127.0.0.1` or `localhost`).
- An app with no way to run on sample data: review the live app, and list "a seed mode for UI review" under what to add.

## Page list

The app's `feature-map.json` (its pages and stateful URLs) is the list when it exists. Without one, read the app's router
and routes with `/opt/aidenhq/ui-review/prompts/router-read.md` and write `pages.json`: every page with a path, a kind
(`PageKind`) and, for a stateful one, the state to reach. `ui-review pages <url> --out review` reads links and sitemaps
when the router read leaves gaps. `--map <file>` points the engine at another file of the same shape.

## Capture

```sh
ui-review capture <url> --out review --workers 4          # 390, 768, 1024, 1512, 1920, 2560 wide, light and dark
ui-review routes <url> --out review                        # the route check: local builds only
```

`--widths 360,…` adds a width, `--states empty,error,loading` the states the app can show, `--pages-file <f>` a subset of
pages, `--resume` continues a run that stopped (a big app queues at most 120 pages per run and records the rest as
`deferred`). A page that never settles is captured with a `not settled` note: read the note before judging it.
For a PR, capture the base into `before/` and the head with `--baseline before` into `after/`; run the pages the changed
files render (a shared shell or header shows on every page: `/` and one other page cover it). A page with no before
capture is a cold page: describe what you see there as notes.

## References

`ui-review refs /opt/aidenhq/ui-review/refs/references.json --out review/refs` measures the best products' pages of each
`PageKind`. Add the public pages the `library.owner-taste` skill lists for the same kinds (at most two pages per site; the
engine paces its requests).

## Review

Write the owner's taste (the text of `library.owner-taste`, when you have it) and the app's brand or design-system
guidelines to files, then:

```sh
ui-review review review --taste taste.md --brand brand.md --model <the ask's model, else the default>
```

The default model suits a normal review; `anthropic/claude-opus-5.5` is the thorough option when the ask says "thorough".
The result is `improvements` (ranked, each naming where, what is weak, the change, why, what the best product does, and its
captures) and `motion` in `report.json`, rendered in `report.md`. Read it against the captures: open each cited image,
drop an improvement the picture doesn't show, and sharpen one that is vague into values (sizes, colours, spacing).

## Show the fix

The top 3 improvements each get a rendered fix, one at a time, in a throwaway copy of the repo:

1. Implement the change with Claude Code or Codex, headless, through the gateway your box already has:
   `claude -p "<the improvement>" --model anthropic/claude-sonnet-5.5` with `ANTHROPIC_BASE_URL` = `OPENROUTER_BASE_URL`
   without its `/v1`, `ANTHROPIC_AUTH_TOKEN` = `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` empty and the three
   `ANTHROPIC_DEFAULT_*_MODEL` variables set to the model; or `codex exec` on `openai/gpt-6.2-sol` with a provider whose
   `base_url` is `OPENROUTER_BASE_URL`, `env_key = "OPENROUTER_API_KEY"` and `wire_api = "responses"`. The same base URL and run
   token your own harness uses.
2. Rebuild, then `ui-review capture --pages-file <that page> --baseline review/captures --out fix-N`.
3. `ui-review fix-check <before.png> <after.png> --width <the width where the change shows>` prints
   `{ wins, accepted }`. Accepted: keep `git diff` as the fix and the before|after pair. Rejected, or the build failed: revert
   the change, keep the improvement as text and record `fix: failed` with the build error's first line.
4. Collateral: recapture every other page at that width and at 390 with `--baseline review/captures`; a page whose pixels
   change by 0.1% or more is listed with the fix.

## Report

Evidence first: `design_run_start { target, kind: "review", model }`, then `design_evidence_put` the report's cited
captures, the before|after pairs and each fix's diff (8 MB per call), then `design_run_finish { run, report }`.

Then one comment on your task (`task_comment`, then `task_finish`): the improvements ranked, each with where, what is weak,
the change, why, what the best product does and, for a fixed one, its before|after image attached with `task_file_upload`
(`base64 -w0 <file>` as `data`, `type: "image/png"`) and the diff in words; then the bugs the checks confirmed (each with its
capture and the fix); then a short list of cold-page notes for a PR. For a PR ask also post one PR comment with the headline
findings (`github_issue_comment`; GitHub takes no images from you). A request to land a fix goes to an Engineer with
`task_delegate`: the repo, the PR, each fix's diff and how you will check it.
If an upload fails, say so and describe what the image shows; one try is enough.

## Learning taste

Every design correction the owner makes becomes a rule in `library.owner-taste` with `self_change`: the rule, its reason, and
`(inferred)` after the reason when it is a guess. State it as what to do, with the value.

## Regression set

When asked: `node /opt/aidenhq/design-eval/run.ts <suite>`. Post its results on the asking task.
