// Light types for the split files: annotates exactly what strict tsc rejects, with `any`, until it stops changing.
// Erasable-only edits (`: any`, `?`), so stripping types gives back the moved code (verify.mjs).
// Usage: node types.mjs <runner dir> [dir=main]
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [runnerDir, dir = "main"] = process.argv.slice(2);
const target = resolve(runnerDir, "src", dir) + "/";
const cfgPath = join(runnerDir, "tsconfig.json");
const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } });

const innermost = (sf, pos, end) => {
  let n = sf;
  for (;;) {
    const c = n.getChildren(sf).find((k) => k.getStart(sf) <= pos && end <= k.end && k.kind !== ts.SyntaxKind.SyntaxList ? true : k.kind === ts.SyntaxKind.SyntaxList && k.pos <= pos && end <= k.end);
    if (!c) return n;
    n = c;
  }
};
const up = (n, pred) => { while (n && !pred(n)) n = n.parent; return n; };
const rootId = (n) => {
  for (;;) {
    if (ts.isIdentifier(n)) return n;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) n = n.expression;
    else return undefined;
  }
};

let pass = 0, fallback = false, fallbacks = 0;
const skip = new Set(); // last resorts that broke the parse: file:line:code
for (;;) {
  pass++;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName.startsWith(target));
  const edits = new Map(); // file → Map(pos → { text, rank })
  const residual = [];
  const add = (sf, pos, text, rank) => {
    const m = edits.get(sf.fileName) ?? new Map();
    const key = `${pos}:${text}`;
    m.set(key, { pos, text, rank });
    edits.set(sf.fileName, m);
  };
  // annotate a declaration (in a split file, untyped) with `: any`; false when it can't be
  const anyOn = (decl) => {
    if (!decl || !decl.getSourceFile().fileName.startsWith(target)) return false;
    const sf = decl.getSourceFile();
    if (ts.isBindingElement(decl)) decl = up(decl, (n) => ts.isVariableDeclaration(n) || ts.isParameter(n));
    if (!decl || decl.type) return false;
    // a for-of variable can't carry a type: its iterable's root does instead
    if (ts.isVariableDeclaration(decl) && decl.parent?.parent && ts.isForOfStatement(decl.parent.parent)) return anyOnExpr(decl.parent.parent.expression) || (fallback && asAny(decl.parent.parent.expression));
    if (ts.isParameter(decl)) { add(sf, (decl.questionToken ?? decl.name).end, decl.dotDotDotToken ? ": any[]" : ": any", 1); return true; }
    if (ts.isVariableDeclaration(decl)) { add(sf, (decl.exclamationToken ?? decl.name).end, ": any", 1); return true; }
    return false;
  };
  const declOf = (id) => {
    const sym = ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    const real = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    return real?.valueDeclaration;
  };
  // the root's declaration, else (a call like Object.entries(box)) its arguments' roots
  function anyOnExpr(e) {
    const id = rootId(e);
    if (id && anyOn(declOf(id))) return true;
    const call = ts.isCallExpression(e) ? e : undefined;
    return Boolean(call) && call.arguments.length > 0 && call.arguments.every((a) => anyOnExpr(a));
  }
  // last resort: (expr as any), once per expression per pass
  const wrapped = new Set();
  function asAny(e) {
    if (!e || !e.getSourceFile().fileName.startsWith(target)) return false;
    if (e.parent && ts.isShorthandPropertyAssignment(e.parent)) return false;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || (e.parent && ts.isPropertyAssignment(e.parent) && e.parent.name === e)) return false;
    if (ts.isAsExpression(e) || (ts.isParenthesizedExpression(e) && ts.isAsExpression(e.expression)) || (e.parent && ts.isAsExpression(e.parent)) || (e.parent && ts.isParenthesizedExpression(e.parent))) return false;
    const sf = e.getSourceFile(), k = `${sf.fileName}:${e.getStart()}:${e.end}`;
    if (wrapped.has(k)) return true;
    wrapped.add(k);
    add(sf, e.getStart(), "(", 3);
    add(sf, e.end, " as any)", 2);
    return true;
  }
  // an argument of the wrong type: a spread call's function returns any, a callback's parameter is any, or the
  // receiver of the method (environment.includes(x): environment) is any
  function lastResortArg(arg) {
    if (!arg) return false;
    if (ts.isSpreadElement(arg) && ts.isCallExpression(arg.expression)) {
      const decl = declOf(rootId(arg.expression) ?? arg.expression);
      const fn = decl && ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) ? decl.initializer : decl && ts.isFunctionDeclaration(decl) ? decl : undefined;
      const close = fn && !fn.type && fn.getChildren().find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
      if (close && fn.getSourceFile().fileName.startsWith(target)) { add(fn.getSourceFile(), close.end, ": any", 1); return true; }
      return false;
    }
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.parameters.some((p) => anyOn(p));
    const call = arg.parent && ts.isCallExpression(arg.parent) ? arg.parent : undefined;
    // the callee's own parameter (a default like `extra = []` is never[])
    const sig = call && checker.getResolvedSignature(call)?.getDeclaration();
    const param = sig?.parameters?.[call.arguments.indexOf(arg)];
    if (param && !param.dotDotDotToken && anyOn(param)) return true;
    return Boolean(call) && ts.isPropertyAccessExpression(call.expression) && anyOnExpr(call.expression.expression);
  }
  const exprAt = (n) => up(n, (x) => ts.isExpression(x) && !(x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x));
  const fbKey = new Map();
  const fbFiles = new Set(); // one last resort per file per pass, so edits never overlap
  for (const d of diags) {
    const sf = d.file;
    const dkey = `${sf.fileName}:${sf.getLineAndCharacterOfPosition(d.start).line}:${d.code}`;
    const node = innermost(sf, d.start, d.start + d.length);
    let done = false;
    if ([7006, 7031, 7019].includes(d.code)) done = anyOn(up(node, ts.isParameter));
    else if ([7005, 7034].includes(d.code)) done = ts.isIdentifier(node) ? anyOn(declOf(node)) : anyOn(up(node, ts.isVariableDeclaration));
    else if (d.code === 2554) {
      // Expected N arguments, but got M: the callee's parameters from M on become optional
      const call = up(node, (n) => ts.isCallExpression(n) || ts.isNewExpression(n));
      const decl = call && checker.getResolvedSignature(call)?.getDeclaration();
      const got = call?.arguments?.length ?? 0;
      if (decl && decl.getSourceFile().fileName.startsWith(target) && got < decl.parameters.length) {
        for (const p of decl.parameters.slice(got)) if (!p.questionToken && !p.initializer && !p.dotDotDotToken) add(decl.getSourceFile(), p.name.end, "?", 0);
        done = true;
      }
    } else {
      const start = ts.isIdentifier(node) && node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
      done = anyOnExpr(start);
      if (!fallback || done || fbFiles.has(sf.fileName) || skip.has(dkey)) {}
      else if ((ts.isPropertyAssignment(node.parent) && node.parent.name === node)) done = asAny(node.parent.initializer);
      else if (d.code === 2345 && lastResortArg(exprAt(node))) done = true;
      else if (!done && [2532, 18048].includes(d.code)) { const e = exprAt(node); if (e) { add(sf, e.end, "!", 0); done = true; } }
      else if (!done && d.code === 2353) done = asAny(up(node, ts.isObjectLiteralExpression));
      else if (!done && d.code === 2783) done = asAny(up(node, ts.isObjectLiteralExpression)?.properties.find(ts.isSpreadAssignment)?.expression);
      else if (!done) done = asAny(exprAt(start));
      if (fallback && done && !fbFiles.has(sf.fileName) && edits.has(sf.fileName)) { fbFiles.add(sf.fileName); fbKey.set(sf.fileName, dkey); }
    }
    if (!done) residual.push(`${sf.fileName.slice(target.length)}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 160)}`);
  }
  // declarations first, to a fixed point; then one round of last resorts; then declarations again
  if (!edits.size && !fallback && fallbacks < 40) { fallback = true; fallbacks++; pass--; continue; }
  if (!edits.size || pass >= 80) {
    console.log(`pass ${pass}: nothing more to annotate; ${residual.length} left for hand fixes`);
    for (const r of residual) console.log("  " + r);
    process.exit(residual.length ? 1 : 0);
  }
  let n = 0;
  for (const [file, m] of edits) {
    let text = readFileSync(file, "utf8");
    // descending position; at one position "?" (rank 0) ends up before ": any" (rank 1)
    for (const e of [...m.values()].sort((a, b) => b.pos - a.pos || b.rank - a.rank)) { text = text.slice(0, e.pos) + e.text + text.slice(e.pos); n++; }
    const before = readFileSync(file, "utf8");
    const parsedOk = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).parseDiagnostics.length === 0;
    if (!parsedOk) { console.log(`  reverted a last resort that broke the parse: ${fbKey.get(file) ?? file}`); skip.add(fbKey.get(file)); text = before; }
    writeFileSync(file, text);
  }
  console.log(`pass ${pass}${fallback ? " (last resorts)" : ""}: ${diags.length} errors, ${n} annotations`);
  fallback = false;
}
