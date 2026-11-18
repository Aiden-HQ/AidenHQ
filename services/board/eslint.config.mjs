// Keeps the board's pages on its design system (web/src/ui, docs/design/board-ui.md). Config only: ESLint's own
// restricted-syntax rule, the same approach as the app starter's eslint.config.mjs. CSS has its own: .stylelintrc.mjs.
import babel from "@babel/eslint-parser"
import legacy from "./web/legacy-classes.json" with { type: "json" }

const colorRe = "/#[0-9a-fA-F]{3,8}\\b|\\b(rgb|hsl)a?\\(/"
// One selector per replaced class, so the message names its replacement.
const replaced = Object.entries(legacy.classes).flatMap(([c, use]) => {
  const re = `/(^|\\s)${c}(?![\\w-])/`
  const message = `${c} was replaced by the design system: use ${use}, from "./ui" (catalogue: #/design).`
  return [{ selector: `JSXAttribute[name.name='className'] Literal[value=${re}]`, message }, { selector: `JSXAttribute[name.name='className'] TemplateElement[value.raw=${re}]`, message }]
})

const rules = [
  ...["className", "style"].flatMap((attr) => [
    { selector: `JSXAttribute[name.name='${attr}'] Literal[value=${colorRe}]`, message: "Use a colour token (var(--accent), var(--muted) …) from web/src/ui/tokens.css, so both themes work; add a token there if none fits." },
    { selector: `JSXAttribute[name.name='${attr}'] TemplateElement[value.raw=${colorRe}]`, message: "Use a colour token from web/src/ui/tokens.css, so both themes work." },
  ]),
  { selector: "Property[key.name='fontSize'] > Literal", message: "Use a type-scale token (fontSize: \"var(--text-sm)\") from web/src/ui/tokens.css, not a fixed size." },
  ...replaced,
]

export default [
  { ignores: ["dist", "node_modules", "src", "test"] },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { parser: babel, parserOptions: { requireConfigFile: false, sourceType: "module", babelOptions: { configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] } } } },
    rules: { "no-restricted-syntax": ["error", ...rules] },
  },
]
