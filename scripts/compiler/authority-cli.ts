// The authority diff of an apply, for the apply log (ops/apply-config-work.sh) and the operator: one line per module change.
//   node scripts/compiler/authority-cli.ts <old product sha> <new product sha> [<instance dir> <old instance sha> <new instance sha>]
// Without the instance arguments, both sides use the instance checkout's current instance.yaml (AIDENHQ_INSTANCE_DIR), or
// every module when there is none. Reads module manifests with `git show` at each sha, so any two commits work. Exit 2 when
// a commit or manifest can't be read: the apply refuses rather than guess.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityLines, diffAll, forkChanges, marketplaceChanges, moduleInputs } from "./authority.ts";
import { effective } from "./release.ts";
import { hostFetch, officialSides, withRemote } from "./sources.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The kernel has no YAML dependency; the compiler's (scripts/, installed by every apply) reads the manifests.
const YAML = createRequire(join(repo, "scripts/package.json"))("yaml") as { parse: (s: string) => unknown };
// The product whose commits are read: this checkout, or AIDENHQ_PRODUCT_DIR (tests).
const product = process.env.AIDENHQ_PRODUCT_DIR ?? repo;
const SHA = /^[0-9a-f]{40}$/;

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const yaml = (text: string) => (YAML.parse(text) ?? {}) as Record<string, unknown>;

function main(argv: string[]) {
  const [from, to, inst, ib, ih] = argv;
  if (!SHA.test(from ?? "") || !SHA.test(to ?? "") || (inst !== undefined && (!SHA.test(ib ?? "") || !SHA.test(ih ?? "")))) {
    console.error("usage: authority-cli.ts <old product sha> <new product sha> [<instance dir> <old instance sha> <new instance sha>]");
    return 2;
  }
  try {
    const d = process.env.AIDENHQ_INSTANCE_DIR;
    const current = d && existsSync(join(d, "instance.yaml")) ? yaml(readFileSync(join(d, "instance.yaml"), "utf8")) : undefined;
    const fetch = { ...hostFetch(repo), parse: YAML.parse };
    // A release (instance.yaml release:) supplies the official marketplace, read at its distro sha on both sides; a refusal
    // (product: off its kernel) exits 2.
    const [rawBase, rawHead] = inst !== undefined ? [yaml(git(inst, "show", `${ib}:instance.yaml`)), yaml(git(inst, "show", `${ih}:instance.yaml`))] : [current ?? {}, current ?? {}];
    let [baseInstance, headInstance] = [effective(rawBase, fetch), effective(rawHead, fetch)];
    // The official modules by folder tree id (the product's ./modules, or the `aidenhq` marketplace from 5b); third-party ones
    // (instance.yaml marketplaces:) are fetched at their pinned shas through the host's credential helper.
    const official = officialSides(baseInstance, headInstance, from!, to!, product, fetch);
    // No instance at all: every module, on both sides.
    if (inst === undefined && !current) baseInstance = headInstance = { modules: [...new Set([...Object.keys(official.baseDefs), ...Object.keys(official.headDefs)])] };
    const sides = withRemote({ baseInstance, headInstance, ...official }, fetch);
    const lines = authorityLines([...marketplaceChanges(baseInstance, headInstance), ...forkChanges(baseInstance, headInstance), ...diffAll(moduleInputs({ ...sides, always: [] }))]);
    for (const l of lines.length ? lines : ["none"]) console.log(`apply authority: ${l}`);
    return 0;
  } catch (e) {
    console.error(`apply authority: can't read the change (${String((e as Error).message ?? e).split("\n")[0]})`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
