// Releases (spec §6.4, §6.8): instance.yaml `release: { name, source, sha }` pins a tested set from the distro repo, read at
// that sha as releases/<name>.json. The release supplies the kernel sha and its prebuilt images; the official modules are the
// product commit's own modules/ (2026-11-18). `product:` is the release's kernel, or a commit that descends from it on the
// official kernel repository's main (the owner moved the install to a main commit: kernel/src/updates.ts verifyMain). Then
// the release's images belong to an older commit, so none are pulled and apply builds every image from the checkout. A release
// file's `marketplace` and `modules` (from before that) are never read: nothing in a release points the modules elsewhere.
// A release name is display: only its sha resolves.
//   node scripts/compiler/release.ts <instance.yaml>     the apply's check: prints the resolved release; exit 2 refused
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFetch, OFFICIAL, onOfficialMain, repoAt, sourceOf, type Fetch, type Where } from "./sources.ts";

type Dict = Record<string, unknown>;
export type Resolved = { name: string; kernel: string; images: Record<string, string> };

const SHA = /^[0-9a-f]{40}$/;
/** The official kernel repository (a constant: nothing in a release file or instance.yaml points it elsewhere). */
export const KERNEL_URL = "https://github.com/Aiden-HQ/AidenHQ.git";
const NAME = /^\d{4}\.\d{1,2}(\.\d+){0,2}$/;
const IMAGE = /^[a-z0-9][a-z0-9.-]*(:[0-9]+)?(\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const sha = (v: unknown, what: string) => {
  if (typeof v !== "string" || !SHA.test(v)) throw new Error(`release: ${what} must be a 40-character sha (got ${JSON.stringify(v)?.slice(0, 50)})`);
  return v;
};

/** instance.yaml `release:`, as its name and where its file is; null without one. */
export function releaseOf(instance: Dict): { name: string; at: Where } | null {
  const r = instance.release;
  if (r == null) return null;
  if (!isMap(r) || typeof r.name !== "string" || !NAME.test(r.name)) throw new Error("instance.yaml release: needs { name: <YYYY.M[.D[.N]]>, source, sha }");
  const at = sourceOf(r.source, "instance.yaml release", undefined, r.sha, true);
  return { name: r.name, at: { ...at, path: "" } };
}

/**
 * A release file as the instance runs it: { release, kernel, images? }. Unknown keys are ignored (a newer release file loads,
 * and an older one's `modules`); every key used is checked. Throws when the release isn't the one instance.yaml names, or
 * `product:` is neither the release's kernel nor a commit `descends` vouches for (on the kernel repo's main, after the kernel);
 * such a product runs with no prebuilt images.
 */
export function resolveRelease(file: unknown, instance: Dict, descends: (kernel: string, product: string) => boolean = () => false): Resolved {
  if (!isMap(file) || typeof file.release !== "string") throw new Error("release: the file needs release and kernel");
  const want = isMap(instance.release) ? instance.release.name : undefined;
  if (want !== undefined && want !== file.release) throw new Error(`release: instance.yaml names ${String(want)}, the file is ${file.release}`);
  const kernel = sha(file.kernel, "kernel");
  const product = String(instance.product);
  if (product !== kernel && !(SHA.test(product) && descends(kernel, product))) throw new Error(`release ${file.release}: product: is ${product}, neither the release's kernel ${kernel} nor a commit after it on the kernel repository's main`);
  // images: the prebuilt images of this release (name -> registry/repo@sha256:...), which apply pulls instead of building.
  const images: Record<string, string> = {};
  if (file.images != null && !isMap(file.images)) throw new Error("release: images must be a map of name to image@sha256:digest");
  for (const [k, v] of Object.entries(file.images ?? {})) {
    if (typeof v !== "string" || !IMAGE.test(v)) throw new Error(`release: images.${k} must be registry/name@sha256:<digest>`);
    images[k] = v;
  }
  return { name: file.release, kernel, images: product === kernel ? images : {} };
}

/**
 * The release instance.yaml pins, read from the distro repo at exactly its sha, and resolved; null without one. A product
 * after the release's kernel is checked in the official kernel repository (`kernelUrl`: a test's local copy).
 */
export function readRelease(instance: Dict, f: Fetch, kernelUrl = KERNEL_URL): Resolved | null {
  const r = releaseOf(instance);
  if (!r) return null;
  const repo = repoAt({ ...r.at, owned: true }, f);
  const text = execFileSync("git", ["--git-dir", repo, "show", `${r.at.sha}:releases/${r.name}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return resolveRelease(JSON.parse(text), instance, (kernel, product) => {
    const at: Where = { url: kernelUrl, path: "", sha: product, owned: true };
    if (!onOfficialMain(at, f)) return false;
    try { execFileSync("git", ["--git-dir", repoAt(at, f), "merge-base", "--is-ancestor", kernel, product], { stdio: "ignore", timeout: 30_000 }); return true; } catch { return false; }
  });
}

/** The instance as it runs with its release: without an obsolete `aidenhq` marketplace entry (the kernel's modules/ are the official ones). */
export function withRelease(instance: Dict, r: Resolved | null): Dict {
  if (!r) return instance;
  const marketplaces = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).filter((m) => !(isMap(m) && m.name === OFFICIAL));
  const { marketplaces: _m, ...rest } = instance;
  return marketplaces.length ? { ...rest, marketplaces } : rest;
}

/** withRelease on the release instance.yaml pins, read at its distro sha. */
export const effective = (instance: Dict, f: Fetch) => withRelease(instance, readRelease(instance, f));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // Imported here only, from scripts' dependencies: the runner and the kernel import this file without them (a variable
    // specifier, so their typechecks don't resolve it).
    const yaml = "yaml";
    const { default: YAML } = await import(yaml);
    const instance = (YAML.parse(readFileSync(process.argv[2] ?? "", "utf8")) ?? {}) as Dict;
    const r = readRelease(instance, hostFetch(resolve(import.meta.dirname, "../..")));
    console.log(r ? `release: ${r.name}, kernel ${r.kernel.slice(0, 12)}, ${Object.keys(r.images).length} prebuilt images` : "release: none");
  } catch (e) {
    console.error(`release: refused (${String((e as Error).message ?? e).split("\n")[0]})`);
    process.exitCode = 2;
  }
}
