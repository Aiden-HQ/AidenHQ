// Module sources and third-party marketplaces (spec §6.2-§6.5): a module comes from a marketplace at a pinned 40-char sha,
// never a ref. Sources are a relative path in the marketplace, or a hosted repo, a folder of a git URL (`git-subdir`) or a git `url`, each
// with its own sha. Git fetches the sha into a cache (through the credential helper the caller passes, per command, never
// into a checkout's config), checks it is that commit, refuses symlinks and submodules, and extracts the tree; nothing is
// built or run. The tier is computed, never claimed: declared (it compiles), conformant (+ the contract kit passes in the job
// sandbox, offline), official (from the `aidenhq` marketplace, whose kit runs in CI). Sync: the compiler is.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Dict = Record<string, unknown>;
/**
 * Where a module or marketplace is: a git repository (https URL or a local absolute path), a folder in it, a commit. `owned`:
 * the owner's instance.yaml names this repository itself, so the host's credential helper may be used for it; a URL taken
 * from a third-party marketplace.json never gets it.
 */
export type Where = { url: string; path: string; sha: string; owned?: boolean };
export type Fetch = { cacheDir: string; credentialHelper?: string };
export type Tier = "declared" | "conformant" | "official";
/** `market`: where its marketplace is (advisories are read from that repository's head). */
export type Remote = { name: string; marketplace: string; market: Where; at: Where; root: string; def: Dict; tier: Tier };

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

/** instance.yaml `marketplaces:`, the third-party ones (the `aidenhq` marketplace is the product's ./modules until 5b). */
export function marketplacesOf(instance: Dict): { name: string; at: Where }[] {
  const list = instance.marketplaces == null ? [] : instance.marketplaces;
  if (!Array.isArray(list)) throw new Error("instance.yaml marketplaces: must be a list");
  const seen = new Set<string>();
  return list.map((m, i) => {
    const name = String(isMap(m) ? m.name : "");
    const where = `instance.yaml marketplaces[${i}]`;
    if (!NAME.test(name)) throw new Error(`${where}: name must be kebab-case`);
    if (name === OFFICIAL) throw new Error(`${where}: ${OFFICIAL} is the official marketplace (the product's ./modules), not a third-party one`);
    if (seen.has(name)) throw new Error(`${where}: ${name} is listed twice`);
    seen.add(name);
    return { name, at: sourceOf((m as Dict).source, where, undefined, (m as Dict).sha, true) };
  });
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

/** The bare cache repository of a URL, holding `sha` (fetched by sha, else every branch). */
export function repoAt(w: Where, f: Fetch): string {
  const repo = cacheRepo(w.url, f);
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", repo]);
  }
  if (!has(f, repo, w.sha)) {
    const net = { owned: w.owned === true, timeout: 120_000 };
    try { git(f, repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, w.sha], net); } catch { git(f, repo, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, "+refs/heads/*:refs/remotes/source/*"], net); }
  }
  if (!has(f, repo, w.sha) || git(f, repo, ["rev-parse", "--verify", `${w.sha}^{commit}`]).toString().trim() !== w.sha) throw new Error(`${w.url} has no commit ${w.sha}`);
  return repo;
}

/** The tree at `w` as a local folder, extracted once per sha and path. Symlinks and submodules are refused. */
export function checkout(w: Where, f: Fetch): string {
  const dest = join(f.cacheDir, "trees", `${w.sha}-${hash(`${w.url}\0${w.path}`)}`);
  if (existsSync(dest)) return dest;
  const repo = repoAt(w, f);
  const tree = w.path ? `${w.sha}:${w.path}` : w.sha;
  const entries = git(f, repo, ["ls-tree", "-r", "-z", tree]).toString().split("\0").filter(Boolean);
  if (!entries.length) throw new Error(`${w.url}@${w.sha}: ${w.path || "the repository"} is empty or missing`);
  const odd = entries.filter((e) => /^(120000|160000) /.test(e)).map((e) => e.split("\t")[1]);
  if (odd.length) throw new Error(`${w.url}@${w.sha}: symlinks and submodules are refused (${odd.slice(0, 5).join(", ")})`);
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-x", "-C", tmp], { input: git(f, repo, ["archive", "--format=tar", tree], { timeout: 120_000 }), maxBuffer: 256 << 20, timeout: 120_000 });
  renameSync(tmp, dest);
  return dest;
}

/**
 * Files that differ between two checkouts of a module, relative to it, for the authority diff's code check. A different
 * repository or folder is a move: everything changed.
 */
export function changedFiles(a: Where, b: Where, f: Fetch): string[] {
  if (a.sha === b.sha && a.url === b.url && a.path === b.path) return [];
  if (a.url !== b.url || a.path !== b.path) return ["(source moved)"];
  const repo = repoAt(b, f);
  repoAt(a, f);
  const out = git(f, repo, ["diff", "--name-only", "--no-renames", a.sha, b.sha, "--", ...(b.path ? [b.path] : [])]).toString();
  return out.split("\n").filter(Boolean).map((p) => (b.path ? p.slice(b.path.length + 1) : p));
}

/** instance.yaml `modules:` entries naming a third-party marketplace (`name@marketplace`), by marketplace. */
function wantedRemote(instance: Dict): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of Array.isArray(instance.modules) ? instance.modules : []) {
    if (isMap(m) && m.sha != null) throw new Error(`instance.yaml modules: ${String(m.id)}: a per-module sha is not supported yet; pin the marketplace`);
    const [name, mkt] = String(isMap(m) ? m.id : m).split("@");
    if (mkt && mkt !== OFFICIAL) out.set(mkt, [...(out.get(mkt) ?? []), name!]);
  }
  return out;
}

/**
 * The modules instance.yaml installs from third-party marketplaces, fetched and read. `parse`: the caller's YAML parser (the
 * compiler's); `kit`: whether a module passes the contract kit (conformant). A module from a third-party marketplace is
 * `untrusted` unless its manifest says otherwise (spec §4.1); saying otherwise is new authority (the authority diff).
 */
export function remoteModules(instance: Dict, f: Fetch & { parse: (s: string) => unknown; kit?: (root: string, def: Dict, at: Where) => boolean }): Remote[] {
  const mkts = new Map(marketplacesOf(instance).map((m) => [m.name, m.at]));
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
      const w = sourceOf(e.source, `marketplace ${mkt}: ${name}`, at);
      const root = checkout(w, f);
      if (!existsSync(join(root, "module.yaml"))) throw new Error(`${name}@${mkt}: no module.yaml at ${w.url}@${w.sha}${w.path ? `:${w.path}` : ""}`);
      const def = (f.parse(readFileSync(join(root, "module.yaml"), "utf8")) ?? {}) as Dict;
      if (def.name !== name) throw new Error(`${name}@${mkt}: module.yaml name is ${String(def.name)}, expected ${name}`);
      def.isolation ??= "untrusted";
      out.push({ name, marketplace: mkt, market: at, at: w, root, def, tier: f.kit?.(root, def, w) ? "conformant" : "declared" });
    }
  }
  return out;
}

/**
 * How the host fetches: the default cache, the jailed kit, and the host's credential helper (ops/git-credential-app.mjs, the
 * code host module's App tokens; it answers nothing for a repo the App can't read, and git then fetches anonymously).
 */
export function hostFetch(repo: string): Fetch & { kit: ReturnType<typeof kitInJail> } {
  const cacheDir = defaultCache();
  const helper = join(repo, "ops/git-credential-app.mjs");
  return { cacheDir, kit: kitInJail(cacheDir), ...(existsSync(helper) ? { credentialHelper: `!node ${helper}` } : {}) };
}

/**
 * The module side of an apply with third-party modules (the apply log and the card): each side's official defs plus the
 * third-party modules that side's instance.yaml installs, the files those changed between the sides (as modules/<name>/…
 * paths, as the product's own diff names them), and where each comes from (marketplace, sha, tier) for the card.
 */
export function withRemote<T extends { baseInstance: Dict; headInstance: Dict; baseDefs: Record<string, Dict>; headDefs: Record<string, Dict>; changed: string[] }>(a: T, f: Fetch & { parse: (s: string) => unknown; kit?: (root: string, def: Dict, at: Where) => boolean }) {
  const [rb, rh] = [remoteModules(a.baseInstance, f), remoteModules(a.headInstance, f)];
  const defs = (official: Record<string, Dict>, remote: Remote[]) => {
    const out = { ...official };
    for (const r of remote) {
      if (out[r.name]) throw new Error(`${r.name}@${r.marketplace}: a module named ${r.name} is already installed`);
      out[r.name] = r.def;
    }
    return out;
  };
  const origin = (l: Remote[]) => Object.fromEntries(l.map((r) => [r.name, `${r.marketplace} at ${r.at.sha.slice(0, 12)} (tier ${r.tier})`]));
  const changed = [...a.changed];
  // An install brings code that runs, as a code change does (the panel reviews it).
  for (const h of rh) {
    const b = rb.find((x) => x.name === h.name);
    changed.push(...(b ? changedFiles(b.at, h.at, f) : ["(installed)"]).map((p) => `modules/${h.name}/${p}`));
  }
  return { ...a, baseDefs: defs(a.baseDefs, rb), headDefs: defs(a.headDefs, rh), changed, origins: { base: origin(rb), head: origin(rh) } };
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
 * What a reviewer reads of third-party module code an apply brings (the card's diff): each updated module's git diff, each
 * installed module's file list, at most `max` characters. Content of a third-party repository is untrusted: every line of it
 * is quoted (`| `) and file names outside a safe set are escaped.
 */
export function remoteCodeText(baseInstance: Dict, headInstance: Dict, f: Fetch & { parse: (s: string) => unknown }, max = 40_000): string {
  const [rb, rh] = [remoteModules(baseInstance, f), remoteModules(headInstance, f)];
  const parts: string[] = [];
  for (const h of rh) {
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

/**
 * The contract kit (kernel/sdk) on a third-party module, in the job sandbox with no network: true only when it ran and
 * passed. The kit covers engine@1, so a module with no engine is not conformant yet. Nowhere to jail it (no bwrap, not
 * Linux) is not conformant either. One run per sha, remembered in the cache.
 */
export function kitInJail(cacheDir: string) {
  return (root: string, def: Dict, at: Where) => {
    if (!isMap(def.providers) || def.providers.engine == null || process.platform !== "linux") return false;
    const mark = join(cacheDir, "kit", `${at.sha}-${hash(`${at.url}\0${at.path}`)}`);
    if (existsSync(mark)) return true;
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), root], { encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) return false; // failed, or no jail here: run again next time
    mkdirSync(join(cacheDir, "kit"), { recursive: true });
    writeFileSync(mark, "pass");
    return true;
  };
}

// The jailed kit itself: `node sources.ts <module dir>`. Exit 0 passed, 3 no jail, else failed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? "");
  const repo = resolve(import.meta.dirname, "../../..");
  const { sandboxConfig } = await import("../sandbox-config.ts");
  const { layout } = await import("../sandbox.ts");
  const cfg = sandboxConfig();
  const yaml = join(repo, "kernel/node_modules");
  if (spawnSync(cfg.bwrap, ["--version"]).status !== 0) process.exit(3);
  const argv = [cfg.bwrap, ...layout(cfg, { ro: [root, join(repo, "kernel/sdk"), yaml] }), "--unshare-net", "--die-with-parent", "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", homedir(), "--setenv", "NODE_PATH", yaml, "--", process.execPath, "--disable-warning=ExperimentalWarning", join(repo, "kernel/sdk/bin/aidenhq-module-test.ts"), root];
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", timeout: 110_000 });
  process.exit(r.status === 0 ? 0 : 1);
}
