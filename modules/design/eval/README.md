# UI review regression set

Run on request, never in CI: whenever the review prompt, a default model or the engine changes. The UI Reviewer runs it too
(skill `design.ui-review`, "Regression set"). In an agent computer:

    node /opt/aidenhq/design-eval/run.ts degraded|fixes|references|calibrate|corrections [--model m] [--rated file] [--cases dir]

From a checkout: `AIDENHQ_UI_REVIEW=<checkout>/services/computer/images/agent-base/ui-review AIDENHQ_APP_STARTER=<checkout>/modules/apps-platform/starter
node modules/design/eval/run.ts degraded` (needs `AGENT_BROWSER_EXECUTABLE_PATH` for a Chrome, and the engine's `npm ci`).
It prints one JSON line per suite (with the spend in `usd`) and exits 1 below the suite's bar. Use the capped eval key
(`openrouter_eval_key`) by hand, or the fleet's gateway from an agent box. A full `degraded` + `fixes` run costs about $0.5.

Shots go to `--work <dir>` and are reused when they are already there, so they can be taken where Chrome is and the model
calls made elsewhere: `--capture-only` stops after the shots.

| Suite | What it checks | Bar |
|---|---|---|
| `degraded` | 4 starter pages x 4 subtle degradations (`degrade.ts`: 2-4px vertical spacing jitter, one extra font size, one off-palette colour, a 2px misalignment). The reviewer picks the original and names the kind of change. The original alternates between A and B. | original picked >= 15/16; change named >= 12/16 |
| `fixes` | 6 good and 6 bad fix cases (`fixes/<case>/{patch.css,expect.json}`) through `fixCheck`. `patch.css` makes the starter page worse. A good case shows the patched page as BEFORE and the starter as AFTER; a bad case the starter as BEFORE and the patched page as AFTER. | good accepted >= 16/18, bad accepted <= 1/18 (kept as ratios over the 36 sample-orders of 6 cases) |
| `references` | The same pages reviewed twice, with the engine's `refs/references.json` and with `refs/fallback.json`, everything else equal: specificity (improvements naming a region and a concrete value), the share naming a reference token, and with `--rated` the rank agreement of each variant. `--targets <file>` lists `{ name, url, pages[] }` (default: the starter's own pages). Needs `ui-review capture` and `refs`. | none until the first run |
| `calibrate` | The reviewer's order over `--rated` products (2 pages each, 4 requests a second, GET only) against the rated scores, 3 shuffled samples. Format: `rated.example.json`; the real file is the instance's `design/eval/rated.json`. | Spearman rho >= 0.6, and the owner's apps below every site |
| `corrections` | `--cases <dir>`: one `*.json` per owner correction, `{ url, page, width, theme, expect: { where, change } }` (regexes); each expected improvement appears in the top 10. No cases is a failure. Needs `ui-review capture`. | all found |

Notes. `degraded` scores "names the change" as the reviewer's single choice of kind (spacing, font-size, colour, alignment,
other) for the worse version. Ratings, correction cases and answer keys (`kind`, `expect`) are scoring data: they are never in a
prompt. Change a bar only with the owner.
