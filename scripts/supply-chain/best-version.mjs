#!/usr/bin/env node
// Which version may we use? The newest one published at least N days ago (the 7-day rule), from the public registries.
// No dependencies, Node 22+. A byte-identical copy lives in modules/core/templates/ci/.github/supply-chain/ for app
// repos (scripts/sync-shared.mjs).
//
//   node best-version.mjs npm <package>                     time[version] from the npm registry
//   node best-version.mjs pypi <package>                    earliest file upload_time on PyPI
//   node best-version.mjs github-release <owner/repo>       release published_at
//   node best-version.mjs github-action <owner/repo>        the same, plus the tag's commit SHA to pin
//   node best-version.mjs docker <image[:tag or tag*glob]>  Docker Hub push time (ghcr.io: GitHub Packages, with
//                                                           GITHUB_TOKEN), plus the digest to pin; never the image's
//                                                           own `created` time
//   node best-version.mjs apt <package> --source "<url> <dist> <component>"   the .deb's Last-Modified in that repo
//   node best-version.mjs apt-gvisor runsc                  the same, from gVisor's release repo
//   options: --min-days 7 (default), --json
//
// Prints one line: name version published (age) [digest or SHA]. GITHUB_TOKEN, when set, is sent to api.github.com.
// Security comes first: a package listed in .github/supply-chain-exceptions.yaml (Security Watch keeps it) gets its
// listed version, and a version with a known vulnerability (OSV) gets the lowest release that fixes it, even when that is
// under 7 days old; the line then ends with the advisory ids and what to record.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const DAY = 86400000;
// gVisor's repo keeps each weekly release in its own suite (dists/<yyyymmdd>); `release` holds only the newest.
export const GVISOR_URL = "https://storage.googleapis.com/gvisor/releases";
const gvisorSource = (version) => `${GVISOR_URL} ${String(version).split(".")[0]} main`;

export async function getJson(url, headers = {}) {
  return (await fetchRetry(url, { headers: { accept: "application/json", ...headers } })).json();
}

// Retries transient failures; a 404 (or another 4xx but 429) fails at once. Never returns a failed response.
export async function fetchRetry(url, init = {}) {
  const headers = { ...init.headers };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let err;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30000) });
      if (r.ok) return r;
      err = Object.assign(new Error(`${r.status} from ${url}`), { status: r.status, response: r });
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { err = e; }
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  throw err;
}

// Semver-ish compare: -1, 0, 1. A leading "v" is ignored; a prerelease sorts before its release.
export function cmpVersion(a, b) {
  const parse = (v) => { const [core, pre] = String(v).replace(/^v/, "").split("+")[0].split(/-(.+)/); return { n: core.split(".").map((x) => parseInt(x, 10) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) < (y.n[i] || 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// dpkg's version order (epoch:upstream-revision; "~" sorts before everything, even the end).
export function cmpDeb(a, b) {
  const split = (v) => { const m = /^(?:(\d+):)?(.*?)(?:-([^-]*))?$/.exec(v); return [Number(m[1] || 0), m[2], m[3] || "0"]; };
  const order = (c) => (c === undefined ? 0 : c === "~" ? -1 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
  const part = (x, y) => {
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      while ((i < x.length && !/\d/.test(x[i])) || (j < y.length && !/\d/.test(y[j]))) {
        const cx = /\d/.test(x[i] ?? "0") ? undefined : x[i], cy = /\d/.test(y[j] ?? "0") ? undefined : y[j];
        if (order(cx) !== order(cy)) return order(cx) < order(cy) ? -1 : 1;
        if (cx !== undefined) i++;
        if (cy !== undefined) j++;
      }
      let nx = "", ny = "";
      while (/\d/.test(x[i] ?? "")) nx += x[i++];
      while (/\d/.test(y[j] ?? "")) ny += y[j++];
      if (Number(nx || 0) !== Number(ny || 0)) return Number(nx || 0) < Number(ny || 0) ? -1 : 1;
    }
    return 0;
  };
  const [ea, ua, ra] = split(a), [eb, ub, rb] = split(b);
  return ea !== eb ? (ea < eb ? -1 : 1) : part(ua, ub) || part(ra, rb);
}

const RELEASE = /^v?\d+(\.\d+)*$/; // a plain release: no prerelease, rc, dev or build suffix

// ---------------------------------------------------------------- registries: [{version, published, digest?, sha?}]

async function npmVersions(name) {
  const p = await getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  return Object.entries(p.time || {}).filter(([v]) => RELEASE.test(v)).map(([version, published]) => ({ version, published }));
}

async function pypiVersions(name) {
  const p = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  return Object.entries(p.releases || {}).filter(([v, files]) => RELEASE.test(v) && files.length && !files.every((f) => f.yanked))
    .map(([version, files]) => ({ version, published: files.map((f) => f.upload_time_iso_8601).sort()[0] }));
}

async function githubReleases(repo) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const rs = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`);
    for (const r of rs) if (!r.draft && !r.prerelease && r.published_at && RELEASE.test(r.tag_name)) out.push({ version: r.tag_name, published: r.published_at });
    if (rs.length < 100) break;
  }
  return out;
}

// The commit a tag points at (annotated tags dereferenced by the commits endpoint).
const tagSha = async (repo, tag) => (await getJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`)).sha;

// ---------------------------------------------------------------- container images

export function parseImage(ref) {
  let [rest, digest] = String(ref).split("@");
  let tag;
  const slash = rest.lastIndexOf("/"), colon = rest.lastIndexOf(":");
  if (colon > slash) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  let host = "docker.io", repo = rest;
  const first = rest.split("/")[0];
  if (rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) { host = first; repo = rest.slice(first.length + 1); }
  if (host === "docker.io" && !repo.includes("/")) repo = `library/${repo}`;
  return { host, repo, tag, digest };
}

// Image dates come only from the registry's own push records, never the image's `created` field (its author sets
// that, so a fresh image could claim to be old). Docker Hub: each tag's push time and digest. ghcr.io: the GitHub
// Packages API's version created_at (needs GITHUB_TOKEN with read access to packages). Any other registry, or no
// record: fail closed.
const UNDATED = "can't establish its publish time from the registry; pin an image whose push time is known, or add a supply-chain exception";
const glob = (pat) => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

// Docker Hub tags [{version, published, digest}], optionally narrowed by a name substring; at most 1000.
async function hubTags(repo, filter = "") {
  const out = [];
  let url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100${filter ? `&name=${encodeURIComponent(filter)}` : ""}`;
  for (let i = 0; url && i < 10; i++) {
    const page = await getJson(url);
    for (const t of page.results || []) if (t.digest && t.tag_last_pushed) out.push({ version: t.name, published: t.tag_last_pushed, digest: t.digest, via: "Docker Hub push time" });
    url = page.next;
  }
  return out;
}

// ghcr.io package versions [{version (each tag), published, digest}] from the GitHub Packages API (org, then user).
async function ghcrVersions(repo) {
  const [owner, ...rest] = repo.split("/");
  const pkg = encodeURIComponent(rest.join("/"));
  let vs;
  for (const kind of ["orgs", "users"]) {
    try { vs = await getJson(`https://api.github.com/${kind}/${owner}/packages/container/${pkg}/versions?per_page=100`); break; } catch (e) { if (e.status !== 404) throw new Error(`ghcr.io/${repo}: ${UNDATED} (${e.message})`); }
  }
  if (!vs) throw new Error(`ghcr.io/${repo}: ${UNDATED}`);
  return vs.flatMap((v) => (v.metadata?.container?.tags || []).map((t) => ({ version: t, published: v.created_at, digest: v.name, via: "GitHub Packages publish time" })));
}

async function imageVersions(host, repo, filter) {
  if (host === "docker.io") return hubTags(repo, filter);
  if (host === "ghcr.io") return ghcrVersions(repo);
  throw new Error(`${host}/${repo}: ${UNDATED}`);
}

async function dockerVersions(name) {
  const { host, repo, tag } = parseImage(name);
  const want = tag ? glob(tag) : RELEASE;
  const filter = tag ? tag.split("*").sort((a, b) => b.length - a.length)[0] : "";
  return (await imageVersions(host, repo, filter)).filter((t) => want.test(t.version));
}

// ---------------------------------------------------------------- apt repositories

export async function aptIndex(source) {
  const [url, dist, comp = "main"] = source.trim().split(/\s+/);
  const dir = `${url.replace(/\/$/, "")}/dists/${dist}/${comp}/binary-amd64/Packages`;
  let text;
  try { text = await (await fetchRetry(dir)).text(); } catch {
    // zlib, not DecompressionStream: Ubuntu 22.04's release-pocket indexes end in zero padding, which the stream rejects.
    text = gunzipSync(Buffer.from(await (await fetchRetry(`${dir}.gz`)).arrayBuffer())).toString("utf8");
  }
  return text.split(/\n\n+/).map((s) => Object.fromEntries(s.split("\n").filter((l) => /^\S+: /.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)])))
    .map((p) => ({ ...p, url }));
}

const debPublished = async (p) => {
  const lm = (await fetchRetry(`${p.url.replace(/\/$/, "")}/${p.Filename}`, { method: "HEAD" })).headers.get("last-modified");
  if (!lm) throw new Error(`${p.Package} ${p.Version}: the repository gives no Last-Modified`);
  return new Date(lm).toISOString();
};

async function aptVersions(name, source, { minDays, now }) {
  const pkgs = (await aptIndex(source)).filter((p) => p.Package === name).sort((a, b) => cmpDeb(b.Version, a.Version));
  // Newest first, dated one at a time (a HEAD each) until one is old enough.
  const out = [];
  for (const p of pkgs) {
    if (out.some((o) => o.version === p.Version)) continue;
    out.push({ version: p.Version, published: await debPublished(p), via: "the .deb's Last-Modified" });
    if (now - Date.parse(out.at(-1).published) >= minDays * DAY) break;
  }
  return out;
}

async function gvisorVersions({ minDays, now }) {
  const ls = await getJson("https://storage.googleapis.com/storage/v1/b/gvisor/o?prefix=releases/dists/&delimiter=/");
  const suites = (ls.prefixes || []).map((p) => /dists\/(\d{8})\/$/.exec(p)?.[1]).filter(Boolean).sort().reverse();
  const out = [];
  for (const d of suites) {
    for (const p of (await aptIndex(gvisorSource(d))).filter((x) => x.Package === "runsc")) {
      out.push({ version: p.Version, published: await debPublished(p), source: gvisorSource(d), via: "the .deb's Last-Modified" });
    }
    if (out.length && now - Date.parse(out.at(-1).published) >= minDays * DAY) break;
  }
  return out;
}

// ---------------------------------------------------------------- the API

/** Every version the registry lists (plain releases only), with its publish time. */
export async function versions(kind, name, { source, minDays = 7, now = Date.now() } = {}) {
  switch (kind) {
    case "npm": return npmVersions(name);
    case "pypi": return pypiVersions(name);
    case "github-release": case "github-action": return githubReleases(name);
    case "docker": return dockerVersions(name);
    case "apt": if (!source) throw new Error("apt needs --source \"<url> <dist> <component>\""); return aptVersions(name, source, { minDays, now });
    case "apt-gvisor": if (name !== "runsc") throw new Error("apt-gvisor knows runsc only"); return gvisorVersions({ minDays, now });
    default: throw new Error(`unknown kind ${kind}`);
  }
}

// OSV's name for each kind's ecosystem (images and third-party apt repos have none).
const OSV = { npm: "npm", pypi: "PyPI", "github-action": "GitHub Actions", "github-release": "GitHub Actions" };
const exceptionKind = (kind) => (kind === "apt-gvisor" ? "apt" : kind === "github-release" ? "github-action" : kind);

// Known vulnerabilities in this version (OSV), and the lowest version that fixes them all: {ids, fixed} or null.
export async function osvFix(kind, name, version) {
  if (!OSV[kind]) return null;
  const r = await fetchRetry("https://api.osv.dev/v1/query", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: OSV[kind] }, version: version.replace(/^v/, "") }) });
  const vulns = (await r.json()).vulns || [];
  if (!vulns.length) return null;
  let fixed = null;
  for (const v of vulns) {
    const fixes = (v.affected || []).filter((a) => a.package?.name === name).flatMap((a) => (a.ranges || []).flatMap((g) => g.events || []))
      .map((e) => e.fixed).filter((f) => f && cmpVersion(f, version) > 0).sort(cmpVersion);
    if (fixes[0] && (!fixed || cmpVersion(fixes[0], fixed) > 0)) fixed = fixes[0];
  }
  return { ids: vulns.map((v) => v.id), fixed };
}

/**
 * The version to use: {name, version, published, ageDays, digest?, sha?, note?}. Normally the newest published at least
 * minDays ago. Two security exceptions return a newer one: an entry for this package in the exceptions file (kept by
 * Security Watch, read from `exceptions`), and a known vulnerability (OSV) in that version fixed in a newer release,
 * which returns the lowest release that fixes it.
 */
export async function bestVersion(kind, name, { minDays = 7, now = Date.now(), source, exceptions = [] } = {}) {
  const all = await versions(kind, name, { source, minDays, now });
  const order = kind.startsWith("apt") ? cmpDeb : cmpVersion;
  const age = (v) => Math.floor((now - Date.parse(v.published)) / DAY);
  const finish = async (v, note) => {
    const best = { name, ...v, ageDays: age(v), ...(note ? { note } : {}) };
    if (kind === "github-action") best.sha = await tagSha(name, best.version);
    return best;
  };
  const ok = all.filter((v) => now - Date.parse(v.published) >= minDays * DAY).sort((a, b) => order(b.version, a.version));
  // A listed security exception wins only while it is newer than what the 7-day rule allows.
  const pkg = kind === "docker" ? name.replace(/:[^:/]*$/, "") : name;
  const listed = exceptions.find((e) => !e.owner && e.package === pkg && (e.ecosystem || "npm") === exceptionKind(kind) && (!ok.length || order(e.version, ok[0].version) > 0));
  if (listed) {
    const v = all.find((x) => x.version === listed.version) || { version: listed.version, published: new Date(now).toISOString() };
    return finish(v, `security exception ${listed.advisory} (listed in the exceptions file)`);
  }
  if (!ok.length) throw new Error(`${kind} ${name}: no version is ${minDays} days old`);
  const vuln = await osvFix(kind, name, ok[0].version);
  const ids = (l) => l.slice(0, 5).join(", ") + (l.length > 5 ? ` and ${l.length - 5} more` : "");
  if (vuln) {
    const fix = vuln.fixed && all.filter((v) => order(v.version, vuln.fixed) >= 0).sort((a, b) => order(a.version, b.version))[0];
    if (fix) return finish(fix, `security fix: under ${minDays} days (${ids(vuln.ids)}); record it in .github/supply-chain-exceptions.yaml`);
    return finish(ok[0], `known vulnerabilities with no released fix: ${ids(vuln.ids)}`);
  }
  return finish(ok[0]);
}

// The exceptions file nearest the current directory (the repo's .github/supply-chain-exceptions.yaml), or none.
export function localExceptions(dir = process.cwd()) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const f = join(d, ".github", "supply-chain-exceptions.yaml");
    if (existsSync(f)) return readExceptions(readFileSync(f, "utf8"));
    if (dirname(d) === d) return [];
  }
}

/**
 * When was this exact pin published? {published, via}. Fails (throws) when it can't be dated: never guesses.
 *   npm, pypi: name + version.  github-action: owner/repo + version (the tag in the pin's comment) + sha, which must be
 *   that tag's commit.  docker: name (repo:tag) + digest.  apt: name + version + source.
 */
export async function publishedAt(kind, name, { version, digest, sha, source } = {}) {
  if (kind === "npm") {
    const t = (await getJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}`)).time?.[version];
    if (!t) throw new Error(`${name}@${version}: not in the npm registry`);
    return { published: t, via: "npm publish time" };
  }
  if (kind === "pypi") {
    const files = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)).urls || [];
    if (!files.length) throw new Error(`${name}==${version}: no files on PyPI`);
    return { published: files.map((f) => f.upload_time_iso_8601).sort()[0], via: "PyPI upload time" };
  }
  if (kind === "github-release") {
    const r = await getJson(`https://api.github.com/repos/${name}/releases/tags/${encodeURIComponent(version)}`);
    if (!r.published_at) throw new Error(`${name} ${version}: no published release`);
    return { published: r.published_at, via: "GitHub release" };
  }
  if (kind === "github-action") {
    if (!version) throw new Error(`${name}@${sha}: no version comment (# vX.Y.Z) to date it by`);
    const got = await tagSha(name, version);
    if (got !== sha) throw new Error(`${name}@${sha}: tag ${version} is commit ${got}, not the pinned one`);
    const r = await getJson(`https://api.github.com/repos/${name}/releases/tags/${encodeURIComponent(version)}`);
    if (!r.published_at) throw new Error(`${name} ${version}: no published release`);
    return { published: r.published_at, via: "GitHub release" };
  }
  if (kind === "docker") {
    const { host, repo, tag } = parseImage(name);
    if (!digest) throw new Error(`${name}: no digest`);
    if (host === "docker.io" && tag) {
      try {
        const t = await getJson(`https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(tag)}`);
        if (t.digest === digest && t.tag_last_pushed) return { published: t.tag_last_pushed, via: "Docker Hub push time" };
      } catch (e) { if (e.status !== 404) throw e; }
    }
    // The tag has moved on: another tag (or for ghcr, the package version) that still holds this digest.
    const hit = (await imageVersions(host, repo, "")).filter((t) => t.digest === digest).sort((a, b) => Date.parse(a.published) - Date.parse(b.published)).at(-1);
    if (!hit) throw new Error(`${name}@${digest}: ${UNDATED}`);
    return { published: hit.published, via: `${hit.via} (as ${hit.version})` };
  }
  if (kind === "apt" || kind === "apt-gvisor") {
    const src = kind === "apt-gvisor" ? gvisorSource(version) : source;
    const p = (await aptIndex(src)).find((x) => x.Package === name && x.Version === version);
    if (!p) throw Object.assign(new Error(`${name}=${version}: not in ${src}`), { notListed: true }); // read fine, not there
    return { published: await debPublished(p), via: "the .deb's Last-Modified" };
  }
  throw new Error(`unknown kind ${kind}`);
}

// The exceptions file (.github/supply-chain-exceptions.yaml): one flow-style entry per line under `exceptions:`,
// `- { ecosystem: docker, package: node, version: 24.22.2-bookworm-slim, advisory: CVE-…, reason: … }`. Other YAML
// shapes are not read (fail closed: an unread entry clears nothing).
export function readExceptions(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*-\s*\{(.*)\}\s*$/.exec(line);
    if (!m) continue;
    const e = {};
    for (const kv of m[1].split(/,\s*(?=\w+:\s)/)) {
      const i = kv.indexOf(":");
      if (i > 0) e[kv.slice(0, i).trim()] = kv.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    out.push(e);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const minDays = Number(opt("--min-days") ?? 7), source = opt("--source");
  const json = args.includes("--json");
  const [kind, name] = args.filter((a) => a !== "--json");
  if (!kind || !name) throw new Error("usage: best-version.mjs <npm|pypi|docker|github-release|github-action|apt|apt-gvisor> <name> [--min-days 7] [--source \"<url> <dist> <comp>\"] [--json]");
  const b = await bestVersion(kind, name, { minDays, source, exceptions: localExceptions() });
  if (json) console.log(JSON.stringify(b));
  else console.log([b.name, b.version, `published ${b.published} (${b.ageDays} days)`, b.digest || b.sha || (b.source ? `(deb ${b.source})` : ""), b.note ? `-- ${b.note}` : ""].join(" ").replace(/ +/g, " ").trim());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
