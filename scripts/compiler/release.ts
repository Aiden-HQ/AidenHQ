// Releases (spec §6.4, §6.8): instance.yaml `release: { name, source, sha }` pins a tested set from the distro repo, read at
// that sha as releases/<name>.json. The release supplies the kernel sha and its prebuilt images; the official modules are the
// product commit's own modules/ (2026-11-18). `product:` is the release's kernel, or a commit that descends from it on the
// official kernel repository's main with product CI green on exactly that commit (ciRefusal: the owner moved the install to a
// main commit, kernel/src/updates.ts verifyMain; an unreadable CI status refuses too: nothing runs unverified). Then
// the release's images belong to an older commit, so none are pulled and apply builds every image from the checkout. A release
// file's `marketplace` and `modules` (from before that) are never read: nothing in a release points the modules elsewhere.
// A release name is display: only its sha resolves.
//   node scripts/compiler/release.ts <instance.yaml>     the apply's check: prints the resolved release; exit 2 refused
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFetch, OFFICIAL, onOfficialMain, repoAt, sourceOf, type Fetch, type Where } from "./sources.ts";

type Dict = Record<string, unknown>;
export type Resolved = { name: string; kernel: string; images: Record<string, string> };

const SHA = /^[0-9a-f]{40}$/;
/** The official kernel repository (a constant: nothing in a release file or instance.yaml points it elsewhere). */
export const KERNEL_URL = "https://github.com/Aiden-HQ/AidenHQ.git";
/** GitHub's check runs named ci-required on kernel commit `sha` (product CI's single required check). */
export const ciRunsUrl = (sha: string) => `https://api.github.com/repos/Aiden-HQ/AidenHQ/commits/${sha}/check-runs?check_name=ci-required&per_page=20`;
/**
 * Product CI on exactly `sha`, from the check-runs answer at ciRunsUrl: null when its newest GitHub Actions `ci-required` run
 * completed with success (what the distro's release.yml requires of a release's kernel), else why not. The one judge of it:
 * release.ts (every apply) and the updater (kernel/src/updates.ts verifyMain) both ask this.
 */
export function ciRefusal(runs: unknown, sha: string): string | null {
  const list = (isMap(runs) && Array.isArray(runs.check_runs) ? runs.check_runs : []).filter((r): r is Dict => isMap(r) && isMap(r.app) && r.app.slug === "github-actions");
  const last = list.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).at(-1);
  if (!last) return `${sha.slice(0, 12)} has no ci-required check: CI hasn't run on it`;
  if (last.status !== "completed") return `CI is still running on ${sha.slice(0, 12)}: ask again when it is green`;
  if (last.conclusion !== "success") return `CI failed on ${sha.slice(0, 12)} (ci-required: ${String(last.conclusion).slice(0, 40)})`;
  return null;
}
/** The check-runs answer at ciRunsUrl, read synchronously (a child's fetch): apply's compile reads releases without awaiting. */
function checkRuns(sha: string): unknown {
  const js = "const r = await fetch(process.argv[1], { headers: { accept: 'application/vnd.github+json', 'user-agent': 'aidenhq-apply' }, signal: AbortSignal.timeout(30000) }); if (!r.ok) { console.error(`${process.argv[1]} answered ${r.status}`); process.exit(1); } process.stdout.write(await r.text());";
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", js, ciRunsUrl(sha)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 }));
}
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
 * `product:` is neither the release's kernel nor a commit `ahead` vouches for (it throws why not: on the kernel repo's main,
 * after the kernel, CI green); such a product runs with no prebuilt images.
 */
export function resolveRelease(file: unknown, instance: Dict, ahead?: (kernel: string, product: string) => void): Resolved {
  if (!isMap(file) || typeof file.release !== "string") throw new Error("release: the file needs release and kernel");
  const want = isMap(instance.release) ? instance.release.name : undefined;
  if (want !== undefined && want !== file.release) throw new Error(`release: instance.yaml names ${String(want)}, the file is ${file.release}`);
  const kernel = sha(file.kernel, "kernel");
  const product = String(instance.product);
  if (product !== kernel) {
    if (!SHA.test(product) || !ahead) throw new Error(`release ${file.release}: product: is ${product}, not the release's kernel ${kernel}`);
    try { ahead(kernel, product); } catch (e) { throw new Error(`release ${file.release}: product: ${product.slice(0, 12)} isn't the release's kernel ${kernel.slice(0, 12)}, and ${(e as Error).message}`); }
  }
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
 * after the release's kernel is checked in the official kernel repository (`kernelUrl`) and on GitHub's check runs (`runs`,
 * read only for a commit not yet seen green: `<cacheDir>/ci-green/<sha>`); a test passes local stand-ins. A CI status that
 * can't be read refuses.
 */
export function readRelease(instance: Dict, f: Fetch, kernelUrl = KERNEL_URL, runs: (sha: string) => unknown = checkRuns): Resolved | null {
  const r = releaseOf(instance);
  if (!r) return null;
  const repo = repoAt({ ...r.at, owned: true }, f);
  const text = execFileSync("git", ["--git-dir", repo, "show", `${r.at.sha}:releases/${r.name}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return resolveRelease(JSON.parse(text), instance, (kernel, product) => {
    const at: Where = { url: kernelUrl, path: "", sha: product, owned: true };
    if (!onOfficialMain(at, f)) throw new Error("it isn't on the kernel repository's main");
    try { execFileSync("git", ["--git-dir", repoAt(at, f), "merge-base", "--is-ancestor", kernel, product], { stdio: "ignore", timeout: 30_000 }); } catch { throw new Error("it doesn't descend from the release's kernel"); }
    // A commit's green ci-required never changes: green is remembered per sha (one GitHub read per commit across applies, the
    // planner and the authority diff), never red, missing, running or unreadable.
    const green = join(f.cacheDir, "ci-green", product);
    if (existsSync(green)) return;
    let answer: unknown;
    try { answer = runs(product); } catch (e) { throw new Error(`its CI status can't be read (${String((e as Error).message).split("\n")[0]!.slice(0, 200)})`); }
    const no = ciRefusal(answer, product);
    if (no) throw new Error(no);
    mkdirSync(join(f.cacheDir, "ci-green"), { recursive: true });
    writeFileSync(green, "");
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
