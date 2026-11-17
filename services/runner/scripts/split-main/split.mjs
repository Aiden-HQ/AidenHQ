// Splits services/runner/src/main.mjs by concern into src/<dir>/*.ts, moving every top-level statement byte for byte.
// Usage: node split.mjs <runner dir> <manifest.json> [--only N]   (N: extract only the first N files of the manifest)
// Fails loudly on: a top-level declaration the manifest doesn't place, a manifest name that no longer exists, a top-level
// `let` written from another file, a sibling file read while modules evaluate (TDZ), context importing a sibling.
import ts from "typescript";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [runnerDir, manifestPath, ...rest] = process.argv.slice(2);
const only = rest[0] === "--only" ? Number(rest[1]) : Infinity;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const mainPath = join(runnerDir, "src/main.mjs");
const src = readFileSync(mainPath, "utf8");
const program = ts.createProgram([mainPath], { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(mainPath);
const errors = [];
const ENTRY = "main.mjs";
const UNSPLIT = "unsplit.ts"; // with --only: what is not split out yet, as one module (the entry can't be imported)
const fileNames = Object.keys(manifest.files).slice(0, only);

// ---- imports: local symbol → { decl index, kind, imported name }
const imports = []; // { spec, default?, ns?, named: [{ imported, local }], text, typeOnly }
const importOf = new Map(); // symbol → { imp, local }
for (const st of sf.statements) {
  if (!ts.isImportDeclaration(st)) continue;
  const imp = { spec: st.moduleSpecifier.text, named: [], st };
  const c = st.importClause;
  if (c?.name) { imp.default = c.name.text; importOf.set(checker.getSymbolAtLocation(c.name), { imp, local: c.name.text }); }
  if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) { imp.ns = c.namedBindings.name.text; importOf.set(checker.getSymbolAtLocation(c.namedBindings.name), { imp, local: imp.ns }); }
  if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
    for (const el of c.namedBindings.elements) {
      const n = { imported: (el.propertyName ?? el.name).text, local: el.name.text };
      imp.named.push(n);
      importOf.set(checker.getSymbolAtLocation(el.name), { imp, local: n.local });
    }
  }
  imports.push(imp);
}

// ---- top-level statements and where each goes
const keyOf = (st) =>
  ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) ? st.name.text : ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText()).join(",") : undefined;
const placed = new Map(); // key → file
for (const [f, keys] of Object.entries(manifest.files)) for (const k of keys) {
  if (placed.has(k)) errors.push(`placed twice: ${k}`);
  placed.set(k, f);
}
const stmts = sf.statements.filter((s) => !ts.isImportDeclaration(s));
const entryFrom = stmts.findIndex((s) => !keyOf(s) && s.getText().startsWith(manifest.entryFrom));
if (entryFrom < 0) errors.push(`entryFrom not found: ${manifest.entryFrom}`);
const seen = new Set();
let prev = ENTRY;
const fileOfStmt = stmts.map((s, i) => {
  const k = keyOf(s);
  let f;
  if (k) {
    seen.add(k);
    f = placed.get(k);
    if (!f) { errors.push(`unplaced top-level declaration: ${k} (line ${sf.getLineAndCharacterOfPosition(s.getStart()).line + 1})`); f = ENTRY; }
    prev = f;
  } else f = i >= entryFrom ? ENTRY : prev; // a side effect goes with the declaration it follows
  return f === ENTRY || fileNames.includes(f) ? f : UNSPLIT;
});
for (const k of placed.keys()) if (!seen.has(k)) errors.push(`manifest names a declaration that no longer exists: ${k}`);

// ---- top-level symbols
const topSym = new Map(); // symbol → { file, kind: "function"|"class"|"let"|"const", name }
const bindingNames = (n, out = []) => {
  if (ts.isIdentifier(n)) out.push(n);
  else for (const el of n.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
};
stmts.forEach((s, i) => {
  const file = fileOfStmt[i];
  if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) topSym.set(checker.getSymbolAtLocation(s.name), { file, kind: ts.isClassDeclaration(s) ? "class" : "function", name: s.name.text });
  if (ts.isVariableStatement(s)) {
    const kind = s.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
    for (const d of s.declarationList.declarations) for (const id of bindingNames(d.name)) topSym.set(checker.getSymbolAtLocation(id), { file, kind, name: id.text });
  }
});

// ---- references
const symOf = (id) => {
  const p = id.parent;
  if (p && ts.isShorthandPropertyAssignment(p) && p.name === id) return checker.getShorthandAssignmentValueSymbol(p);
  return checker.getSymbolAtLocation(id);
};
const uses = new Map(); // file → { ext: Map(imp → Set(local)), sib: Map(file → Set(name)) }
const useOf = (f) => uses.get(f) ?? (uses.set(f, { ext: new Map(), sib: new Map() }), uses.get(f));
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);
const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AsteriskEqualsToken]);
const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
stmts.forEach((s, i) => {
  const file = fileOfStmt[i];
  const u = useOf(file);
  const walk = (n, inFn) => {
    if (ts.isIdentifier(n)) {
      const sym = symOf(n);
      const imp = sym && importOf.get(sym);
      if (imp) { const set = u.ext.get(imp.imp) ?? new Set(); set.add(imp.local); u.ext.set(imp.imp, set); }
      const top = sym && topSym.get(sym);
      if (top && top.file !== file) {
        const set = u.sib.get(top.file) ?? new Set(); set.add(top.name); u.sib.set(top.file, set);
        // read while modules evaluate: a sibling's const/let/class is in its TDZ until that module has run
        if (!inFn && top.kind !== "function" && top.file !== "context.ts" && file !== ENTRY) errors.push(`evaluated at load: ${file} reads ${top.name} from ${top.file} (line ${line(n)})`);
        if (!inFn && top.kind === "function" && file !== ENTRY) console.warn(`note: ${file} calls ${top.name} (${top.file}) at load (line ${line(n)})`);
      }
    }
    // a top-level let written from another file
    const target = ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) ? n.left : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator) ? n.operand : undefined;
    if (target) for (const id of ts.isIdentifier(target) ? [target] : []) {
      const top = topSym.get(checker.getSymbolAtLocation(id));
      if (top?.kind === "let" && top.file !== file) errors.push(`let written from another file: ${top.name} (declared in ${top.file}) written in ${file} (line ${line(id)})`);
    }
    ts.forEachChild(n, (c) => walk(c, inFn || isFn(n)));
  };
  walk(s, false);
});
if (uses.get("context.ts")?.sib.size) errors.push(`context.ts imports siblings: ${[...uses.get("context.ts").sib.keys()]}`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

// ---- output
const order = [...fileNames, ...(fileOfStmt.includes(UNSPLIT) ? [UNSPLIT] : [])];
const exportsOf = new Map();
for (const [, u] of uses) for (const [f, names] of u.sib) { const set = exportsOf.get(f) ?? new Set(); names.forEach((n) => set.add(n)); exportsOf.set(f, set); }
const rewrite = (spec, file) => (file === ENTRY || !(spec.startsWith("./") || spec.startsWith("../")) ? spec : spec.startsWith("./") ? `../${spec.slice(2)}` : `../${spec}`);
const importLines = (file) => {
  const u = useOf(file);
  const out = [];
  for (const imp of imports) {
    const used = u.ext.get(imp);
    if (!used) continue;
    const spec = JSON.stringify(rewrite(imp.spec, file));
    if (imp.ns) { out.push(`import * as ${imp.ns} from ${spec};`); continue; }
    const named = imp.named.filter((n) => used.has(n.local)).map((n) => (n.imported === n.local ? n.local : `${n.imported} as ${n.local}`));
    const parts = [imp.default && used.has(imp.default) ? imp.default : undefined, named.length ? `{ ${named.join(", ")} }` : undefined].filter(Boolean);
    out.push(`import ${parts.join(", ")} from ${spec};`);
  }
  for (const f of order) {
    const names = u.sib.get(f);
    const from = `"${file === ENTRY ? `./${manifest.dir}/` : "./"}${f}"`;
    if (names?.size) out.push(`import { ${[...names].sort().join(", ")} } from ${from};`);
    else if (file === ENTRY) out.push(`import ${from};`); // every module loads, in manifest order
  }
  return out;
};
const body = (file) => stmts.map((s, i) => (fileOfStmt[i] === file ? src.slice(s.getFullStart(), s.end) : undefined)).filter((t) => t !== undefined).join("").replace(/^\n+/, "");
const outDir = join(runnerDir, "src", manifest.dir);
rmSync(outDir, { recursive: true, force: true });
if (order.length) mkdirSync(outDir, { recursive: true });
for (const f of order) {
  const ex = [...(exportsOf.get(f) ?? [])].sort();
  const text = `${importLines(f).join("\n")}\n\n${body(f)}\n${ex.length ? `\nexport { ${ex.join(", ")} };\n` : ""}`;
  writeFileSync(join(outDir, f), text);
}
// the entry: its header (shebang and comments before the first import), its imports, what stays
const firstImport = sf.statements.find(ts.isImportDeclaration);
const header = src.slice(0, firstImport.getStart());
const entryImports = importLines(ENTRY);
writeFileSync(mainPath, `${header}${entryImports.join("\n")}\n\n${body(ENTRY)}\n`);
console.log(`split ${order.length} file(s): ${order.join(", ")}`);
