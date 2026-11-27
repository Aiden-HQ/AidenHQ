# Visual UI review: design

Status: approved v6 (owner, 2026-11-26; build all three phases). Evidence: three spikes on 2026-11-26 (bug finding, discovery/logins,
design critique), kept in the instance repo under `docs/product-history/research/2026-11-26-visual-ui-review/`.
Reviewed by a cold builder read and two Codex consults; "(my call)" marks choices made in those passes.

## Intent

The UIs we and every AidenHQ user build should be beautiful and easy to use. Today they aren't (owner: the board is
relatively poor; Roadmap Keeper weaker still), and nothing looks at a running app the way a designer would. The UI
Reviewer is a **professional product designer**: it opens an app at every width and theme, on every page, signed in where
needed, uses it like a person, and says, concretely and in priority order, what to change to make it more polished and
easier to use, showing each change rendered before|after. Finding bugs is the secondary job. Screenshots, recordings
and measurements exist mainly to serve the design review.

Built for every user who installs AidenHQ: any app, repo or URL, every exposure mode; taste comes from each user.

## Goals

- **Design review first**: ranked, concrete improvements to visual polish (hierarchy, spacing rhythm, type scale,
  colour, alignment, density, consistency across pages, responsiveness at every width, motion) and ease of use (clarity,
  flow friction, CTAs and key details, empty/error/loading states, feedback, accessibility), each with where, what is
  weak, the change, why, and a rendered before|after when the repo is available.
- **Verified bugs second**, from the same captures and a clicking pass.
- Four depths, one engine: code (diff review), public scan, signed-in scan, tester passes.
- People trigger it; schedules are opt-in per app. Users choose models, spend mode and live-app mode.

## Non-goals

A polish score or grade (models gave every site 6–9/10, Duolingo as high as Stripe: scores aren't reliable);
pixel-perfect regression against approved baselines; load testing; native mobile apps.

## Anti-goals

Generic advice ("improve hierarchy") with no where/what/how; findings not visible in the image; one model's or one
user's taste imposed on every install; unverified bug lists; changing real data on a live app; hammering third-party
sites; any automatic run on a PR, push or change; a second parallel way to review UI.

## What the spikes measured

Design critique (9 owner-rated reference sites, the board, Roadmap Keeper; 6 models × 7 methods):
- **Absolute scores are useless**: all 6–9/10; the board ~1 point under the reference sites.
- **Taste and references help most**: Opus with the owner's taste profile ranked sites closest to his ratings (rho
  0.60–0.70); Opus with Stripe/Linear screenshots as the bar scored the board 5.7 and Roadmap Keeper 5.0, closest to his
  view. Model order: Opus > Gemini Argon > Sol > DeepSeek Flash > Haiku ≈ Luna (Luna's suggestions 50% specific).
- **Public rubrics** (Impeccable, Anthropic design-critique, Vercel guidelines) did not beat a plain designer prompt;
  Impeccable was worst and costliest.
- **Measured design stats** improved ranking for Gemini but not its calibration.
- **Rendering the fix works**: 3/3, 45–52 s, $0.36–0.49 each, before|after images a person judges at a glance.
- **Motion from video** (Gemini): cheap but unreliable (hallucinated details, missed a real slide): measure motion instead.
- Pairwise "original vs degraded copy": every model preferred the original (the degradation was gross).
Bug finding: diff code review 9/10 planted bugs; screenshot models 4–8; rule tools 0; testers 0–4 each; before|after
removes noise; screenshots can't see behaviour, clicking can. Discovery: reading the router 61/61 and 13/13 pages.
Logins: supplied, repo-aware (4/4) and sign-up (3/3) all worked. Recording: 2–4 MB/min, ffmpeg already in agent-base.

## Approaches considered

- **A. One engine, one designer agent (chosen).** `ui-review` captures and measures; the UI Reviewer (one agent, one
  skill) writes the design review, renders top fixes, and verifies bugs. Front doors: on request (owner, agents), the
  code-review `ui` lens (report to Primer), and the "UI testing" Fleet page (opt-in schedules).
- **B. A scoring reviewer** (grade pages, track a polish score). Rejected: scores don't separate good from poor design.
- **C. Adopt a public critique skill as the reviewer** (Impeccable). Rejected by measurement: no better than a plain
  prompt, costlier; we reuse its checklists as reference text only.

## Design

### Engine: `ui-review` (agent-base)

Code owns: the coverage queue (pages × widths × themes × states, resumable); the page list (feature map, else the
router read in setup, else links + real sitemaps); **capture** at 360/390, 768/1024, 1512, 1920, 2560 × light/dark
(owner's full-viewport rule), scroll steps through the main scroller, frozen clock, empty/error/loading states where
reachable, reliable readiness (loading states cleared, capped), retries, partial results; **design measurements**
(distinct font sizes/weights, colours, radii, shadows, spacing values and 4/8px-scale fit, alignment near-misses,
content width vs viewport, CTA prominence, contrast, cross-page component inconsistency); **motion measurements** from
recordings and CSS (durations, easing, long tasks, layout shift during interactions); **rule checks** as evidence (page
errors, failed loads, blank routes, overflow, axe, dead-control candidates); politeness caps; session checks; the
browser launched by the engine, agents attach; evidence copied to the module's store.

### The UI Reviewer (the one agent)

1. **Design review** (primary). Inputs: the captures, the app's own design system/brand, a short **taste rule file**, and
   category-matched reference screens with their measured tokens (type scale, row height, radius, max width) for the
   page types under review (dashboard, list, settings, timeline…). Output: the top improvements per app, ranked by
   impact, each with where (page, width, theme, region), what is weak, the change (concrete: values, layout), why, what
   the best product in the category does instead, and which captures show it. No scores.
   The taste rule file (owner, 2026-11-26; we build for mass appeal): **widely agreed failures** are written as
   `NEVER <failure> → INSTEAD <fix>, because <reason>` (the form won 79% of blind comparisons against positive phrasing);
   a **user's personal taste** stays as softer positive preferences layered on top (ours: Stripe polish, Linear
   crispness, more colour, moderate radius, little white space, prominent CTAs, professional). The product ships the
   universal rules; each instance adds its owner's preferences, and every design correction an owner makes is distilled
   into that file (Emil Kowalski's `learn-taste` method: each rule with its reason, unconfirmed reasons marked inferred).
2. **Show the fix**: with the repo (a throwaway local build or preview), the agent implements the top improvements one
   at a time and re-captures. A fix is shown only when a pairwise check, judged at the width where the change shows,
   both orders, 3 samples, says AFTER is better than BEFORE (spike: real fixes 17/18 accepted at their width, bad fixes
   0/18). Otherwise the improvement stays text-only. The fix is a suggestion with its diff, never pushed by the reviewer.
3. **Ease of use**: a clicking pass (the Codex harness with agent-browser's `dogfood` skill) works the coverage queue's
   flows as the user's personas would, feeding friction findings into the design review and behaviour bugs into (4).
4. **Bugs** (secondary): one judging job per page, before|after when a baseline exists, reproduction for behaviour and
   unclear findings; only verified bugs are reported.
5. **Motion pass**: on measured motion only (computed transitions, `getAnimations()` with finished animations filtered by
   play state, `:active`/`:hover` rules, keyframes, long animation frames), reviewed against Emil Kowalski's
   `review-animations` standards and Jakub Krehel's polish checklist (both MIT); Before/After/Why rows checked against the
   CSS (spike: 14/17 correct). Never judged from video alone.
Not used (measured, no gain): trained taste models (UIClip too weak; Apple's RLDF research-only), pairwise ranking as a
calibration tool, a fidelity ledger, measured stats injected as facts, absolute scores.

### Logins and live apps

Unchanged from v4: supplied login → repo-aware least-privilege session → sign-up with a test mailbox → throwaway auth
patch (own repo, local build, never fork PRs); AidenHQ apps via the platform's per-request signed member identity; login
material never reaches the model. Live-app mode picked per run: read-only (default) / test account may write (dangerous
requests blocked) / anything.

### Front doors, triggers, outcomes

| Trigger | What runs | Where | Outcome |
|---|---|---|---|
| A PR touching UI files | the existing diff code review only | code-review box | GitHub review, as today |
| Someone asks the UI Reviewer (owner, Aiden, an agent) | design review + fixes + bugs, for a PR (before\|after) or an app | UI Reviewer's computer | report on its task (one PR comment for a PR) |
| A code-review run with `ui.scan` / `ui.scan-signed-in` | the same, scan depth | a whole-target check job | one report to Primer |
| The "UI testing" Fleet page (per app) | the same + clicking passes | UI Reviewer's computer | the design review as one "design improvements" issue per app (refreshed, not duplicated) with before\|after images; verified bugs as issues; no repo → a board report |
Never automatic on a PR, push or change. Per app: on request (default), after each deploy + daily cap (opt-in), 24/7
(opt-in); one active pass per app; the cap enforced in the gateway.

### Models

Per run or per app. Defaults (owner, 2026-11-26): design review, motion pass and fix confirmation on **Gemini 4 Carbon**
(best value: ~$0.023/page, specificity 0.97–1.00, top-tier calibration on the owner's sites; it scores our apps a little
high, which matters less with no scores in the output); Opus 5.5 offered as the thorough option (closest to the owner on
our own apps, ~$0.07/page). Fixes: Sonnet via Claude Code or Codex on Sol; clicking pass Codex on Sol; bug judging Carbon. Reasoning models at low effort with a large token limit.

### Evaluating the reviewer (kept as a regression set)

Re-run whenever the prompt, model or engine changes:
- **Taste calibration**: rank agreement with the owner's rated sites and apps (Stripe/shadcn > Linear > Monday ≈ Cal >
  Airtable ≈ Notion ≈ Raycast > Duolingo; board poor; Roadmap Keeper weaker). Other installs calibrate with their own
  rated examples.
- **Pairwise degraded copies**: subtle degradations (2–4px spacing jitter, one extra font size, an off-palette colour)
  of real pages; the reviewer must pick the original and name the change.
- **Specificity and correctness**: share of improvements with where/what/how, and a sample checked against the image.
- **Owner corrections**: every correction the owner makes to a review becomes a case (standing direction 5).

## Phasing

1. **Design review on request**: engine capture reliability (#1876 follow-ups, <10 min), measurements, coverage queue
   and page list, the design-review prompt with taste profile and reference screens, fix rendering, the evaluation set,
   report on task and via the code-review `ui` lens to Primer.
2. **Signed-in and bugs**: login ladder, AidenHQ identity, clicking pass, verified bugs.
3. **UI testing page**: per-app settings, opt-in schedules, issues, recordings and motion measurements.

## Left to the builder

Report layout; measurement thresholds; coverage bookkeeping; issue dedupe keys; the Fleet page layout (board design
system); how many improvements get a rendered fix per run (start with the top 3).
