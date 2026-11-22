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
//                 distro package pinned anyway (`pkg=version`) is dated from its own base's distro (its stage's FROM
//                 `debian:<codename>` or `ubuntu:<codename>`; the file's source entries first, then that distro's
//                 pockets). A stage inherits the repositories a stage it extends (`FROM <stage>`) added, and neither
//                 its own nor its siblings' additions leak into another stage.
//                 Where the base's codename can't be read (a host script, scratch, FROM ${ARG}, another image) the
//                 host's Ubuntu pockets are used. A host script pins per Ubuntu release in the arms of
//                 `case "$codename" in <release>) …;; esac`: a pin in an arm is dated for that release only, any other
//                 for every release the file names (noble when it names none).
//   host pins     ops/vm/pins.json (read by ops/vm/setup.sh): `apt` for every release, `releases.<codename>.apt` for one;
//                 each dated from the file's `repos` as that release reads them, then its distro's pockets.
// Dated (only pins a change adds or alters, against the base): images, actions, npm, PyPI, apt pins, GitHub release
// downloads, and digest-pinned image strings in code. Each must be 7+ days old or be a security exception in
// .github/supply-chain-exceptions.yaml read from the head, so a fix and its exception land in one PR and the code review
// covers both (`ecosystem` docker, github-action, npm, pypi, apt or github-release; `package`, `version`, `advisory`,
// `reason`). A pin that can't be dated (a registry with no push record, a lookup error, an apt pin in no repository
// its file or base image lists) is a printed warning, not a failure (the gates fail open); a pin the registry contradicts (an action's tag is another commit) fails.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DAY, parseImage, publishedAt, readExceptions } from "./best-version.ts";
import type { Exception, FetchError } from "./best-version.ts";

export interface Pin { kind: string; name: string; package: string; version?: string; digest?: string; sha?: string; at: string; sources?: string[]; releases?: string[]; release?: string; distro?: string }
// Apt repository state: `files` are the source files the stage has (each used for dating, and whether it was removed),
// `entries` the `deb` lines by source file (`undefined` for a line naming no file, which accumulates) and `added` whether
// the stage has added any repository at all — a Deb822 `.sources` file adds one without a parseable `deb` line. A stage
// extending another inherits the files it still has, never one the parent rewrote or removed.
interface State { files: Map<string, string[]>; holds: Set<string>; entries: Map<string | undefined, string[]>; added: boolean; releases: Set<string>; releaseCase?: boolean; arm?: string[]; base?: { distro: string; release: string } }
const sources = (s: State) => [...s.entries.values()].flat();

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
const onRelease = (s: string, release: string, distro = "ubuntu") => s.replace(/\{(distro|codename)\}/g, (x: string, k: string) => (k === "distro" ? distro : release)).replace(/\$\{?(\w+)\}?/g, (x: string, k: string) => (({ codename: release, VERSION_CODENAME: release, arch: "amd64" }) as Record<string, string>)[k] ?? x).replace(/"?\$\(\.\s*\/etc\/os-release.*$/, release);
// The release's own repositories, tried after any the file adds: where a pinned distro package (fail2ban=…) is dated.
// Debian's point releases fold updates into the release suite; its -updates and -security indexes are xz only (unread
// here), so a pin only they carry fails as unlisted.
const distroSources = (r: string, distro = "ubuntu") => distro === "debian"
  ? [`http://deb.debian.org/debian ${r} main`]
  : [`${r}-updates main`, `${r}-updates universe`, `${r}-security main`, `${r}-security universe`, `${r} main`, `${r} universe`].map((s) => `http://archive.ubuntu.com/ubuntu ${s}`);

// The distro and codename a Dockerfile FROM installs: Docker Hub's debian:<codename> (sid, bookworm, trixie, …) and
// ubuntu:<codename> (noble, or a `noble-…` / `…-noble` tag). Anything else, a local stage or an unread codename: none.
const DISTRO_TAGS = new Map<string, [string, string[]]>([
  ["debian", ["debian", ["sid", "bookworm", "trixie", "forky", "bullseye", "buster"]]],
  ["ubuntu", ["ubuntu", ["noble", "jammy", "focal", "oracular", "plucky", "questing", "resolute"]]],
]);
function baseDistro(ref: string): { distro: string; release: string } | undefined {
  const { host, repo, tag } = parseImage(ref);
  if (!tag || !repo.startsWith("library/")) return undefined;
  // A Map, not an object: an image named `constructor` or `__proto__` must read as an unknown image, not Object.prototype.
  const entry = host === "docker.io" ? DISTRO_TAGS.get(repo.slice("library/".length)) : undefined;
  if (!entry) return undefined;
  const [distro, codenames] = entry;
  const release = tag.split("-").find((part) => codenames.includes(part));
  return release ? { distro, release } : undefined;
}

export const wanted = (path: string) => !SKIP.test(path) && (DOCKERFILE.test(path) || COMPOSE.test(path) || WORKFLOW.test(path) || SHELL.test(path) || CODE.test(path) || HOST_PINS.test(path));

// Logical lines: backslash continuations joined, with the first line's number.
function logical(text: string) {
  const out: { n: number; text: string }[] = [];
  let buf = "", start = 0;
  text.split("\n").forEach((l, i) => {
    if (!buf) start = i + 1;
    if (/\\\s*$/.test(l)) buf += l.replace(/\\\s*$/, " ");
    else { out.push({ n: start, text: buf + l }); buf = ""; }
  });
  return out;
}

const imagePin = (ref: string, at: string): Pin => {
  const { tag, digest } = parseImage(ref);
  return { kind: "docker", name: ref.split("@")[0]!, package: ref.split("@")[0]!.replace(/:[^:/]*$/, ""), version: tag, digest, at };
};
const strip = (s: string) => s.replace(/^["']|["']$/g, "");
const words = (s: string) => s.trim().split(/\s+/).map(strip).filter(Boolean);
// A file a command writes, whether it appends, and what reaches it: `deb` when the command's own `deb` line does,
// `unknown` when it copies content we can't read (a Deb822 source, a `2>` target), and `empty` when nothing does
// (`< /dev/null`, or a producer whose `>` sent its stdout past the pipe). An empty file adds no repository.
interface Written { path: string; file?: string; append: boolean; content: "deb" | "unknown" | "empty" }
const REDIRECT = /(?:^|[^>])(\d*)(>>?)\s*("[^"]+"|'[^']+'|[^\s;|&)]+)/g;
const stdoutRedirected = (text: string) => [...text.replace(/\d*>&\d+/g, " ").matchAll(REDIRECT)].some((m) => m[1] !== "2");
// The destinations a command writes: a `>`/`>>` target and each `tee` operand. A path it only reads, as
// `cat /etc/apt/sources.list.d/debian.sources | tee /tmp/log` reads one, is not a write; `file` is set only for a
// sources.list.d name, and the caller keeps `.list` and `.sources`, the only names APT loads.
function writtenFiles(segment: string): Written[] {
  const out: Written[] = [];
  const add = (path: string, append: boolean, content: Written["content"]) => {
    const file = /\/etc\/apt\/sources\.list\.d\/([^/\s"']+)$/.exec(path)?.[1];
    out.push({ path, ...(file ? { file } : {}), append, content });
  };
  // A descriptor duplication (`2>&1`) names no file: drop it so its `&` neither ends a `tee` operand list nor reads as a
  // target.
  const clean = segment.replace(/\d*>&\d+/g, " ");
  for (const m of clean.matchAll(REDIRECT)) add(strip(m[3]!), m[2] === ">>", m[1] === "2" ? "unknown" : "deb");
  // `tee`'s operands are its output files: its options and any redirection are not — `2>&1` must not cut the operand list
  // short at its `&`, and `< file` (which overrides the pipe) is consumed here so it isn't read as a file name.
  for (const m of clean.matchAll(/\btee\b([^|;&]*)/g)) {
    const arg = m[1]!;
    const raw = arg.replace(/(?:\d*>>?|\d*<<?|&>>?)\s*(&?\d+|"[^"]*"|'[^']*'|\S+)/g, " ");
    const append = /(?:^|\s)(?:-a|--append)(?=\s|$)/.test(raw);
    // What `tee` writes comes from its stdin: a `< file` overrides the pipe, and a producer whose own stdout a `>` sent
    // elsewhere leaves the pipe empty.
    const input = /(?:^|\s)\d*<<?\s*("[^"]+"|'[^']+'|\S+)/.exec(arg)?.[1];
    const pipe = clean.lastIndexOf("|", m.index! - 1);
    const producer = pipe >= 0 ? clean.slice(0, pipe) : "";
    const content: Written["content"] = input ? (strip(input) === "/dev/null" ? "empty" : "unknown") : producer.trim() && !stdoutRedirected(producer) ? "deb" : "empty";
    for (const a of words(raw).filter((a) => !a.startsWith("-"))) add(a, append, content);
  }
  return out;
}

// Install commands on one logical line: pins found, problems found.
function commands(text: string, at: string, state: State, pins: Pin[], problems: string[]): void {
  const cmd = text.replace(/(^|\s)#.*$/, "");
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(\S*\/)?(ba|z|da)?sh\b/.test(cmd)) problems.push(`${at}: piping a download into a shell installs whatever is served: download a pinned version and check its sha256`);
  for (const m of cmd.matchAll(/\bnpm\s+(?:i|install|add)\s+([^;&|]*)/g)) {
    const args = words(m[1]!);
    if (!args.some((a) => a === "-g" || a === "--global")) continue;
    for (const a of args.filter((x) => !x.startsWith("-"))) {
      const p = /^(@?[^@\s]+)@(\d+\.\d+\.\d+\S*)$/.exec(a);
      if (!p) problems.push(`${at}: npm -g ${a} is not at an exact version (name@1.2.3)`);
      else pins.push({ kind: "npm", name: p[1]!, package: p[1]!, version: p[2], at });
    }
  }
  for (const m of cmd.matchAll(/\bnpx\s+([^;&|]*)/g)) {
    const args = words(m[1]!);
    if (!args.some((a) => a === "-y" || a === "--yes")) continue; // without --yes npx runs the project's own (lockfiled) bin
    const a = args.find((x) => !x.startsWith("-"));
    const p = /^(@?[^@\s]+)@(\d+\.\d+\.\d+\S*)$/.exec(a || "");
    if (!p) problems.push(`${at}: npx -y ${a} is not at an exact version (name@1.2.3)`);
    else pins.push({ kind: "npm", name: p[1]!, package: p[1]!, version: p[2], at });
  }
  for (const m of cmd.matchAll(/\bpip3?"?\s+install\s+([^;&|]*)/g)) {
    const args = words(m[1]!);
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-r" || a === "-c" || a === "-e" || a === "--requirement" || a === "--constraint") { i++; continue; }
      if (a.startsWith("-") || a.startsWith(".") || a.startsWith("/") || a.startsWith("$")) continue;
      const p = /^([A-Za-z0-9_.\-[\]]+)==([^\s,;]+)$/.exec(a);
      if (!p) problems.push(`${at}: pip install ${a} is not at an exact version (name==1.2.3)`);
      else pins.push({ kind: "pypi", name: p[1]!.replace(/\[.*\]$/, ""), package: p[1]!.replace(/\[.*\]$/, ""), version: p[2], at });
    }
  }
  // Per-release arms: `case "$codename" in`, a label (`noble)`, `noble|resolute)`) then the arm's commands, `;;`, `esac`.
  if (/^\s*case\s+"?\$\{?(codename|VERSION_CODENAME)\b/.test(cmd)) state.releaseCase = true;
  else if (/^\s*esac\b/.test(cmd)) state.releaseCase = false;
  const label = state.releaseCase && /^\s*([a-z][a-z0-9]*(?:\|[a-z][a-z0-9]*)*)\)/.exec(cmd);
  if (label) { state.arm = label[1]!.split("|"); state.arm.forEach((r) => state.releases.add(r)); }
  // Repository writes and apt installs are applied in the order the line runs them, so each install is checked against
  // the repositories present at that point: adding a repository is what makes a later unpinned install a problem, and
  // removing it before an install stops it being one. A `deb` line is filed under the source file its own command
  // writes, appends to or removes; one naming no file is kept apart and its entries accumulate.
  for (const segment of cmd.split(/&&|\|\||;/)) {
    const debs = [...segment.matchAll(/\bdeb\s+(?:\[[^\]]*\]\s+)?(https?:\/\/[^\s"']+)\s+([^\s"']+)\s+([^\s"']+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    const removes = /\b(rm|unlink)\b/.test(segment) && /sources\.list\.d/.test(segment);
    // What a command reads is not what it writes: the file a pipeline's `tee` writes carries its `deb` line, while a
    // source file it only copies for diagnostics adds no repository.
    const named = [...segment.matchAll(/sources\.list\.d\/([^\s"';|&)]*)/g)].map((m) => m[1]!).filter(Boolean);
    const files = writtenFiles(segment);
    // Only `.list` and `.sources` are loaded: a write to `vendor.list.disabled` is a repository neither APT nor a later
    // install sees, so it neither requires pins nor dates them.
    const loaded = files.filter((w) => w.file && /\.(list|sources)$/.test(w.file));
    if (removes) {
      // `rm` of one file drops that file; `rm` of the directory itself (no name) drops them all. A name APT ignores
      // removes nothing it loads.
      const removed = named.filter((f) => /\.(list|sources)$/.test(f));
      if (removed.length) removed.forEach((f) => { state.files.delete(f); state.holds.delete(f); state.entries.delete(f); });
      else if (!named.length) { state.files.clear(); state.holds.clear(); state.entries.clear(); }
      state.added = state.holds.size > 0 || state.entries.has(undefined);
    } else if (loaded.length) {
      // `>>` and `tee -a` add to the file they name; a plain `>` or `tee` replaces what it held, and each destination has
      // its own mode. A file counts as added when its content was written or copied rather than known to be empty — a
      // Deb822 `.sources` holds a repository its Types/URIs fields spell out even with no parseable `deb` line — but a
      // file written empty (`< /dev/null`, a producer whose `>` bypassed the pipe) adds none and dates none.
      for (const { file, append, content } of loaded) {
        const written = content === "deb" ? debs : [];
        state.files.set(file!, append ? [...(state.files.get(file!) ?? []), ...written] : written);
        state.entries.set(file!, append ? [...(state.entries.get(file!) ?? []), ...written] : written);
        if (content === "empty") state.holds.delete(file!);
        else state.holds.add(file!);
      }
      state.added = state.holds.size > 0 || state.entries.has(undefined);
    } else if (debs.length && !files.some((w) => w.file)) state.entries.set(undefined, [...(state.entries.get(undefined) ?? []), ...debs]);
    for (const m of segment.matchAll(/\bapt(?:-get)?\s+(?:-\S+\s+)*install\s+([^;&|]*)/g)) {
      for (const a of words(m[1]!).filter((x) => !x.startsWith("-") && !x.startsWith("./") && !x.startsWith("/") && !x.startsWith("$"))) {
        const [pkg, ver] = a.split("=") as [string, string | undefined];
        if (ver) pins.push({ kind: "apt", name: pkg, package: pkg, version: ver, sources: sources(state), releases: state.arm, ...(state.arm ? {} : state.base), at });
        else if (state.added) problems.push(`${at}: apt install ${pkg} after an apt repository is added: pin it (${pkg}=<version>) or install it before the repository`);
      }
    }
  }
  for (const m of cmd.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/\s"'$]+)\//g)) {
    pins.push({ kind: "github-release", name: m[1]!, package: m[1]!, version: m[2], at });
  }
  if (/;;\s*$/.test(cmd)) state.arm = undefined;
}

/**
 * ops/vm/pins.json: one apt pin per package and release, with the file's repositories as that release reads them. A file
 * with no releases dates its top-level `apt` for DEFAULT_RELEASE (as scanFile does for a host script naming none); an `apt`
 * block no release can read (not an object of pins, or under a release that isn't an object) is a problem, never skipped.
 */
function hostPins(path: string, text: string): { pins: Pin[]; problems: string[] } {
  const j = JSON.parse(text);
  const at = `${path}:${text.split("\n").findIndex((l) => /"apt"\s*:/.test(l)) + 1}`;
  const lineOf = (name: string, version: string) => text.split("\n").findIndex((l) => l.includes(`"${name}": "${version}"`)) + 1;
  const obj = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  const problems: string[] = [];
  if (j.apt !== undefined && !obj(j.apt)) problems.push(`${at}: \`apt\` is not an object of package pins`);
  if (j.releases !== undefined && !obj(j.releases)) problems.push(`${path}: \`releases\` is not an object of releases: its apt pins can't be dated`);
  const releases: Record<string, any> = obj(j.releases) && Object.keys(j.releases).length ? j.releases : { [DEFAULT_RELEASE]: { distro: "ubuntu" } };
  const pins = Object.entries(releases).flatMap(([release, r]) => {
    if (!obj(r) || (r.apt !== undefined && !obj(r.apt))) { problems.push(`${path}: release ${release} is not an object with an \`apt\` object: its pins can't be dated`); return []; }
    const sources = Object.values((j.repos ?? {}) as Record<string, string>).map((s) => onRelease(s, release, r.distro));
    return Object.entries({ ...(obj(j.apt) ? j.apt : {}), ...(r.apt ?? {}) } as Record<string, string>).map(([name, version]) =>
      ({ kind: "apt", name, package: name, version, sources, release, distro: r.distro, at: `${path}:${lineOf(name, version)}` }));
  });
  return { pins, problems };
}

/** One file's pins and its unpinned problems. */
export function scanFile(path: string, text: string): { pins: Pin[]; problems: string[] } {
  if (HOST_PINS.test(path)) return hostPins(path, text);
  const pins: Pin[] = [], problems: string[] = [];
  const fresh = (): State => ({ files: new Map(), holds: new Set(), entries: new Map(), added: false, releases: new Set() });
  const clone = (s: State): State => ({ ...s, files: new Map([...s.files].map(([f, v]) => [f, [...v]])), holds: new Set(s.holds), entries: new Map([...s.entries].map(([f, v]) => [f, [...v]])), releases: new Set(s.releases), arm: s.arm && [...s.arm] });
  let state: State = fresh();
  const at = (n: number) => `${path}:${n}`;
  if (DOCKERFILE.test(path)) {
    const stages = new Set(["scratch"]);
    // Each named stage's state as its RUN lines leave it, so a stage that extends it starts from the same filesystem.
    const stageState = new Map<string, State>();
    const syntax = /^#\s*syntax\s*=\s*(\S+)/m.exec(text);
    if (syntax) DIGEST.test(syntax[1]!) ? pins.push(imagePin(syntax[1]!, at(1))) : problems.push(`${at(1)}: # syntax=${syntax[1]} has no digest`);
    for (const { n, text: l } of logical(text)) {
      const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
      const copy = /^\s*COPY\s+.*--from=(\S+)/i.exec(l);
      const ref = from?.[1] ?? copy?.[1];
      if (ref && !ref.includes("$") && !stages.has(ref.toLowerCase()) && (from || /[:/]/.test(ref))) {
        DIGEST.test(ref) ? pins.push(imagePin(ref, at(n))) : problems.push(`${at(n)}: image ${ref} has no digest (name:tag@sha256:…)`);
      }
      if (from) {
        // A stage starts from its own filesystem: a new image from scratch (its own distro, no repositories), a
        // stage it extends from what that stage had when it finished. Either way the additions stay in this stage.
        const ref = from[1]!, inherited = stages.has(ref.toLowerCase()) ? stageState.get(ref.toLowerCase()) : undefined;
        state = inherited ? clone(inherited) : fresh();
        state.base = ref.includes("$") ? undefined : inherited ? inherited.base : baseDistro(ref);
      }
      if (from?.[2]) {
        stages.add(from[2].toLowerCase());
        stageState.set(from[2].toLowerCase(), state);
      }
      if (/^\s*RUN\s/i.test(l)) commands(l, at(n), state, pins, problems);
    }
  } else if (COMPOSE.test(path) || WORKFLOW.test(path)) {
    const lines = text.split("\n");
    // A compose service is a 2-space-indented key; its block runs to the next one.
    const blockOf = (i: number) => { let s = i; while (s > 0 && !/^ {2}[\w.-]+:\s*$/.test(lines[s]!)) s--; let e = i + 1; while (e < lines.length && !/^ {2}[\w.-]+:\s*$/.test(lines[e]!) && !/^\S/.test(lines[e]!)) e++; return lines.slice(s, e); };
    lines.forEach((l, i) => {
      const img = /^\s*-?\s*(?:image|container):\s*["']?([^\s"'#]+)/.exec(l);
      if (img && !img[1]!.includes("$")) {
        if (COMPOSE.test(path) && blockOf(i).some((b) => /^\s+build:/.test(b))) return;
        DIGEST.test(img[1]!) ? pins.push(imagePin(img[1]!, at(i + 1))) : problems.push(`${at(i + 1)}: image ${img[1]} has no digest (name:tag@sha256:…)`);
      }
      const uses = WORKFLOW.test(path) && /^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?\s*(?:#\s*(\S+))?/.exec(l);
      if (uses && !uses[1]!.startsWith("./")) {
        if (uses[1]!.startsWith("docker://")) {
          const ref = uses[1]!.slice(9);
          DIGEST.test(ref) ? pins.push(imagePin(ref, at(i + 1))) : problems.push(`${at(i + 1)}: ${uses[1]} has no digest`);
        } else {
          const [action, ref] = uses[1]!.split("@") as [string, string | undefined];
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
      for (const m of l.matchAll(/([a-z0-9][\w.\/-]*:[\w.-]+@sha256:[0-9a-f]{64})/g)) pins.push(imagePin(m[1]!, at(i + 1)));
    });
  }
  // An apt pin once per release it is installed on: an arm's releases (a host script, naming its own distro), else its
  // own base image's, else DEFAULT_RELEASE.
  const all = state.releases.size ? [...state.releases] : [DEFAULT_RELEASE];
  return { pins: pins.flatMap(({ releases, ...p }) => (p.kind === "apt" ? (releases ?? (p.release ? [p.release] : all)).map((release) => ({ ...p, release })) : [p])), problems };
}

// An apt pin's distro and sources are part of it: the same version from another repository or distro is dated again.
const key = (p: Pin) => JSON.stringify([p.kind, p.name, p.version, p.digest, p.sha, p.release, p.distro, p.sources]);
const exceptionFor = (p: Pin, exceptions: Exception[]) => exceptions.find((e) => e.ecosystem === p.kind && e.package === p.package && e.version === p.version && e.advisory);
// An owner-approved one (`owner: approved`, no advisory) covers a pin only while today < expires, at most 14 days out, and
// only the exact pin: its digest or sha when the pin has one (as npm-age.ts's, for any ecosystem here).
const ownerApproved = (p: Pin, exceptions: Exception[], now: number) => exceptions.some((e) => e.ecosystem === p.kind && e.package === p.package && e.version === p.version && e.owner === "approved"
  && now < Date.parse(e.expires!) && Date.parse(e.expires!) - now <= 14 * DAY && e.digest === p.digest && e.sha === p.sha);

/** Date each new or changed pin; the problems, one line each. `date(pin)` returns {published, via} or throws (then `warn`s). */
export async function checkAges({ pins, basePins = [], exceptions = [], date = datePin, now = Date.now(), warn = console.warn }: { pins: Pin[]; basePins?: Pin[]; exceptions?: Exception[]; date?: (p: Pin) => Promise<{ published: string; via: string }>; now?: number; warn?: (line: string) => void }): Promise<string[]> {
  const old = new Set(basePins.map(key));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const p of pins) {
    if (old.has(key(p)) || seen.has(key(p))) continue;
    seen.add(key(p));
    const label = `${p.at}: ${p.name}${p.version && p.kind !== "docker" ? ` ${p.version}` : ""}${p.digest ? `@${p.digest.slice(0, 19)}…` : ""}${p.release ? ` (${p.release})` : ""}`;
    try {
      const { published, via } = await date(p);
      const age = now - Date.parse(published);
      if (age >= 7 * DAY) continue;
      if (exceptionFor(p, exceptions) || ownerApproved(p, exceptions, now)) continue;
      problems.push(`${label} was published ${(age / DAY).toFixed(1)} days ago (${via}, under 7): use an older version (best-version.ts), or add a security exception`);
    } catch (e) {
      // Only a pin that can't be dated is let through; one the registry contradicts (an action's tag is another commit) fails.
      if ((e as FetchError).mismatch) { problems.push(`${label}: ${(e as Error).message}`); continue; }
      warn(`warning: ${label}: could not be dated, not checked: ${(e as Error).message}`);
    }
  }
  return problems;
}

async function datePin(p: Pin) {
  if (p.kind === "docker") return publishedAt("docker", p.name, { digest: p.digest });
  if (p.kind === "apt") return dateApt(p);
  return publishedAt(p.kind, p.name, { version: p.version, sha: p.sha });
}

/**
 * An apt pin, from the repositories its file adds, then the distro's pockets, as its release reads them. A source is
 * passed over only when it was read and doesn't list the version; any other error (a repository that can't be read)
 * fails, so a lookup failure on the file's own repository never falls through to dating the package from somewhere else.
 */
export async function dateApt(p: Pin, lookup: typeof publishedAt = publishedAt) {
  const release = p.release ?? DEFAULT_RELEASE;
  for (const source of [...p.sources!.map((s) => onRelease(s, release, p.distro)), ...distroSources(release, p.distro)]) {
    try { return await lookup("apt", p.name, { version: p.version, source }); } catch (e) { if (!(e as FetchError).notListed) throw e; }
  }
  throw new Error(`${p.name}=${p.version}: no apt repository in this file, nor ${release}'s own, lists it`);
}

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
function scanRef(ref: string) {
  const pins: Pin[] = [], problems: string[] = [];
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
  try { exText = git("show", `${head}:.github/supply-chain-exceptions.yaml`); } catch { /* none yet */ }
  const ages = await checkAges({ pins: now.pins, basePins: scanRef(base).pins, exceptions: readExceptions(exText) });
  const problems = [...now.problems, ...ages];
  console.log(`${now.pins.length} pins; ${now.problems.length} unpinned; ${ages.length} too new`);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
