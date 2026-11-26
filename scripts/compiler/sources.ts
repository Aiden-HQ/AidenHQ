// Module sources and third-party marketplaces (spec §6.2-§6.5): a module comes from a marketplace at a pinned 40-char sha,
// never a ref. Sources are a relative path in the marketplace, or a hosted repo, a folder of a git URL (`git-subdir`) or a git `url`, each
// with its own sha. Git fetches the sha into a cache (through the credential helper the caller passes, per command, never
// into a checkout's config), checks it is that commit, refuses symlinks and submodules, and extracts the tree; nothing is
// built or run (no third-party code runs on the host). The tier is computed, never claimed: declared (it compiles), official
// (from the `aidenhq` marketplace, whose contract kit runs in CI). A third-party module's kit is a check job (platform's
// `contract` recipe); a source none can snapshot stays declared. Sync: the compiler is.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, sep } from "node:path";

type Dict = Record<string, unknown>;
/**
 * Where a module or marketplace is: a git repository (https URL or a local absolute path), a folder in it, a commit. `owned`:
 * the owner's instance.yaml names this repository itself, so the host's credential helper may be used for it; a URL taken
 * from a third-party marketplace.json never gets it.
 */
export type Where = { url: string; path: string; sha: string; owned?: boolean };
export type Fetch = { cacheDir: string; credentialHelper?: string };
export type Tier = "declared" | "official";
/** `market`: where its marketplace is (advisories are read from that repository's head); `fork`: the owner's fork it runs. */
export type Remote = { name: string; marketplace: string; market: Where; at: Where; root: string; def: Dict; tier: Tier; fork?: Fork };

export const OFFICIAL = "aidenhq";
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Hosts a third-party marketplace.json may point a module at (https only, never a local path, never the host's credentials). */
const THIRD_PARTY_HOSTS = ["github.com"];

/** The default cache: outside the product checkout and the data dir (fetched trees are rebuildable from their shas). */
export const defaultCache = () => process.env.AIDENHQ_SOURCES_DIR ?? join(homedir(), ".cache/aidenhq/sources");

function relPath(p: unknown, where: string): string {
  const s = String(p ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (typeof p !== "string" || s.split("/").some((x) => !/^[\w.-]+$/.test(x) || x === "." || x === "..")) throw new Error(`${where}: path ${JSON.stringify(p)} must be a relative path inside the repository`);
  return s;
}

/**
 * A source as marketplace.json or instance.yaml writes it, as a Where. `within`: the marketplace a relative path is in (it
 * keeps that marketplace's `owned`). `sha`: the entry's own sha when the source object carries none (instance.yaml's
 * marketplace entries). `owned`: the owner's instance.yaml wrote it; otherwise (a third-party marketplace.json) a remote
 * source must be https on THIRD_PARTY_HOSTS.
 */
export function sourceOf(src: unknown, where: string, within?: Where, sha?: unknown, owned = false): Where {
  if (typeof src === "string") {
    if (!within || !src.startsWith("./")) throw new Error(`${where}: a relative source (./<folder>) is only allowed inside a marketplace`);
    return { url: within.url, path: posix.join(within.path, relPath(src, where)).replace(/^\.$/, ""), sha: within.sha, ...(within.owned ? { owned: true } : {}) };
  }
  const w = remoteOf(src, where, sha);
  if (owned) return { ...w, owned: true };
  if (!THIRD_PARTY_HOSTS.includes(/^https:\/\/([\w.-]+)\//.exec(w.url)?.[1] ?? "")) throw new Error(`${where}: a marketplace may point a module only at https on ${THIRD_PARTY_HOSTS.join(", ")} (got ${w.url})`);
  return w;
}

function remoteOf(src: unknown, where: string, sha?: unknown): Where {
  if (!isMap(src)) throw new Error(`${where}: source must be a relative path or a { source, ..., sha } object`);
  const at = String(src.sha ?? sha ?? "");
  if (!SHA.test(at)) throw new Error(`${where}: a remote source needs a 40-character sha (a ref alone is refused)`);
  const url = (u: unknown) => {
    const s = String(u ?? "");
    if (!/^https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+$/.test(s) && !/^\/[\w./-]+$/.test(s)) throw new Error(`${where}: url must be https://… or an absolute local path`);
    return s;
  };
  if (src.source === "github") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(src.repo ?? ""))) throw new Error(`${where}: repo must be <owner>/<repo>`);
    return { url: `https://github.com/${src.repo}.git`, path: "", sha: at };
  }
  if (src.source === "git-subdir") return { url: url(src.url), path: relPath(src.path, where), sha: at };
  if (src.source === "url") return { url: url(src.url), path: "", sha: at };
  throw new Error(`${where}: source ${JSON.stringify(src.source)} is not supported`);
}

/** A marketplace.json's entries, checked where the kernel uses them; any other field is ignored (decision 6). */
export function marketplaceEntries(json: unknown, where: string): { name: string; source: unknown }[] {
  if (!isMap(json) || !Array.isArray(json.plugins)) throw new Error(`${where}: plugins must be a list`);
  if (json.name != null && (typeof json.name !== "string" || !NAME.test(json.name))) throw new Error(`${where}: name must be kebab-case`);
  return json.plugins.map((p, i) => {
    if (!isMap(p) || typeof p.name !== "string" || !NAME.test(p.name)) throw new Error(`${where}: plugins[${i}] needs a kebab-case name`);
    if (isMap(p.source) && ["npm", "archive", "command"].includes(String(p.source.source))) throw new Error(`${where}: ${p.name}: ${p.source.source} sources are refused`);
    return { name: p.name, source: p.source };
  });
}

/** instance.yaml `marketplaces:`, checked: third-party ones, and the official `aidenhq` one from 5b (officialSides). */
export function marketplacesOf(instance: Dict): { name: string; at: Where }[] {
  const list = instance.marketplaces == null ? [] : instance.marketplaces;
  if (!Array.isArray(list)) throw new Error("instance.yaml marketplaces: must be a list");
  const seen = new Set<string>();
  return list.map((m, i) => {
    const name = String(isMap(m) ? m.name : "");
    const where = `instance.yaml marketplaces[${i}]`;
    if (!NAME.test(name)) throw new Error(`${where}: name must be kebab-case`);
    // `local` names the instance's own modules (tier local): a marketplace by that name would share their bare ids.
    if (name === "local") throw new Error(`${where}: local is the instance's own modules; give the marketplace another name`);
    if (seen.has(name)) throw new Error(`${where}: ${name} is listed twice`);
    seen.add(name);
    return { name, at: sourceOf((m as Dict).source, where, undefined, (m as Dict).sha, true) };
  });
}

/** The official modules repository (5b): the `aidenhq` entry pointing anywhere else is the owner's (marketplaceChanges). */
export const OFFICIAL_URL = "https://github.com/Aiden-HQ/aidenhq-modules.git";

/**
 * A carry-your-patch fork (spec §6.9b): `product_fork:` (target `kernel`) or a `modules:` entry's `fork:`, as the owner's
 * instance.yaml writes it. Only the sha resolves; `branch` and `upstream_pr` are for the switch-back routine and the card.
 * The fork's repository is not the host's: it is fetched over https only, anonymously (no credential helper, no local
 * path or file protocol), and its content is untrusted (quoted on cards, nothing run on the host).
 */
export type Fork = { target: string; at: Where; branch?: string; upstream_pr?: string };
const PR = /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d{1,9}$/;
function forkEntry(v: unknown, target: string, where: string, pr: unknown): Fork {
  if (!isMap(v)) throw new Error(`${where}: fork must be { source, repo | url, sha, branch? }`);
  if (v.branch != null && !/^[\w][\w./-]{0,99}$/.test(String(v.branch))) throw new Error(`${where}: branch must be a plain branch name`);
  if (pr != null && !PR.test(String(pr))) throw new Error(`${where}: upstream_pr must be an https pull request URL (https://<host>/<owner>/<repo>/pull/<n>)`);
  const at = remoteOf(v, where);
  if (!at.url.startsWith("https://")) throw new Error(`${where}: a fork is fetched over https only (got ${at.url})`);
  return { target, at, ...(v.branch != null ? { branch: String(v.branch) } : {}), ...(pr != null ? { upstream_pr: String(pr) } : {}) };
}

/** instance.yaml's forks, checked: the kernel's (`product_fork:`) and each module's (`modules: - { id, fork, upstream_pr }`). */
export function forksOf(instance: Dict): Fork[] {
  const out: Fork[] = [];
  if (instance.product_fork != null) out.push(forkEntry(instance.product_fork, "kernel", "instance.yaml product_fork", (instance.product_fork as Dict)?.upstream_pr));
  for (const m of Array.isArray(instance.modules) ? instance.modules : []) {
    if (!isMap(m) || (m.fork == null && m.upstream_pr == null)) continue;
    const name = String(m.id).split("@")[0]!;
    if (m.fork == null) throw new Error(`instance.yaml modules: ${name}: upstream_pr without a fork`);
    out.push(forkEntry(m.fork, name, `instance.yaml modules: ${name}`, m.upstream_pr));
  }
  return out;
}

/**
 * The fork's tree at `base`'s folder. Refused unless the fork sha descends from `base.sha` (the sha the release, the
 * marketplace pin or `product:` gives), so the patch is exactly base..fork. Fetched into the cache by sha, never checked out
 * on the host.
 */
export function onFork(base: Where, fork: Fork, f: Fetch): Where {
  const at = { ...fork.at, path: base.path };
  const repo = repoAt(at, f);
  let ok = has(f, repo, base.sha);
  if (ok) try { git(f, repo, ["merge-base", "--is-ancestor", base.sha, at.sha]); } catch { ok = false; }
  if (!ok) throw new Error(`${fork.target}: fork ${at.url} at ${at.sha.slice(0, 12)} does not descend from ${base.sha.slice(0, 12)} (what it runs on top of); refused`);
  return at;
}

/**
 * Where the official modules folder is for an instance at product sha `sha`: the product's own ./modules (the official modules
 * are part of the product again since 2026-11-18), the kernel's fork's (product_fork:) when there is one, checked to descend
 * from `sha`. An `aidenhq` marketplace entry is ignored there. A product commit from before that (no tracked
 * modules/marketplace.json, and no modules-pin.json deleted in its history) is read as it ran: its `aidenhq` marketplace, else
 * its modules-pin.json; only an apply or a rollback across the move reads one. Any other commit without modules/ is refused.
 */
export function officialAt(instance: Dict, sha: string, product: string, f: Fetch): Where {
  const local = (args: string[]) => execFileSync("git", ["-C", product, ...args], { maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const kernel = forksOf(instance).find((x) => x.target === "kernel");
  const own: Where = { url: product, path: "modules", sha, owned: true };
  if (!SHA.test(sha) || tracks(local, sha)) return kernel ? onFork(own, kernel, f) : own;
  // One way only: a commit whose history already took the modules in (a commit there deleted modules-pin.json) never reads
  // them from anywhere else again.
  if (local(["log", "-1", "--diff-filter=D", "--format=%H", sha, "--", "modules-pin.json"]).trim()) throw new Error(`product ${sha.slice(0, 12)} has no modules/ of its own, but its history moved the official modules into the product: refused`);
  const pinned = () => { try { const p = JSON.parse(local(["show", `${sha}:modules-pin.json`])); return sourceOf({ source: "github", repo: p.repo }, "modules-pin.json", undefined, p.sha, true); } catch { return undefined; } };
  return marketplacesOf(instance).find((m) => m.name === OFFICIAL)?.at ?? pinned() ?? own;
}

/** Whether product commit `sha` holds the official modules itself (modules/marketplace.json); throws when the commit isn't there. */
function tracks(local: (args: string[]) => string, sha: string): boolean {
  local(["cat-file", "-e", `${sha}^{commit}`]);
  try { local(["cat-file", "-e", `${sha}:modules/marketplace.json`]); return true; } catch { return false; }
}

/** What a fork is on top of: `product:` for the kernel, else the module's folder in the official modules or its marketplace. */
export function forkBase(instance: Dict, fork: Fork, product: string, f: Fetch & { parse: (s: string) => unknown }): Where {
  const sha = String(instance.product ?? "");
  if (fork.target === "kernel") return { url: product, path: "", sha, owned: true };
  const remote = remoteModules(instance, f, false).find((r) => r.name === fork.target);
  if (remote) return remote.at;
  const w = officialAt(instance, sha, product, f);
  return { ...w, path: posix.join(w.path, fork.target) };
}

/**
 * Each official module's module.yaml and folder tree id, on both sides of an apply: the instance's `aidenhq` marketplace entry
 * (from 5b), else the modules repository commit the product pins (modules-pin.json, from 5b), else the product checkout's own
 * ./modules at that side's product sha. A module whose folder tree id is the same
 * on both sides is unchanged, whatever repository or sha it now comes from (git filter-repo keeps tree ids, spec §8.7: the 5b
 * move is an empty authority diff, nothing rebuilt). Otherwise its changed files: a git diff within one repository, the whole
 * folder across two.
 */
export function officialSides(baseInstance: Dict, headInstance: Dict, from: string, to: string, product: string, f: Fetch & { parse: (s: string) => unknown}) {
  const local = (args: string[]) => execFileSync("git", ["-C", product, ...args], { maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const side = (instance: Dict, sha: string) => {
    const w = officialAt(instance, sha, product, f);
    const repo = w.url === product ? "" : repoAt(w, f);
    const run = (args: string[]) => (repo ? git(f, repo, args, { owned: true }).toString() : local(args));
    const at = (rel: string) => `${w.sha}:${posix.join(w.path, rel)}`.replace(/:\.$/, ":");
    const top = (() => { try { return run(["ls-tree", "-z", at(".")]); } catch { return ""; } })(); // no modules/ at that commit: none
    const trees = Object.fromEntries(top.split("\0").map((e) => /^040000 tree ([0-9a-f]{40})\t([a-z0-9][a-z0-9-]*)$/.exec(e)).filter((m) => m && run(["ls-tree", at(m[2]!), "module.yaml"])).map((m) => [m![2]!, m![1]!]));
    const defs = Object.fromEntries(Object.keys(trees).map((m) => [m, (f.parse(run(["show", at(`${m}/module.yaml`)])) ?? {}) as Dict]));
    // A forked official module (spec §6.9b) is the fork's tree on top of its official folder: its def, and a computed tier
    // that is never official.
    const forks: Record<string, { at: Where; origin: string }> = {};
    // A per-module pin: the module's folder at its own commit of the official repository (pinsOf).
    for (const p of pinsOf(instance).filter((x) => x.marketplace === OFFICIAL && trees[x.name])) {
      const pw = { ...w, path: posix.join(w.path, p.name), sha: p.sha };
      if (w.url === product) throw new Error(`${p.name}: an official module is part of the product: pin the product (product:), not the module`);
      const root = checkout(pw, f);
      defs[p.name] = (f.parse(readFileSync(join(root, "module.yaml"), "utf8")) ?? {}) as Dict;
      forks[p.name] = { at: pw, origin: onOfficialMain(pw, f) ? `${OFFICIAL} pinned at ${p.sha.slice(0, 12)}` : `${OFFICIAL} pinned at ${p.sha.slice(0, 12)}, unreviewed: not on its main (tier declared)` };
    }
    for (const k of forksOf(instance).filter((x) => x.target !== "kernel" && trees[x.target])) {
      const fw = onFork({ ...w, path: posix.join(w.path, k.target) }, k, f);
      const root = checkout(fw, f);
      defs[k.target] = (f.parse(readFileSync(join(root, "module.yaml"), "utf8")) ?? {}) as Dict;
      forks[k.target] = { at: fw, origin: `fork ${fw.url} at ${fw.sha.slice(0, 12)} (tier declared)` };
    }
    // Official: read from the product's own modules/ at this commit (no kernel fork), not pinned or forked on its own.
    const official = w.url === product && w.path === "modules" ? Object.keys(trees).filter((m) => !forks[m]) : [];
    return { w, run, trees, defs, forks, official };
  };
  const [b, h] = [side(baseInstance, from), side(headInstance, to)];
  const forked = new Set([...Object.keys(b.forks), ...Object.keys(h.forks)]);
  const moved = [...new Set([...Object.keys(b.trees), ...Object.keys(h.trees)])].filter((m) => !forked.has(m) && b.trees[m] !== h.trees[m]);
  const changed = !moved.length ? [] : b.w.url !== h.w.url || b.w.path !== h.w.path ? moved.map((m) => `modules/${m}/(source moved)`)
    : h.run(["diff", "--name-only", "--no-renames", b.w.sha, h.w.sha, "--", ...moved.map((m) => posix.join(h.w.path, m))]).split("\n").filter(Boolean).map((p) => `modules/${h.w.path ? p.slice(h.w.path.length + 1) : p}`);
  const where = (s: typeof b, m: string): Where => s.forks[m]?.at ?? { ...s.w, path: posix.join(s.w.path, m) };
  for (const m of forked) if (b.trees[m] && h.trees[m]) changed.push(...changedFiles(where(b, m), where(h, m), f).map((p) => `modules/${m}/${p}`));
  const origins = (s: typeof b) => Object.fromEntries(Object.entries(s.forks).map(([m, x]) => [m, x.origin]));
  return { baseDefs: b.defs, headDefs: h.defs, changed, origins: { base: origins(b), head: origins(h) }, official: { base: b.official, head: h.official } };
}

/** Git on a cache repo, bounded in time; the credential helper and local paths only for a repository the owner named. */
function git(f: Fetch, repo: string, args: string[], { input, owned = false, timeout = 30_000 }: { input?: Buffer; owned?: boolean; timeout?: number } = {}) {
  const cred = owned && f.credentialHelper ? ["-c", `credential.helper=${f.credentialHelper}`, "-c", "credential.useHttpPath=true"] : [];
  return execFileSync("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", `protocol.file.allow=${owned ? "always" : "never"}`, "-c", "credential.helper=", ...cred, "--git-dir", repo, ...args], {
    maxBuffer: 256 << 20, input, timeout, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}
const has = (f: Fetch, repo: string, sha: string) => { try { git(f, repo, ["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; } };

/** The bare cache repository of a URL. */
export const cacheRepo = (url: string, f: Fetch) => join(f.cacheDir, "git", `${hash(url)}.git`);

/** Each network step's time limit: two minutes, or less when a `deadline` (epoch ms) comes sooner. */
const netTimeout = (deadline?: number) => Math.max(1_000, Math.min(120_000, deadline === undefined ? 120_000 : deadline - Date.now()));

/** The bare cache repository of a URL, holding `sha` (fetched by sha, else every branch). Past `deadline` a fetch is killed. */
export function repoAt(w: Where, f: Fetch, deadline?: number): string {
  const repo = cacheRepo(w.url, f);
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", repo]);
  }
  if (!has(f, repo, w.sha)) {
    const net = () => ({ owned: w.owned === true, timeout: netTimeout(deadline) });
    try { git(f, repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, w.sha], net()); } catch { git(f, repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, "+refs/heads/*:refs/remotes/source/*"], net()); }
  }
  if (!has(f, repo, w.sha) || git(f, repo, ["rev-parse", "--verify", `${w.sha}^{commit}`]).toString().trim() !== w.sha) throw new Error(`${w.url} has no commit ${w.sha}`);
  return repo;
}

/** The tree at `w` as a local folder, extracted once per sha and path. Symlinks and submodules are refused. `deadline`: as repoAt. */
export function checkout(w: Where, f: Fetch, deadline?: number): string {
  const dest = join(f.cacheDir, "trees", `${w.sha}-${hash(`${w.url}\0${w.path}`)}`);
  if (existsSync(dest)) return dest;
  const repo = repoAt(w, f, deadline);
  const tree = w.path ? `${w.sha}:${w.path}` : w.sha;
  const entries = git(f, repo, ["ls-tree", "-r", "-z", tree]).toString().split("\0").filter(Boolean);
  if (!entries.length) throw new Error(`${w.url}@${w.sha}: ${w.path || "the repository"} is empty or missing`);
  const odd = entries.filter((e) => /^(120000|160000) /.test(e)).map((e) => e.split("\t")[1]);
  if (odd.length) throw new Error(`${w.url}@${w.sha}: symlinks and submodules are refused (${odd.slice(0, 5).join(", ")})`);
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-x", "-C", tmp], { input: git(f, repo, ["archive", "--format=tar", tree], { timeout: netTimeout(deadline) }), maxBuffer: 256 << 20, timeout: netTimeout(deadline) });
  renameSync(tmp, dest);
  return dest;
}

/**
 * Files that differ between two checkouts of a module, relative to it, for the authority diff's code check. A different
 * repository or folder is a move: everything changed.
 */
export function changedFiles(a: Where, b: Where, f: Fetch): string[] {
  if (a.sha === b.sha && a.url === b.url && a.path === b.path) return [];
  if (a.path !== b.path) return ["(source moved)"];
  // Across two repositories (a fork and what it is on top of): diffed in the fetched one that holds both commits.
  const repo = a.url === b.url ? (repoAt(a, f), repoAt(b, f)) : [b, a].map((w) => cacheRepo(w.url, f)).find((r) => existsSync(r) && has(f, r, a.sha) && has(f, r, b.sha));
  if (!repo) return ["(source moved)"];
  const out = git(f, repo, ["diff", "--name-only", "--no-renames", a.sha, b.sha, "--", ...(b.path ? [b.path] : [])]).toString();
  return out.split("\n").filter(Boolean).map((p) => (b.path ? p.slice(b.path.length + 1) : p));
}

/**
 * Per-module pins (`modules: - { id, sha }`): the module's folder, as its marketplace names it, read at that commit of the
 * same repository instead of the marketplace's pin. Every other module keeps following its marketplace. Not with a fork.
 */
export function pinsOf(instance: Dict): { name: string; marketplace: string; sha: string }[] {
  const out: { name: string; marketplace: string; sha: string }[] = [];
  for (const m of Array.isArray(instance.modules) ? instance.modules : []) {
    if (!isMap(m) || m.sha == null) continue;
    const [name, mkt] = String(m.id).split("@");
    if (!SHA.test(String(m.sha))) throw new Error(`instance.yaml modules: ${name}: sha must be a 40-character commit`);
    if (m.fork != null) throw new Error(`instance.yaml modules: ${name}: a fork and a sha can't both be set`);
    out.push({ name: name!, marketplace: mkt || OFFICIAL, sha: String(m.sha) });
  }
  return out;
}

/**
 * Whether a pinned commit is on the official repository's main, so reviewed code. GitHub serves a fork's or a PR's commits
 * through the upstream URL too, so a sha alone proves nothing: one off main is treated as a fork (computed tier, the owner's).
 */
export function onOfficialMain(w: Where, f: Fetch): boolean {
  try {
    const repo = repoAt(w, f);
    git(f, repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, "+refs/heads/main:refs/remotes/official/main"], { owned: w.owned === true, timeout: 120_000 });
    git(f, repo, ["merge-base", "--is-ancestor", w.sha, "refs/remotes/official/main"]);
    return true;
  } catch {
    return false;
  }
}

/** instance.yaml `modules:` entries naming a third-party marketplace (`name@marketplace`), by marketplace. */
function wantedRemote(instance: Dict): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of Array.isArray(instance.modules) ? instance.modules : []) {
    const [name, mkt] = String(isMap(m) ? m.id : m).split("@");
    if (mkt && mkt !== OFFICIAL) out.set(mkt, [...(out.get(mkt) ?? []), name!]);
  }
  return out;
}

/**
 * The modules instance.yaml installs from third-party marketplaces, fetched and read. `parse`: the caller's YAML parser (the
 * compiler's). A module from a third-party marketplace is
 * `untrusted` unless its manifest says otherwise (spec §4.1); saying otherwise is new authority (the authority diff).
 */
export function remoteModules(instance: Dict, f: Fetch & { parse: (s: string) => unknown }, withForks = true): Remote[] {
  const mkts = new Map(marketplacesOf(instance).map((m) => [m.name, m.at]));
  const forks = withForks ? forksOf(instance) : [];
  const pins = pinsOf(instance);
  const out: Remote[] = [];
  for (const [mkt, names] of wantedRemote(instance)) {
    const at = mkts.get(mkt);
    if (!at) throw new Error(`instance.yaml modules: ${names[0]}@${mkt}: no marketplace ${mkt} in marketplaces:`);
    const dir = checkout(at, f);
    const file = join(dir, "marketplace.json");
    if (!existsSync(file)) throw new Error(`marketplace ${mkt}: no marketplace.json at ${at.url}@${at.sha}${at.path ? `:${at.path}` : ""}`);
    const entries = marketplaceEntries(JSON.parse(readFileSync(file, "utf8")), `marketplace ${mkt}`);
    for (const name of names) {
      const e = entries.find((x) => x.name === name);
      if (!e) throw new Error(`marketplace ${mkt} lists no module ${name}`);
      const fork = forks.find((x) => x.target === name);
      const pin = pins.find((x) => x.name === name && x.marketplace === mkt);
      const listed = { ...sourceOf(e.source, `marketplace ${mkt}: ${name}`, at), ...(pin ? { sha: pin.sha } : {}) };
      const w = fork ? onFork(listed, fork, f) : listed;
      const root = checkout(w, f);
      if (!existsSync(join(root, "module.yaml"))) throw new Error(`${name}@${mkt}: no module.yaml at ${w.url}@${w.sha}${w.path ? `:${w.path}` : ""}`);
      const def = (f.parse(readFileSync(join(root, "module.yaml"), "utf8")) ?? {}) as Dict;
      if (def.name !== name) throw new Error(`${name}@${mkt}: module.yaml name is ${String(def.name)}, expected ${name}`);
      def.isolation ??= "untrusted";
      out.push({ name, marketplace: mkt, market: at, at: w, root, def, tier: "declared", ...(fork ? { fork } : {}) });
    }
  }
  return out;
}

/** One teammate of a browsable module, as the catalog lists it (`department` is the agent's department id). */
export type BrowseTeammate = { key: string; name: string; job: string; sample: string; description: string; department: string; first?: number; face?: unknown };
/** A third-party module the instance doesn't install, listed for browsing and hiring (metadata only, never installed). */
export type BrowseEntry = { name: string; marketplace: string; description: string; requires: string[]; agents: string[]; teammates: BrowseTeammate[]; revision: string; source: { url: string; path: string } };
/** How long the whole browse step may take across every marketplace, so dead remotes never hold an apply. */
const BROWSE_BUDGET_MS = 90_000;
const AGENT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Third-party text: one line, control characters dropped, at most `max` characters. */
const plainText = (v: unknown, max: number) => String(v ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** A fetch that failed (network, timeout, a commit not there yet): retried next apply, so that listing isn't cached. */
class Transient extends Error {}
/** checkout(), its failures sorted: a refused tree (symlinks, empty) is the entry's own fault; anything else is the fetch's. */
const fetched = (w: Where, f: Fetch, deadline: number) => {
  try { return checkout(w, f, deadline); } catch (e) { const m = (e as Error).message; throw /symlinks and submodules|is empty or missing/.test(m) ? e : new Transient(m); }
};

/**
 * Every third-party marketplace's listing (instance.yaml `marketplaces:`, never the official one), read at its pinned sha
 * outside the install graph: each module's module.yaml and its agents' AGENTS.md frontmatter, nothing run. Cached by the
 * marketplace's pin (`<cacheDir>/browse/<hash>.json`, the whole listing); the modules the instance installs are left out
 * after reading, so installing one never refetches. A broken entry is skipped with a warning; a marketplace that can't be
 * read is skipped whole. Never throws. `teammate(text, where)`: the compiler's reader of an AGENTS.md (the teammate block
 * checked, third-party caps applied): undefined for an agent that isn't a teammate, a throw drops that teammate.
 */
export function browseMarketplaces(instance: Dict, f: Fetch & { parse: (s: string) => unknown }, warn: (msg: string) => void, teammate: (agentsMd: string, where: string) => Omit<BrowseTeammate, "key" | "department"> | undefined): BrowseEntry[] {
  let mkts: { name: string; at: Where }[];
  try { mkts = marketplacesOf(instance).filter((m) => m.name !== OFFICIAL); } catch { return []; } // remoteModules reports a bad list
  const wanted = wantedRemote(instance);
  const until = Date.now() + BROWSE_BUDGET_MS;
  const out: BrowseEntry[] = [];
  for (const { name: mkt, at } of mkts) {
    const file = join(f.cacheDir, "browse", `${hash(`${at.url}|${at.path}|${at.sha}`)}.json`);
    let listing: BrowseEntry[] | undefined;
    if (existsSync(file)) try { listing = JSON.parse(readFileSync(file, "utf8")); } catch { listing = undefined; }
    if (!listing) {
      let entries: { name: string; source: unknown }[];
      try {
        if (Date.now() > until) throw new Error("browse ran out of time");
        const dir = checkout(at, f, until);
        entries = marketplaceEntries(JSON.parse(readFileSync(join(dir, "marketplace.json"), "utf8")), `marketplace ${mkt}`);
      } catch (e) {
        warn(`marketplace ${mkt}: its listing can't be read (${(e as Error).message.slice(0, 200)})`);
        continue;
      }
      listing = [];
      let complete = true;
      let late = 0;
      for (const e of entries) {
        if (Date.now() > until) { late++; complete = false; continue; }
        try {
          const w = sourceOf(e.source, `marketplace ${mkt}: ${e.name}`, at);
          const root = fetched(w, f, until);
          const def = (f.parse(readFileSync(join(root, "module.yaml"), "utf8")) ?? {}) as Dict;
          if (def.name !== e.name) throw new Error(`its module.yaml name is ${String(def.name)}`);
          if (def.apps != null || Object.values(isMap(def.services) && isMap(def.services.run) ? def.services.run : {}).some((x) => isMap(x) && x.build != null)) throw new Error("apps and service builds from a remote source aren't supported");
          const agents = isMap(def.agents) ? def.agents : {};
          const teammates: BrowseTeammate[] = [];
          for (const [key, entry] of Object.entries(agents)) {
            const where = `marketplace ${mkt}: ${e.name}: agent ${key.slice(0, 64)}`;
            const md = join(root, "agents", key, "AGENTS.md");
            if (!AGENT_KEY.test(key) || !existsSync(md) || !realpathSync(md).startsWith(realpathSync(root) + sep)) { if (!AGENT_KEY.test(key) || existsSync(md)) warn(`${where}: not listed (a plain agent key whose AGENTS.md is inside the module)`); continue; }
            try {
              const t = teammate(readFileSync(md, "utf8"), where);
              const dept = isMap(entry) && typeof entry.department === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(entry.department) ? entry.department : "general";
              if (t) teammates.push({ key, ...t, department: dept });
            } catch (err) {
              warn(`${where}: its teammate isn't listed (${(err as Error).message.slice(0, 200)})`);
            }
          }
          listing.push({ name: e.name, marketplace: mkt, description: plainText(def.description, 300), requires: (Array.isArray(def.requires) ? def.requires : []).map(String).filter((r) => NAME.test(r)), agents: Object.keys(agents).filter((k) => AGENT_KEY.test(k)), teammates, revision: at.sha, source: { url: at.url, path: at.path } });
        } catch (err) {
          if (err instanceof Transient) complete = false;
          warn(`marketplace ${mkt}: ${e.name} not listed: ${(err as Error).message.slice(0, 200)}`);
        }
      }
      if (late) warn(`browse ran out of time: ${late} entries not listed`);
      if (complete) {
        // The cache only saves a refetch: a failed write keeps the listing in memory.
        try {
          mkdirSync(join(f.cacheDir, "browse"), { recursive: true });
          writeFileSync(file, JSON.stringify(listing));
        } catch (e) {
          warn(`marketplace ${mkt}: its listing isn't cached (${(e as Error).message.slice(0, 200)})`);
        }
      }
    }
    const installed = new Set(wanted.get(mkt) ?? []);
    // The cache is keyed by the pin: the name is the one instance.yaml gives it now.
    out.push(...listing.filter((x) => !installed.has(x.name)).map((x) => ({ ...x, marketplace: mkt })));
  }
  return out;
}

/**
 * How the host fetches: the default cache and the host's credential helper (ops/git-credential-github.mjs, the
 * owner's GitHub sign-in; it answers for the instance repo alone, and git fetches anonymously for any other).
 */
export function hostFetch(repo: string): Fetch {
  const cacheDir = defaultCache();
  const helper = join(repo, "ops/git-credential-github.mjs");
  return { cacheDir, ...(existsSync(helper) ? { credentialHelper: `!node ${helper}` } : {}) };
}

/**
 * The module side of an apply with third-party modules (the apply log and the card): each side's official defs plus the
 * third-party modules that side's instance.yaml installs, the files those changed between the sides (as modules/<name>/…
 * paths, as the product's own diff names them), and where each comes from (marketplace, sha, tier) for the card.
 */
export function withRemote<T extends { baseInstance: Dict; headInstance: Dict; baseDefs: Record<string, Dict>; headDefs: Record<string, Dict>; changed: string[]; origins?: { base: Record<string, string>; head: Record<string, string> } }>(a: T, f: Fetch & { parse: (s: string) => unknown}) {
  const [rb, rh] = [remoteModules(a.baseInstance, f), remoteModules(a.headInstance, f)];
  const defs = (official: Record<string, Dict>, remote: Remote[]) => {
    const out = { ...official };
    for (const r of remote) {
      if (out[r.name]) throw new Error(`${r.name}@${r.marketplace}: a module named ${r.name} is already installed`);
      out[r.name] = r.def;
    }
    return out;
  };
  const origin = (l: Remote[]) => Object.fromEntries(l.map((r) => [r.name, `${r.fork ? `fork ${r.at.url} on ` : ""}${r.marketplace} at ${r.at.sha.slice(0, 12)} (tier ${r.tier})`]));
  const changed = [...a.changed];
  // An install brings code that runs, as a code change does (the panel reviews it).
  for (const h of rh) {
    const b = rb.find((x) => x.name === h.name);
    changed.push(...(b ? changedFiles(b.at, h.at, f) : ["(installed)"]).map((p) => `modules/${h.name}/${p}`));
  }
  return { ...a, baseDefs: defs(a.baseDefs, rb), headDefs: defs(a.headDefs, rh), changed, origins: { base: { ...a.origins?.base, ...origin(rb) }, head: { ...a.origins?.head, ...origin(rh) } } };
}

/** A file name as the card shows it: safe characters as they are, anything else JSON-escaped. */
const safeName = (n: string) => (/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(n) ? n : JSON.stringify(n));
/**
 * Untrusted text on the card: split on every line terminator a model may read as one (\n, \r, \v, \f, U+0085, U+2028,
 * U+2029), other control, format and bidi characters shown as visible \uXXXX, and every line behind `| `, so none can pass
 * for a runner-written heading or section.
 */
const quoted = (text: string) => text.replace(/\r?\n$/, "").split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).map((l) => `| ${l.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === "\t" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))}`).join("\n");

/**
 * What a reviewer reads of third-party module code an apply brings (the card's diff): each fork it enters or moves (the
 * kernel's or a module's) as its patch on what it runs on top of, each updated module's git diff, each installed module's
 * file list, at most `max` characters. `product`: the product checkout (where the kernel and the official modules are).
 * Content of a fork or a third-party repository is untrusted: every line of it is quoted (`| `) and file names outside a
 * safe set are escaped.
 */
export function remoteCodeText(baseInstance: Dict, headInstance: Dict, f: Fetch & { parse: (s: string) => unknown }, product = "", max = 40_000): string {
  const parts: string[] = [];
  const was = forksOf(baseInstance);
  for (const k of forksOf(headInstance)) {
    const b = was.find((x) => x.target === k.target);
    if (b && b.at.url === k.at.url && b.at.sha === k.at.sha) continue;
    const base = forkBase(headInstance, k, product, f);
    const fw = onFork(base, k, f);
    const patch = git(f, repoAt(fw, f), ["diff", "--no-color", "--no-ext-diff", base.sha, fw.sha, "--", ...(fw.path ? [fw.path] : [])]).toString();
    parts.push(`Fork of ${k.target}: ${fw.url} at ${fw.sha.slice(0, 12)}, its patch on ${base.sha.slice(0, 12)}${k.upstream_pr ? ` (upstream ${k.upstream_pr})` : ""} (fork text, quoted):\n${quoted(patch)}`);
  }
  const [rb, rh] = [remoteModules(baseInstance, f), remoteModules(headInstance, f)];
  for (const h of rh) {
    if (h.fork) continue; // its patch is above
    const b = rb.find((x) => x.name === h.name);
    if (b && b.at.sha === h.at.sha && b.at.url === h.at.url && b.at.path === h.at.path) continue;
    const repo = repoAt(h.at, f);
    const spec = h.at.path ? [h.at.path] : [];
    if (b && b.at.url === h.at.url && b.at.path === h.at.path) {
      parts.push(`Module ${h.name}@${h.marketplace} code, ${b.at.sha.slice(0, 12)} → ${h.at.sha.slice(0, 12)} (third-party text, quoted):\n${quoted(git(f, repo, ["diff", "--no-color", "--no-ext-diff", b.at.sha, h.at.sha, "--", ...spec]).toString())}`);
    } else {
      const names = git(f, repo, ["ls-tree", "-r", "-z", "--name-only", h.at.path ? `${h.at.sha}:${h.at.path}` : h.at.sha]).toString().split("\0").filter(Boolean);
      parts.push(`Module ${h.name}@${h.marketplace} installed at ${h.at.sha.slice(0, 12)}, files (third-party names, quoted):\n${quoted(names.map(safeName).join("\n"))}`);
    }
  }
  const text = parts.join("\n");
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}
