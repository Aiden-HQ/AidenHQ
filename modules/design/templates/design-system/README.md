# design-system

The shared look of every AidenHQ app: design tokens, a small CSS component kit and the guidelines the UI/UX Engineer
reviews against. Owned by the UI/UX Engineer (agent `ui-designer`); changes are pull requests built by an Engineer and
reviewed like any UI change.

| File | What it is |
|---|---|
| `tokens.css` | Every color, type size, space, radius and duration, for light and dark. Apps use only these. |
| `components.css` | Plain CSS classes on top of the tokens: page layout, top and bottom bars, buttons, cards, lists, forms, badges, tables, empty/loading/error states. |
| `guidelines.md` | The rules: phone first, one primary action, the spacing and type scales, contrast, the three states, no hidden navigation, and what blocks a UI pull request. |

## Using it in an app

1. Copy `tokens.css` and `components.css` into the app's web folder (e.g. `web/design-system/`), and put this repo's
   commit in each file's `design-system commit:` line.
2. Load `tokens.css`, then `components.css`, before the app's own CSS.
3. Use the tokens and classes instead of literals. App CSS only adds what the kit doesn't have; if two apps need the same
   thing, it moves here.
4. To pick up a new version, copy the files again and update the commit line (one small PR).

Apps vendor the files rather than load them from here, so this repo can stay private and an app never changes under
its own feet.

## Changing it

Keep it small: a token or component earns its place when two apps need it. Every change keeps both themes and the
390px layout working, and updates `guidelines.md` when it changes a rule.
