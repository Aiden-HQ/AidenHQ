// The product files a script runs: itself and every file it imports by a relative path, transitively, one repo-relative
// path per line. The apply hashes these (with the data the script reads) to skip a step whose inputs did not change
// (ops/apply-config-work.sh setupInputs). An import it cannot resolve fails loudly, so the step runs rather than skips.
//   node scripts/imports.ts <script>
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seen = new Set<string>();
const queue = [resolve(repo, process.argv[2] ?? "")];
while (queue.length) {
  const file = queue.pop()!;
  if (seen.has(file)) continue;
  seen.add(file);
  for (const m of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']+)["']/g)) {
    const spec = m[1]!;
    const path = [spec, `${spec}.ts`, `${spec}.mjs`, `${spec}.js`].map((s) => resolve(dirname(file), s)).find((p) => existsSync(p));
    if (!path) throw new Error(`${relative(repo, file)}: cannot resolve ${spec}`);
    queue.push(path);
  }
}
console.log([...seen].map((f) => relative(repo, f)).sort().join("\n"));
