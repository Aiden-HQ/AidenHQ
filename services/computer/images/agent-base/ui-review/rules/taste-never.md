# Universal design rules: failure and fix

Failure modes a reviewer looks for and what the design does instead. Each rule keeps its reason. A reason marked
`(inferred)` is a plausible explanation the evidence did not confirm.

1. NEVER flat unlayered surfaces, heavy shadows or mixed radii → INSTEAD hairline borders with a gentle shadow and one radius family, because layered depth separates content without noise and mixed radii read as unfinished (inferred).
2. NEVER zoomed-in or oversized type, or many near-identical sizes → INSTEAD 14-16px body on a clear stepped scale, because oversized type looks unprofessional and near-identical sizes blur the hierarchy (inferred).
3. NEVER big empty areas or cramped, misaligned rows → INSTEAD compact, aligned rows and grids with padding used to group related things, because wasted space pushes content below the fold and uneven rows are hard to scan (inferred).
4. NEVER washed-out or competing calls to action, or key facts buried in muted text → INSTEAD one filled accent primary action per view and the key facts (status, counts, amounts, deadlines) largest or boldest, because people find the next step and the answer first.
5. NEVER low-contrast text, icons, borders or focus rings → INSTEAD clearly visible ones in light and dark, because unreadable text and invisible focus make a page unusable for many people.
6. NEVER a narrow centred column or half-width cards on a wide screen → INSTEAD grids that fill the container and add columns at 2560, with a clean stacked mobile view, because half-empty wide screens look broken.
7. NEVER a screen that makes people hunt for the next step, or lists with uneven rows → INSTEAD one main question per screen, an obvious next step and consistent row heights, because scanning cost is what makes a screen feel hard.
8. NEVER vague buttons ("Submit", "OK") or jargon headings → INSTEAD verb plus object ("Save changes") and headings that name the section's content in plain words, because people choose faster when a label says what happens (inferred).
9. NEVER a data view without empty, loading or error states, or invented values → INSTEAD states written for that view, and unknown stays unknown, because a blank or invented screen costs trust (inferred) (inferred).
10. NEVER slow, bouncy or long transitions, or animation on frequent actions → INSTEAD hover and colour changes 120-180ms, presses about 90ms, enters ease out, exits shorter, drawers under 300ms, because frequent actions must feel instant and quiet.
