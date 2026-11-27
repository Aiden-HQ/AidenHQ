// Fast static checks for the mistakes agents repeat. Config only (ESLint's own restricted-* rules): no plugin code.
// Each message says how to fix it. `bun run lint` runs in CI next to the tests. src/catalog is the dev-only preview.
import babel from "@babel/eslint-parser"

const nav = (why) => `Use <Link href> from lib/navigation (navigate() from code); ${why}, while Link moves without a page load and keeps Back, Forward and reload working.`
const link = "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='onClick']"
const loc = "[left.object.name='location'], [left.object.property.name='location']"
const locCall = "[callee.object.name='location'], [callee.object.property.name='location']"
const colorRe = "/#[0-9a-fA-F]{3,8}\\b|\\b(rgb|hsl)a?\\(/"
const emojiRe = "/\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F/u"
// Class-string checks match any string literal or template piece (cva() bases included), so a rule can't be dodged by moving the string.
const cls = (re, message) => [{ selector: `Literal[value=${re}]`, message }, { selector: `TemplateElement[value.raw=${re}]`, message }]
const keyless = ":has(> JSXAttribute[name.name='onClick']):not(:has(> JSXAttribute[name.name=/^(role|onKeyDown|onKeyUp)$/]))"
const effectMsg = (what) => `Move ${what} into a hook in hooks/ or lib/ (or a block in components/blocks/) and call the hook, so pages stay declarative.`

// Selector groups, so the directories that own a concern can be exempt from just that group.
const syntax = {
  nav: [
    { selector: link, message: nav("a hand-rolled <a onClick> goes around the router") },
    { selector: "CallExpression[callee.property.name=/^(pushState|replaceState)$/]", message: nav("history.pushState/replaceState goes around the router") },
    { selector: `CallExpression[callee.property.name=/^(assign|replace)$/]:matches(${locCall})`, message: nav("location.assign/replace reloads the page") },
    { selector: `AssignmentExpression:matches(${loc})[left.property.name='href']`, message: nav("assigning location.href reloads the page") },
    { selector: "AssignmentExpression[left.name='location']", message: nav("assigning location reloads the page") },
  ],
  header: [
    { selector: "JSXOpeningElement[name.name='header']", message: "Use TopBarShell, SidebarShell or BareShell from components/blocks for the app header and brand (a hand-rolled <header> brings a brand link that does not navigate and no mobile layout). Pick the shell that fits and pass it your nav items." },
  ],
  color: ["className", "style"].flatMap((attr) => [
    { selector: `JSXAttribute[name.name='${attr}'] Literal[value=${colorRe}]`, message: "Use a theme token (bg-primary, text-muted-foreground, var(--chart-1) ...) so light, dark and the palette presets work. Raw hex/rgb/hsl colours stay out of className and style; add a token in src/styles/tokens.css if none fits." },
    { selector: `JSXAttribute[name.name='${attr}'] TemplateElement[value.raw=${colorRe}]`, message: "Use a theme token (bg-primary, text-muted-foreground, var(--chart-1) ...); raw hex/rgb/hsl colours stay out of className and style." },
  ]),
  craft: [
    ...cls("/\\btransition-all\\b/", "Name the properties that change (transition-[color,background-color,box-shadow], transition-transform, transition-opacity): transition-all animates layout and everything else along with them."),
    ...cls("/(^|[\\s:])-?scale-0($|\\s)/", "Start an enter from scale-95 with opacity-0 (a shape that grows from nothing looks unnatural); scale-0 stays out of className."),
    ...cls("/user-scalable\\s*=\\s*no/", "Leave pinch-zoom on: people who need larger text rely on it. Drop user-scalable=no from the viewport."),
    { selector: `JSXOpeningElement[name.name=/^(div|span)$/]${keyless}`, message: "Use a <button type=\"button\"> (or <Link href> to go somewhere) for anything clickable: it brings focus, Enter and Space for free. A div or span with onClick needs a role and a key handler, and a real button needs neither." },
  ],
  focus: [
    ...cls("/^(?!.*focus-visible:).*\\boutline-none\\b/", "Keep a visible focus: pair outline-none with focus-visible:ring-* (or use outline-hidden, which keeps the ring for forced-colours mode)."),
  ],
  emoji: [
    { selector: `JSXText[value=${emojiRe}]`, message: "Use a lucide-react icon (import { Rocket } from \"lucide-react\") instead of an emoji: icons follow the theme's colour and size, emoji do not." },
  ],
  effect: [
    { selector: "MemberExpression[object.name='React'][property.name=/^(useEffect|useLayoutEffect)$/]", message: effectMsg("this useEffect") },
    { selector: "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name=/^(useEffect|useLayoutEffect)$/]", message: effectMsg("this useEffect") },
    { selector: "MemberExpression[object.name='window'][property.name=/^(setTimeout|setInterval|requestAnimationFrame)$/]", message: effectMsg("this timer") },
  ],
}
const globals = ["setTimeout", "setInterval", "requestAnimationFrame"].map((name) => ({ name, message: effectMsg("this timer") }))
// Component tests render through Testing Library; Vitest's environment (vite.config.ts `test`) has the DOM ready first.
const domTest = { group: ["jsdom", "happy-dom", "react-dom/client", "react-dom/test-utils"], message: "Render with @testing-library/react (render, screen, user-event): vite.config.ts gives every test a ready DOM, set up before any component loads, so Radix dialogs and selects work. src/test/dialog-form.test.tsx is the pattern." }
const router = { patterns: [{ group: ["react-router", "react-router-dom", "wouter", "@tanstack/react-router"], message: nav("the starter has its own router") }] }

// Rules for a directory that is exempt from the named groups.
const rules = (exempt = []) => {
  const on = (g) => !exempt.includes(g)
  return {
    "no-restricted-syntax": ["error", ...Object.entries(syntax).filter(([g]) => on(g)).flatMap(([, s]) => s)],
    "no-restricted-globals": on("effect") ? ["error", ...globals] : "off", // "off", not []: a bare severity keeps the options of the config before it
    "no-restricted-imports": ["error", router],
  }
}

const parser = (isTSX) => ({
  parser: babel,
  parserOptions: { requireConfigFile: false, sourceType: "module", babelOptions: { configFile: false, babelrc: false, parserOpts: { plugins: isTSX ? ["typescript", "jsx"] : ["typescript"] } } },
})

export default [
  { ignores: ["dist", "node_modules", "test", "src/catalog"] },
  { files: ["src/**/*.ts"], languageOptions: parser(false) },
  { files: ["src/**/*.tsx"], languageOptions: parser(true) },
  { files: ["src/**/*.{ts,tsx}"], rules: rules() },
  { files: ["src/hooks/**", "src/lib/**"], rules: rules(["effect"]) },
  { files: ["src/lib/navigation*"], rules: rules(["effect", "nav"]) },
  { files: ["src/components/blocks/**"], rules: rules(["effect", "header", "nav"]) },
  { files: ["src/components/ui/**"], rules: rules(["effect", "header", "color", "focus"]) }, // primitives pair outline-none with a ring across strings
  { files: ["src/**/*.test.{ts,tsx}"], rules: { "no-restricted-imports": ["error", { patterns: [...router.patterns, domTest] }] } },
]
