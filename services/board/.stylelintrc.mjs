// Keeps the board's CSS on its design tokens (web/src/ui/tokens.css): colours and font sizes come from there, and a
// class the design system replaced stays gone (web/legacy-classes.json). The token file is the one place raw values live.
import { readFileSync } from "node:fs"

const legacy = JSON.parse(readFileSync(new URL("./web/legacy-classes.json", import.meta.url), "utf8")).classes
const tokens = "Use a token from web/src/ui/tokens.css (add one there if none fits), so both themes and the type scale stay in one place."

export default {
  rules: {
    "color-no-hex": [true, { message: tokens }],
    "function-disallowed-list": [["rgb", "rgba", "hsl", "hsla"], { message: tokens }],
    "declaration-property-unit-disallowed-list": [{ "font-size": ["px"], font: ["px"] }, { message: tokens }],
    "selector-disallowed-list": [Object.keys(legacy).map((c) => new RegExp(`\\.${c}(?![\\w-])`)), { message: (s) => `${s}: this class was replaced by the design system (web/legacy-classes.json).` }],
  },
  overrides: [{ files: ["web/src/ui/tokens.css"], rules: { "color-no-hex": null, "function-disallowed-list": null, "declaration-property-unit-disallowed-list": null } }],
}
