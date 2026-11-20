#!/usr/bin/env node
// Everything outside package-lock.json is pinned, and nothing newly pinned is under 7 days old (the owner's rule).
// Lockfiles are npm-age.ts's. No dependencies, Node 22+; a byte-identical copy is in the app CI template.
//   node pins.ts <base-ref> <head-ref>      (GITHUB_TOKEN, when set, for the GitHub API)
//
// Pinned (checked over the whole tree at head):
//   Dockerfiles   `# syntax=`, FROM and COPY --from images by digest (build stages, `scratch` and FROM ${ARG} aside);
//   compose       every `image:` by digest, unless its service has a `build:`;
//   workflows     every `uses:` by a 40-character commit SHA with its tag in a comment (`# v1.2.3`), local ./ aside;
//   commands      (Dockerfile RUN, *.sh, workflow lines) `npm i -g` and `npx -y` at an exact version, `pip install`
//                 at `==`, no `curl | sh`, and after a script adds an apt repository (sources.list.d) every apt install
//                 is `pkg=version`. Distro packages installed before that ride on the base image's digest; a
//                 distro package pinned anyway (`pkg=version`) is dated from the host's Ubuntu pockets. A host script
//                 pins per Ubuntu release in the arms of `case "$codename" in <release>) …;; esac`: a pin in an arm is
//                 dated for that release only, any other for every release the file names (noble when it names none).
//   host pins     ops/vm/pins.json (read by ops/vm/setup.sh): `apt` for every release, `releases.<codename>.apt` for one;
//                 each dated from the file's `repos` as that release reads them, then its distro's pockets.
// Dated (only pins a change adds or alters, against the base; any lookup error fails): images, actions, npm, PyPI, apt
// pins, GitHub release downloads, and digest-pinned image strings in code. Each must be 7+ days old or be a security
// exception in .github/supply-chain-exceptions.yaml read from the base (`ecosystem` docker, github-action, npm, pypi,
// apt or github-release; `package`, `version`, `advisory`, `reason`; and `digest`/`sha` for a pin the registry can't date).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DAY, ghcrRelease, parseImage, publishedAt, readExceptions } from "./best-version.ts";

const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;
const SHELL = /\.sh$/;
const CODE = /\.(m?js|ts)$/;
const HOST_PINS = /(^|\/)ops\/vm\/pins\.json$/;
const SKIP = /(^|\/)(node_modules|test\/fixtures)\//;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const DEFAULT_RELEASE = "noble"; // a host file that names no release: Ubuntu 24.04 (hosts are amd64)
// A repository line as the host reads it on that release ($codename, $(. /etc/os-release …), $arch; pins.json's {distro}
// and {codename}).
const onRelease = (s, release, distro = "ubuntu") => s.replace(/\{(distro|codename)\}/g, (x, k) => (k === "distro" ? distro : release)).replace(/\$\{?(\w+)\}?/g, (x, k) => ({ codename: release, VERSION_CODENAME: release, arch: "amd64" })[k] ?? x).replace(/"?\$\(\.\s*\/etc\/os-release.*$/, release);
// The release's own repositories, tried after any the file adds: where a pinned distro package (fail2ban=…) is dated.
// Debian's point releases fold updates into the release suite; its -updates and -security indexes are xz only (unread
// here), so a pin only they carry fails as unlisted.
const distroSources = (r, distro = "ubuntu") => distro === "debian"
  ? [`http://deb.debian.org/debian ${r} main`]
  : [`${r}-updates main`, `${r}-updates universe`, `${r}-security main`, `${r}-security universe`, `${r} main`, `${r} universe`].map((s) => `http://archive.ubuntu.com/ubuntu ${s}`);

export const wanted = (path) => !SKIP.test(path) && (DOCKERFILE.test(path) || COMPOSE.test(path) || WORKFLOW.test(path) || SHELL.test(path) || CODE.test(path) || HOST_PINS.test(path));

// Logical lines: backslash continuations joined, with the first line's number.
function logical(text) {
  const out = [];
  let buf = "", start = 0;
  text.split("\n").forEach((l, i) => {
    if (!buf) start = i + 1;
    if (/\\\s*$/.test(l)) buf += l.replace(/\\\s*$/, " ");
    else { out.push({ n: start, text: buf + l }); buf = ""; }
  });
  return out;
}

const imagePin = (ref, at) => {
  const { tag, digest } = parseImage(ref);
  return { kind: "docker", name: ref.split("@")[0], package: ref.split("@")[0].replace(/:[^:/]*$/, ""), version: tag, digest, at };
};
const strip = (s) => s.replace(/^["']|["']$/g, "");
const words = (s) => s.trim().split(/\s+/).map(strip).filter(Boolean);

// Install commands on one logical line: pins found, problems found.
function commands(text, at, state, pins, problems) {
  const cmd = text.replace(/(^|\s)#.*$/, "");
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(\S*\/)?(ba|z|da)?sh\b/.test(cmd)) problems.push(`${at}: piping a download into a shell installs whatever is served: download a pinned version and check its sha256`);
  for (const m of cmd.matchAll(/\bnpm\s+(?:i|install|add)\s+([^;&|]*)/g)) {
    const args = words(m[1]);
    if (!args.some((a) => a === "-g" || a === "--global")) continue;
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      const p = /^(@?[^@\s]+)@(\d+\.\d+\.\d+\S*)$/.exec(a);
      if (!p) problems.push(`${at}: npm -g ${a} is not at an exact version (name@1.2.3)`);
      else pins.push({ kind: "npm", name: p[1], package: p[1], version: p[2], at });
    }
  }
  for (const m of cmd.matchAll(/\bnpx\s+([^;&|]*)/g)) {
    const args = words(m[1]);
    if (!args.some((a) => a === "-y" || a === "--yes")) continue; // without --yes npx runs the project's own (lockfiled) bin
    const a = args.find((x) => !x.startsWith("-"));
    const p = /^(@?[^@\s]+)@(\d+\.\d+\.\d+\S*)$/.exec(a || "");
    if (!p) problems.push(`${at}: npx -y ${a} is not at an exact version (name@1.2.3)`);
    else pins.push({ kind: "npm", name: p[1], package: p[1], version: p[2], at });
  }
  for (const m of cmd.matchAll(/\bpip3?"?\s+install\s+([^;&|]*)/g)) {
    const args = words(m[1]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-r" || a === "-c" || a === "-e" || a === "--requirement" || a === "--constraint") { i++; continue; }
      if (a.startsWith("-") || a.startsWith(".") || a.startsWith("/") || a.startsWith("$")) continue;
      const p = /^([A-Za-z0-9_.\-[\]]+)==([^\s,;]+)$/.exec(a);
      if (!p) problems.push(`${at}: pip install ${a} is not at an exact version (name==1.2.3)`);
      else pins.push({ kind: "pypi", name: p[1].replace(/\[.*\]$/, ""), package: p[1].replace(/\[.*\]$/, ""), version: p[2], at });
    }
  }
  if (/sources\.list\.d\//.test(cmd) && /(>|tee\b)/.test(cmd)) state.repoAdded = true;
  for (const m of cmd.matchAll(/\bdeb\s+(?:\[[^\]]*\]\s+)?(https?:\/\/[^\s"']+)\s+([^\s"']+)\s+([^\s"']+)/g)) state.sources.push(`${m[1]} ${m[2]} ${m[3]}`);
  // Per-release arms: `case "$codename" in`, a label (`noble)`, `noble|resolute)`) then the arm's commands, `;;`, `esac`.
  if (/^\s*case\s+"?\$\{?(codename|VERSION_CODENAME)\b/.test(cmd)) state.releaseCase = true;
  else if (/^\s*esac\b/.test(cmd)) state.releaseCase = false;
  const label = state.releaseCase && /^\s*([a-z][a-z0-9]*(?:\|[a-z][a-z0-9]*)*)\)/.exec(cmd);
  if (label) { state.arm = label[1].split("|"); state.arm.forEach((r) => state.releases.add(r)); }
  for (const m of cmd.matchAll(/\bapt(?:-get)?\s+(?:-\S+\s+)*install\s+([^;&|]*)/g)) {
    for (const a of words(m[1]).filter((x) => !x.startsWith("-") && !x.startsWith("./") && !x.startsWith("/") && !x.startsWith("$"))) {
      const [pkg, ver] = a.split("=");
      if (ver) pins.push({ kind: "apt", name: pkg, package: pkg, version: ver, sources: state.sources, releases: state.arm, at });
      else if (state.repoAdded) problems.push(`${at}: apt install ${pkg} after an apt repository is added: pin it (${pkg}=<version>) or install it before the repository`);
    }
  }
  for (const m of cmd.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/\s"'$]+)\//g)) {
    pins.push({ kind: "github-release", name: m[1], package: m[1], version: m[2], at });
  }
  if (/;;\s*$/.test(cmd)) state.arm = undefined;
}

/**
 * ops/vm/pins.json: one apt pin per package and release, with the file's repositories as that release reads them. A file
 * with no releases dates its top-level `apt` for DEFAULT_RELEASE (as scanFile does for a host script naming none); an `apt`
 * block no release can read (not an object of pins, or under a release that isn't an object) is a problem, never skipped.
 */
function hostPins(path, text) {
  const j = JSON.parse(text);
  const at = `${path}:${text.split("\n").findIndex((l) => /"apt"\s*:/.test(l)) + 1}`;
  const lineOf = (name, version) => text.split("\n").findIndex((l) => l.includes(`"${name}": "${version}"`)) + 1;
  const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const problems = [];
  if (j.apt !== undefined && !obj(j.apt)) problems.push(`${at}: \`apt\` is not an object of package pins`);
  if (j.releases !== undefined && !obj(j.releases)) problems.push(`${path}: \`releases\` is not an object of releases: its apt pins can't be dated`);
  const releases = obj(j.releases) && Object.keys(j.releases).length ? j.releases : { [DEFAULT_RELEASE]: { distro: "ubuntu" } };
  const pins = Object.entries(releases).flatMap(([release, r]) => {
    if (!obj(r) || (r.apt !== undefined && !obj(r.apt))) { problems.push(`${path}: release ${release} is not an object with an \`apt\` object: its pins can't be dated`); return []; }
    const sources = Object.values(j.repos ?? {}).map((s) => onRelease(s, release, r.distro));
    return Object.entries({ ...(obj(j.apt) ? j.apt : {}), ...(r.apt ?? {}) }).map(([name, version]) =>
      ({ kind: "apt", name, package: name, version, sources, release, distro: r.distro, at: `${path}:${lineOf(name, version)}` }));
  });
  return { pins, problems };
}

/** One file's pins and its unpinned problems. */
export function scanFile(path, text) {
  if (HOST_PINS.test(path)) return hostPins(path, text);
  const pins = [], problems = [];
  const state = { repoAdded: false, sources: [], releases: new Set() };
  const at = (n) => `${path}:${n}`;
  if (DOCKERFILE.test(path)) {
    const stages = new Set(["scratch"]);
    const syntax = /^#\s*syntax\s*=\s*(\S+)/m.exec(text);
    if (syntax) DIGEST.test(syntax[1]) ? pins.push(imagePin(syntax[1], at(1))) : problems.push(`${at(1)}: # syntax=${syntax[1]} has no digest`);
    for (const { n, text: l } of logical(text)) {
      const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
      const copy = /^\s*COPY\s+.*--from=(\S+)/i.exec(l);
      const ref = from?.[1] ?? copy?.[1];
      if (ref && !ref.includes("$") && !stages.has(ref.toLowerCase()) && (from || /[:/]/.test(ref))) {
        DIGEST.test(ref) ? pins.push(imagePin(ref, at(n))) : problems.push(`${at(n)}: image ${ref} has no digest (name:tag@sha256:…)`);
      }
      if (from?.[2]) stages.add(from[2].toLowerCase());
      if (/^\s*RUN\s/i.test(l)) commands(l, at(n), state, pins, problems);
    }
  } else if (COMPOSE.test(path) || WORKFLOW.test(path)) {
    const lines = text.split("\n");
    // A compose service is a 2-space-indented key; its block runs to the next one.
    const blockOf = (i) => { let s = i; while (s > 0 && !/^ {2}[\w.-]+:\s*$/.test(lines[s])) s--; let e = i + 1; while (e < lines.length && !/^ {2}[\w.-]+:\s*$/.test(lines[e]) && !/^\S/.test(lines[e])) e++; return lines.slice(s, e); };
    lines.forEach((l, i) => {
      const img = /^\s*-?\s*(?:image|container):\s*["']?([^\s"'#]+)/.exec(l);
      if (img && !img[1].includes("$")) {
        if (COMPOSE.test(path) && blockOf(i).some((b) => /^\s+build:/.test(b))) return;
        DIGEST.test(img[1]) ? pins.push(imagePin(img[1], at(i + 1))) : problems.push(`${at(i + 1)}: image ${img[1]} has no digest (name:tag@sha256:…)`);
      }
      const uses = WORKFLOW.test(path) && /^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?\s*(?:#\s*(\S+))?/.exec(l);
      if (uses && !uses[1].startsWith("./")) {
        if (uses[1].startsWith("docker://")) {
          const ref = uses[1].slice(9);
          DIGEST.test(ref) ? pins.push(imagePin(ref, at(i + 1))) : problems.push(`${at(i + 1)}: ${uses[1]} has no digest`);
        } else {
          const [action, ref] = uses[1].split("@");
          if (!/^[0-9a-f]{40}$/.test(ref || "")) problems.push(`${at(i + 1)}: ${uses[1]} is not pinned to a commit SHA`);
          else if (!uses[2]) problems.push(`${at(i + 1)}: ${uses[1]} has no version comment (# v1.2.3)`);
          else pins.push({ kind: "github-action", name: action.split("/").slice(0, 2).join("/"), package: action.split("/").slice(0, 2).join("/"), version: uses[2], sha: ref, at: at(i + 1) });
        }
      }
      if (WORKFLOW.test(path)) commands(l, at(i + 1), state, pins, problems);
    });
  } else if (SHELL.test(path)) {
    for (const { n, text: l } of logical(text)) commands(l, at(n), state, pins, problems);
  }
  if (SHELL.test(path) || CODE.test(path)) {
    // Digest-pinned images named in scripts and code (e.g. a scanner or renderer image): dated when they change.
    text.split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/([a-z0-9][\w.\/-]*:[\w.-]+@sha256:[0-9a-f]{64})/g)) pins.push(imagePin(m[1], at(i + 1)));
    });
  }
  // An apt pin once per release it is installed on.
  const all = state.releases.size ? [...state.releases] : [DEFAULT_RELEASE];
  return { pins: pins.flatMap(({ releases, ...p }) => (p.kind === "apt" ? (releases ?? all).map((release) => ({ ...p, release })) : [p])), problems };
}

// An apt pin's distro and sources are part of it: the same version from another repository or distro is dated again.
const key = (p) => JSON.stringify([p.kind, p.name, p.version, p.digest, p.sha, p.release, p.distro, p.sources]);
const exceptionFor = (p, exceptions) => exceptions.find((e) => e.ecosystem === p.kind && e.package === p.package && e.version === p.version && e.advisory);
// An owner-approved one (`owner: approved`, no advisory) covers a pin only while today < expires, at most 14 days out, and
// only the exact pin: its digest or sha when the pin has one (as npm-age.ts's, for any ecosystem here).
const ownerApproved = (p, exceptions, now) => exceptions.some((e) => e.ecosystem === p.kind && e.package === p.package && e.version === p.version && e.owner === "approved"
  && now < Date.parse(e.expires) && Date.parse(e.expires) - now <= 14 * DAY && e.digest === p.digest && e.sha === p.sha);

/** Date each new or changed pin; the problems, one line each. `date(pin)` returns {published, via} or throws. */
export async function checkAges({ pins, basePins = [], exceptions = [], date = datePin, releaseOf = baseRelease, now = Date.now() }) {
  const old = new Set(basePins.map(key));
  const seen = new Set();
  const problems = [];
  for (const p of pins) {
    if (old.has(key(p)) || seen.has(key(p))) continue;
    seen.add(key(p));
    const label = `${p.at}: ${p.name}${p.version && p.kind !== "docker" ? ` ${p.version}` : ""}${p.digest ? `@${p.digest.slice(0, 19)}…` : ""}${p.release ? ` (${p.release})` : ""}`;
    try {
      const { published, via, byRelease } = await date(p);
      // A release dates a version, not a digest: a new digest under a tag the base already pinned could be a re-push.
      if (byRelease && basePins.some((b) => b.kind === p.kind && b.name === p.name)) {
        problems.push(`${label}: could not be dated: only the digest changed on an unchanged tag, and the registry keeps no push record to date a re-push by (${via}); bump to a new tag`);
        continue;
      }
      // ...and must move forward: its release is newer than the release of the base's tag for the same image.
      if (byRelease) {
        const img = parseImage(p.name);
        const prior = basePins.filter((b) => b.kind === "docker" && parseImage(b.name).host === img.host && parseImage(b.name).repo === img.repo);
        let blocked = false;
        for (const b of prior) {
          const before = await releaseOf(b);
          if (!before || Date.parse(published) <= Date.parse(before)) {
            problems.push(`${label}: could not be dated: a release-dated pin must move forward, but ${b.name} is not older than it (${via}); the registry keeps no push record, so use an owner exception for a downgrade or sideways move`);
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }
      const age = now - Date.parse(published);
      if (age >= 7 * DAY) continue;
      if (exceptionFor(p, exceptions) || ownerApproved(p, exceptions, now)) continue;
      problems.push(`${label} was published ${(age / DAY).toFixed(1)} days ago (${via}, under 7): use an older version (best-version.ts), or add a security exception`);
    } catch (e) {
      // A pin whose registry keeps no push record to date it by passes only on a security exception that names it exactly: its
      // version and its digest or sha (`digest: sha256:…`), so the exception, not the registry, vouches for what is pulled.
      // Every other failure (a lookup error) stands.
      const ex = e.undated && exceptionFor(p, exceptions);
      if (ex && ex.digest === p.digest && ex.sha === p.sha) continue;
      problems.push(`${label}: could not be dated: ${e.message}`);
    }
  }
  return problems;
}

// The release date of a base pin's tag (null when it has none), to compare a release-dated move against.
async function baseRelease(b) {
  const { repo, tag } = parseImage(b.name);
  return tag ? (await ghcrRelease(repo, tag))?.published ?? null : null;
}

async function datePin(p) {
  if (p.kind === "docker") return publishedAt("docker", p.name, { digest: p.digest });
  if (p.kind === "apt") return dateApt(p);
  return publishedAt(p.kind, p.name, { version: p.version, sha: p.sha });
}

/**
 * An apt pin, from the repositories its file adds, then the distro's pockets, as its release reads them. A source is
 * passed over only when it was read and doesn't list the version; any other error (a repository that can't be read)
 * fails, so a lookup failure on the file's own repository never falls through to dating the package from somewhere else.
 */
export async function dateApt(p, lookup = publishedAt) {
  const release = p.release ?? DEFAULT_RELEASE;
  for (const source of [...p.sources.map((s) => onRelease(s, release, p.distro)), ...distroSources(release, p.distro)]) {
    try { return await lookup("apt", p.name, { version: p.version, source }); } catch (e) { if (!e.notListed) throw e; }
  }
  throw new Error(`${p.name}=${p.version}: no apt repository in this file, nor ${release}'s own, lists it`);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
function scanRef(ref) {
  const pins = [], problems = [];
  for (const path of git("ls-tree", "-r", "--name-only", ref).split("\n").filter(wanted)) {
    const text = git("show", `${ref}:${path}`);
    if (CODE.test(path) && !text.includes("@sha256:")) continue;
    const r = scanFile(path, text);
    pins.push(...r.pins);
    problems.push(...r.problems);
  }
  return { pins, problems };
}

async function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: pins.ts <base-ref> <head-ref>");
  const now = scanRef(head);
  let exText = "";
  try { exText = git("show", `${base}:.github/supply-chain-exceptions.yaml`); } catch { /* none yet */ }
  const ages = await checkAges({ pins: now.pins, basePins: scanRef(base).pins, exceptions: readExceptions(exText) });
  const problems = [...now.problems, ...ages];
  console.log(`${now.pins.length} pins; ${now.problems.length} unpinned; ${ages.length} too new or undatable`);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
