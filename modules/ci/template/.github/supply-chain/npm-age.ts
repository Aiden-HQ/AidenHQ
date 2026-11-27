#!/usr/bin/env node
// The 7-day rule for npm packages (wave 3 item 17): every bun.lock entry a change adds or alters, transitive ones included,
// must have been published at least 7 days ago (our own @aidenhq scope excepted), unless it is an owner-approved security
// fix, or an owner-approved expiring exception, listed in .github/supply-chain-exceptions.yaml, read from the head ref.
// Unchanged entries are never checked. Any lookup error fails: never pass on error. In a Bun repository (a bun.lock anywhere at
// head, as the product and the app starter's apps) Bun is the one package manager, so any other lockfile a change adds or
// alters fails; a repository with no bun.lock (an npm app from before Bun, another owner's repo) has its package-lock.json
// entries checked the same way. Either way npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml and bun.lockb fail, as do an .npmrc,
// a non-canonical bunfig.toml (BUNFIG) and a package with dependencies but no lockfile beside it.
// No dependencies (a byte-identical copy runs in app repos' CI, from the app CI template); everything else is pins.ts's.
// Usage: node scripts/supply-chain/npm-age.ts <base-ref> <head-ref>   (GITHUB_TOKEN for the advisory lookups)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExceptions } from "./best-version.ts";
import type { Exception } from "./best-version.ts";

export const MIN_AGE_MS = 7 * 24 * 3600 * 1000;

// bun.lock `packages` values: [id, registry, meta, integrity] for a registry package, where id is `<name>@<version>`, the
// registry "" (the default) and integrity a sha512 SRI; other sources (`<name>@workspace:…`, `link:`, `file:`, `github:`, a
// URL) have other shapes. The key is where it installs: `name` or `parent/name` (a nested copy).
type BunEntry = unknown[];
interface BunLock { lockfileVersion?: number; workspaces?: Record<string, unknown>; packages?: Record<string, BunEntry> }
interface LockEntry { name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean; inBundle?: boolean; bundleDependencies?: string[]; bundledDependencies?: string[] }
interface LockDep { resolved?: string; dependencies?: Record<string, LockDep> }
interface Lock { lockfileVersion?: number; packages?: Record<string, LockEntry>; dependencies?: Record<string, LockDep> }
interface Change { name: string; version: string; resolved?: string; integrity?: string; bad?: string }
// Registry JSON is untyped, so the result is any.
type GetJson = (url: string) => Promise<any>;

// bun.lock is JSON with trailing commas (Bun's JSONC, which it writes without comments). Commas before a closing bracket
// are dropped outside strings; a comment or anything else JSON.parse refuses throws, so a lockfile the check can't read fails.
export function parseBunLock(text: string): BunLock {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

// The bunfig.toml every directory with a bun.lock carries: its `[install]` is exactly exact saves and the 7-day minimum
// release age, nothing that changes where packages come from (registry, scopes, cafile...). Its only other table is `[test]`
// (bun test's settings, e.g. a preload); nothing outside a table. Compared line by line, comments and blank lines aside.
export const BUNFIG = ["[install]", "exact = true", "minimumReleaseAge = 604800"];
export const bunfigProblem = (file: string, text: string | undefined) => {
  if (text === undefined) return `${file}: missing; every bun.lock has a bunfig.toml beside it (${BUNFIG.join("; ")})`;
  const tables = new Map<string, string[]>();
  let at: string | undefined;
  for (const l of text.split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#"))) {
    if (l.startsWith("[")) { at = l; if (tables.has(at)) return `${file}: ${l} appears twice`; tables.set(at, []); continue; }
    if (at === undefined) return `${file}: ${l.slice(0, 40)} is outside a table: only [install] and [test] are allowed`;
    tables.get(at)!.push(l);
  }
  const bad = [...tables.keys()].filter((t) => t !== "[install]" && t !== "[test]");
  if (bad.length) return `${file}: ${bad.join(", ")}: only [install] and [test] are allowed (another table could change where or what bun installs)`;
  return JSON.stringify(["[install]", ...(tables.get("[install]") ?? [])]) === JSON.stringify(BUNFIG) ? undefined
    : `${file}: [install] must be exactly ${BUNFIG.slice(1).join("; ")} (comments aside): another setting could change where or what bun installs`;
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
// `<name>@<spec>` with a scoped or plain name.
const splitId = (id: string) => {
  const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
  return at > 0 ? { name: id.slice(0, at), spec: id.slice(at + 1) } : null;
};
// The installed name a key ends in: `a/b` is b under a, `a/@s/b` is @s/b under a.
const keyParent = (key: string) => {
  const parts = key.split("/");
  const n = parts.length >= 2 && parts[parts.length - 2]!.startsWith("@") ? 2 : 1;
  return parts.length > n ? parts.slice(0, -n).join("/") : null;
};
const isRegistry = (e: unknown): e is [string, string, Record<string, unknown>, string] => Array.isArray(e) && e.length === 4
  && typeof e[0] === "string" && e[1] === "" && !!e[2] && typeof e[2] === "object" && !Array.isArray(e[2]) && typeof e[3] === "string";

// Entries of a bun.lock's `packages` map that are new or different in `next`: [{name, version, integrity}], or with `bad`
// set for an entry that cannot be age-checked. Fail closed: an added or changed entry must be a default-registry package
// (registry "") with an exact version and a sha512 integrity, and check() binds that integrity to the registry's own for
// that name and version, so a lockfile cannot show one package and install another. The name is the entry's own (an
// alias key installs the package its id names). Allowed without a registry lookup: workspace and link entries inside the
// repo, and a package bundled in its parent's tarball when that parent is checked here. Anything else needs a source
// exception (package, source = the id's spec, integrity).
export function changedEntries(prev: BunLock | null | undefined, next: BunLock | null | undefined): Change[] {
  const out: Change[] = [];
  const pk = next?.packages || {};
  const changed = (key: string) => JSON.stringify(prev?.packages?.[key]) !== JSON.stringify(pk[key]);
  for (const [key, e] of Object.entries(pk)) {
    if (!changed(key)) continue;
    const id = Array.isArray(e) && typeof e[0] === "string" ? splitId(e[0]) : null;
    const name = id?.name || key;
    const integrity = Array.isArray(e) && typeof e.at(-1) === "string" ? e.at(-1) as string : undefined;
    const bad = (why: string) => out.push({ name, version: id?.spec || "?", resolved: id?.spec, integrity, bad: `${key}: ${why}` });
    if (!id) { bad("not a [<name>@<version>, …] entry"); continue; }
    const local = /^(workspace|link):(.*)$/.exec(id.spec);
    if (local) {
      if (Array.isArray(e) && e.length <= 2 && !local[2]!.startsWith("/") && !local[2]!.split("/").includes("..")) continue;
      bad(`${local[1]} outside the repo`); continue;
    }
    if (!isRegistry(e)) { bad(`not a default-registry package (${JSON.stringify(e).slice(0, 80)})`); continue; }
    if (!EXACT.test(id.spec)) { bad(`version ${id.spec.slice(0, 40)} is not an exact registry version`); continue; }
    // A bundled dependency ships inside its parent's tarball, so the parent's age and integrity cover it: skip it only when
    // its parent is a registry package that depends on it and is checked here (changed). A top-level entry is never bundled.
    if (e[2].bundled === true && e[3] === "") {
      const at = keyParent(key), parent = at ? pk[at] : undefined;
      const deps = isRegistry(parent) ? { ...(parent[2].dependencies as object), ...(parent[2].optionalDependencies as object) } : {};
      if (at && isRegistry(parent) && !parent[2].bundled && SHA512.test(parent[3]) && key.slice(at.length + 1) in deps && changed(at)) continue;
      bad("bundled, but its parent is not a changed registry package that depends on it"); continue;
    }
    if (!SHA512.test(e[3])) { bad("no sha512 integrity"); continue; }
    out.push({ name: id.name, version: id.spec, integrity: e[3] });
  }
  return out;
}

// Whether a changed bun.lock can be fully checked, one problem per reason; fail closed. `text` is the file at head.
export function lockProblems(file: string, text: string | undefined): string[] {
  let lock: BunLock;
  try { lock = parseBunLock(text!); } catch { return [`${file}: cannot be parsed, so its entries can't be age-checked`]; }
  const v = lock?.lockfileVersion;
  if (!(Number.isInteger(v) && v! >= 1 && v! <= 3)) return [`${file}: lockfileVersion ${JSON.stringify(v)} is not one this check reads (1-3)`];
  const pk = lock.packages;
  if (pk !== undefined && (!pk || typeof pk !== "object" || Array.isArray(pk))) return [`${file}: \`packages\` is not a map, so its entries can't be age-checked`];
  if (!lock.workspaces || typeof lock.workspaces !== "object") return [`${file}: no \`workspaces\` map`];
  return [];
}

// An npm repository (no bun.lock anywhere: an app from before Bun, or any other owner's repo the checks serve): its
// package-lock.json is checked as before Bun. Entries of a lockfile's `packages` map that are new or different in `next`: [{name, version}], or with `bad` set for
// an entry that cannot be age-checked. Fail closed: an added or changed entry must resolve to exactly
// https://registry.npmjs.org/<name>/-/<file>.tgz, with that name and version and an integrity hash. The name and version
// are derived from the URL and must match the entry's own, so a lockfile cannot show one package and install another.
// Allowed without a registry lookup: `link: true` entries that point inside the repo (workspaces), and workspace
// package entries (no node_modules/ in the key, no resolved). Anything else needs an exception in the file.
const REGISTRY_URL = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/;
export function npmChangedEntries(prev: Lock | null | undefined, next: Lock | null | undefined): Change[] {
  const out: Change[] = [];
  for (const [key, e] of Object.entries(next?.packages || {})) {
    if (!key) continue;
    const old = prev?.packages?.[key];
    if (old && JSON.stringify(old) === JSON.stringify(e)) continue;
    const keyName = key.includes("node_modules/") ? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length) : null;
    const name = e.name || keyName || key;
    const bad = (why: string) => out.push({ name, version: e.version || "?", resolved: e.resolved, integrity: e.integrity, bad: `${key}: ${why}` });
    if (e.link) {
      if (typeof e.resolved !== "string" || e.resolved.startsWith("/") || e.resolved.split("/").includes("..")) bad("link outside the repo");
      continue;
    }
    // A bundled dependency ships inside its parent's tarball, so the parent's age and integrity cover it. The lockfile's
    // `inBundle` flag alone proves nothing: skip the entry only when the parent is a registry tarball that names this
    // child in its bundle list, the child has no source of its own, and the parent is either checked here (changed) or
    // carries the same bundle list as in the base. Anything else falls through and is checked like any entry.
    // A top-level entry (no parent package in its key) is never bundled.
    const cut = key.lastIndexOf("/node_modules/");
    if (e.inBundle && keyName && cut > 0 && !e.resolved && !e.integrity) {
      const at = key.slice(0, cut);
      const parentName = at.slice(at.lastIndexOf("node_modules/") + "node_modules/".length);
      const parent = next!.packages![at], before = prev?.packages?.[at];
      const list = (p: LockEntry | undefined) => p?.bundleDependencies ?? p?.bundledDependencies;
      const url = REGISTRY_URL.exec(String(parent?.resolved || ""));
      const registry = at.includes("node_modules/") && parent && !parent.inBundle && parent.integrity && url && url[1] === parentName
        && (!parent.name || parent.name === parentName);
      const changed = JSON.stringify(before) !== JSON.stringify(parent);
      if (registry && Array.isArray(list(parent)) && list(parent)!.includes(keyName) && (changed || JSON.stringify(list(before)) === JSON.stringify(list(parent)))) continue;
    }
    if (!keyName && !e.resolved) continue; // a workspace package's own entry
    const m = REGISTRY_URL.exec(String(e.resolved || ""));
    if (!m) { bad(`resolved is not a registry tarball URL (${String(e.resolved).slice(0, 80)})`); continue; }
    if (!e.version || !e.integrity) { bad("no version or integrity"); continue; }
    const base = m[1]!.slice(m[1]!.lastIndexOf("/") + 1);
    if (m[1] !== name || m[2] !== `${base}-${e.version}`) { bad(`resolved ${m[1]}/${m[2]} does not match ${name}@${e.version}`); continue; }
    out.push({ name, version: e.version, resolved: e.resolved, integrity: e.integrity });
  }
  return out;
}

// Whether a changed lockfile can be fully checked, one problem per reason; fail closed. changedEntries reads only the
// `packages` map, so a lockfile it can't read, a pre-v2 one (no `packages`), or a `dependencies` tree naming something
// `packages` doesn't back would let entries through unchecked. `text` is the file at head, or undefined when git can't show it.
export function npmLockProblems(file: string, text: string | undefined): string[] {
  let lock: Lock;
  try { lock = JSON.parse(text!); } catch { return [`${file}: cannot be parsed as JSON, so its entries can't be age-checked`]; }
  const v = lock?.lockfileVersion;
  if (!(Number.isInteger(v) && v! >= 2)) return [`${file}: lockfileVersion ${JSON.stringify(v)} is below 2, so its entries can't be age-checked (regenerate it with a current npm)`];
  const pk = lock.packages;
  if (!pk || typeof pk !== "object" || Array.isArray(pk) || !Object.keys(pk).length) return [`${file}: no \`packages\` map, so its entries can't be age-checked`];
  const out: string[] = [];
  const walk = (deps: Record<string, LockDep> | undefined, prefix: string): void => {
    for (const [name, d] of Object.entries(deps || {})) {
      const key = `${prefix}node_modules/${name}`;
      const e = pk[key];
      if (!e || typeof e !== "object") out.push(`${file}: dependencies entry ${key} has no matching packages entry`);
      else if (d?.resolved !== undefined && d.resolved !== e.resolved) out.push(`${file}: dependencies entry ${key} resolves to ${String(d.resolved).slice(0, 80)}, not its packages entry's source`);
      walk(d?.dependencies, `${key}/`);
    }
  };
  walk(lock.dependencies, "");
  return out.slice(0, 20);
}

const parse = (v: string) => {
  const [core, pre] = String(v).split("+")[0]!.split(/-(.+)/);
  return { n: core!.split(".").map(Number), pre };
};
// -1, 0, 1. A prerelease sorts before its release.
export function cmp(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) < (y.n[i] || 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// An owner-approved exception (`owner: approved`) needs no advisory: it holds for its exact package@version only while
// now < expires, and expires is at most 14 days from now, so it cannot be left open-ended.
const ownerHolds = (ex: Exception, now: number) => ex.owner === "approved" && now < Date.parse(ex.expires!) && Date.parse(ex.expires!) - now <= 14 * 86400000;

// Does this exception hold up? The advisory must exist, name the package, and be patched at or below the version.
async function exceptionHolds(ex: Exception, getJson: GetJson) {
  const adv: { vulnerabilities?: { package?: { ecosystem?: string; name?: string }; first_patched_version?: string }[] } = await getJson(`https://api.github.com/advisories/${encodeURIComponent(ex.advisory!)}`);
  const hit = (adv.vulnerabilities || []).find((v) => v.package?.ecosystem === "npm" && v.package?.name === ex.package
    && v.first_patched_version && cmp(v.first_patched_version, ex.version!) <= 0);
  return Boolean(hit);
}

// changes: [{name, version, integrity}]. Returns the problems, one line each. Lookups run 16 at a time; each name's
// packument is fetched once. A registry entry passes only when the registry's integrity for that name and version is the
// lockfile's (so the default registry can't be swapped for another source) and it is 7+ days old or excepted.
export async function check({ changes, exceptions = [], getJson, now = Date.now() }: { changes: Change[]; exceptions?: Exception[]; getJson: GetJson; now?: number }): Promise<string[]> {
  const unique = [...new Map(changes.map((c) => [JSON.stringify([c.name, c.version, c.bad, c.resolved, c.integrity]), c])).values()];
  const packuments = new Map<string, Promise<{ time?: Record<string, string>; versions?: Record<string, { dist?: { integrity?: string } }> }>>();
  const packument = (name: string) => {
    if (!packuments.has(name)) packuments.set(name, getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}`));
    return packuments.get(name)!;
  };
  const one = async ({ name, version, bad, resolved, integrity }: Change): Promise<string | undefined> => {
    const id = `${name}@${version}`;
    if (bad) {
      // A non-registry entry clears only with its own kind of exception, pinned to the exact source and integrity;
      // an advisory (security-fix) exception never clears it.
      const ok = exceptions.some((e) => e.source && e.source === resolved && e.integrity && e.integrity === integrity && e.package === name);
      return ok ? undefined : `${bad}: not checkable, add a reviewed source exception (package, source, integrity)`;
    }
    // Our own scope: published from main by the product's trusted-publishing workflow, used the same day.
    if (name.startsWith("@aidenhq/")) return undefined;
    try {
      const p = await packument(name);
      const published = p.time?.[version];
      if (!published) throw new Error("no publish time in the registry");
      const theirs = p.versions?.[version]?.dist?.integrity;
      if (theirs !== integrity) return `${id}: the lockfile's integrity is not the registry's (${String(theirs).slice(0, 20)}…): not the package npm serves`;
      const age = now - Date.parse(published);
      if (age >= MIN_AGE_MS) return undefined;
      const days = (age / 86400000).toFixed(1);
      const exs = exceptions.filter((e) => e.package === name && e.version === version);
      const ex = exs.find((e) => !e.owner) || exs[0];
      if (exs.some((e) => ownerHolds(e, now))) return undefined;
      if (!ex) return `${id} was published ${days} days ago (under 7): wait, or add a reviewed security exception`;
      if (ex.owner) return `${id}: the owner-approved exception is expired, or expires more than 14 days from now`;
      if (!(await exceptionHolds(ex, getJson))) return `${id}: exception ${ex.advisory} does not name this package with a patched version at or below it`;
      return undefined;
    } catch (e) {
      return `${id}: lookup failed: ${(e as Error).message}`;
    }
  };
  const results: (string | undefined)[] = new Array(unique.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, unique.length) }, async () => {
    while (next < unique.length) { const i = next++; results[i] = await one(unique[i]!); }
  }));
  return results.filter((p): p is string => !!p);
}

async function getJsonWithRetry(url: string): Promise<any> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let err: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
      err = new Error(`${r.status} from ${url}`);
      if (r.status === 404) break;
    } catch (e) { err = e; }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw err;
}

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
// A path missing at that ref is undefined (git's complaint about it is not printed).
const textAt = (ref: string, path: string) => { try { return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; } };
const BAD_LOCK = /(^|\/)(npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/;
const BUN_LOCK = /(^|\/)bun\.lock$/, NPM_LOCK = /(^|\/)package-lock\.json$/;
const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "");
// A package.json's dependencies that come from a registry (local `file:`, `link:` and `workspace:` ones need no lockfile),
// required peers included: npm and Bun install those too.
const registryDeps = (text: string | undefined) => {
  try {
    const j = JSON.parse(text!);
    const optionalPeer = (n: string) => j?.peerDependenciesMeta?.[n]?.optional === true;
    return [
      ...["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) => Object.values(j?.[k] ?? {})),
      ...Object.entries(j?.peerDependencies ?? {}).filter(([n]) => !optionalPeer(n)).map(([, v]) => v),
    ].filter((v) => !/^(file|link|workspace):/.test(String(v))).length;
  } catch { return 0; }
};
// Whether `rel` (a package dir relative to a workspace root) is one of the root's `workspaces` globs (`*` one segment, `**` any).
const member = (workspaces: unknown, rel: string) => {
  const globs = Array.isArray(workspaces) ? workspaces : Array.isArray((workspaces as { packages?: unknown })?.packages) ? (workspaces as { packages: unknown[] }).packages : [];
  return globs.some((g) => typeof g === "string" && new RegExp(`^${g.replace(/^\.\//, "").replace(/\/+$/, "").split("/").map((p) => (p === "**" ? ".*" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))).join("/")}$`).test(rel));
};

async function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: npm-age.ts <base-ref> <head-ref>");
  // Raw paths (-z): a quoted one (a non-ASCII directory) would slip past the name tests. No renames: a moved file is its old
  // path deleted and its new one added, so the package it left is checked too.
  const diff = git("diff", "--name-only", "-z", "--no-renames", `${base}..${head}`).split("\0").filter(Boolean);
  const bunRepo = git("ls-tree", "-r", "--name-only", "-z", head).split("\0").some((f) => BUN_LOCK.test(f));
  const at = (f: string) => textAt(head, f);
  const bunLocks = diff.filter((f) => BUN_LOCK.test(f));
  // A package's lockfile: beside it, or a workspace root's above it (a root package.json with `workspaces`) that holds one.
  const hasLock = (d: string) => at(`${d}bun.lock`) !== undefined || (!bunRepo && at(`${d}package-lock.json`) !== undefined);
  const locked = (d: string): boolean => {
    if (hasLock(d)) return true;
    for (let up = d.slice(0, -1); up; ) {
      up = up.includes("/") ? up.slice(0, up.lastIndexOf("/")) : "";
      const root = up ? `${up}/` : "";
      try { if (member(JSON.parse(at(`${root}package.json`) ?? "null")?.workspaces, d.slice(root.length, -1)) && hasLock(root)) return true; } catch { /* not a root */ }
      if (!up) break;
    }
    return false;
  };
  const npmLocks = diff.filter((f) => NPM_LOCK.test(f));
  // Files deleted at head have nothing to check; anything there that can't be fully read, or that bun alone should own, fails.
  const structural = [
    ...diff.filter((f) => (BAD_LOCK.test(f) || (bunRepo && NPM_LOCK.test(f))) && at(f) !== undefined).map((f) => `${f}: Bun is the one package manager here: install with bun (bun.lock), never another lockfile`),
    ...diff.filter((f) => /(^|\/)\.npmrc$/.test(f) && at(f) !== undefined).map((f) => `${f}: an .npmrc can point installs at another registry: none is allowed`),
    // Every changed bun.lock has the canonical bunfig.toml beside it, a changed bunfig.toml stays canonical, and one beside a
    // bun.lock is never deleted.
    ...[...new Set([...bunLocks, ...diff.filter((f) => /(^|\/)bunfig\.toml$/.test(f))].map((f) => `${dirOf(f)}bunfig.toml`))]
      .map((f) => ({ f, text: at(f) }))
      // A missing one is a problem only beside a bun.lock; one that is there is always checked (a root bunfig governs subdirs' installs too).
      .filter(({ f, text }) => text !== undefined || at(`${dirOf(f)}bun.lock`) !== undefined)
      .map(({ f, text }) => bunfigProblem(f, text)).filter((p): p is string => !!p),
    // A package whose manifest or lockfile changed and that has registry dependencies keeps its lockfile: without one an install
    // resolves a tree nobody reviewed.
    ...[...new Set(diff.filter((f) => /(^|\/)(package\.json|bun\.lock|package-lock\.json)$/.test(f)).map(dirOf))]
      .filter((d) => registryDeps(at(`${d}package.json`)) > 0 && !locked(d))
      .map((d) => `${d}package.json: has dependencies but no ${bunRepo ? "bun.lock" : "lockfile"} beside it: commit the lockfile (bun install)`),
    ...bunLocks.flatMap((f) => { const t = at(f); return t === undefined ? [] : lockProblems(f, t); }),
    ...(bunRepo ? [] : npmLocks.flatMap((f) => { const t = at(f); return t === undefined ? [] : npmLockProblems(f, t); })),
  ];
  const bunAt = (ref: string, f: string) => { try { return parseBunLock(textAt(ref, f)!); } catch { return null; } };
  const npmAt = (ref: string, f: string) => { try { return JSON.parse(textAt(ref, f)!); } catch { return null; } };
  const changes = [
    ...bunLocks.flatMap((f) => { const next = bunAt(head, f); return next ? changedEntries(bunAt(base, f), next) : []; }),
    ...(bunRepo ? [] : npmLocks.flatMap((f) => { const next = npmAt(head, f); return next ? npmChangedEntries(npmAt(base, f), next) : []; })),
  ];
  // Exceptions come from the head: a fix and its exception land in one PR, and the code review covers both.
  let exText = "";
  try { exText = git("show", `${head}:.github/supply-chain-exceptions.yaml`); } catch { /* none yet */ }
  // npm's own entries only: a docker or apt entry named like an npm package must not clear it.
  const exceptions = readExceptions(exText).filter((e) => (e.ecosystem || "npm") === "npm");
  const problems = [...structural, ...await check({ changes, exceptions, getJson: getJsonWithRetry })];
  console.log(`checked ${new Set(changes.map((c) => `${c.name}@${c.version}`)).size} changed lockfile entries in ${bunLocks.length + (bunRepo ? 0 : npmLocks.length)} lockfiles`);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
