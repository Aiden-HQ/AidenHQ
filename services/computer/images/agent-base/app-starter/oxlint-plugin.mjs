// Fast static checks for the mistakes agents repeat, as Oxlint JS-plugin rules (one rule per group, so a directory that owns
// a concern can be exempt from just that group: .oxlintrc.json overrides). Each message says how to fix it.
// `bun run lint` runs in CI next to the tests. src/catalog is the dev-only preview.
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
const groups = {
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

const restricted = (selectors) => ({
  meta: { type: "problem", schema: [] },
  create: (context) => Object.fromEntries(selectors.map(({ selector, message }) => [selector, (node) => context.report({ node, message })])),
})

export default { meta: { name: "app" }, rules: Object.fromEntries(Object.entries(groups).map(([g, s]) => [g, restricted(s)])) }
