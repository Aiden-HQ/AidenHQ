// Proves the split moved code only: every non-import statement of the old main.mjs (with its comments) appears exactly
// once across the new main.mjs and src/<dir>/*.ts, after erasing TypeScript types, whitespace aside.
// Usage: node verify.mjs <old main.mjs> <runner dir> [dir=main]
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [oldPath, runnerDir, dir = "main"] = process.argv.slice(2);
// erase types the way a compiler does: `(x as any).y` and `x!.y` both come back as `x.y`
const erase = (t) => ts.transpileModule(t, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
const norm = (t) => t.replace(/\s+/g, " ").trim();
const stmts = (text, name) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements.filter((s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)).map((s) => norm(s.getFullText()));
const before = stmts(erase(readFileSync(oldPath, "utf8")), "old.mjs");
const files = [join(runnerDir, "src/main.mjs"), ...readdirSync(join(runnerDir, "src", dir)).filter((f) => f.endsWith(".ts")).map((f) => join(runnerDir, "src", dir, f))];
const after = files.flatMap((f) => { const t = readFileSync(f, "utf8"); return stmts(erase(t), "x.mjs"); });
const count = (l) => l.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map());
const a = count(before), b = count(after);
const bad = [...new Set([...a.keys(), ...b.keys()])].filter((s) => a.get(s) !== b.get(s));
for (const s of bad) console.error(`${a.get(s) ?? 0} → ${b.get(s) ?? 0}: ${s.slice(0, 160)}`);
console.log(bad.length ? `FAIL: ${bad.length} statement(s) differ` : `ok: ${before.length} statements, each moved once, nothing else changed`);
process.exit(bad.length ? 1 : 0);
