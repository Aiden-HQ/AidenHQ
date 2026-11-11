# Guidelines

How AidenHQ apps look and behave. The UI/UX Engineer reviews every UI pull request against this page; only real usability
or visual defects block a merge, everything else goes to the design backlog.

## Principles

1. **Simplest thing that works.** Fewer screens, fewer controls, fewer options. Remove before adding.
2. **Answer first.** A screen says what needs attention; the owner shouldn't have to hunt or click to find it.
3. **Phone first.** Designed at 390px wide, then given room on desktop. No horizontal page scroll, ever.
4. **Plain words.** No jargon or internal names on screens people see.
5. **No speculative UI.** No settings, toggles or "advanced" panels until the second time someone needs one.

## Layout

- One column on phone; 16px side gutters (`--gutter`); content max 960px (`.page`).
- Spacing only from the scale: 4, 8, 12, 16, 24, 32, 48 (`--space-1` … `--space-7`). Related things close, groups apart.
- One primary action per screen (`.btn-primary`), placed where the thumb reaches on phone (bottom of the form or card).

## Navigation

- Primary destinations are always visible: `.bottombar` on phone (at most 5), `.topbar nav` on desktop.
- No hamburger menus for main sections, no hover-only controls, no screen without a way back.
- The current place is marked (`aria-current="page"`).

## Type

- Only the scale: 13, 15, 17, 20, 24, 30 (`--text-xs` … `--text-2xl`). Body 15-17px, line height 1.5. Nothing below 13px.
- One `.title` per screen; `.heading` for sections. Hierarchy by size, weight and space, not by color or boxes.
- Numbers in tables right-aligned with tabular figures (`.num`). Recent dates relative ("2h ago"), absolute on hover/tap.

## Color and themes

- Only tokens from `tokens.css`; no literal colors in app CSS.
- Light and dark both work: test both. Colors come from tokens, so dark mode is free unless something is hard-coded.
- Contrast WCAG AA: 4.5:1 for body text, 3:1 for large text, icons and control borders. Muted gray on gray is the usual
  failure.
- Meaning colors (ok, warn, danger) always come with a word or icon, never color alone.

## Controls

- Tap targets at least 44px (`--tap`); never closer than 8px apart.
- Buttons say what they do ("Save note", not "OK"). Destructive actions are `.btn-danger` and ask once.
- Forms: a visible label on every field (`.label`), hints below (`.hint`), errors next to the field (`.field-error`) in
  words that say how to fix it.

## States

Every list and data view has all three:

- **Empty** (`.empty`): what goes here and how to add the first one.
- **Loading** (`.skeleton` shaped like the content): no layout jump when the data arrives.
- **Error** (`.error-state`): what went wrong in plain words, and a retry.

## Motion

- Only to explain a change, 150-200ms (`--duration`). `prefers-reduced-motion` turns it off (the tokens do this).

## What blocks a UI pull request

Blocking: something can't be done, read or reached on a phone; contrast failures; a broken theme; tap targets under
40px; a missing empty, loading or error state; hidden or lost navigation; a break from the system users will see as a bug.

Not blocking (backlog): spacing a few pixels off the scale, copy polish, a nicer layout idea, a literal that should be a
token. When unsure, it's not blocking.
