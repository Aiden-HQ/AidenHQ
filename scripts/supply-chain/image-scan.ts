#!/usr/bin/env node
// The `image-scan` check without a build (CI's self-hosted runners have no Docker, and building a PR's Dockerfile would
// run its RUN steps): for each Dockerfile, grype scans its directory (lock files and manifests) and every image its FROM,
// COPY --from and RUN --mount=from name, pulled straight from the registry. Nothing in the repository is executed: each
// Dockerfile is read as text, anything this reader can't follow exactly as BuildKit would is refused, and only
// digest-pinned references that pass a strict grammar reach grype (one argv word each).
// Not covered: what RUN steps install (apt, pip, downloads), ADD downloads and a base image's ONBUILD triggers; a fix made
// in a RUN step can't turn the check green either. And it no longer proves the image builds. Policy as before:
// --only-fixed --fail-on high. Exceptions (.github/image-scan-exceptions.yaml, read from the base commit) ignore one path
// in one base image, for files a Dockerfile replaces or never copies out, only while every Dockerfile using that image
// still meets the exception's condition; or one accepted advisory with no fixed release in one image, until it expires.
// Accepted risks (.github/image-scan-accepted.yaml, read from the base commit, the owner's approval): one finding in one
// image pinned by digest that no newer upstream release of that image fixes yet, for at most 14 days; an expired entry fails the scan.
// No dependencies, Node 22+; a byte-identical copy is in the app CI template.
//   node image-scan.ts [--exceptions <file>] [--accepted <file>] [--local <name>=<Dockerfile>]... [--service-image <ref>]... -- <Dockerfile>...
//     (options only before --; everything after it is a path, even one that starts with -)
//     (grype on PATH; GRYPE_DB_CACHE_DIR)
// --local: an image this repository builds itself, named by a FROM (e.g. an ARG default): scanned through its own
// Dockerfile, never pulled from a registry under the same name.
// --service-image: an image a module's module.yaml pins outright (services.run.<service>.image): the change that re-pins it
// names it, and it is scanned from the registry as published, exactly as a Dockerfile's FROM base image is (never built).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A reference grype may pull: [registry[:port]/]path[:tag]@sha256:<64 hex>, lowercase path components as Docker has them.
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REPO = `(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/)?${COMPONENT}(?:/${COMPONENT})*`;
const IMAGE = new RegExp(`^${REPO}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`);
const NAMED = new RegExp(`^${REPO}$`); // an image name alone: a --local name, an exception's image
const SYNTAX = /^(?:docker\.io\/)?docker\/dockerfile:[0-9][0-9a-z.-]*@sha256:[0-9a-f]{64}$/; // the official frontend only
const PLATFORM = /^--platform=(?:linux\/amd64|\$\{?(?:BUILDPLATFORM|TARGETPLATFORM)\}?)$/; // CI scans linux/amd64; every pinned base is multi-arch, so an arm64 host builds the same references
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/; // repository-relative, no . or .. segments
const PLAIN = "[A-Za-z0-9 ._@\/=:+,-]*"; // plain words and spaces: all a RUN step may hold to satisfy an exception
const PLAIN_PART = new RegExp(`^${PLAIN}$`), PLAIN_RUN = new RegExp(`^${PLAIN}(?:&&${PLAIN})*$`);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const show = (s: unknown) => JSON.stringify(String(s).slice(0, 200)); // untrusted text in a message: one quoted line
const nameOf = (ref: string) => ref.replace(/@.*$/, "").replace(/:[^:/]*$/, "");

// A stage's base, or what a COPY --from or mount names: an earlier stage, scratch, or an image (ref).
interface Ref { image?: string; local?: string; final: boolean }
interface Source { stage?: number; scratch?: boolean; ref?: Ref }
interface Stage { base: Source; runs: string[]; copies: { src: Source; paths: string[] }[]; mounts: Source[] }
export interface Use { final: boolean; finalRuns: string[]; copies: { paths: string[]; runs: string[] }[]; mounted: boolean }
export interface Exception { image: string; vulnerability?: string; expires?: string; path?: string; when?: string }
export interface Accepted { id: string; image: string; expires: string }
type PlannedImage = { ref: string; uses: (Use & { df: string })[]; service?: boolean };

/**
 * What a Dockerfile's text names: `refs`, each { image } (a registry reference) or { local } (a --local name) with
 * `final` true when the final image is built on it (through stage aliases), and `uses`, one per ref, saying how that
 * image's files can reach the final image (for the exceptions: `meets`). Throws on anything it can't read with certainty:
 * an escape directive, a frontend other than docker/dockerfile, a heredoc, a quoted or odd --mount, ONBUILD, an ARG
 * without a default or set after the first FROM, any other `$` form, a platform other than amd64, a reference without a
 * digest, or one outside the grammar.
 */
export function bases(text: string, local: Set<string> = new Set()): { refs: Ref[]; uses: Use[] } {
  const lines = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n");
  // Directives, wherever they appear and in either comment style BuildKit reads (`#`, `//`, after a shebang): another
  // escape character would change how every line continues, and another frontend how the whole file is read.
  for (const l of lines) {
    const d = /^\s*(?:#|\/\/)\s*(escape|syntax)\s*=\s*(.*?)\s*$/i.exec(l);
    if (d && (/^escape$/i.test(d[1]!) || !SYNTAX.test(d[2]!))) throw new Error(`directive ${show(l.trim())}: no escape directive, and only docker/dockerfile pinned by digest as syntax`);
  }
  // Logical lines: comment lines dropped (also inside a continuation, as Docker does), backslash continuations joined.
  const logical: string[] = [];
  let buf: string | null = null;
  for (const l of lines) {
    if (/^\s*#/.test(l) || (buf !== null && /^\s*$/.test(l))) continue; // BuildKit skips blank lines inside a continuation
    const cont = /\\\s*$/.test(l);
    buf = (buf ?? "") + (cont ? l.replace(/\\\s*$/, " ") : l);
    if (!cont) (logical.push(buf), (buf = null));
  }
  if (buf !== null) logical.push(buf);

  // Stages: each FROM's base ({ ref }, { stage: index } or { scratch }), its RUN commands (split at &&), what it copies
  // and mounts from elsewhere.
  const args = new Map<string, string>(), names = new Map<string, number>(), stages: Stage[] = [], refs: Ref[] = [];
  const expand = (s: string) => {
    const v = s.replace(/\$(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_: string, braced: string | undefined, bare: string | undefined) => {
      const k = (braced ?? bare)!;
      if (!NAME.test(k)) throw new Error(`\${${show(k)}} is not a plain ARG reference`);
      if (!args.has(k)) throw new Error(`ARG ${k} has no default before the first FROM`);
      return args.get(k)!;
    });
    if (v.includes("$")) throw new Error(`${show(s)} has a $ that isn't an ARG reference`);
    return v;
  };
  // A FROM, COPY --from or mount source: an earlier stage (by name; by index only outside FROM), scratch, or an image.
  const source = (ref: string, what: string): Source => {
    if (names.has(ref.toLowerCase())) return { stage: names.get(ref.toLowerCase()) };
    if (what !== "FROM" && /^[0-9]+$/.test(ref)) {
      if (Number(ref) >= stages.length) throw new Error(`${what} ${show(ref)}: no such stage`);
      return { stage: Number(ref) };
    }
    if (ref.toLowerCase() === "scratch") return { scratch: true };
    if (!local.has(ref) && !IMAGE.test(ref)) throw new Error(`${what} ${show(ref)} is not an image reference pinned by digest (name:tag@sha256:…)`);
    const r: Ref = local.has(ref) ? { local: ref, final: false } : { image: ref, final: false };
    refs.push(r);
    return { ref: r };
  };
  const current = (word: string): Stage => {
    if (!stages.length) throw new Error(`${word} before the first FROM`);
    return stages[stages.length - 1]!;
  };
  for (const l of logical) {
    const [ins = "", ...rest] = l.trim().split(/\s+/);
    const word = ins.toUpperCase();
    // A heredoc's body is content, not instructions: this reader can't tell them apart, so it refuses them.
    if (/^(RUN|COPY|ADD)$/.test(word) && l.includes("<<")) throw new Error(`${word} with a heredoc (<<) is not supported`);
    if (word === "ONBUILD") throw new Error("ONBUILD is not supported");
    if (word === "ARG" && !stages.length) {
      for (const a of rest) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([^\s"'$\\]*))?$/.exec(a);
        if (!m) throw new Error(`ARG ${show(a)} is not NAME or NAME=value (plain, unquoted)`);
        if (m[2] === undefined) args.delete(m[1]!);
        else args.set(m[1]!, m[2]);
      }
    } else if (word === "FROM") {
      const words = rest.filter((w) => !PLATFORM.test(w));
      if (words.some((w) => w.startsWith("-"))) throw new Error(`FROM ${show(rest.join(" "))}: only --platform=linux/amd64 (or $BUILDPLATFORM, $TARGETPLATFORM) is supported`);
      if (!(words.length === 1 || (words.length === 3 && /^as$/i.test(words[1]!) && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(words[2]!))))
        throw new Error(`FROM ${show(rest.join(" "))} is not FROM <image> [AS <name>]`);
      stages.push({ base: source(expand(words[0]!), "FROM"), runs: [], copies: [], mounts: [] });
      if (words[2]) names.set(words[2].toLowerCase(), stages.length - 1);
    } else if (word === "COPY") {
      const from = rest.map((w) => /^--from=(.*)$/i.exec(w)).find(Boolean);
      if (!from) continue;
      if (from[1]!.includes("$")) throw new Error(`COPY --from=${show(from[1])}: a variable here is not supported`);
      const operands = rest.filter((w) => !w.startsWith("--"));
      current(word).copies.push({ src: source(from[1]!, "COPY --from"), paths: operands.slice(0, -1) });
    } else if (word === "RUN") {
      const flags: string[] = [];
      while (rest[0]?.startsWith("--")) flags.push(rest.shift()!);
      const stage = current(word);
      // Only plain words joined by && are split; anything else (quotes, $, >, ;, |, #, escapes) is kept whole and never matches.
      const cmd = rest.join(" ");
      stage.runs.push(...(PLAIN_RUN.test(cmd) ? cmd.split("&&").map((s) => s.trim()) : [cmd]));
      for (const w of flags) {
        if (!/^--mount=/i.test(w)) continue;
        // BuildKit reads a mount as CSV with case-insensitive keys: anything quoted is refused, every from= collected.
        if (/["'$]/.test(w)) throw new Error(`RUN ${show(w)}: a quoted or variable mount is not supported`);
        for (const kv of w.slice(8).split(",")) {
          const [k, v = ""] = kv.split("=");
          if (k!.trim().toLowerCase() === "from") stage.mounts.push(source(v.trim(), "RUN --mount from="));
        }
      }
    }
  }
  if (!stages.length) throw new Error("no FROM line");

  // A stage and the stages it is built on, nearest first.
  const chain = (i: number) => { const out: number[] = []; for (let s: number | undefined = i; s !== undefined; s = stages[s]!.base.stage) out.push(s); return out; };
  const finalChain = chain(stages.length - 1);
  const uses: Use[] = refs.map((r) => {
    // The image's family: every stage built on it. Its files reach the final image through a family stage in the final
    // chain, or through a COPY --from (or a mount) of the image or a family stage.
    const family = new Set(stages.map((_, i) => i).filter((i) => chain(i).some((s) => stages[s]!.base.ref === r)));
    const runsOf = (ids: number[]) => ids.filter((s) => family.has(s)).flatMap((s) => stages[s]!.runs);
    const fromIt = (x: Source) => x.ref === r || family.has(x.stage!);
    return {
      final: finalChain.some((s) => family.has(s)),
      finalRuns: runsOf(finalChain),
      copies: stages.flatMap((s) => s.copies.filter((c) => fromIt(c.src)).map((c) => ({ paths: c.paths, runs: c.src.stage === undefined ? [] : runsOf(chain(c.src.stage)) }))),
      mounted: stages.some((s) => s.mounts.some(fromIt)),
    };
  });
  refs.forEach((r, i) => (r.final = uses[i]!.final));
  return { refs, uses };
}

/**
 * Exceptions, one flow-style line each, every other line a comment, blank or `exceptions:`:
 * `- { image: node, path: /usr/local/lib/node_modules/npm/**, when: "RUN npm install -g npm@", reason: "…" }`.
 * `when` is the condition that justifies it, checked for every Dockerfile using the image (`meets`).
 */
export function readExceptions(text: string, now = Date.now()): Exception[] {
  const out: Exception[] = [];
  for (const l of text.split("\n")) {
    if (/^\s*(#.*)?$/.test(l) || /^exceptions:\s*$/.test(l)) continue;
    // An accepted finding with no fix to take yet: one advisory in one image, until a date at most 90 days ahead.
    const v = /^\s*-\s*\{\s*image:\s*([^,\s]+),\s*vulnerability:\s*(GHSA(?:-[a-z0-9]{4}){3}|CVE-\d{4}-\d{4,}|GO-\d{4}-\d{4,}),\s*expires:\s*(\d{4}-\d{2}-\d{2}),\s*reason:\s*"[^"]+"\s*\}\s*$/.exec(l);
    if (v) {
      if (!NAMED.test(v[1]!) || !(Date.parse(v[3]!) - now <= 90 * 86_400_000)) throw new Error(`exception ${show(l.trim())}: an image name and an expiry at most 90 days ahead`);
      out.push({ image: v[1]!, vulnerability: v[2], expires: v[3] });
      continue;
    }
    const m = /^\s*-\s*\{\s*image:\s*([^,\s]+),\s*path:\s*([^,\s]+),\s*when:\s*(build-stage|"RUN [A-Za-z0-9 ._@\/=:-]+"),\s*reason:\s*"[^"]+"\s*\}\s*$/.exec(l);
    // A path names at least two directories before any wildcard: never a whole image or a whole top-level directory.
    if (!m || !NAMED.test(m[1]!) || !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._*-]+)*$/.test(m[2]!))
      throw new Error(`exception ${show(l.trim())} is not { image: <name>, path: /<dir>/<dir or file>[/…], when: build-stage | "RUN <text>", reason: "…" } nor { image: <name>, vulnerability: <id>, expires: <YYYY-MM-DD>, reason: "…" }`);
    out.push({ image: m[1]!, path: m[2], when: m[3]!.replace(/^"|"$/g, "") });
  }
  return out;
}

const ADVISORY = /^(?:GHSA(?:-[a-z0-9]{4}){3}|CVE-\d{4}-\d{4,}|GO-\d{4}-\d{4,})$/;
// An accepted entry's image: always pinned by digest (a tag alone would cover whatever is pushed under it later).
const PINNED = new RegExp(`^${REPO}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`);

/**
 * Accepted risks, one flow-style line each, every other line a comment, blank or `accepted:`:
 * `- { id: GO-2026-6888, image: grafana/grafana:13.3.0, expires: 2026-11-30, reason: "…" }`. Returns the entries in
 * force and the expired ones (which fail the scan: an owner renews or drops them).
 */
export function readAccepted(text: string, now = Date.now()): { entries: Accepted[]; expired: Accepted[] } {
  const entries: Accepted[] = [], expired: Accepted[] = [];
  for (const l of text.split("\n")) {
    if (/^\s*(#.*)?$/.test(l) || /^accepted:\s*$/.test(l)) continue;
    const m = /^\s*-\s*\{\s*id:\s*([^,\s]+),\s*image:\s*([^,\s]+),\s*expires:\s*(\d{4}-\d{2}-\d{2}),\s*reason:\s*"[^"]{12,}"\s*\}\s*$/.exec(l);
    if (!m || !ADVISORY.test(m[1]!) || !PINNED.test(m[2]!) || Number.isNaN(Date.parse(m[3]!)))
      throw new Error(`accepted risk ${show(l.trim())} is not { id: <GHSA-…, CVE-… or GO-…>, image: <name[:tag]@sha256:…>, expires: <YYYY-MM-DD>, reason: "…" }`);
    if (Date.parse(m[3]!) - now > 14 * 86_400_000) throw new Error(`accepted risk ${show(l.trim())}: expires at most 14 days ahead`);
    (now < Date.parse(m[3]!) + 86_400_000 ? entries : expired).push({ id: m[1]!, image: m[2]!, expires: m[3]! });
  }
  return { entries, expired };
}

/** The accepted ids for one scanned reference: entries for the same image name and the same digest (the tag is ignored). */
export function acceptedFor(ref: string, entries: Accepted[]) {
  const digest = (r: string) => /@(sha256:[0-9a-f]{64})$/.exec(r)?.[1];
  const same = (img: string) => nameOf(img) === nameOf(ref) && digest(img) !== undefined && digest(img) === digest(ref);
  return [...new Set(entries.filter((e) => same(e.image)).map((e) => e.id))];
}

/** Whether COPY sources (paths in the source stage) may carry anything under an exception's path. */
function covers(paths: string[], glob: string) {
  const lit = glob.includes("*") ? glob.slice(0, glob.indexOf("*")).replace(/\/[^/]*$/, "") : glob; // its literal directory
  return paths.some((p) => {
    if (/[*?[\]"'$\\]|(^|\/)\.\.(\/|$)/.test(p)) return true; // a glob, JSON form, variable or parent: assume it does
    const n = `/${p}`.replace(/\/+/g, "/").replace(/\/\.(?=\/|$)/g, "").replace(/\/$/, "") || "/";
    return n === "/" || n === lit || lit.startsWith(`${n}/`) || n.startsWith(`${lit}/`);
  });
}

/**
 * Whether an exception's condition holds for one use of its image. Nothing mounted from it, and:
 *   build-stage   no final image is built on it, and no COPY out of it can carry the path;
 *   "RUN <text>"  every way the path can reach the final image passes a stage built on the image with a RUN command (or
 *                 one of its && parts, with no ;, | or & in it) whose leading words are <text>'s, word for word, and
 *                 one of whose arguments is <text>'s last word exactly (`rm -rf /a /b` holds for "RUN rm -rf /b", not
 *                 for "RUN rm -rf /b-old"); a last word ending in @ takes an exact version and only the exact form
 *                 `<leading words> <pkg>@<version>`, no other flag or argument (npm@ holds for `npm install -g npm@11.21.2`,
 *                 not for `npm install -g --registry=… npm@11.21.2` or `npm install -g npm@11.21.2 other`).
 */
export function meets(e: Exception, use: Use): boolean {
  if (use.mounted) return false;
  if (e.when === "build-stage") return !use.final && use.copies.every((c) => !covers(c.paths, e.path!));
  const words = e.when!.slice(4).split(" "), lead = words.slice(0, -1), arg = words.at(-1)!;
  const isArg = (w: string) => w === arg || (arg.endsWith("@") && w.startsWith(arg) && /^[0-9][A-Za-z0-9.+-]*$/.test(w.slice(arg.length)));
  // The && split ignores shell syntax: a RUN step with anything but plain words and && never satisfies a condition.
  const replaced = (runs: string[]) => runs.some((s) => {
    if (!PLAIN_PART.test(s)) return false;
    const t = s.trim().split(/\s+/);
    if (/[;|&]/.test(s) || !lead.every((w, i) => t[i] === w)) return false;
    return arg.endsWith("@") ? t.length === lead.length + 1 && isArg(t[lead.length]!) : t.slice(lead.length).some(isArg);
  });
  return (!use.final || replaced(use.finalRuns)) && use.copies.every((c) => !covers(c.paths, e.path!) || replaced(c.runs));
}

/**
 * The scan targets for some Dockerfiles: directories, and images each with every use of it, each once, in order. A
 * `services` ref is a module service image no Dockerfile names: scanned whole from the registry (`service: true`), so no
 * Dockerfile exception (which needs a use) applies to it.
 */
export function plan(dockerfiles: string[], { root, local = new Map(), services = [] }: { root: string; local?: Map<string, string>; services?: string[] }) {
  const realRoot = realpathSync(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  const dirs: string[] = [], images = new Map<string, (Use & { df: string })[]>(), done = new Set<string>(), notes: string[] = [];
  const visit = (df: string, chain: string[]): void => {
    if (!PATH.test(df)) throw new Error(`${show(df)} is not a plain repository path`);
    if (done.has(df)) return;
    if (chain.includes(df)) throw new Error(`${df}: its FROM chain loops`);
    const abs = join(realRoot, df);
    if (!lstatSync(abs).isFile() || !inside(realpathSync(abs))) throw new Error(`${df} is not a regular file in the repository`);
    const dir = dirname(df);
    // grype follows symlinks out of the scanned directory: none allowed in it (the checkout has none of its own).
    const link = readdirSync(join(realRoot, dir), { recursive: true, withFileTypes: true }).find((e) => e.isSymbolicLink());
    if (link) throw new Error(`${df}: ${show(join(link.parentPath, link.name).slice(realRoot.length + 1))} is a symlink; the scanned directory may hold none`);
    if (!dirs.includes(dir)) dirs.push(dir);
    const { refs, uses } = bases(readFileSync(abs, "utf8"), new Set(local.keys()));
    refs.forEach((r, i) => {
      if (r.image) images.set(r.image, [...(images.get(r.image) ?? []), { df, ...uses[i]! }]);
      else { notes.push(`${df}: ${r.local} is this repository's ${local.get(r.local!)}`); visit(local.get(r.local!)!, [...chain, df]); }
    });
    done.add(df);
  };
  for (const df of dockerfiles) visit(df, []);
  for (const ref of services) if (!images.has(ref)) images.set(ref, []);
  // Only a service ref has no uses: every Dockerfile ref carries at least one.
  return { dirs, images: [...images].map(([ref, uses]) => ({ ref, uses, ...(uses.length ? {} : { service: true }) })), notes };
}

/**
 * The paths to ignore in one image: a path whose exceptions (one or more, any of them may hold) cover every use of the
 * image, and why each other path isn't ignored.
 */
export function ignored(image: PlannedImage, exceptions: Exception[], now = Date.now()) {
  const ignore: string[] = [], vulnerabilities: string[] = [], skipped: string[] = [];
  const mine = exceptions.filter((x) => x.image === nameOf(image.ref));
  for (const e of mine.filter((x) => x.vulnerability)) {
    if (now < Date.parse(e.expires!) + 86_400_000) vulnerabilities.push(e.vulnerability!);
    else skipped.push(`${e.vulnerability} not ignored: its exception expired on ${e.expires}`);
  }
  for (const path of new Set(mine.filter((x) => x.path).map((e) => e.path))) {
    // A service image ships as its registry publishes it: no Dockerfile builds on it, so no path exception can hold.
    if (image.service) { skipped.push(`${path} not ignored: ${nameOf(image.ref)} is a module service image, published as it is`); continue; }
    const forPath = mine.filter((e) => e.path === path);
    const miss = image.uses.find((u) => !forPath.some((e) => meets(e, u)));
    if (miss) skipped.push(`${path} not ignored: ${miss.df} meets none of its conditions (${forPath.map((e) => e.when).join("; ")})`);
    else ignore.push(path!);
  }
  return { ignore, vulnerabilities, skipped };
}

function main(argv: string[]): number {
  const local = new Map<string, string>(), dockerfiles: string[] = [], services: string[] = [];
  let exceptions: Exception[] = [], accepted: { entries: Accepted[]; expired: Accepted[] } = { entries: [], expired: [] };
  try {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--") { dockerfiles.push(...argv.slice(i + 1)); break; }
      if (argv[i] === "--local") {
        const m = /^([^=]+)=(.+)$/.exec(argv[++i] ?? "");
        if (!m || !NAMED.test(m[1]!) || !PATH.test(m[2]!)) throw new Error(`--local ${show(argv[i])} is not <name>=<Dockerfile>`);
        local.set(m[1]!, m[2]!);
      } else if (argv[i] === "--service-image") {
        const ref = argv[++i] ?? "";
        if (!IMAGE.test(ref)) throw new Error(`--service-image ${show(ref)} is not a digest-pinned reference (name:tag@sha256:…)`);
        services.push(ref);
      } else if (argv[i] === "--exceptions") exceptions = readExceptions(readFileSync(argv[++i]!, "utf8"));
      else if (argv[i] === "--accepted") accepted = readAccepted(readFileSync(argv[++i]!, "utf8"));
      else throw new Error(`${show(argv[i])} is not an option; paths go after --`);
    }
  } catch (e) { console.log(`::error::${(e as Error).message}`); return 1; }
  const root = process.cwd();
  console.log("image-scan scans each image's directory (lock files, manifests), the base images its Dockerfile names and each module service image named outright, without building anything.");
  console.log("::warning::Not covered: packages that RUN steps install (apt, pip, downloads) and ADD downloads. Only base-image and lock-file changes are proven here.");
  let p: ReturnType<typeof plan>;
  try { p = plan(dockerfiles, { root, local, services }); } catch (e) { console.log(`::error::${(e as Error).message}`); return 1; }
  for (const n of p.notes) console.log(n);
  // grype runs from an empty directory, as its HOME too, with its own config and no other environment: nothing in the
  // checkout or the job (a .grype.yaml, GRYPE_* variables) configures it.
  const cwd = mkdtempSync(join(tmpdir(), "image-scan-"));
  const env = { PATH: process.env.PATH, HOME: cwd, GRYPE_DB_CACHE_DIR: process.env.GRYPE_DB_CACHE_DIR ?? join(cwd, "db") };
  if (spawnSync("grype", ["version"], { cwd, env, stdio: "ignore" }).status !== 0) {
    console.log("::error::grype is not on PATH: the CI runner image (modules/ci/runner) needs rolling");
    return 1;
  }
  let status = 0, n = 0;
  for (const e of accepted.expired) { console.log(`::error::accepted risk ${e.id} in ${e.image} expired on ${e.expires} (.github/image-scan-accepted.yaml): renew it with the owner or drop it`); status = 1; }
  const scan = (label: string, target: string, { ignore = [], vulnerabilities = [], risks = [] }: { ignore?: string[]; vulnerabilities?: string[]; risks?: string[] }, ...extra: string[]) => {
    const config = join(cwd, `grype-${++n}.yaml`);
    writeFileSync(config, JSON.stringify({ ignore: [...ignore.map((path) => ({ package: { location: path } })), ...[...vulnerabilities, ...risks].map((vulnerability) => ({ vulnerability }))] }) + "\n");
    for (const x of [...ignore, ...vulnerabilities]) console.log(`${label}: ignoring ${x} (.github/image-scan-exceptions.yaml)`);
    for (const x of risks) console.log(`${label}: accepting ${x} (.github/image-scan-accepted.yaml)`);
    // grype's output names files and packages from the repository and the images: no workflow commands inside it.
    const token = randomBytes(16).toString("hex");
    console.log(`::group::${label}`);
    console.log(`::stop-commands::${token}`);
    const r = spawnSync("grype", [target, ...extra, "--only-fixed", "--fail-on", "high", "-c", config], { cwd, env, stdio: "inherit" });
    console.log(`::${token}::`);
    console.log("::endgroup::");
    if (r.status !== 0) { console.log(`::error::${label}: fixable high or critical vulnerabilities, or the scan failed (exit ${r.status ?? r.signal})`); status = 1; }
  };
  for (const d of p.dirs) scan(`directory ${d}`, `dir:${resolve(root, d)}`, {});
  for (const i of p.images) {
    const { ignore, vulnerabilities, skipped } = ignored(i, exceptions);
    for (const s of skipped) console.log(`image ${i.ref}: ${s}`);
    scan(`image ${i.ref}`, `registry:${i.ref}`, { ignore, vulnerabilities, risks: acceptedFor(i.ref, accepted.entries) }, "--platform", "linux/amd64");
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
