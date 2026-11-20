// New code is TypeScript: fails when a change adds a .js/.mjs/.cjs file that .github/ci/js-allowlist.txt does not list.
//   node ts-only.ts <base-ref> <head-ref> [allowlist-file]
// CI's `policy` job runs this script and its allowlist from the PR's base, so a PR can't loosen its own check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [base, head, list = ".github/ci/js-allowlist.txt"] = process.argv.slice(2);
const entries = readFileSync(list, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const allowed = (f: string) => entries.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));
const added = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--diff-filter=AR", base!, head!], { encoding: "utf8" }).split("\0").filter(Boolean);
const bad = added.filter((f) => /\.(js|mjs|cjs)$/.test(f) && !/(^|\/)(node_modules|dist)\//.test(f) && !allowed(f));
for (const f of bad) console.log(`::error file=${f}::new JavaScript file: write it as TypeScript (.ts), or, if something loads it by a fixed .js/.mjs name, ask the maintainer to list it in .github/ci/js-allowlist.txt`);
process.exit(bad.length ? 1 : 0);
