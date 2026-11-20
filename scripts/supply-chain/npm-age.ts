#!/usr/bin/env node
// The 7-day rule for npm (wave 3 item 17): every package-lock.json entry a change adds or alters, transitive ones
// included, must have been published at least 7 days ago (our own @aidenhq scope excepted), unless it is an owner-approved security fix, or an owner-approved expiring exception, listed in
// .github/supply-chain-exceptions.yaml, read from the base ref. Unchanged entries are never checked. Any lookup error fails: never pass on error.
// No dependencies (a byte-identical copy runs in app repos' CI, from the app CI template); everything else is pins.ts's.
// Usage: node scripts/supply-chain/npm-age.ts <base-ref> <head-ref>   (GITHUB_TOKEN for the advisory lookups)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExceptions } from "./best-version.ts";

export const MIN_AGE_MS = 7 * 24 * 3600 * 1000;

// Entries of a lockfile's `packages` map that are new or different in `next`: [{name, version}], or with `bad` set for
// an entry that cannot be age-checked. Fail closed: an added or changed entry must resolve to exactly
// https://registry.npmjs.org/<name>/-/<file>.tgz, with that name and version and an integrity hash. The name and version
// are derived from the URL and must match the entry's own, so a lockfile cannot show one package and install another.
// Allowed without a registry lookup: `link: true` entries that point inside the repo (workspaces), and workspace
// package entries (no node_modules/ in the key, no resolved). Anything else needs an exception in the file.
const REGISTRY_URL = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/;
export function changedEntries(prev, next) {
  const out = [];
  for (const [key, e] of Object.entries(next?.packages || {})) {
    if (!key) continue;
    const old = prev?.packages?.[key];
    if (old && JSON.stringify(old) === JSON.stringify(e)) continue;
    const keyName = key.includes("node_modules/") ? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length) : null;
    const name = e.name || keyName || key;
    const bad = (why) => out.push({ name, version: e.version || "?", resolved: e.resolved, integrity: e.integrity, bad: `${key}: ${why}` });
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
      const parent = next.packages[at], before = prev?.packages?.[at];
      const list = (p) => p?.bundleDependencies ?? p?.bundledDependencies;
      const url = REGISTRY_URL.exec(String(parent?.resolved || ""));
      const registry = at.includes("node_modules/") && parent && !parent.inBundle && parent.integrity && url && url[1] === parentName
        && (!parent.name || parent.name === parentName);
      const changed = JSON.stringify(before) !== JSON.stringify(parent);
      if (registry && Array.isArray(list(parent)) && list(parent).includes(keyName) && (changed || JSON.stringify(list(before)) === JSON.stringify(list(parent)))) continue;
    }
    if (!keyName && !e.resolved) continue; // a workspace package's own entry
    const m = REGISTRY_URL.exec(String(e.resolved || ""));
    if (!m) { bad(`resolved is not a registry tarball URL (${String(e.resolved).slice(0, 80)})`); continue; }
    if (!e.version || !e.integrity) { bad("no version or integrity"); continue; }
    const base = m[1].slice(m[1].lastIndexOf("/") + 1);
    if (m[1] !== name || m[2] !== `${base}-${e.version}`) { bad(`resolved ${m[1]}/${m[2]} does not match ${name}@${e.version}`); continue; }
    out.push({ name, version: e.version, resolved: e.resolved, integrity: e.integrity });
  }
  return out;
}

// Whether a changed lockfile can be fully checked, one problem per reason; fail closed. changedEntries reads only the
// `packages` map, so a lockfile it can't read, a pre-v2 one (no `packages`), or a `dependencies` tree naming something
// `packages` doesn't back would let entries through unchecked. `text` is the file at head, or undefined when git can't show it.
export function lockProblems(file, text) {
  let lock;
  try { lock = JSON.parse(text); } catch { return [`${file}: cannot be parsed as JSON, so its entries can't be age-checked`]; }
  const v = lock?.lockfileVersion;
  if (!(Number.isInteger(v) && v >= 2)) return [`${file}: lockfileVersion ${JSON.stringify(v)} is below 2, so its entries can't be age-checked (regenerate it with a current npm)`];
  const pk = lock.packages;
  if (!pk || typeof pk !== "object" || Array.isArray(pk) || !Object.keys(pk).length) return [`${file}: no \`packages\` map, so its entries can't be age-checked`];
  const out = [];
  const walk = (deps, prefix) => {
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

const parse = (v) => {
  const [core, pre] = String(v).split("+")[0].split(/-(.+)/);
  return { n: core.split(".").map(Number), pre };
};
// -1, 0, 1. A prerelease sorts before its release.
export function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) < (y.n[i] || 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// An owner-approved exception (`owner: approved`) needs no advisory: it holds for its exact package@version only while
// now < expires, and expires is at most 14 days from now, so it cannot be left open-ended.
const ownerHolds = (ex, now) => ex.owner === "approved" && now < Date.parse(ex.expires) && Date.parse(ex.expires) - now <= 14 * 86400000;

// Does this exception hold up? The advisory must exist, name the package, and be patched at or below the version.
async function exceptionHolds(ex, getJson) {
  const adv = await getJson(`https://api.github.com/advisories/${encodeURIComponent(ex.advisory)}`);
  const hit = (adv.vulnerabilities || []).find((v) => v.package?.ecosystem === "npm" && v.package?.name === ex.package
    && v.first_patched_version && cmp(v.first_patched_version, ex.version) <= 0);
  return Boolean(hit);
}

// changes: [{name, version}]. Returns the problems, one line each.
export async function check({ changes, exceptions = [], getJson, now = Date.now() }) {
  const problems = [];
  const seen = new Set();
  const packuments = new Map();
  for (const { name, version, bad, resolved, integrity } of changes) {
    const id = `${name}@${version}`;
    const dedupe = JSON.stringify([name, version, bad, resolved, integrity]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (bad) {
      // A non-registry entry clears only with its own kind of exception, pinned to the exact source and integrity;
      // an advisory (security-fix) exception never clears it.
      const ok = exceptions.some((e) => e.source && e.source === resolved && e.integrity && e.integrity === integrity && e.package === name);
      if (!ok) problems.push(`${bad}: not checkable, add a reviewed source exception (package, source, integrity)`);
      continue;
    }
    // Our own scope: published from main by the product's trusted-publishing workflow, used the same day.
    if (name.startsWith("@aidenhq/")) continue;
    try {
      if (!packuments.has(name)) packuments.set(name, await getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}`));
      const published = packuments.get(name).time?.[version];
      if (!published) throw new Error("no publish time in the registry");
      const age = now - Date.parse(published);
      if (age >= MIN_AGE_MS) continue;
      const days = (age / 86400000).toFixed(1);
      const exs = exceptions.filter((e) => e.package === name && e.version === version);
      const ex = exs.find((e) => !e.owner) || exs[0];
      if (exs.some((e) => ownerHolds(e, now))) continue;
      if (!ex) problems.push(`${id} was published ${days} days ago (under 7): wait, or add a reviewed security exception`);
      else if (ex.owner) problems.push(`${id}: the owner-approved exception is expired, or expires more than 14 days from now`);
      else if (!(await exceptionHolds(ex, getJson))) problems.push(`${id}: exception ${ex.advisory} does not name this package with a patched version at or below it`);
    } catch (e) {
      problems.push(`${id}: lookup failed: ${e.message}`);
    }
  }
  return problems;
}

async function getJsonWithRetry(url) {
  const headers = { accept: "application/json" };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let err;
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

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const lockAt = (ref, path) => { try { return JSON.parse(git("show", `${ref}:${path}`)); } catch { return null; } };
const textAt = (ref, path) => { try { return git("show", `${ref}:${path}`); } catch { return undefined; } };

async function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: npm-age.ts <base-ref> <head-ref>");
  const files = git("diff", "--name-only", `${base}..${head}`).split("\n").filter((f) => /(^|\/)package-lock\.json$/.test(f));
  // A lockfile deleted at head has nothing to check; one that is there but can't be fully read fails.
  const structural = files.flatMap((f) => { const t = textAt(head, f); return t === undefined ? [] : lockProblems(f, t); });
  const changes = files.flatMap((f) => { const next = lockAt(head, f); return next ? changedEntries(lockAt(base, f), next) : []; });
  // Exceptions come from the base commit: a change cannot approve its own exception; it lands in a PR of its own first.
  let exText = "";
  try { exText = git("show", `${base}:.github/supply-chain-exceptions.yaml`); } catch { /* none yet */ }
  // npm's own entries only: a docker or apt entry named like an npm package must not clear it.
  const exceptions = readExceptions(exText).filter((e) => (e.ecosystem || "npm") === "npm");
  const problems = [...structural, ...await check({ changes, exceptions, getJson: getJsonWithRetry })];
  console.log(`checked ${new Set(changes.map((c) => `${c.name}@${c.version}`)).size} changed lockfile entries in ${files.length} lockfiles`);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
