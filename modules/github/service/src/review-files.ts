// The changed files as the AI reviewer reads them (reviewer@1's `files`): the requester reads each changed file at the
// reviewed commit and sends it whole, whatever its size; the reviewer shows what fits inline and reads the rest with its tools.
//
// Canonical copy: services/shared/review-files.ts. Byte-identical copies (scripts/sync-shared.ts): the reviewer module's
// (modules/ai-reviewer/service/src/review-files.ts) and the code host's, whose plan reads the files (codehost-local's too).

/** Inert media: named to the reviewer with type and size, never escalated for being unseen. Only a file that decodes as binary
 * (a NUL or invalid UTF-8) counts: plain text under a media name is shown like any other file. */
const MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|woff2?|ttf|otf|eot|mp3|wav|ogg|oga|flac|aac|m4a|mp4|m4v|mov|webm|avi|mkv|pdf)$/i;
/** Executables and opaque containers: always escalated, whatever their content looks like. */
const OPAQUE = /\.(so|dylib|dll|exe|bin|wasm|jar|war|class|node|o|a|pyc|zip|tar|gz|tgz|bz2|xz|zst|7z|rar|whl|deb|rpm|dmg|apk)$/i;
/** An ELF or PE header (files arrive as UTF-8 text, so only headers that survive decoding are checked). */
const EXECUTABLE = /^(\x7fELF|MZ)/;

/** A changed file: text is undefined when deleted. */
interface ChangedFile { name: string; text?: string }
/** A changed file as the reviewer reads it: plain text whole, or code's note naming what it is and its size. */
export interface FileEntry { name: string; text?: string; note?: string }

/**
 * The changed files at the reviewed commit: [{ name, text }] in order → { list, leftOut }. Plain text goes whole; inert media
 * (images, fonts, audio, video, PDFs) is a note with type and size; an executable or opaque binary is a note and is named in
 * leftOut, which sends the card back to the agent (the reviewer can't read it). Deleted files (text undefined) are skipped.
 */
export function fileContext(files: ChangedFile[]): { list: FileEntry[]; leftOut: string[] } {
  const list: FileEntry[] = [];
  const leftOut: string[] = [];
  for (const f of files) {
    if (f.text === undefined) continue;
    if (OPAQUE.test(f.name) || EXECUTABLE.test(f.text) || (f.text.includes("\u0000") && !MEDIA.test(f.name))) {
      list.push({ name: f.name, note: `(${f.name}: executable or opaque binary, not shown)` });
      leftOut.push(`${f.name} (binary, ${Buffer.byteLength(f.text)} bytes)`);
    } else if (MEDIA.test(f.name) && /[\u0000\uFFFD]/.test(f.text)) list.push({ name: f.name, note: `(${f.name}: binary, not shown; ${f.name.match(MEDIA)![1]!.toLowerCase()} file, about ${Math.ceil(Buffer.byteLength(f.text) / 1024)} KB)` });
    else list.push({ name: f.name, text: f.text });
  }
  return { list, leftOut };
}

/**
 * The code host's own count of what a change touches (`git diff --numstat --text --no-renames`, run at filing beside the
 * diff): [{ path, add, del }]. The reviewer checks the diff it was sent against it (sameChanges) before any model reads it.
 */
export function numstat(text: string | null | undefined) {
  return String(text ?? "").split("\n").filter(Boolean).map((l) => {
    const [add, del, ...path] = l.split("\t");
    // A binary file is counted "-" "-": its path is checked, not its lines.
    return { path: path.join("\t"), ...(add === "-" ? {} : { add: Number(add), del: Number(del) }) };
  });
}

/** A path as git quotes it (C escapes, octal bytes), read back. */
function unquote(p: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, "\\": 92, '"': 34 };
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== "\\") { bytes.push(...Buffer.from(p[i]!)); continue; }
    const oct = /^[0-7]{3}/.exec(p.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; } else { bytes.push(esc[p[i + 1]!] ?? p.charCodeAt(i + 1)); i += 1; }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The files a diff changes, each with the lines it adds and removes, read from its own `diff --git` headers and hunks. */
export function diffFiles(diff: string | null | undefined) {
  const out: { path: string; add: number; del: number }[] = [];
  let hunk = false;
  for (const l of String(diff ?? "").split("\n")) {
    // No renames, so both sides name the same path (which may hold spaces). Git quotes a path with special characters
    // ("a/caf\303\251.txt"): read back to the path itself.
    const q = /^diff --git "a\/((?:[^"\\]|\\.)*)" "b\/(?:[^"\\]|\\.)*"$/.exec(l);
    const m = q ? [l, unquote(q[1]!)] : /^diff --git a\/(.+) b\/\1$/.exec(l) ?? /^diff --git a\/\S+ b\/(\S+)/.exec(l);
    if (m) {
      out.push({ path: m[1]!, add: 0, del: 0 });
      hunk = false;
    } else if (l.startsWith("@@")) hunk = true;
    else if (hunk && out.length && l.startsWith("+")) out.at(-1)!.add++;
    else if (hunk && out.length && l.startsWith("-")) out.at(-1)!.del++;
  }
  return out;
}

/**
 * Where a diff differs from the code host's count of the change (`changed`, numstat): one line per file missing, extra or
 * with other line counts. Empty: the diff is the whole change.
 */
export function sameChanges(changed: { path: string; add?: number; del?: number }[], diff: string) {
  const key = (f: { path: string; add?: number; del?: number }) => (f.add === undefined ? f.path : `${f.path} (+${f.add} -${f.del})`);
  const binary = new Set(changed.filter((f) => f.add === undefined).map((f) => f.path));
  const want = changed.map(key).sort(), got = diffFiles(diff).map((f) => (binary.has(f.path) ? f.path : key(f))).sort();
  const left = [...got];
  const missing = want.filter((k: string) => { const i = left.indexOf(k); return i < 0 || (left.splice(i, 1), false); });
  return [...missing.map((k: string) => `in the change, not the diff: ${k}`), ...left.map((k: string) => `in the diff, not the change: ${k}`)];
}
