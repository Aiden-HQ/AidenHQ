// The authority diff of an apply, for the apply log (ops/apply-config-work.sh) and the operator: one line per module change.
//   node kernel/src/loader/authority-cli.ts <old product sha> <new product sha> [<instance dir> <old instance sha> <new instance sha>]
// Without the instance arguments, both sides use the instance checkout's current instance.yaml (AIDENHQ_INSTANCE_DIR), or
// every module when there is none. Reads module manifests with `git show` at each sha, so any two commits work. Exit 2 when
// a commit or manifest can't be read: the apply refuses rather than guess.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityLines, diffAll, marketplaceChanges, moduleInputs, type ModuleDef } from "./authority.ts";
import { hostFetch, withRemote } from "./sources.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// The kernel has no YAML dependency; the compiler's (scripts/, installed by every apply) reads the manifests.
const YAML = createRequire(join(repo, "scripts/package.json"))("yaml") as { parse: (s: string) => unknown };
// The product whose commits are read: this checkout, or AIDENHQ_PRODUCT_DIR (tests).
const product = process.env.AIDENHQ_PRODUCT_DIR ?? repo;
const SHA = /^[0-9a-f]{40}$/;

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const yaml = (text: string) => (YAML.parse(text) ?? {}) as Record<string, unknown>;

function defsAt(rev: string): Record<string, ModuleDef> {
  const out: Record<string, ModuleDef> = {};
  for (const f of git(product, "ls-tree", "-r", "--name-only", rev, "--", "modules").split("\n")) {
    const m = /^modules\/([a-z0-9][a-z0-9-]*)\/module\.yaml$/.exec(f);
    if (m) out[m[1]!] = yaml(git(product, "show", `${rev}:${f}`));
  }
  return out;
}

function main(argv: string[]) {
  const [from, to, inst, ib, ih] = argv;
  if (!SHA.test(from ?? "") || !SHA.test(to ?? "") || (inst !== undefined && (!SHA.test(ib ?? "") || !SHA.test(ih ?? "")))) {
    console.error("usage: authority-cli.ts <old product sha> <new product sha> [<instance dir> <old instance sha> <new instance sha>]");
    return 2;
  }
  try {
    const [baseDefs, headDefs] = [defsAt(from!), defsAt(to!)];
    let baseInstance: Record<string, unknown>, headInstance: Record<string, unknown>;
    if (inst !== undefined) [baseInstance, headInstance] = [yaml(git(inst, "show", `${ib}:instance.yaml`)), yaml(git(inst, "show", `${ih}:instance.yaml`))];
    else {
      const dir = process.env.AIDENHQ_INSTANCE_DIR;
      const now = dir && existsSync(join(dir, "instance.yaml")) ? yaml(readFileSync(join(dir, "instance.yaml"), "utf8")) : { modules: [...new Set([...Object.keys(baseDefs), ...Object.keys(headDefs)])] };
      baseInstance = headInstance = now;
    }
    const changed = from === to ? [] : git(product, "diff", "--name-only", "--no-renames", from!, to!, "--", "modules").split("\n").filter(Boolean);
    // Third-party modules (instance.yaml marketplaces:) are fetched at their pinned shas through the host's credential helper.
    const sides = withRemote({ baseInstance, headInstance, baseDefs, headDefs, changed }, { ...hostFetch(repo), parse: YAML.parse });
    const lines = authorityLines([...marketplaceChanges(baseInstance, headInstance), ...diffAll(moduleInputs({ ...sides, always: [] }))]);
    for (const l of lines.length ? lines : ["none"]) console.log(`apply authority: ${l}`);
    return 0;
  } catch (e) {
    console.error(`apply authority: can't read the change (${String((e as Error).message ?? e).split("\n")[0]})`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
