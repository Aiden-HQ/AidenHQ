#!/usr/bin/env node
// Everything outside package-lock.json is pinned, and nothing newly pinned is under 7 days old (the owner's rule).
// Lockfiles are npm-age.ts's. No dependencies, Node 22+; a byte-identical copy is in the app CI template.
//   node pins.ts <base-ref> <head-ref>      (GITHUB_TOKEN, when set, for the GitHub API)
//
// Pinned (checked over the whole tree at head):
//   Dockerfiles   `# syntax=`, FROM and COPY --from images by digest (build stages, `scratch` and FROM ${ARG} aside);
//   compose       every `image:` by digest, unless its service has a `build:`;
//   modules       modules/<name>/module.yaml: every `services.run.<service>.image` by digest (a `build:` service is this
//                 repository's own image, and the agent-level `image:` lines name a computer image: neither is a pin);
//   workflows     (and .github/actions/*/action.yml) every `uses:` by a 40-character commit SHA with its tag in a comment (`# v1.2.3`), local ./ aside;
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
import { DAY, fetchRetry, parseImage, publishedAt, readExceptions } from "./best-version.ts";
import type { Exception, FetchError } from "./best-version.ts";

export interface Pin { kind: string; name: string; package: string; version?: string; digest?: string; sha?: string; at: string; sources?: string[]; releases?: string[]; release?: string; distro?: string; raced?: boolean; suiteAlias?: boolean; codename?: string }
// Apt repository state. `files` are the source files the stage has (each used for dating, and whether it was removed);
// `entries` holds the repositories, one string per `deb` line and one `url suite component` per Deb822 stanza, filed
// under the source file it was written to (`undefined` for a line naming no file, which accumulates); `added` is whether
// the stage has added any repository at all — a Deb822 `.sources` file adds one without a parseable `deb` line. A file
// APT loads is `files` or `entries`' key, so a file written empty is neither. A stage extending another inherits the
// files it still has, never one the parent rewrote or removed.
// `empty` are the source files this stage wrote and left holding nothing: they exist, so a `cp -n` onto one is skipped
// (`files` holds the ones that hold a repository, or content we can't read). `maybe` are the names a guarded write may
// have created and may not have: a `cp -n` onto one may replace, so it is neither certainly skipped nor certainly applied.
// A name in none of them is one the scanner can't see (an image file), which `-n` treats like `maybe` but a replace
// overwrites.
interface State { files: Set<string>; empty: Set<string>; maybe: Set<string>; raced: Set<string>; entries: Map<string | undefined, string[]>; added: boolean; releases: Set<string>; releaseCase?: boolean; arm?: string[]; base?: { distro: string; release: string } }
// Each repository once, in the order its file first held it: two source files naming the same repository (a `mv -n`
// that keeps both) are one place to date a pin from.
const sources = (s: State) => [...new Set([...s.entries.values()].flat())];
// A fresh filesystem: no source files, no repository.
const emptyState = (): State => ({ files: new Set(), empty: new Set(), maybe: new Set(), raced: new Set(), entries: new Map(), added: false, releases: new Set() });
// A deep copy, so one stage's later writes never reach another's (a stage inherits a snapshot, not a live view).
const cloneState = (s: State): State => ({ ...s, files: new Set(s.files), empty: new Set(s.empty), maybe: new Set(s.maybe), raced: new Set(s.raced), entries: new Map([...s.entries].map(([f, v]) => [f, [...v]])), releases: new Set(s.releases), arm: s.arm && [...s.arm] });
// Whether a stage holds any repository a later install would see: any entry (a `deb` line or a Deb822 stanza, filed under
// its file or the `undefined` bucket), or a file whose content we can't read. Content, not existence: a repository a
// guarded write may have left still counts, since an install after it may well see it.
const hasRepo = (s: State) => [...s.entries.values()].some((v) => v.length > 0) || s.files.size > 0;

const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
// A workflow, or a local composite action one runs (`uses: ./.github/actions/<name>`): both pin every `uses:`.
const WORKFLOW = /(^|\/)\.github\/(workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/;
const SHELL = /\.sh$/;
const CODE = /\.(m?js|ts)$/;
const HOST_PINS = /(^|\/)ops\/vm\/pins\.json$/;
const MODULE = /^modules\/[^/]+\/module\.yaml$/;
const SKIP = /(^|\/)(node_modules|test\/fixtures)\//;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const DEFAULT_RELEASE = "noble"; // a host file that names no release: Ubuntu 24.04 (hosts are amd64)
// A repository line as the host reads it on that release ($codename, $(. /etc/os-release …), $arch; pins.json's {distro}
// and {codename}).
const onRelease = (s: string, release: string, distro = "ubuntu") => s.replace(/\{(distro|codename)\}/g, (x: string, k: string) => (k === "distro" ? distro : release)).replace(/\$\{?(\w+)\}?/g, (x: string, k: string) => (({ codename: release, VERSION_CODENAME: release, arch: "amd64" }) as Record<string, string>)[k] ?? x).replace(/"?\$\(\.\s*\/etc\/os-release.*$/, release);
// The release's own repositories, tried after any the file adds: where a pinned distro package (fail2ban=…) is dated.
// A suite deb.debian.org no longer carries (`DEBIAN_ARCHIVE`) is read from archive.debian.org instead.
// Debian's point releases fold some fixes into the release suite, while the rest live in its -updates pocket and in the
// -security pocket (served from debian-security, which best-version.ts reads for that suite name); both publish their
// amd64 index as Packages.xz only, decoded with the system `xz`. A release with no such pocket (sid) has no index there,
// and the pin then warns as undated.
const DEBIAN_ARCHIVE = new Set(["buster", "stretch", "jessie"]);
const distroSources = (r: string, distro = "ubuntu") => distro === "debian"
  ? DEBIAN_ARCHIVE.has(r)
    // A suite deb.debian.org has stopped serving lives on at the archive only, and its -security pocket is reached
    // under `${suite}/updates`. Reading the archive is what lets a buster pin still be dated rather than merely undated.
    ? [`http://archive.debian.org/debian ${r} main`, `http://archive.debian.org/debian ${r}-updates main`, `http://archive.debian.org/debian-security ${r}/updates main`]
    : [`http://deb.debian.org/debian ${r} main`, `http://deb.debian.org/debian ${r}-updates main`, `http://deb.debian.org/debian ${r}-security main`]
  // An interim release leaves archive.ubuntu.com for old-releases once it is retired, so both hosts are named: the
  // archive first, then the retirement host, which answers 404 for a suite it does not hold (dateApt skips those).
  : [`${r}-updates main`, `${r}-updates universe`, `${r}-security main`, `${r}-security universe`, `${r} main`, `${r} universe`]
      .flatMap((s) => [`http://archive.ubuntu.com/ubuntu ${s}`, `http://old-releases.ubuntu.com/ubuntu ${s}`]);

// The distro and codename a Dockerfile FROM installs: Docker Hub's debian:<codename> (sid, bookworm, trixie, …) and
// ubuntu:<codename> (noble, or a `noble-…` / `…-noble` tag), plus the numeric release tags each suite answers to
// (`debian:12` is bookworm, `ubuntu:24.04` is noble). Anything else, a local stage or an unread codename: none.
const DISTRO_TAGS = new Map<string, [string, string[], Map<string, string>]>([
  ["debian", ["debian", ["sid", "bookworm", "trixie", "forky", "bullseye", "buster"], new Map([["12", "bookworm"], ["13", "trixie"], ["11", "bullseye"], ["10", "buster"], ["14", "forky"]])]],
  ["ubuntu", ["ubuntu", ["noble", "jammy", "focal", "bionic", "xenial", "oracular", "plucky", "questing", "resolute"], new Map([["24.04", "noble"], ["22.04", "jammy"], ["20.04", "focal"], ["18.04", "bionic"], ["16.04", "xenial"], ["24.10", "oracular"], ["25.04", "plucky"], ["25.10", "questing"], ["26.04", "resolute"]])]],
]);
// A suite alias is not resolved to a codename here: `stable` and `testing` move with each release, so pinning today's
// answer (trixie, forky) would mis-date the stage as soon as they move. The alias is kept as the release instead and
// Debian resolves it server-side — dists/stable, dists/<alias>-updates and dists/<alias>-security all answer for it, so
// the pin is dated from whatever the alias names at scan time, with no image pull and nothing to keep current.
const DISTRO_ALIASES = new Map<string, Set<string>>([
  ["debian", new Set(["stable", "testing", "oldstable", "unstable"])],
]);
// A numeric tag names its suite by its leading number: Debian's whole major covers its point releases (`12.7` is
// bookworm), and Ubuntu's year.minor covers its point releases (`24.04.1` is noble). A tag of any other shape is not one.
function numericRelease(part: string, distro: string, numbers: Map<string, string>): string | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(part)) return undefined;
  const fields = part.split(".");
  return numbers.get(distro === "debian" ? fields[0]! : fields.slice(0, 2).join("."));
}
function baseDistro(ref: string): { distro: string; release: string; suiteAlias?: boolean } | undefined {
  const { host, repo, tag } = parseImage(ref);
  if (!tag || !repo.startsWith("library/")) return undefined;
  // A Map, not an object: an image named `constructor` or `__proto__` must read as an unknown image, not Object.prototype.
  const entry = host === "docker.io" ? DISTRO_TAGS.get(repo.slice("library/".length)) : undefined;
  if (!entry) return undefined;
  const [distro, codenames, numbers] = entry;
  for (const part of tag.split("-")) {
    if (DISTRO_ALIASES.get(distro)?.has(part)) return { distro, release: part, suiteAlias: true };
    if (codenames.includes(part)) return { distro, release: part };
    const release = numericRelease(part, distro, numbers);
    if (release) return { distro, release };
  }
  return undefined;
}

export const wanted = (path: string) => !SKIP.test(path) && (DOCKERFILE.test(path) || COMPOSE.test(path) || WORKFLOW.test(path) || SHELL.test(path) || CODE.test(path) || HOST_PINS.test(path) || MODULE.test(path));

// The delimiter of the first here-document a line opens, with quoted text as data: `echo 'a << b'` opens none, and
// `<<'EOF'` names EOF. `<<<` is a here-string, not a here-document, and so is `<<` with no word after it (a redirection of
// both streams as in `cat <<<`), arithmetic (`x=$((1 << 2))`) and a `#` comment (`# cat <<EOF`), which merely print text.
function heredocOf(line: string): { strip: boolean; word: string } | undefined {
  const quoted: string[] = [];
  // A `#` at a word's start begins a comment (not `a#b`), and a single-quoted string holds neither a comment nor an
  // operator, so a line ending in one is still lost.
  const masked = line
    .replace(/'([^']*)'/g, (_m: string, q: string) => `\uE000${quoted.push(q) - 1}\uE001`)
    .replace(/(^|\s)#.*$/, "");
  // Arithmetic: `$(( … ))` is an expression, and `<<` there shifts rather than redirecting.
  const code = masked.replace(/\$?\(\([^()]*\)\)/g, " ");
  for (const m of code.matchAll(/(?<!<)<<(-?)\s*(?:\uE000(\d+)\uE001|([A-Za-z_][\w]*))/g)) {
    const word = m[2] !== undefined ? quoted[Number(m[2])]! : m[3]!;
    if (/^[A-Za-z_][\w]*$/.test(word)) return { strip: m[1] === "-", word };
  }
  return undefined;
}

// Logical lines: backslash continuations joined, with the first line's number. A here-document's body is kept with the
// line that opens it (after a `\n`) — it is what a `tee … <<EOF` or `cat > … <<EOF` writes to a source file — and runs to
// its delimiter's line, honouring `<<-`'s leading tabs and a quoted delimiter (`<<'EOF'`).
function logical(text: string) {
  const out: { n: number; text: string }[] = [];
  const lines = text.split("\n");
  let buf = "", start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!buf) start = i + 1;
    const body = !/\\\s*$/.test(l) ? heredocOf(l) : undefined;
    if (body) {
      let j = i + 1;
      while (j < lines.length && (body.strip ? lines[j]!.replace(/^\t+/, "") : lines[j]!) !== body.word) j++;
      // `<<-` strips leading tabs from the body as well as the terminator, so its fields start at the line's beginning.
      const kept = body.strip ? lines.slice(i + 1, j).map((x) => x.replace(/^\t+/, "")) : lines.slice(i + 1, j);
      out.push({ n: start, text: buf + l + "\n" + kept.join("\n") });
      buf = "";
      i = j;
      continue;
    }
    if (/\\\s*$/.test(l)) buf += l.replace(/\\\s*$/, " ");
    else { out.push({ n: start, text: buf + l }); buf = ""; }
  }
  return out;
}

const imagePin = (ref: string, at: string): Pin => {
  const { tag, digest } = parseImage(ref);
  return { kind: "docker", name: ref.split("@")[0]!, package: ref.split("@")[0]!.replace(/:[^:/]*$/, ""), version: tag, digest, at };
};
const strip = (s: string) => s.replace(/^["']|["']$/g, "");
const words = (s: string) => s.trim().split(/\s+/).map(strip).filter(Boolean);
// A file a command writes, whether it appends, and what reaches it: `deb` when the command's own `deb` line does,
// `unknown` when it copies content we can't read (a `2>` target, a `.sources` file whose fields name no repository), and
// `empty` when it truncates to nothing (`< /dev/null`, a producer whose `>` sent its stdout past the pipe, an earlier of
// two stdout redirects), and `none` when it adds no bytes without truncating (`tee -a … < /dev/null`), which leaves the
// file as it was. `text` is the content when we can read it (a here-document's body). A file that ends up empty adds no
// repository.
interface Written { path: string; file?: string; append: boolean; content: "deb" | "unknown" | "empty" | "none"; text?: string; retain?: boolean; entries?: string[]; raced?: string[] }
// `>|` is bash's noclobber override: still a truncating write to the file it names.
const REDIRECT = /(?<!>)(\d*)(>>?\|?)\s*("[^"]+"|'[^']+'|[^\s;|&)<>]+)/g;
// A command's stdout as the shell leaves it, walked in order: fd 1 starts on the pipe, a file redirect moves it to
// that file, and a duplication (`3>&1`, then `1>&3`) copies another descriptor's destination. So `3>&1 >/tmp/log 1>&3`
// ends with stdout back on the pipe, and `>vendor.list 3>&1 >/tmp/log 1>&3` ends with it on /tmp/log (vendor.list is
// truncated but gets no bytes). Returns the index of the redirect fd 1 finally lands on, or "pipe" when nothing took it.
// An unquoted operand ends at the next redirect: `3>&1>/tmp/log` is two redirects, not one whose file is `1>/tmp/log`.
const STDOUT_REDIRECT = /(\d*)(>>?\|?|>&)\s*("[^"]*"|'[^']*'|[^\s;|&)<>]+)/g;
const stdoutTarget = (text: string, decode: (t: string) => string = (t) => t): "pipe" | number => {
  const target = new Map<number, "pipe" | number>([[1, "pipe"]]);
  for (const m of text.matchAll(STDOUT_REDIRECT)) {
    const fd = m[1] === "" ? 1 : Number(m[1]);
    // A closed descriptor (`>&-`) or another stream (`1>&2`) is not the pipe, and no file redirect owns it. A quoted
    // operand is the same number: `1>&"3"` moves stdout to fd 3.
    const to = decode(m[3]!).replace(/^["']|["']$/g, "");
    target.set(fd, m[2] === ">&" ? (/^\d+$/.test(to) ? target.get(Number(to)) ?? -1 : -1) : m.index!);
  }
  return target.get(1) ?? "pipe";
};
const stdoutFeedsPipe = (text: string, decode?: (t: string) => string) => stdoutTarget(text, decode) === "pipe";
// A command's own words, with quoted text blanked: `echo '… rm /etc/apt/sources.list.d/x'` prints a message, it does
// not remove anything.
const unquoted = (s: string) => s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
// A line's commands, split at its unquoted `&&`, `||` and `;`: a quoted `;` or `&&` is text, so `echo 'a; rm x'`
// prints a message rather than running two commands, and a backslash escapes the next character.
function splitOps(s: string): string[] {
  const out: string[] = [];
  let buf = "", quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { buf += ch; if (ch === quote) quote = undefined; continue; }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === "\\" && i + 1 < s.length) { buf += ch + s[i + 1]!; i++; continue; }
    const two = s.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push(buf, two); buf = ""; i++; continue; }
    if (ch === ";") { out.push(buf, ";"); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}
// A `deb` line's URL is whitespace-delimited: a quoted `printf '…\\n'` leaves a literal backslash, which is not part of
// the URL.
const DEB_LINE = /\bdeb\s+(?:\[[^\]]*\]\s+)?(https?:\/\/[^\s"'\\]+)\s+([^\s"'\\]+)\s+([^\s"'\\]+)/g;
// A `#` comment is not a repository: a heredoc that writes `# deb https://…` writes an inactive line, and APT skips it.
const debLines = (text: string) => text.split("\n").filter((l) => !/^\s*#/.test(l)).flatMap((l) => [...l.replace(/\s+#.*$/, "").matchAll(DEB_LINE)]).map((m) => `${m[1]} ${m[2]} ${m[3]}`);
/**
 * The repositories a source file's text spells out: each `deb` line, and each Deb822 stanza of a `.sources` file —
 * `Types` (deb; a deb-src-only stanza is not one), `URIs` × `Suites` × `Components` (each a whitespace-separated list, a
 * continued line appending to its field; Components defaults to main), skipping `Enabled: no`. `declares` is whether the
 * text names a repository at all, even one we can't date from (no URIs read).
 */
function repoEntries(text: string): { repos: string[]; declares: boolean } {
  const repos = debLines(text);
  let declares = repos.length > 0;
  for (const stanza of text.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    let last: string | undefined;
    for (const line of stanza.split("\n")) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (m) { last = m[1]!.toLowerCase(); fields.set(last, m[2]!.trim()); }
      else if (last && /^\s+\S/.test(line)) fields.set(last, `${fields.get(last) ?? ""} ${line.trim()}`.trim());
    }
    const list = (k: string) => (fields.get(k) ?? "").split(/\s+/).filter(Boolean);
    if (!list("types").includes("deb") || list("enabled").includes("no")) continue;
    declares = true;
    const comps = list("components");
    for (const uri of list("uris")) for (const suite of list("suites")) for (const comp of comps.length ? comps : ["main"]) repos.push(`${uri} ${suite} ${comp}`);
  }
  return { repos, declares };
}
const writtenKind = (text: string): Pick<Written, "content" | "text"> => {
  const { repos, declares } = repoEntries(text);
  return { content: repos.length ? "deb" : declares ? "unknown" : "empty", text };
};
// The destinations a command writes: a `>`/`>>` target and each `tee` operand. A path it only reads, as
// `cat /etc/apt/sources.list.d/debian.sources | tee /tmp/log` reads one, is not a write; `file` is set only for a
// sources.list.d name, and the caller keeps `.list` and `.sources`, the only names APT loads. `body` is the here-document
// the logical line carries, which is what `cat > file <<EOF` or `tee file <<EOF` writes.
function writtenFiles(segment: string, body?: string, knownSource?: (path: string) => string[] | undefined): Written[] & { racedPaths?: Set<string> } {
  const out: Written[] = [];
  // Every write's path and the command that made it, so a name two commands write can be spotted as a race.
  const writes: { path: string; cmd: number }[] = [];
  // An append of nothing adds no bytes: `tee -a file < /dev/null` leaves the file as it was.
  const add = (path: string, append: boolean, written: Pick<Written, "content" | "text" | "entries">, cmd?: number) => {
    const file = /\/etc\/apt\/sources\.list\.d\/([^/\s"']+)$/.exec(path)?.[1];
    const content = append && written.content === "empty" ? "none" as const : written.content;
    out.push({ path, ...(file ? { file } : {}), append, content, ...(written.text !== undefined ? { text: written.text } : {}), ...(written.entries ? { entries: written.entries } : {}) });
    writes.push({ path, cmd: cmd ?? 0 });
  };
  // Quoted text is data, not shell syntax: `echo 'a > b'` writes nothing. Each quoted run is masked so redirects and
  // operands are read from code alone, keeping its content so a quoted target still resolves to its path.
  const quoted: string[] = [];
  const unmask = (t: string) => { const m = /^\uE000(\d+)\uE001$/.exec(t); return m ? quoted[Number(m[1])]! : t; };
  // Every masked quoted run in a longer string, back to its text: the content a command actually prints.
  const expand = (t: string) => t.replace(/\uE000(\d+)\uE001/g, (_m: string, n: string) => quoted[Number(n)]!);
  const code = segment.replace(/'([^']*)'|"([^"]*)"/g, (_m: string, a: string | undefined, b: string | undefined) => {
    quoted.push(a ?? b ?? "");
    return `\uE000${quoted.length - 1}\uE001`;
  });
  // A descriptor duplication (`2>&1`) names no file: drop it so its `&` neither ends a `tee` operand list nor reads as a
  // target.
  // Length-preserving, so an index into `clean` is the same index into `code`.
  // A duplication's operand may be quoted or spaced (`2>&"1"` and `2>& 1` are the same as `2>&1`), and a quoted run is
  // masked here, so the quoted content is read back to tell a descriptor number from an ambiguous redirect, which bash
  // rejects.
  const clean = code.replace(/\d*>&[ \t]*(?:\uE000(\d+)\uE001|(\d+))/g, (d: string, q: string | undefined) => (q === undefined || /^\d+$/.test(quoted[Number(q)]!)) ? " ".repeat(d.length) : d);
  // The pipeline elements of the line, with the operator before each: one ends a chain (`;`), the next reads the previous
  // one's stdout (`|`).
  const parts: { text: string; start: number; end: number; op?: string }[] = [];
  let from = 0;
  // Boundaries come from `clean` (its blanking is length-preserving), but each element's text is sliced from `code`:
  // a descriptor duplication is what decides whether stdout still reaches the pipe.
  // A `|` glued to a `>` is the noclobber operator, not a pipe: `echo x >| f` is one command with one redirect.
  for (const m of clean.matchAll(/(?<!>)[|;]/g)) { parts.push({ text: code.slice(from, m.index), start: from, end: m.index }); parts.at(-1)!.op = m[0]!; from = m.index! + 1; }
  parts.push({ text: code.slice(from), start: from, end: clean.length });
  // A here-document's body is what the command reads, so a redirect or `tee` fed by it writes known content (a Deb822
  // `.sources` stanza, a `deb` line); an opener with no body wrote nothing. The masked `<<` is indistinguishable from
  // `<<<` (a here-string), so the operator is read from the masked code.
  const heredoc = [...clean.replace(/\$?\(\([^()]*\)\)/g, " ").matchAll(/(?<!<)<<-?\s*(?:\uE000(\d+)\uE001|([A-Za-z_][\w]*))/g)]
    .some((m) => /^[A-Za-z_][\w]*$/.test(m[1] !== undefined ? quoted[Number(m[1])]! : m[2]!));

  const hereText = heredoc ? writtenKind(body ?? "") : undefined;
  // The last fd-0 (`<`, `0<`) redirect after a position overrides the pipe, and its filename ends at an unquoted shell
  // operator, so a redirect with no whitespace before it is still one: `f < /tmp/x</dev/null` reads /dev/null (the shell
  // applies `< /dev/null` last), not `/tmp/x</dev/null`. `2<` is another descriptor and `<<`/`<<<` are not `<`.
  const stdinOf = (text: string) => [...text.matchAll(/(?<![0-9<])(?:0<|<)(?![<&])\s*("[^"]*"|'[^']*'|[^\s<>&|;]+)/g)].map((n) => n[1]!).at(-1);
  // The command whose stdout reaches this element: the last of a `&&` chain (`a && b | tee f` pipes b's stdout, and
  // `echo x > log && cat | tee f` reads from `cat`, not the earlier command's redirect).
  const lastCommand = (part: string) => part.split(/&&|\|\|/).filter((x) => x.trim()).at(-1) ?? "";
  // A Dockerfile `RUN` keeps its verb in the text; strip it so the command itself is what gets classified. Dockerfile
  // instructions are case-insensitive, so `run`, `Run` and `RUN` are the same.
  const stripVerb = (t: string) => t.replace(/^\s*RUN\s+/i, "");
  // A `cat` (or other copier) whose own fd 0 is a redirect (`cat </dev/null`, `dd if=/dev/null` aside) copies that file
  // rather than its pipe: /dev/null is known-empty, any other file is content we can't read. `<` ends at an unquoted
  // shell operator, so `cat </tmp/x</dev/null` reads /dev/null (the last one applies).
  // What a `cat` command reads, with everything that is not an input dropped: its stdout redirects (`> f`, `>| f`,
  // `2>&1` name where it writes, so `cat > f` fed by a pipe still reads the pipe) and its own name.
  const catRest = (piece: string) => piece
    // A descriptor duplication (`2>&1`, and its quoted or spaced forms `3>&"1"`, `2>& 1`) names no file, so it goes
    // with `stdoutTarget`'s syntax rather than leaving its quoted operand to read as one.
    .replace(/\d*>&[ \t]*(?:\uE000\d+\uE001|\d+)/g, " ")
    // An output redirect and its descriptor go together: `cat /dev/null 2>/tmp/log > f` reads /dev/null, and `2` is
    // not a file. A bare `>` with no descriptor is still one.
    .replace(/(?<![0-9>])\d*(?:>>?\|?|&>>?)\s*("[^"]*"|'[^']*'|[^\s<>&|;]+)/g, " ")
    // Its stdin redirects name an input, not an operand: `cat 0</dev/null` has no file operand, and `0` is the descriptor.
    .replace(/(?<![0-9<])\d*<(?![<&])\s*("[^"]*"|'[^']*'|[^\s<>&|;]+)/g, " ")
    .replace(/^\s*(?:RUN\s+)?cat\b/i, " ");
  const catInput = (piece: string): (Pick<Written, "content" | "entries"> & { readsPipe?: boolean }) | undefined => {
    // Its input files: any `<`-redirect and its positional operands (`cat /tmp/x`, `cat </tmp/x`), with flags dropped
    // (`cat -n f`, `cat -- -x`: a lone `--` ends the options, and `-` names stdin).
    const REDIR = /(?<![0-9<])(?:0<|<)(?![<&])\s*("[^"]*"|'[^']*'|[^\s<>&|;]+)/g;
    // Only the final stdin redirect applies (a later `<` replaces an earlier one), so `cat </tmp/in </dev/null` reads
    // /dev/null, not both.
    const redirects = [...piece.matchAll(REDIR)].map((n) => unmask(strip(n[1]!)));
    // Only the command's own operands: a `>`/`>>` names where `cat` writes, so it ends the operand list (`cat > f` reads
    // the pipe, and the `>>` in `cat </dev/null >> f` is not a file).
    const operands = (catRest(piece).split(/&&|\|\||[;|]|(?<![0-9])>>?/).at(0) ?? "").match(/(?:"[^"]*"|'[^']*'|[^\s<>&]+)/g) ?? [];
    let endOfOptions = false;
    // Read with quotes back first: `cat "-"` names stdin exactly as `cat -` does, and `"-n"` is still an option.
    const positional = operands.map((a) => unmask(strip(a)))
      .filter((a) => { if (endOfOptions) return true; if (a === "--") { endOfOptions = true; return false; } return !a.startsWith("-") || a === "-"; });
    // `cat` reads its file operands and, when it names no file (`cat`, `cat -`), its stdin; a bare `cat` with no file at
    // all takes the pipe. A `<`-redirect only sets what stdin holds, and a file operand does not make stdin unread.
    const files = positional.filter((a) => a !== "-");
    const stdin = positional.length === 0 || positional.includes("-");
    const stdinFile = redirects.at(-1);
    // Its output is known empty only when every input it reads is: each file operand, and stdin when read (a redirect to
    // `/dev/null`, else the pipe — which a bare `cat` passes on by returning nothing here).
    const inputs = [...files, ...(stdin && stdinFile !== undefined ? [stdinFile] : [])];
    // The shell opens a command's redirections before it runs, so a truncating redirect to the same path empties it
    // before `cat` reads it: `cat < f > f` (and `cat f > f`) writes nothing.
    const truncated = new Set([...piece.matchAll(/(?<![>0-9])\d*>(?!>|&)\s*("[^"]*"|'[^']*'|[^\s<>&|;]+)/g)].map((n) => unmask(strip(n[1]!))));
    // A file operand or a `<`-redirect names content we can read only when this stage wrote that file: a source the
    // scanner holds carries its repositories (`cat vendor.list > dest.list` copies the `deb` line), while a name the
    // stage never wrote — or one it holds without readable entries (`COPY --from`, a copied `.sources` with no URIs) —
    // is content we can't read, whatever the pipe holds.
    const entries: string[] = [];
    for (const f of inputs) {
      if (f === "/dev/null" || truncated.has(f)) continue;
      const held = knownSource?.(f);
      if (!held?.length) return { content: "unknown" };
      entries.push(...held);
    }
    // A `-` operand (or no operand at all) reads stdin as well, and only a `<`-redirect replaces what that holds: the
    // caller adds the piped bytes, which are concatenated with whatever files were named. With no file beside it, `cat`
    // is the pipe itself and the caller passes its bytes through.
    const readsPipe = stdin && stdinFile === undefined;
    if (readsPipe && !entries.length) return undefined;
    if (entries.length) return { content: "deb", entries, readsPipe };
    // Only `/dev/null` (or files this command truncated) was read: the output is known empty.
    return { content: "empty" };
  };
  // What a copier's stdout carries: the files it read, concatenated with what the pipe feeds it when it also reads
  // stdin (`cat file -`, in a pipeline or before a redirect). An input either side can't read keeps the write unknown;
  // with nothing named, `cat` is the pipe itself and `flow` supplies those bytes.
  const mergeInputs = (
    read: (Pick<Written, "content" | "entries"> & { readsPipe?: boolean }) | undefined,
    upstream: Pick<Written, "content" | "text" | "entries">,
  ): Pick<Written, "content" | "text" | "entries"> => {
    if (!read) return upstream;
    if (!read.readsPipe) return read;
    if (read.content === "unknown" || upstream.content === "unknown") return { content: "unknown" };
    const piped = upstream.content === "deb" ? (upstream.entries ?? repoEntries(upstream.text ?? "").repos) : [];
    const all = [...(read.entries ?? []), ...piped];
    return all.length ? { content: "deb", entries: all } : { content: "empty" };
  };
  // What reaches pipeline element i's stdout: nothing when its own last command redirects it, known content from a
  // here-document, and otherwise the pipeline's earlier command — or, when that is a pass-through (`cat`, `tee`), what
  // feeds it. A redirect deeper in the pipeline therefore empties the file `tee` is actually fed by.
  const flow = (i: number): Pick<Written, "content" | "text" | "entries"> => {
    if (i < 0 || parts[i]!.op !== "|") return { content: "empty" };
    const piece = stripVerb(lastCommand(parts[i]!.text));
    // Its own stdout redirect sends the bytes elsewhere, whatever it reads: `tee /tmp/log >/dev/null | tee f` feeds f
    // nothing. Only fd 1 (a bare `>` or `1>`) takes it, though: `echo … 3> /tmp/log | tee f` still feeds f.
    if (!stdoutFeedsPipe(piece, unmask)) return { content: "empty" };
    const tee = /\btee\b/.exec(piece);
    if (tee) {
      if (hereText) return hereText;
      // Only fd 0 (`<`, `0<`) overrides the pipe, and the filename ends at an unquoted shell operator, so a redirect
      // with no whitespace before it is still one: `tee f < /tmp/x</dev/null` reads /dev/null (the shell applies
      // `< /dev/null` last), not `/tmp/x</dev/null`; `2<` is another descriptor and `<<`/`<<<` are not `<`.
      const input = stdinOf(piece.slice(tee.index + 4));
      return input ? (unmask(strip(input)) === "/dev/null" ? { content: "empty" } : { content: "unknown" }) : flow(i - 1);
    }
    // A pass-through copies its stdin (or the files it names) to its stdout; anything else is a command whose own
    // output the next element reads, so what it writes is a `deb` line. A `cat` reads its own file operands and, when it
    // names no file, its stdin: `/dev/null` alone writes nothing, any other input is content we can't read, and a bare
    // `cat` passes on what the pipe feeds it.
    // A redirect may touch the name (`cat</dev/null`), which is still `cat` reading /dev/null.
    if (/^\s*cat(?=[\s<]|$)/.test(piece)) {
      // Its own input decides first: `cat</dev/null > f` truncates f where the pipe fed it, so its empty output is
      // reported rather than the upstream `deb` line's. A `-` beside file operands concatenates the pipe with them, so
      // both sets of repositories reach the next stage.
      return mergeInputs(catInput(piece), flow(i - 1));
    }
    return { content: "deb", text: expand(piece) };
  };
  // The command containing an index: one `&&`/`||` chain gives each command its own stdout, so `a > f && b > g` sends
  // nothing to g.
  const commandSpan = (part: number, at: number): [number, number] => {
    const p = parts[part];
    if (!p) return [0, code.length];
    let start = p.start, end = p.end;
    for (const o of p.text.matchAll(/&&|\|\|/g)) {
      const opStart = p.start + o.index!, opEnd = opStart + o[0].length;
      if (at >= opEnd) start = opEnd;
      else if (at < opStart) { end = opStart; break; }
    }
    return [start, end];
  };
  // A command's stdout goes to wherever fd 1 finally lands, and every `>` before that one truncates its own file:
  // `echo … > vendor.list > /tmp/log` empties vendor.list, and `echo … > vendor.list 3>&1 > /tmp/log 1>&3` does too,
  // because `1>&3` puts stdout back on the log — vendor.list gets no bytes either way.
  const redirects = [...clean.matchAll(REDIRECT)];
  // A redirect's write, kept until the whole command is read: within one command the shell opens every destination
  // before it runs it, so a truncation of a path lands before a write that takes stdout there, whatever order the two
  // were written in. The span records which command it belongs to — writes from different pipeline stages are not
  // ordered against each other.
  interface Entry { path: string; append: boolean; takes: boolean; cmd: number; content: Pick<Written, "content" | "text" | "entries"> }
  const entries: Entry[] = [];
  redirects.forEach((m) => {
    const append = m[2] === ">>";
    const part = parts.findIndex((q) => m.index! >= q.start && m.index! < q.end);
    const [cStart, cEnd] = commandSpan(part, m.index!);
    const finalTarget = stdoutTarget(code.slice(cStart, cEnd), unmask);
    const takes = finalTarget !== "pipe" && cStart + finalTarget === m.index!;
    // The command text before this redirect, with a Dockerfile `RUN` keyword dropped so its first word is the command.
    const before = stripVerb(lastCommand((parts[part]?.text ?? code).slice(0, m.index! - (parts[part]?.start ?? 0))));
    // A pass-through (`cat > f`) writes what its pipeline element receives, so a producer that sent its own stdout
    // elsewhere leaves f empty rather than holding a `deb` line.
    const passThrough = /^\s*cat(?=[\s<]|$)/.test(before);
    // A command that writes its own `deb` line gives the file only that line: another command on the same line writing
    // to a log must not have its repository credited here too (`echo a > /tmp/log ; echo b > vendor.list`).
    // A command with no output at all (`:` or `true`) leaves the file it truncates empty.
    const silent = /^\s*(?::|true)\s*$/.test(before);
    // Read with its quoted content back: `echo "deb …" > f` writes a `deb` line, not a masked one.
    const own = takes && !passThrough && !silent ? writtenKind(expand(before)) : undefined;
    // A `cat` reads its own file operands and its stdin only when it names no file, so `cat > f </dev/null` names the
    // override after the write and its inputs are read over the whole command: `/dev/null` alone writes nothing, any
    // other input is content we can't read, and a bare `cat` (or `cat -`, which names that same stdin) passes what the
    // pipe feeds it — `catInput` answers nothing only for that pass-through case.
    const catText = passThrough ? lastCommand(code.slice(cStart, cEnd)) : "";
    const catRead = passThrough ? catInput(catText) : undefined;
    // `cat file -` concatenates the file with what the pipe feeds it, so both sets of repositories reach the file
    // (`mergeInputs`); an input either side can't read keeps the whole write `unknown`.
    const through: Pick<Written, "content" | "text" | "entries"> | undefined = passThrough
      ? mergeInputs(catRead, flow(part - 1))
      : own?.content === "deb" || own?.content === "unknown" ? own : undefined;
    const fed: Pick<Written, "content" | "text" | "entries"> | undefined = hereText ?? through;
    // The file that takes the bytes is the one fd 1 finally lands on, whichever descriptor it was opened with: with
    // `2> f 1>&2` the `2>` names f and `1>&2` moves stdout there, so f holds the line. When stdout goes elsewhere the
    // file is left empty for a truncating stdout redirect, but a redirect on another descriptor (`2> f`, `3> f`) may
    // still be written by the command's stderr or that descriptor, which we can't read: keep it as unknown rather than
    // claiming it holds nothing.
    const stdoutFd = m[1] === "" || m[1] === "1";
    entries.push({ path: unmask(strip(m[3]!)), append, takes, cmd: cStart, content: takes ? fed ?? { content: silent ? "empty" : "deb" } : { content: stdoutFd ? (append ? "none" : "empty") : "unknown" } });
  });
  // Within one command a truncation comes before the write that takes stdout; everything else keeps its written order,
  // so two commands (pipeline stages, `&&` chains) are never reordered against each other.
  const rank = (e: Entry) => (e.takes ? 2 : e.append ? 1 : 0);
  entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.path === b.e.path && a.e.cmd === b.e.cmd ? rank(a.e) - rank(b.e) || a.i - b.i : a.i - b.i))
    .forEach(({ e }) => add(e.path, e.append, e.content, e.cmd));
  // `tee`'s operands are its output files: its options and any redirection are not — `2>&1` must not cut the operand list
  // short at its `&`, and `< file` (which overrides the pipe) is consumed here so it isn't read as a file name.
  // A `>` glued to a `|` is the noclobber redirect, not a pipe: masked so `tee >| /tmp/log f` keeps the operands after it.
  const teeLine = clean.replace(/>\|/g, ">\uE002");
  for (const m of teeLine.matchAll(/\btee\b([^|;&]*)/g)) {
    const arg = m[1]!;
    // Its operands are the words that are not options or redirections (`2>&1`, `< file` and `3< file` are neither), and
    // a redirect leaves no whitespace between itself and the next one: `tee f < /tmp/x</dev/null` names only `f`.
    const options = words(arg.replace(/(?:(?<![0-9<])(?:0<|<)(?![<&])|\d+(?:>>?|<<?)|&>>?)\s*(?:&?-?\d+|[^\s<>&|;\uE002]+)|>>?(?:\uE002)?\s*[^\s<>&|;\uE002]+/g, " ")).map(unmask);
    // `-a` may be quoted or combined with other short options (`tee -ai file`, `tee "-a" file`), and `--append` is the
    // long form; another group (`-i`, `-p`) does not append.
    const append = options.some((a) => a === "--append" || (/^-[a-zA-Z]+$/.test(a) && a.includes("a")));
    // What it reads: the last fd-0 redirect it names (a file, or /dev/null), else its here-document, else the pipeline
    // that feeds it. Only fd 0 (`<`, `0<`) overrides the pipe — `3< /dev/null` redirects another descriptor — and the
    // filename ends at an unquoted shell operator: `tee f < /tmp/x</dev/null` reads /dev/null (the shell applies
    // `< /dev/null` last), not `/tmp/x</dev/null`.
    const redirect = [...arg.matchAll(/(?<![0-9<])(?:0<|<)(?![<&])\s*([^\s<>&|;]+)/g)].map((n) => n[1]!).at(-1);
    const content: Pick<Written, "content" | "text"> = redirect
      ? { content: unmask(strip(redirect)) === "/dev/null" ? "empty" : "unknown" }
      : heredoc ? hereText! : flow(parts.findIndex((p) => m.index! >= p.start && m.index! < p.end) - 1);
    // The command this `tee` belongs to, so a name another stage writes is spotted as a race.
    const cmd = parts.find((p) => m.index! >= p.start && m.index! < p.end);
    for (const a of options.filter((a) => !a.startsWith("-"))) add(a, append, content, cmd?.start ?? -1);
  }
  // Two pipeline stages writing one file are a race, not a sequence: measured in bash, `a > f | b > f > log` left the
  // repository in f in about one run in five. Where two commands write a name and either wrote a repository, every
  // other write to it is unknown instead — a truncation must not be read as clearing a repository a racing stage may
  // have written. The repository write keeps its text, so the pin is still filed where that write is the last one.
  const writers = new Map<string, Set<number>>();
  for (const w of writes) writers.set(w.path, (writers.get(w.path) ?? new Set()).add(w.cmd));
  const repoWritten = new Set(out.filter((w) => w.content === "deb").map((w) => w.path));
  const racy = new Set([...writers].filter(([path, cmds]) => cmds.size > 1 && repoWritten.has(path)).map(([path]) => path));
  // Marked on the write itself: only a racing write may have left the file's earlier repository in place, so only its
  // entries are kept beside what it brought. Any other `unknown` replaces the file for certain (`cat /tmp/x > f`).
  for (const w of out) if (racy.has(w.path) && w.content !== "deb" && w.content !== "none") { w.content = "unknown"; w.retain = true; }
  // Two racing commands may each write a repository and either can be the one bash leaves last (`echo a > f | echo b > f`
  // kept a in 5 of 40 runs and b in the rest), so the file can end holding whichever ran last: every repository written to
  // it by a racing command is a possible survivor, and all of them are kept. The file stays present and known, so a pin
  // can still be dated — dropping one of them would let a version from that repository go unchecked.
  const racedRepos = new Map<string, string[]>();
  for (const w of out) {
    const repos = w.entries ?? (w.content === "deb" ? repoEntries(w.text ?? "").repos : []);
    if (!racy.has(w.path) || !repos.length) continue;
    racedRepos.set(w.path, [...new Set([...(racedRepos.get(w.path) ?? []), ...repos])]);
  }
  for (const w of out) {
    const repos = racedRepos.get(w.path);
    if (repos) { w.entries = repos; w.text = undefined; w.content = "deb"; }
  }
  // The caller files these names so a pin they feed can be dated from every possible winner (see `dateApt`).
  return Object.assign(out, { racedPaths: new Set(racedRepos.keys()) });
}

// Install commands on one logical line: pins found, problems found.
function commands(text: string, at: string, state: State, pins: Pin[], problems: string[]): void {
  // The line's commands (a here-document's body is content, not commands) and that body, which a redirect or `tee`
  // fed by it writes.
  const nl = text.indexOf("\n");
  const cmd = (nl < 0 ? text : text.slice(0, nl)).replace(/(^|\s)#.*$/, "");
  const body = nl < 0 ? undefined : text.slice(nl + 1);
  // When the command runs a shell and feeds it a here-document, the body is shell code: it is checked as its own lines.
  if (body !== undefined && /(?:^|[\s;&|])(?:sudo\s+)?(?:ba|z|da)?sh(?:\s|$)/.test(unquoted(cmd))) {
    for (const line of body.split("\n")) if (line.trim()) commands(line, at, state, pins, problems);
  }
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
  // A removal's reach is decided at each install, not by whether any `||` comes later: after `&&` the next command runs
  // only if the removal succeeded, so `rm x && apt install` reaches the install with x gone — but a `||` between the two
  // (`test -f m && rm x || true && apt install`) is a path that skipped the removal, and a `;` starts a new chain whose
  // commands run whether or not the removal did. `test -f m && rm x && apt install; echo done || true` therefore reaches
  // the install only with x removed: the trailing fallback belongs to another chain and cannot undo that.
  // Only an unconditional removal — the first command, or one after `;` — survives the line; anything else may have been
  // skipped, so it is undone when the line ends and a later line still sees the file.
  const parts = splitOps(cmd);
  const opBefore = (i: number) => parts[i - 1];
  // Undo a removal by putting back what it dropped: a file it later rewrote keeps both (conservative) and a later write
  // on the same line is never lost to the removal's undo.
  const removeFiles = (named: string[]) => {
    const taken = new Map([...state.entries].map(([f, v]) => [f, [...v]] as const));
    const held = new Set(state.files);
    const removed = named.filter((f) => /\.(list|sources)$/.test(f));
    const blank = new Set(state.empty), unsure = new Set(state.maybe), race = new Set(state.raced);
    // A skipped removal leaves the file it would have dropped, so its entries are back even when the line also
    // rewrote that name (`test -f m && rm x && printf … > x || true` leaves the old repository when the test fails):
    // both possible sources are kept (the safe direction).
    const undo = () => {
      for (const [f, v] of taken) state.entries.set(f, [...new Set([...(state.entries.get(f) ?? []), ...v])]);
      held.forEach((f) => state.files.add(f));
      blank.forEach((f) => state.empty.add(f));
      race.forEach((f) => state.raced.add(f));
      unsure.forEach((f) => state.maybe.add(f));
      state.added = hasRepo(state);
    };
    if (removed.length) {
      removed.forEach((f) => { state.files.delete(f); state.empty.delete(f); state.maybe.delete(f); state.raced.delete(f); state.entries.delete(f); });
      state.added = hasRepo(state);
      return undo;
    }
    if (!named.length) {
      state.entries.clear(); state.files.clear(); state.empty.clear(); state.maybe.clear(); state.raced.clear();
      state.added = false;
      return undo;
    }
    return () => {};
  };
  let chain = 0;
  // `final` is a change that certainly ran with no condition that could have failed: it stands at the end of its chain.
  const pending: { index: number; chain: number; certain: boolean; final: boolean; undo: () => void }[] = [];
  // Whether a command at segment i runs certainly: it is the line's first command, after a `;`, or every operator between
  // its chain's start and it is `&&` (so it runs only where its conditions did).
  const branch = (i: number) => {
    if (i === 0 || opBefore(i) === ";") return "certain" as const;
    const start = parts.slice(0, i).reduce((acc, q, j) => (q === ";" ? j : acc), 0);
    return parts.slice(start + 1, i).every((q, j) => (start + 1 + j) % 2 === 0 || q === "&&") ? "certain" as const : "conditional" as const;
  };
  // Whether a command certainly runs, not only certainly-if-its-conditions-did: every operator from its chain's start is
  // `&&` and every condition on the way always succeeds (`true`, `:`). Such a command's write is final at the end of its
  // chain — `true && cat /dev/null > f; apt-get install curl` installs with f empty — while one behind a `test` may have
  // been skipped and is put back.
  const alwaysRuns = (i: number) => {
    if (i === 0 || opBefore(i) === ";") return true;
    const start = parts.slice(0, i).reduce((acc, q, j) => (q === ";" ? j + 1 : acc), 0);
    return parts.slice(start, i).every((q, j) => (start + j) % 2 === 1 ? q === "&&" : /^\s*(?:RUN\s+)?(?::|true)\s*$/.test(q ?? ""));
  };
  // A truncation or other write behind a condition may itself be skipped (`test -f m && : > f || true` leaves f as it
  // was), so it is applied as a change with an undo, settled at each later install exactly like a removal.
  const change = (i: number, undo: () => void) => {
    if (i === 0 || opBefore(i) === ";") return;
    const certain = branch(i) === "certain";
    pending.push({ index: i, chain, certain, final: alwaysRuns(i), undo });
  };
  // The repositories a file holds now, to put them back when a guarded change is undone (merged with whatever a later
  // command on the line wrote, so neither is lost).
  const snapshot = (...names: (string | undefined)[]) => {
    const before = names.map((n) => [n, state.entries.get(n) ? [...state.entries.get(n)!] : undefined, n === undefined ? false : state.files.has(n), n === undefined ? false : state.empty.has(n), n === undefined ? false : state.maybe.has(n), n === undefined ? false : state.raced.has(n)] as const);
    return () => {
      for (const [n, entries, held, blank, unsure, race] of before) {
        if (entries) state.entries.set(n, [...new Set([...(state.entries.get(n) ?? []), ...entries])]);
        if (held && n !== undefined) state.files.add(n);
        if (blank && n !== undefined) state.empty.add(n);
        if (unsure && n !== undefined) state.maybe.add(n);
        if (race && n !== undefined) state.raced.add(n);
      }
      state.added = hasRepo(state);
    };
  };
  // A later chain cannot rely on a conditional removal, and inside a chain a `||` before this command is a path that
  // skipped it: both put the file back before this command's installs are checked. A removal that itself may have been
  // skipped (`a || rm x && install` runs the install with x intact) never applies. A later install may also have been
  // skipped (`rm x && apt install || true`), so only its own segment's install keeps the removal.
  const settle = (i: number) => {
    for (let r = pending.length - 1; r >= 0; r--) {
      const rm = pending[r]!;
      if (rm.chain !== chain || (!rm.certain && !rm.final) || parts.slice(rm.index + 1, i).some((q) => q === "||")) { rm.undo(); pending.splice(r, 1); }
    }
  };
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i]!;
    // A `;` starts a chain that cannot rely on a change it may have skipped (`a && rm x; b`). One that certainly ran has
    // already completed, though, so it is kept rather than undone: `true && cat /dev/null > f; apt-get install curl`
    // installs with f empty.
    if (i > 0 && opBefore(i) === ";") { chain++; pending.splice(0).forEach((rm) => { if (!rm.final) rm.undo(); }); }
    settle(i);
    const debs = debLines(segment);
    // A removal is a command that runs `rm`/`unlink` on a sources.list.d name, not a quoted message mentioning one.
    const removal = /(?:^|\s)(?:sudo\s+)?(?:rm|unlink)\b/.test(unquoted(segment)) && /sources\.list\.d/.test(unquoted(segment));
    // What a command reads is not what it writes: the file a pipeline's `tee` writes carries its `deb` line, while a
    // source file it only copies for diagnostics adds no repository.
    const named = [...segment.matchAll(/sources\.list\.d\/([^\s"';|&)]*)/g)].map((m) => m[1]!).filter(Boolean);
    // What a `cat` of a file this stage wrote copies: its filed entries, and undefined for a file it never wrote.
    const knownSource = (path: string) => { const name = sourceName(path); return name && state.files.has(name) ? (state.entries.get(name) ?? []) : undefined; };
    const files = writtenFiles(segment, body, knownSource);
    // A name two racing commands wrote may end holding either one's repositories, which dating must all check.
    const racedHere = new Set(files.racedPaths ? [...files.racedPaths] : []);
    for (const path of racedHere) { const name = sourceName(path); if (name) state.raced.add(name); }
    // Only `.list` and `.sources` are loaded: a write to `vendor.list.disabled` is a repository neither APT nor a later
    // install sees, so it neither requires pins nor dates them.
    const loaded = files.filter((w) => w.file && /\.(list|sources)$/.test(w.file));
    if (removal) {
      // `rm` of one file drops that file; `rm` of the directory itself (no name) drops them all. A name APT ignores
      // removes nothing it loads. A conditional removal (`a && rm` may be skipped) is put back at the line's end.
      const undo = removeFiles(named);
      // Unconditional (`;`) removals survive the line; a conditional one is undone at line end. A removal runs
      // certainly only when everything from its chain's start to it is `&&`.
      if (i > 0 && opBefore(i) !== ";") pending.push({ index: i, chain, certain: branch(i) === "certain", final: false, undo });
    } else if (loaded.length) {
      // `>>` and `tee -a` add to the file they name; a plain `>` or `tee` replaces what it held, and each destination has
      // its own mode. A file counts as added when its content was written or copied rather than known to be empty — a
      // Deb822 `.sources` holds a repository its Types/URIs fields spell out even with no parseable `deb` line — but a
      // file written empty (`< /dev/null`, a producer whose `>` bypassed the pipe) adds none and dates none.
      // A guarded write (`test -f m && : > f || true`) is put back at the line's end like a removal, so a later line still
      // sees what the file held.
      // A write that certainly runs can't be skipped, so it needs no undo (and its file's existence must stand); a
      // guarded one is put back if a later command skips it.
      if (loaded.some((w) => w.content !== "none") && !alwaysRuns(i)) change(i, snapshot(...loaded.map((w) => w.file)));
      for (const w of loaded) {
        if (w.content === "none") continue;
        // A here-document's body is what it writes: its `deb` lines and its Deb822 stanzas.
        const written = w.entries ?? (w.content === "deb" ? (w.text === undefined ? debs : repoEntries(w.text).repos) : []);
        // `>>` to an empty stream (`cat </dev/null >> f`, `tee -a f </dev/null`) leaves the file as it was on disk,
        // entries and presence alike; only a truncating write (`> f`, a plain `tee`) removes it.
        if (w.append && w.content === "empty") continue;
        // Each write has its own mode: `>>` adds to what the file held, a plain `>` replaces it — so a file written
        // twice on one line takes only the last write's entries when that write replaces, whichever came first. A
        // racing stage's write (`retain`) is the exception: its output we can't read may have left the earlier
        // repository in place, so those entries are kept beside whatever this write brought rather than cleared.
        const prior = w.append || w.retain ? (state.entries.get(w.file!) ?? []) : [];
        state.entries.set(w.file!, [...new Set([...prior, ...written])]);
        // A later write that certainly replaces the file leaves exactly what it wrote, so an earlier race over it no
        // longer leaves another repository possible. A write that is itself part of this line's race keeps the name.
        if (!w.append && !racedHere.has(w.path)) state.raced.delete(w.file!);
        // A write behind a condition may have been skipped, so it leaves the file as it was (the undo puts back what it
        // held) — or it ran, and the file is as the write left it. Either way a `-n` copy onto it is neither certainly
        // skipped nor certainly applied, so the name is only `maybe` known while a later command may skip it.
        if (alwaysRuns(i)) {
          if (w.content === "empty") { state.files.delete(w.file!); state.empty.add(w.file!); }
          else { state.files.add(w.file!); state.empty.delete(w.file!); }
          state.maybe.delete(w.file!);
        } else state.maybe.add(w.file!);
      }
      state.added = hasRepo(state);
    } else if (debs.length && !files.some((w) => w.file)) state.entries.set(undefined, [...(state.entries.get(undefined) ?? []), ...debs]);
    // `cp`/`mv` of a source file into sources.list.d puts a repository there too: the destination file's entries are what
    // the source carries when this stage wrote it, and unknown otherwise (a file from outside the stage the scanner can't
    // read) — the same state a COPY --from leaves, so an unpinned install after it is still a problem.
    for (const m of unquoted(segment).matchAll(/(?:^|\s)(?:sudo\s+)?(cp|mv)\s+/g)) {
      const verb = m[1]!.toLowerCase() as "cp" | "mv";
      const op = copyOperands(segment.slice(m.index!), verb);
      if (!op || !/sources\.list\.d\//.test(segment.slice(m.index!) + " " + op.srcs.join(" ") + " " + op.dest)) continue;
      // What the source held is read before `mv` drops its old name: the destination carries those repositories when the
      // stage wrote them, and is unknown otherwise.
      const held = new Map<string, string[]>();
      for (const src of op.srcs) {
        const name = sourceName(src);
        if (name && state.files.has(name)) held.set(src, state.entries.get(name) ?? []);
      }
      // `mv` renames the file away, so the source name it no longer holds stops being loaded (a move onto a name APT
      // ignores still drops the original): `mv vendor.list vendor.list.disabled` leaves no repository behind.
      // `-n` (`cp` or `mv`) never replaces an existing target, and `-i` replaces it only if the answer says so. A target
      // this stage wrote is known to exist: `cp -n` leaves it exactly as it was (a file it wrote empty stays empty), and
      // `mv -n` leaves the source in place too. A target from the image is past what the scanner can see — and so is an
      // interactive answer — so both repositories are kept: the source keeps its own and the destination gains the
      // source's beside whatever it already held.
      const read = (src: string) => (held.has(src) ? { entries: held.get(src)! } : "unknown");
      // `copyTargets` names a target by the file APT loads (`vendor.list`, not the path): the state knows files by that name.
      // `exists` is a file certainly there, so `-n` certainly skips it. Any other target may already exist (a path from
      // the image) or may not (a name no write certainly created), so `-n` may keep what it held or put the source there.
      const exists = (name: string) => state.files.has(name) || state.empty.has(name);
      // A guarded move (`test -f m && mv x x.disabled`) may be skipped, so it is undone at the end of its chain like a
      // guarded truncation: a later line may still see the repository it would have disabled.
      const move = () => {
        const mode = op!.overwrite ?? "replace";
        const targets = copyTargets(op!, read);
        if (verb === "mv" && mode === "replace") for (const src of op!.srcs) {
          const name = sourceName(src);
          if (name && !(op!.srcs.length === 1 && !op!.dest.endsWith("/") && sourceName(op!.dest) === name)) { state.files.delete(name); state.empty.delete(name); state.entries.delete(name); }
        }
        // Each destination is decided on its own: `cp -n a b dir/` may skip a `b` the stage wrote while `a` lands.
        for (const t of targets) {
          // `-n` onto a file that certainly exists leaves it exactly as it was (one the stage wrote empty stays empty).
          if (mode === "keep" && exists(t.name)) continue;
          // A replacing copy puts the source's content in place of whatever the file held; so does one that may replace
          // (an interactive answer, or a `-n` whose target may already exist) — except that the file keeps what it
          // certainly held beside the source's, since the copy may also have been skipped.
          if (mode === "replace") state.entries.set(t.name, t.unknown ? [] : t.entries);
          else state.entries.set(t.name, [...new Set([...(state.entries.get(t.name) ?? []), ...(t.unknown ? [] : t.entries)])]);
          state.files.add(t.name); state.empty.delete(t.name);
        }
        state.added = hasRepo(state);
      };
      const touched = [...op.srcs.map(sourceName), ...(/sources\.list\.d\//.test(op.dest) ? [sourceName(op.dest)] : [])].filter(Boolean);
      const before = snapshot(...(touched.length ? touched : [undefined]));
      move();
      change(i, () => { before(); state.added = hasRepo(state); });
    }
    // The argument list runs to the next `&`/`|`/`;`, but `2>&1` is a redirect, not the end of the command.
    for (const m of segment.replace(/\d*>&\d+/g, " ").matchAll(/\bapt(?:-get)?\s+(?:-\S+\s+)*install\s+([^;&|]*)/g)) {
      // A redirect (`>/dev/null`, `2>&1`) is not a package argument.
      // A redirect is its own token (`> /dev/null`, `2>&1`), and one glued to the last argument is still one — but the
      // digits of `pkg=1.2.3>/dev/null` belong to the version, not to a file descriptor.
      const args = words(m[1]!
        .replace(/(?:^|[\s;&|(])\d*(?:>>?|<<?)\s*(&?\d+|"[^"]*"|'[^']*'|\S+)/g, " ")
        .replace(/(?:>>?|<<?)\s*(&?\d+|"[^"]*"|'[^']*'|\S+)/g, " "));
      for (const a of args.filter((x) => !x.startsWith("-") && !x.startsWith("./") && !x.startsWith("/") && !x.startsWith("$"))) {
        const [pkg, ver] = a.split("=") as [string, string | undefined];
        if (ver) pins.push({ kind: "apt", name: pkg, package: pkg, version: ver, sources: sources(state), releases: state.arm, ...(state.arm ? {} : state.base), at, ...(state.raced.size ? { raced: true } : {}) });
        else if (state.added) problems.push(`${at}: apt install ${pkg} after an apt repository is added: pin it (${pkg}=<version>) or install it before the repository`);
      }
    }
  }
  // A removal or guarded change that may have been skipped is undone at the line's end: a later line can still see the
  // file. A change that certainly ran with a condition that can't fail (`true && cat /dev/null > f`) is the exception —
  // it stands, since nothing could have skipped it.
  pending.splice(0).forEach((rm) => { if (!rm.final) rm.undo(); });
  for (const m of cmd.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/\s"'$]+)\//g)) {
    pins.push({ kind: "github-release", name: m[1]!, package: m[1]!, version: m[2], at });
  }
  if (/;;\s*$/.test(cmd)) state.arm = undefined;
}

/**
 * A service's `image:` and `build:` as the manifest declares them; `imageLine` is where the `image` key was written (so a
 * value the walk can't read is reported, never dropped), and `nested` is the line of a value that is not a scalar.
 */
interface ServiceDecl { image?: { ref: string; line: number }; imageLine?: number; build: boolean; nested?: number }

/**
 * modules/<name>/module.yaml's `services.run`, each service's `image:` and `build:` as the compiler reads them, in the order
 * the file first names the service. A small indentation-aware walk of the one key path, not a YAML parser (this file takes
 * no dependencies), and the one place both supply-chain checks read it: a quoted key is the same key, a `>-`/`|` block
 * scalar or a plain scalar continued on the next, more-indented line is the value, a trailing comment is dropped, and a
 * `build:` with nothing after it (or only a comment) is YAML null. A flow-style `services`/`run`/service map is reported
 * (`flow`, its line): it would hide an image from the check.
 */
export function moduleServices(text: string): { services: Map<string, ServiceDecl>; flow?: number } {
  const services = new Map<string, ServiceDecl>();
  const stack: { indent: number; key: string }[] = [];
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  let flow: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    // A key line only: a list item, a directive or anything else is not part of a service declaration's keys. A key may be
    // quoted (`"primer-db":`, as YAML allows and the compiler reads): the quotes are dropped, never the key.
    const m = /^(\s*)(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+)):(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length, key = m[2] ?? m[3] ?? m[4]!, raw = m[5], lineNo = i + 1;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    stack.push({ indent, key });
    const keys = stack.map((s) => s.key);
    const under = keys.length === 4 && keys[0] === "services" && keys[1] === "run";
    // `services: {…}`, `run: {…}` and a service `db: {image: …}` are flow maps: their images are past this walk.
    if (/^[{[\[]/.test(raw ?? "") && keys[0] === "services" && (keys.length === 1 || (keys.length === 2 && keys[1] === "run") || (keys.length === 3 && keys[1] === "run"))) flow ??= lineNo;
    // A plain scalar's text: a trailing comment dropped (a `#` at the start or after whitespace), as YAML reads it.
    let value = raw === undefined ? undefined : (raw.trim().startsWith("#") ? "" : raw.replace(/\s#.*$/, "").trim());
    let nested = 0;
    // A leaf key's value may be a block scalar (`>-`, `|`, `|2`) or a plain scalar continued on the next, more-indented
    // line (`image:\n  postgres:17@sha256:…`): those lines, folded to one string, are the value. A line that is itself a
    // key, a list item or a flow map under `image` is a nested value, which the schema forbids: it is reported, never read.
    if (under && (key === "image" || key === "build")) {
      const block = raw !== undefined && /^[>|][+-]?\d*$/.test(raw.trim());
      if (block || value === undefined || value === "") {
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j]!, t = l.trim();
          // A blank or comment-only line is not the end of the value: YAML skips a comment there, a plain scalar continues
          // after a blank line, and a block scalar keeps the blank line. The value is the first line after them.
          if (t === "" || t.startsWith("#")) { if (block || body.length) body.push(l); continue; }
          if (l.search(/\S/) <= indent) break;
          if (!block && /^(?:[-[{|>]|(?:[A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?:\s|$))/.test(t)) { nested = j + 1; break; }
          body.push(l);
        }
        if (block || body.some((l) => l.trim() !== "")) value = body.join(" ").trim();
        i = j - 1; // the value's lines are not keys of their own
      }
    }
    if (keys.length === 3 && keys[0] === "services" && keys[1] === "run") {
      if (!services.has(key)) services.set(key, { build: false });
    } else if (under) {
      const svc = services.get(keys[2]!);
      if (!svc) continue;
      // The compiler's `build != null`: `build:` with nothing after it (or only a comment) is YAML null, so the service
      // names an image after all.
      if (key === "build") svc.build = value !== undefined && !/^(?:~|null)?$/i.test(value.trim());
      if (key === "image") {
        if (nested) { svc.nested = nested; continue; }
        // A plain scalar's ref: quotes dropped. A ref never holds whitespace, so its first token is the whole of it. A ref
        // the walk cannot read as one (a `$`-interpolated one, an anchor) is still kept: modulePins reports it rather than
        // letting an image the check cannot read go unmentioned.
        const ref = value === undefined ? undefined : /^["']?([^\s"'#]+)/.exec(value)?.[1];
        if (!svc.image) { svc.imageLine = lineNo; if (ref) svc.image = { ref, line: lineNo }; }
      }
    }
  }
  return { services, flow };
}

/**
 * modules/<name>/module.yaml: each service's `image:` under `services.run` is a registry pin, by digest like a compose
 * service's (a `build:` service is this repository's own image, and the agent-level `image:` lines name a computer image:
 * neither is one).
 */
function modulePins(path: string, text: string): { pins: Pin[]; problems: string[] } {
  const { services, flow } = moduleServices(text);
  const pins: Pin[] = [], problems: string[] = [];
  const at = (n: number) => `${path}:${n}`;
  if (flow) problems.push(`${at(flow)}: services is written as a flow map; only the block form's service images can be checked`);
  for (const { image, imageLine, build, nested } of services.values()) {
    if (nested) { problems.push(`${at(nested)}: image is a nested value, not a plain reference`); continue; }
    if (build || (!image && imageLine === undefined)) continue;
    // An `image:` the walk read nothing from is reported: the schema wants a plain string, and a value this check cannot
    // read must never pass for a service that names no image.
    if (!image) { problems.push(`${at(imageLine!)}: image has no value; only a plain reference can be checked`); continue; }
    if (image.ref.includes("$")) { problems.push(`${at(image.line)}: image ${image.ref} is not a plain reference (name:tag@sha256:…)`); continue; }
    DIGEST.test(image.ref) ? pins.push(imagePin(image.ref, at(image.line))) : problems.push(`${at(image.line)}: image ${image.ref} has no digest (name:tag@sha256:…)`);
  }
  return { pins, problems };
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

const APT_FILE = /\.(list|sources)$/;
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
// The name of a path under `/etc/apt/sources.list.d/`, or none (a path elsewhere is not one APT loads).
const sourceName = (p: string) => /^\/etc\/apt\/sources\.list\.d\/([^/\s"']+)$/.exec(normalize(p))?.[1];
/**
 * The operands of a `COPY` (Dockerfile), `cp` or `mv` (a RUN line): its paths and any `--from` stage. Dockerfile COPY's
 * JSON form (`["/a", "/b/"]`) is read as the same paths, and flags (`--chown=…`, `-r`, `-f`) are dropped.
 */
function copyOperands(l: string, verb: "COPY" | "cp" | "mv"): { srcs: string[]; dest: string; from?: string; parents?: boolean; targetDir?: string; overwrite?: "replace" | "keep" | "ask" } | undefined {
  let rest = l.replace(new RegExp(`^\\s*${verb}\\s+`, "i"), "").trim();
  let from: string | undefined, parents = false, targetDir: string | undefined;
  // Whether an existing target is replaced: `replace` certainly replaces it, `keep` (`-n`) certainly does not, and `ask`
  // (`-i`) does only if the shell answer says so. For `mv` the last of `-n`/`-f`/`-i` wins (`mv -n -f a b` forces,
  // `mv -f -n a b` does not); GNU `cp`'s `-f` only retries an unopenable destination, so it never cancels `-n` or `-i`,
  // and `-i` after `-n` still asks.
  let overwrite: "replace" | "keep" | "ask" = "replace";
  const setOverwrite = (m: "replace" | "keep" | "ask") => {
    if (verb === "mv" || m !== "replace" || overwrite === "replace") overwrite = m;
  };
  if (verb === "COPY") {
    // Every leading flag is consumed before the operands are read, whichever form they take: `--from=<stage>`, a valued
    // `--flag=value`/`--flag value` (`--chmod`, `--chown`, `--exclude`) and a valueless `--flag` (`--link`, `--parents`,
    // `--follow-link`). A flag never takes the JSON array or the first source path as its value.
    const rules: [RegExp, (m: RegExpMatchArray) => void][] = [
      [/^--from=(\S+)\s*/i, (m) => { from = m[1]; }],
      [/^--(?:chmod|chown|exclude)=\S+\s*/i, () => {}],
      [/^--(?:chmod|chown|exclude)\s+\S+\s*/i, () => {}],
      [/^--(parents|follow-link|link)(?=\s|$)\s*/i, (m) => { if (m[1]!.toLowerCase() === "parents") parents = true; }],
      [/^-[a-zA-Z]+(?=\s|$)\s*/, () => {}],
      [/^--[\w-]+(?=\s|$)\s*/, () => {}],
    ];
    for (;;) {
      const hit = rules.find(([re]) => re.test(rest));
      if (!hit) break;
      rest = rest.replace(hit[0], (m: string, ...g: string[]) => { hit[1]([m, ...g] as unknown as RegExpMatchArray); return ""; });
    }
    // Dockerfile COPY's JSON form: paths as an array, one per operand (the same paths as the shell form).
    if (rest.startsWith("[")) {
      try {
        const j = JSON.parse(rest);
        if (!Array.isArray(j) || !j.every((x) => typeof x === "string") || j.length < 2) return undefined;
        return { srcs: j.slice(0, -1) as string[], dest: j.at(-1)!, ...(from ? { from } : {}), ...(parents ? { parents } : {}), overwrite };
      } catch { return undefined; }
    }
    const args = [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
    if (args.length < 2) return undefined;
    return { srcs: args.slice(0, -1), dest: args.at(-1)!, ...(from ? { from } : {}), ...(parents ? { parents } : {}), overwrite };
  }
  // `cp`/`mv`: GNU getopt permutes, so a flag may sit before, between or after the operands (`mv a b -n`), and a
  // cluster may carry its value (`-nt dir`, `-nS.bak`, `-t=/dir`). Every word is read in order: a flag sets the mode as
  // it is seen, `-t`/`-S` take the rest of their cluster or the next word as their value, everything else is a path.
  const toks = [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
  const args: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "--") { args.push(...toks.slice(i + 1)); break; }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = (eq < 0 ? t.slice(2) : t.slice(2, eq)).toLowerCase(), value = eq < 0 ? undefined : t.slice(eq + 1);
      if (name === "no-clobber") setOverwrite("keep");
      else if (name === "force") setOverwrite("replace");
      else if (name === "interactive") setOverwrite("ask");
      else if (name === "target-directory" || name === "suffix") {
        // Without `=`, the value is the next word (`--target-directory dir f`).
        const v = value ?? toks[i + 1];
        if (eq < 0) i++;
        if (name === "target-directory" && v !== undefined) targetDir = strip(v);
      }
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const c = t[k]!;
        if (c === "n") setOverwrite("keep");
        else if (c === "f") setOverwrite("replace");
        else if (c === "i") setOverwrite("ask");
        else if (c === "t" || c === "S") {
          // The rest of the cluster is this flag's value (`-t/dir`, `-t=/dir`, `-S.bak`); otherwise the next word is.
          const glued = t.slice(k + 1), v = glued || toks[++i];
          if (c === "t" && v !== undefined) targetDir = strip(v.replace(/^=/, ""));
          break;
        }
        // Every other short flag (`-r`, `-v`, `-T`, `-b`) takes no operand.
      }
      continue;
    }
    args.push(t);
  }
  // `cp`/`mv -t dir` (or `--target-directory dir`) names the destination as an option: every operand is a source, even
  // a lone one, and the directory is taken as ending with a slash.
  if (targetDir && args.length >= 1) return { srcs: args, dest: targetDir.endsWith("/") ? targetDir : `${targetDir}/`, ...(from ? { from } : {}), overwrite };
  if (args.length < 2) return undefined;
  return { srcs: args.slice(0, -1), dest: args.at(-1)!, ...(from ? { from } : {}), overwrite };
}
/**
 * The path `COPY --parents` keeps for a source: its parents relative to the last `./` pivot (`./x/a.txt` keeps `x/a.txt`,
 * `/out/./x/a.txt` keeps `x/a.txt`), or with its leading slashes dropped when it has none (`/etc/apt/x.list` keeps
 * `etc/apt/x.list`). Undefined when nothing is left to keep.
 */
function parentsPath(src: string): string | undefined {
  const p = src.replace(/^(?:\.\/)+/, "");
  const pivot = p.lastIndexOf("/./");
  const rel = (pivot >= 0 ? p.slice(pivot + 3) : p).replace(/^\/+|\/+$/g, "");
  return rel || undefined;
}
// The path a shell or Docker resolves: `.` components dropped and repeated slashes collapsed, so
// `/etc/apt/./sources.list.d//x.list` is the `sources.list.d/x.list` APT loads.
const normalize = (p: string) => p.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "").replace(/\/{2,}/g, "/");
/**
 * The files a copy puts in sources.list.d, each under the name the destination gives it: `{ name, entries }` when the
 * source file's content is known, `unknown` when it isn't (a `cp` of a file the scanner doesn't track), and nothing for a
 * source the copy can't resolve or a destination APT doesn't load (`/tmp/`, `vendor.list.disabled`). `read` answers what
 * the source path holds: a tracked stage's file, `unknown`, or nothing.
 */
function copyTargets(op: { srcs: string[]; dest: string; parents?: boolean }, read: (src: string) => { entries: string[] } | "unknown" | undefined): { name: string; entries: string[]; unknown: boolean }[] {
  // `COPY --parents` keeps each source's parent directories under the destination: `vendor.list` lands directly in
  // `/etc/apt/sources.list.d/`, where APT loads it, while `/etc/apt/sources.list.d/vendor.list` keeps its whole path
  // (`dest/etc/apt/sources.list.d/vendor.list`), where APT does not. Only a source whose kept path is a bare file name
  // is a source file APT reads; what it holds is whatever `read` answers.
  if (op.parents) {
    const base = op.dest.endsWith("/") ? op.dest : `${op.dest}/`; // Docker requires a directory destination for --parents
    const kept: { name: string; entries: string[]; unknown: boolean }[] = [];
    for (const src of op.srcs) {
      const path = parentsPath(src);
      if (!path) continue;
      // What APT loads is the file the copy forms, destination and kept path together: `vendor.list` into
      // `/  → /etc/apt/sources.list.d/` loads it, while `etc/apt/sources.list.d/vendor.list` into `/tmp/` does not.
      const name = sourceName(`${base}${path}`);
      // Only a name APT loads is a repository: a kept `vendor.list.disabled` sits in the directory but APT skips it.
      if (!name || !APT_FILE.test(name)) continue;
      const held = read(src);
      kept.push(held && held !== "unknown" ? { name, entries: held.entries, unknown: false } : { name, entries: [], unknown: true });
    }
    return kept;
  }
  const destDir = op.srcs.length > 1 || op.dest.endsWith("/") || op.dest === "/etc/apt/sources.list.d";
  if (destDir ? !/^\/etc\/apt\/sources\.list\.d\/?$/.test(op.dest) : !sourceName(op.dest)) return [];
  const out: { name: string; entries: string[]; unknown: boolean }[] = [];
  for (const src of op.srcs) {
    const name = destDir ? baseName(src) : sourceName(op.dest)!;
    if (!APT_FILE.test(name)) continue;
    const held = read(src);
    if (held === undefined) continue;
    out.push(held === "unknown" ? { name, entries: [], unknown: true } : { name, entries: held.entries, unknown: false });
  }
  return out;
}
// A copy replaces the file it names (Docker's, cp's and mv's semantics), keeping the directory's other source files.
function applyCopy(state: State, targets: { name: string; entries: string[]; unknown: boolean }[]): void {
  for (const t of targets) { state.files.add(t.name); state.empty.delete(t.name); state.entries.set(t.name, t.unknown ? [] : t.entries); }
  state.added = hasRepo(state);
}

/** One file's pins and its unpinned problems. */
export function scanFile(path: string, text: string): { pins: Pin[]; problems: string[] } {
  if (HOST_PINS.test(path)) return hostPins(path, text);
  if (MODULE.test(path)) return modulePins(path, text);
  const pins: Pin[] = [], problems: string[] = [];
  let state: State = emptyState();
  const at = (n: number) => `${path}:${n}`;
  if (DOCKERFILE.test(path)) {
    const stages = new Set(["scratch"]);
    // Each stage's state as its RUN lines leave it, by alias and by index (`--from=0`), so a stage that extends or
    // copies from it starts from the same filesystem.
    const stageState = new Map<string, State>();
    const indices: State[] = [];
    const stageOf = (ref: string | undefined): State | undefined => {
      if (!ref) return undefined;
      if (/^\d+$/.test(ref)) return indices[Number(ref)];
      return stages.has(ref.toLowerCase()) ? stageState.get(ref.toLowerCase()) : undefined;
    };
    const syntax = /^#\s*syntax\s*=\s*(\S+)/m.exec(text);
    if (syntax) DIGEST.test(syntax[1]!) ? pins.push(imagePin(syntax[1]!, at(1))) : problems.push(`${at(1)}: # syntax=${syntax[1]} has no digest`);
    for (const { n, text: l } of logical(text)) {
      const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
      const copyOp = /^\s*COPY\s/i.test(l) ? copyOperands(l, "COPY") : undefined;
      const copy = copyOp?.from ? [null, copyOp.from] as const : null;
      const ref = from?.[1] ?? copy?.[1];
      if (ref && !ref.includes("$") && !stages.has(ref.toLowerCase()) && (from || /[:/]/.test(ref))) {
        DIGEST.test(ref) ? pins.push(imagePin(ref, at(n))) : problems.push(`${at(n)}: image ${ref} has no digest (name:tag@sha256:…)`);
      }
      if (from) {
        // A stage starts from its own filesystem: a new image from scratch (its own distro, no repositories), a
        // stage it extends from what that stage had when it finished. Either way the additions stay in this stage.
        const ref = from[1]!, inherited = stageOf(ref);
        state = inherited ? cloneState(inherited) : emptyState();
        state.base = ref.includes("$") ? undefined : inherited ? inherited.base : baseDistro(ref);
      }
      // `COPY --from=<stage> <src> /etc/apt/sources.list.d/[<name>]` puts that stage's source file in this one's
      // filesystem: its repositories replace the destination file's (each under the name the destination gives it), so a
      // following unpinned install is checked against them. A source the builder doesn't have, a source outside
      // sources.list.d, or a destination APT doesn't load changes nothing.
      if (copyOp) {
        const built = stageOf(copyOp.from);
        // A copy of the directory itself brings every source file the builder still has, each under its own name; a
        // stage that doesn't track the directory's contents (no file, or a source elsewhere) copies nothing known.
        const srcs = copyOp.srcs.flatMap((src) => /\/etc\/apt\/sources\.list\.d\/?$/.test(src) && built
          ? [...built.files].filter((f) => APT_FILE.test(f)).map((f) => `${src.replace(/\/?$/, "/")}${f}`)
          : [src]);
        applyCopy(state, copyTargets({ ...copyOp, srcs }, (src) => {
          const name = sourceName(src);
          if (!built) {
            // From the build context the file's content is past what the scanner reads: whatever it is called in the
            // context (`vendor.conf`), the destination name is what makes APT load it, so a copy that lands as a source
            // file is kept as a repository the scanner can't read rather than dropped.
            return "unknown";
          }
          if (!name || !built.files.has(name)) return undefined;
          return APT_FILE.test(name) ? { entries: built.entries.get(name) ?? [] } : undefined;
        }));
      }
      if (from) {
        const alias = from[2]?.toLowerCase();
        if (alias) { stages.add(alias); stageState.set(alias, state); }
        indices.push(state);
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
// What a Debian suite alias names right now: the alias is what Debian's archive resolves server-side, but a file's own
// repository expands `$VERSION_CODENAME` to the codename, so the two must not be confused. Read once per alias per run;
// an unreadable Release file leaves the alias in place, which keeps the previous behaviour rather than inventing one.
const aliasCodenames = new Map<string, Promise<string>>();
function aliasCodename(alias: string): Promise<string> {
  if (!aliasCodenames.has(alias)) {
    aliasCodenames.set(alias, (async () => {
      // HTTPS: this is suite metadata, not an index, and it selects which suite of a third-party repository is
      // queried, so a plaintext hop that rewrites `Codename` would send the age check to a suite that need not hold
      // the package. Debian serves the same Release file over TLS.
      const r = await fetchRetry(`https://deb.debian.org/debian/dists/${alias}/Release`, { timeout: 30000 });
      const m = /^Codename:\s*(\S+)\s*$/m.exec(await r.text());
      if (!m) throw new Error(`dists/${alias}/Release names no Codename`);
      return m[1]!;
    })().catch((e) => { aliasCodenames.delete(alias); throw e; }));
  }
  return aliasCodenames.get(alias)!;
}

export async function dateApt(p: Pin, lookup: typeof publishedAt = publishedAt, codenameOf: (alias: string) => Promise<string> = aliasCodename) {
  const release = p.release ?? DEFAULT_RELEASE;
  // Only a file's own sources need this, and only when the base named a suite alias rather than a codename.
  if (p.suiteAlias && p.sources?.length) {
    p = { ...p };
    try { p.codename = await codenameOf(release); } catch { /* unreadable: fall back to the alias, as before */ }
  }
  // `stable` and `testing` are Debian suite names, not codenames: Debian's own archive resolves them, but a third-party
  // repository writing `$VERSION_CODENAME` means the codename (`trixie`), never the alias. So a file's own sources are
  // expanded with the codename the alias names today (read from Debian's Release file, cached per alias), while Debian's
  // pockets keep the alias and let the server resolve it.
  const own = p.sources!.map((s) => onRelease(s, p.suiteAlias ? p.codename ?? release : release, p.distro));
  let newest: Awaited<ReturnType<typeof publishedAt>> | undefined;
  for (const source of [...own, ...distroSources(release, p.distro)]) {
    // Only the file's own sources are race candidates; the distro's pockets are where a pin is dated when none of them
    // lists it, so the first pocket that does answers it.
    const inFile = own.includes(source);
    if (!inFile && newest) break;
    try {
      const found = await lookup("apt", p.name, { version: p.version, source });
      if (!p.raced) return found;
      if (!newest || found.published > newest.published) newest = found;
    } catch (e) {
      // An index this release has no pocket for (a retired suite on one host, a pocket it never published) is not an
      // error: the next candidate may hold it. A package that could not be looked up still fails, and so does a
      // 403/429 from the host. A file's own repository always fails, since its absence is a real error.
      const missingIndex = !inFile && (e as FetchError).noIndex === true;
      if (!(e as FetchError).notListed && !missingIndex) throw e;
    }
  }
  if (newest) return newest;
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
