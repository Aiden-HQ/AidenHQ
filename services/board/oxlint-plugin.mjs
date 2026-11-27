// Keeps the board's pages on its design system (web/src/ui, docs/design/board-ui.md): colour literals, fixed font sizes and
// the classes the design system replaced. Each rule is a list of selectors with a message that says how to fix it.
// CSS has its own checks: .stylelintrc.mjs.
import legacy from "./web/legacy-classes.json" with { type: "json" }

const colorSelector = "/#[0-9a-fA-F]{3,8}\\b|\\b(rgb|hsl)a?\\(/"

const restricted = (selectors) => ({
  meta: { type: "problem", schema: [] },
  create: (context) => Object.fromEntries(selectors.map(({ selector, message }) => [selector, (node) => context.report({ node, message })])),
})

// One selector per replaced class, so the message names its replacement.
const replaced = Object.entries(legacy.classes).flatMap(([c, use]) => {
  const re = `/(^|\\s)${c}(?![\\w-])/`
  const message = `${c} was replaced by the design system: use ${use}, from "./ui" (catalogue: #/design).`
  return [{ selector: `JSXAttribute[name.name='className'] Literal[value=${re}]`, message }, { selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${re}]`, message }]
})

export default {
  meta: { name: "board" },
  rules: {
    "no-color-literal": restricted(["className", "style"].flatMap((attr) => [
      { selector: `JSXAttribute[name.name='${attr}'] Literal[value=${colorSelector}]`, message: "Use a colour token (var(--accent), var(--muted) …) from web/src/ui/tokens.css, so both themes work; add a token there if none fits." },
      { selector: `JSXAttribute[name.name='${attr}'] TemplateElement[value.raw=${colorSelector}]`, message: "Use a colour token from web/src/ui/tokens.css, so both themes work." },
    ])),
    "no-font-size-literal": restricted([{ selector: "Property[key.name='fontSize'] > Literal", message: "Use a type-scale token (fontSize: \"var(--text-sm)\") from web/src/ui/tokens.css, not a fixed size." }]),
    "no-legacy-class": restricted(replaced),
  },
}
