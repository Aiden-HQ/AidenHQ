// Puts the official modules at <product>/modules (gitignored since 5b), where the compiler, compose build contexts and
// the host scripts read them: the instance's `aidenhq` marketplace entry, else modules-pin.json (a new instance, CI). The
// tree is fetched and extracted by the kernel's sources.ts at its sha (the host's credential helper for the private
// repository), copied beside the old one and swapped in by rename. Same content at the same path: nothing rebuilds.
//   node scripts/modules-repo/materialize.mjs <product dir> [<instance.yaml>]
import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { checkout, hostFetch, OFFICIAL, sourceOf } from "../../kernel/src/loader/sources.ts";

const [productArg, instanceFile] = process.argv.slice(2);
const product = resolve(productArg ?? ".");
const pin = JSON.parse(readFileSync(join(product, "modules-pin.json"), "utf8"));
const instance = instanceFile ? createRequire(join(product, "scripts/package.json"))("yaml").parse(readFileSync(instanceFile, "utf8")) ?? {} : {};
const entry = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).find((m) => m?.name === OFFICIAL);
const at = sourceOf(entry ? entry.source : { source: "github", repo: pin.repo }, "the official marketplace", undefined, entry ? entry.sha : pin.sha, true);

const dest = join(product, "modules");
const mark = join(dest, ".sha");
if (existsSync(mark) && existsSync(join(dest, "marketplace.json")) && readFileSync(mark, "utf8").trim() === at.sha) process.exit(0);
const tree = checkout(at, hostFetch(product));
rmSync(`${dest}.next`, { recursive: true, force: true });
cpSync(tree, `${dest}.next`, { recursive: true });
writeFileSync(join(`${dest}.next`, ".sha"), `${at.sha}\n`);
rmSync(`${dest}.old`, { recursive: true, force: true });
if (existsSync(dest)) renameSync(dest, `${dest}.old`);
renameSync(`${dest}.next`, dest);
rmSync(`${dest}.old`, { recursive: true, force: true });
console.log(`modules: ${at.url} at ${at.sha.slice(0, 12)}`);
