// The changed files as the AI reviewer reads them (reviewer@1's `files`): the requester shapes them to the reviewer's
// budget before sending, so a request stays small whatever the files weigh, and the reviewer names its limit in its verdicts.
//
// Canonical copy: services/shared/review-files.mjs. Byte-identical copies (scripts/sync-shared.mjs): the reviewer module's
// (modules/ai-reviewer/service/src/review-files.mjs) and the code host's, whose plan shapes the files (codehost-local's too).
/** The changed files' full text the reviewer gets for context; files past the budget are named, not sent. */
export const MAX_FILES = 200_000;

/** Inert media: named to the reviewer with type and size, never escalated for being unseen. */
const MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|woff2?|ttf|otf|eot|mp3|wav|ogg|oga|flac|aac|m4a|mp4|m4v|mov|webm|avi|mkv|pdf)$/i;
/** Executables and opaque containers: always escalated, whatever their content looks like. */
const OPAQUE = /\.(so|dylib|dll|exe|bin|wasm|jar|war|class|node|o|a|pyc|zip|tar|gz|tgz|bz2|xz|zst|7z|rar|whl|deb|rpm|dmg|apk)$/i;
/** An ELF or PE header (files arrive as UTF-8 text, so only headers that survive decoding are checked). */
const EXECUTABLE = /^(\x7fELF|MZ)/;

/**
 * The changed files at the reviewed commit: [{ name, text }] in order → { text, leftOut, oversized }. Each file is sent
 * whole or named (inert media: images, fonts, audio, video, PDFs, with type and size). leftOut names only what genuinely
 * cannot be read — an executable or opaque binary, or a file never read (text null, past the read cap) — and the reviewer
 * sends the card back to the agent for those, naming each file with its size, the limit and the next step. A plain text
 * file that doesn't fit goes into oversized instead: it is named to the model with its own size and the limit, its change
 * is in the DIFF, and the verdict says it was judged from the diff. Deleted files are text undefined, skipped.
 *
 * The text returned never exceeds MAX_FILES, so the FILES fence sends it whole: 300 files with paths near git's limit cost
 * more in notes than the budget, so those names are shortened, and anything still over is counted in one closing line
 * rather than left to the fence to cut off (which would drop the last files' notes and their changes silently).
 */
export function fileContext(files) {
  const entries = files.filter((f) => f.text !== undefined).map((f) => ({ f, kind: classify(f) }));
  // Every file is accounted for by its note, and the notes are reserved before any text. One line per file is what does
  // that, but 300 files with long paths cost more than the budget on their own, so then the names are shortened.
  let notes = entries.map(({ f, kind }) => noteOf(f, kind, f.name));
  const cost = (lines) => lines.reduce((n, x) => n + x.length + 2, 0);
  if (cost(notes) > MAX_FILES) notes = entries.map(({ f, kind }) => noteOf(f, kind, shortName(f.name)));
  let left = MAX_FILES - cost(notes);
  const oversized = [];
  const shown = new Set();
  for (const [i, { f, kind }] of entries.entries()) {
    if (kind !== "text") continue;
    const extra = `#### ${f.name}\n${f.text}`.length - notes[i].length;
    if (extra > left) {
      oversized.push(`${f.name} (${f.text.length} characters)`);
      continue;
    }
    left -= extra;
    shown.add(f);
  }
  // Room for the closing line, so what is emitted plus that line still fits the budget. Anything the notes and text
  // cannot cover — only reachable when even shortened names overflow — is counted there, never dropped by the fence.
  const reserve = 200;
  const out = [];
  let used = 0;
  let omitted = 0;
  for (const [i, { f }] of entries.entries()) {
    const line = shown.has(f) ? `#### ${f.name}\n${f.text}` : notes[i];
    if (used + line.length + 2 > MAX_FILES - reserve) {
      omitted++;
      continue;
    }
    used += line.length + 2;
    out.push(line);
  }
  if (omitted) out.push(`(${out.length} of ${entries.length} changed files are named above; ${omitted} more ${omitted === 1 ? "is" : "are"} not named, over the ${MAX_FILES}-character budget for changed files, and every change is in the DIFF)`);
  // Named with what it is and its size, not the same phrase per file: a card can have many, and every one is named.
  const leftOut = entries.filter(({ kind }) => kind === "binary" || kind === "unreadable").map(({ f, kind }) => `${f.name} (${kind === "binary" ? `binary, ${Buffer.byteLength(f.text)} bytes` : "not read, size unknown"})`);
  return { text: out.join("\n\n"), leftOut, oversized };
}

/** What a changed file is, from its name and its own bytes alone. */
function classify(f) {
  if (f.text === null) return "unreadable";
  if (OPAQUE.test(f.name) || EXECUTABLE.test(f.text) || (f.text.includes("\u0000") && !MEDIA.test(f.name))) return "binary";
  return MEDIA.test(f.name) ? "media" : "text";
}

/** The note that stands in for a file the reviewer isn't shown in full, from the file's own name and size. */
function noteOf(f, kind, name = f.name) {
  if (kind === "unreadable") return `(${name}: not read, past the read cap; its content is not available)`;
  if (kind === "binary") return `(${name}: executable or opaque binary, not shown)`;
  if (kind === "media") return `(${name}: binary, not shown; ${f.name.match(MEDIA)[1].toLowerCase()} file, about ${Math.ceil(Buffer.byteLength(f.text) / 1024)} KB)`;
  const why = f.text.length > MAX_FILES ? "larger on its own than the" : "over what is left of the";
  return `(${name}: ${f.text.length}-character text file, ${why} ${MAX_FILES}-character budget for changed files; not shown in full, its change is in the DIFF)`;
}

/** A file name short enough to keep every note affordable: the repo, then the last two path segments, each cut if long. */
const shortName = (name) => {
  const [repo, ...rest] = String(name).split(" ");
  const cut = (part) => (part.length > 40 ? `${part.slice(0, 37)}…` : part);
  return `${repo} …/${String(rest.join(" ")).split("/").slice(-2).map(cut).join("/")}`;
};

