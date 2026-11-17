// Releases (spec §6.4, §6.8): instance.yaml `release: { name, source, sha }` pins a tested set from the distro repo, read at
// that sha as releases/<name>.json. The release supplies the kernel sha (`product:` must equal it, so the deploy flow is
// unchanged), the official marketplace's sha and each default module's sha; a per-module `{ id, sha }` entry overrides one.
// A release name is display: only its sha resolves.
//   node kernel/src/loader/release.ts <instance.yaml>     the apply's check: prints the resolved release; exit 2 refused
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFetch, OFFICIAL, repoAt, sourceOf, type Fetch, type Where } from "./sources.ts";

type Dict = Record<string, unknown>;
export type Resolved = { name: string; kernel: string; marketplace: { name: string; source: unknown; sha: string }; modules: Record<string, string> };

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^\d{4}\.\d{1,2}(\.\d+)?$/;
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const sha = (v: unknown, what: string) => {
  if (typeof v !== "string" || !SHA.test(v)) throw new Error(`release: ${what} must be a 40-character sha (got ${JSON.stringify(v)?.slice(0, 50)})`);
  return v;
};

/** instance.yaml `release:`, as its name and where its file is; null without one. */
export function releaseOf(instance: Dict): { name: string; at: Where } | null {
  const r = instance.release;
  if (r == null) return null;
  if (!isMap(r) || typeof r.name !== "string" || !NAME.test(r.name)) throw new Error("instance.yaml release: needs { name: <YYYY.MM[.N]>, source, sha }");
  const at = sourceOf(r.source, "instance.yaml release", undefined, r.sha, true);
  return { name: r.name, at: { ...at, path: "" } };
}

/**
 * A release file as the instance runs it. Unknown keys are ignored (a newer release file loads); every key used is checked.
 * Throws when `product:` isn't the release's kernel, when the release isn't the one instance.yaml names, or when the
 * instance's own official marketplace entry disagrees with the release's.
 */
export function resolveRelease(file: unknown, instance: Dict): Resolved {
  if (!isMap(file) || typeof file.release !== "string" || !isMap(file.marketplace) || !isMap(file.modules)) throw new Error("release: the file needs release, kernel, marketplace and modules");
  const want = isMap(instance.release) ? instance.release.name : undefined;
  if (want !== undefined && want !== file.release) throw new Error(`release: instance.yaml names ${String(want)}, the file is ${file.release}`);
  const kernel = sha(file.kernel, "kernel");
  if (instance.product !== kernel) throw new Error(`release ${file.release}: product: is ${String(instance.product)}, the release's kernel is ${kernel}`);
  const m = file.marketplace;
  if (m.name !== OFFICIAL) throw new Error(`release ${file.release}: the marketplace must be ${OFFICIAL}`);
  const marketplace = { name: OFFICIAL, source: m.source, sha: sha(m.sha, "marketplace.sha") };
  const modules: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.modules)) modules[k] = sha(v, `modules.${k}`);
  for (const e of Array.isArray(instance.modules) ? instance.modules : []) {
    if (!isMap(e) || e.sha == null) continue;
    const [name, mkt] = String(e.id).split("@");
    if (!mkt || mkt === OFFICIAL) modules[name!] = sha(e.sha, `modules ${String(e.id)}`);
  }
  const own = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).find((x) => isMap(x) && x.name === OFFICIAL) as Dict | undefined;
  if (own) {
    const [a, b] = [sourceOf(own.source, "instance.yaml marketplaces", undefined, own.sha, true), sourceOf(marketplace.source, "release marketplace", undefined, marketplace.sha, true)];
    if (a.url !== b.url || a.path !== b.path || a.sha !== b.sha) throw new Error(`release ${file.release}: instance.yaml's ${OFFICIAL} marketplace (${a.url} at ${a.sha.slice(0, 12)}) isn't the release's (${b.url} at ${b.sha.slice(0, 12)})`);
  }
  return { name: file.release, kernel, marketplace, modules };
}

/** The release instance.yaml pins, read from the distro repo at exactly its sha, and resolved; null without one. */
export function readRelease(instance: Dict, f: Fetch): Resolved | null {
  const r = releaseOf(instance);
  if (!r) return null;
  const repo = repoAt({ ...r.at, owned: true }, f);
  const text = execFileSync("git", ["--git-dir", repo, "show", `${r.at.sha}:releases/${r.name}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return resolveRelease(JSON.parse(text), instance);
}

/**
 * The instance as it runs with its release: the official marketplace entry is the release's (the loader reads the official
 * modules from it, by folder tree id), so a release move is classified by the module changes it resolves to, not by the key.
 */
export function withRelease(instance: Dict, r: Resolved | null): Dict {
  if (!r) return instance;
  const others = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).filter((m) => !(isMap(m) && m.name === OFFICIAL));
  return { ...instance, marketplaces: [{ name: OFFICIAL, source: r.marketplace.source, sha: r.marketplace.sha }, ...others] };
}

/** withRelease on the release instance.yaml pins, read at its distro sha. */
export const effective = (instance: Dict, f: Fetch) => withRelease(instance, readRelease(instance, f));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // Imported here only: the runner imports this file without the kernel's dependencies.
    const { default: YAML } = await import("yaml");
    const instance = (YAML.parse(readFileSync(process.argv[2] ?? "", "utf8")) ?? {}) as Dict;
    const r = readRelease(instance, hostFetch(resolve(import.meta.dirname, "../../..")));
    console.log(r ? `release: ${r.name}, kernel ${r.kernel.slice(0, 12)}, marketplace ${OFFICIAL} at ${r.marketplace.sha.slice(0, 12)}, ${Object.keys(r.modules).length} modules` : "release: none");
  } catch (e) {
    console.error(`release: refused (${String((e as Error).message ?? e).split("\n")[0]})`);
    process.exitCode = 2;
  }
}
