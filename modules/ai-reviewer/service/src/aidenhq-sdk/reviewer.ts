// reviewer@1 (spec §3.3.3): the AI reviewer is a module the kernel calls; a requester never runs it in its own process.
//   requester → kernel  POST /v1/reviews { request } (the runner's reviewer key) → the verdict, once the module sends it
//   kernel → module     POST <url>/review { id, token, model_token, request } (the module's service key) → { accepted: true }
//   module → kernel     POST /v1/reviews/:id <verdict> | { error } (Bearer: that review's token, once: it burns on use)
// The module calls models through the gateway with `model_token` (a reviewer token the kernel minted for this review), never a
// vendor key. It can't change a tier: the verdict is the requester's input, and the records bind it to their digest.
//
// Deviations from the spec's sketch, kept until 3b moves review orchestration into the kernel: one dispatch carries the panel
// (`request.panel`) and the module runs it itself, so the second reviewer is asked only after a first approve, and an unsure
// first hands its note to the second (both as before); the verdict is today's shape (decision, code, reason, model, second,
// flag), and `panel_marked` says the first reviewer called the change authority-expanding, so the requester records that on
// its card before acting on the verdict.
//
// The requester shapes the changed files with `fileContext` (the contract's budget), so the request stays small whatever
// the files weigh.
//
// Canonical copy: kernel/sdk/src/reviewer.ts. The reviewer module holds a byte-identical copy at src/aidenhq-sdk/reviewer.ts:
// edit this one, then run `node scripts/sync-shared.mjs`.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ReviewCard { action: string; rule: string; target?: string; sentence?: string; reason?: string }
export interface Files { text: string; leftOut: string[]; oversized: string[] }
export interface SourceRecords { where: string; records: Record<string, unknown>[] }
/** One Tier 1 request as the reviewer reads it. Everything but `card.action`, `card.rule` and `panel` is data an agent or a stranger wrote. */
export interface ReviewRequest {
  card: ReviewCard; diff: string; files?: Files; chain?: string; siblings?: string; sources?: SourceRecords;
  requesterModel?: string; panel?: boolean; previous?: string[]; relift?: string;
  /** The ledger's name for the model calls (the card's review, or an agent's check before filing). */
  component?: string;
}
export interface Verdict { decision: "approve" | "reject" | "escalate"; code?: string; reason: string; model: string; second?: string; flag?: boolean; panel_marked?: boolean }
/** The model's "I can't tell" (a second reviewer decides; both unsure, the request goes back to the agent). */
export const UNSURE = "reviewer_unsure";
/** The request fields a reviewer reads; anything else in a request (a policy, a model) is dropped. */
export const REQUEST_FIELDS = ["card", "diff", "files", "chain", "siblings", "sources", "requesterModel", "panel", "previous", "relift"] as const;

/** The changed files' full text the reviewer gets for context; files past the budget are named, not sent. */
export const MAX_FILES = 200_000;

/** Inert media: named to the reviewer with type and size, never escalated for being unseen. */
const MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|woff2?|ttf|otf|eot|mp3|wav|ogg|oga|flac|aac|m4a|mp4|m4v|mov|webm|avi|mkv|pdf)$/i;
/** Executables and opaque containers: always escalated, whatever their content looks like. */
const OPAQUE = /\.(so|dylib|dll|exe|bin|wasm|jar|war|class|node|o|a|pyc|zip|tar|gz|tgz|bz2|xz|zst|7z|rar|whl|deb|rpm|dmg|apk)$/i;
/** An ELF or PE header (files arrive as UTF-8 text, so only headers that survive decoding are checked). */
const EXECUTABLE = /^(\x7fELF|MZ)/;

type File = { name: string; text?: string | null };
type Kind = "unreadable" | "binary" | "media" | "text";

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
export function fileContext(files: File[]): Files {
  const entries = files.filter((f) => f.text !== undefined).map((f) => ({ f, kind: classify(f) }));
  // Every file is accounted for by its note, and the notes are reserved before any text. One line per file is what does
  // that, but 300 files with long paths cost more than the budget on their own, so then the names are shortened.
  let notes = entries.map(({ f, kind }) => noteOf(f, kind, f.name));
  const cost = (lines: string[]) => lines.reduce((n, x) => n + x.length + 2, 0);
  if (cost(notes) > MAX_FILES) notes = entries.map(({ f, kind }) => noteOf(f, kind, shortName(f.name)));
  let left = MAX_FILES - cost(notes);
  const oversized: string[] = [];
  const shown = new Set<File>();
  for (const [i, { f, kind }] of entries.entries()) {
    if (kind !== "text") continue;
    const extra = `#### ${f.name}\n${f.text}`.length - notes[i]!.length;
    if (extra > left) {
      oversized.push(`${f.name} (${f.text!.length} characters)`);
      continue;
    }
    left -= extra;
    shown.add(f);
  }
  // Room for the closing line, so what is emitted plus that line still fits the budget. Anything the notes and text
  // cannot cover — only reachable when even shortened names overflow — is counted there, never dropped by the fence.
  const reserve = 200;
  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const [i, { f }] of entries.entries()) {
    const line = shown.has(f) ? `#### ${f.name}\n${f.text}` : notes[i]!;
    if (used + line.length + 2 > MAX_FILES - reserve) {
      omitted++;
      continue;
    }
    used += line.length + 2;
    out.push(line);
  }
  if (omitted) out.push(`(${out.length} of ${entries.length} changed files are named above; ${omitted} more ${omitted === 1 ? "is" : "are"} not named, over the ${MAX_FILES}-character budget for changed files, and every change is in the DIFF)`);
  // Named with what it is and its size, not the same phrase per file: a card can have many, and every one is named.
  const leftOut = entries.filter(({ kind }) => kind === "binary" || kind === "unreadable").map(({ f, kind }) => `${f.name} (${kind === "binary" ? `binary, ${Buffer.byteLength(f.text!)} bytes` : "not read, size unknown"})`);
  return { text: out.join("\n\n"), leftOut, oversized };
}

/** What a changed file is, from its name and its own bytes alone. */
function classify(f: File): Kind {
  if (f.text === null) return "unreadable";
  const text = f.text!;
  if (OPAQUE.test(f.name) || EXECUTABLE.test(text) || (text.includes("\u0000") && !MEDIA.test(f.name))) return "binary";
  return MEDIA.test(f.name) ? "media" : "text";
}

/** The note that stands in for a file the reviewer isn't shown in full, from the file's own name and size. */
function noteOf(f: File, kind: Kind, name = f.name): string {
  if (kind === "unreadable") return `(${name}: not read, past the read cap; its content is not available)`;
  if (kind === "binary") return `(${name}: executable or opaque binary, not shown)`;
  if (kind === "media") return `(${name}: binary, not shown; ${f.name.match(MEDIA)![1]!.toLowerCase()} file, about ${Math.ceil(Buffer.byteLength(f.text!) / 1024)} KB)`;
  const why = f.text!.length > MAX_FILES ? "larger on its own than the" : "over what is left of the";
  return `(${name}: ${f.text!.length}-character text file, ${why} ${MAX_FILES}-character budget for changed files; not shown in full, its change is in the DIFF)`;
}

/** A file name short enough to keep every note affordable: the repo, then the last two path segments, each cut if long. */
const shortName = (name: string) => {
  const [repo, ...rest] = String(name).split(" ");
  const cut = (part: string) => (part.length > 40 ? `${part.slice(0, 37)}…` : part);
  return `${repo} …/${String(rest.join(" ")).split("/").slice(-2).map(cut).join("/")}`;
};

/** The module's reviewer: one request in, one verdict out. `onPanel` records that the change needs a second reviewer. */
export type Review = (req: ReviewRequest, ctx: { modelToken: string; onPanel: () => Promise<void> }) => Promise<Verdict>;

/**
 * A handler for POST `<path>/review`: answers and returns true, or returns false for any other path. It accepts at once and
 * sends the verdict to the kernel with the review's token (retried; a verdict the kernel no longer waits for is dropped).
 * A reviewer that throws sends `{ error }`: the requester counts it as a failed review (reviewer_failed) and tries again later.
 */
export function serveReviewer(review: Review, { key, kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", path = "/aidenhq/v1/reviewer", log = () => {} }: {
  key: string; kernelUrl?: string; path?: string; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  async function deliver(id: string, token: string, v: Verdict | { error: string }) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${kernelUrl}/v1/reviews/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(v), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r && (r.ok || r.status === 404 || r.status === 401)) return;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
    log("verdict not delivered", { id });
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (String(req.url ?? "") !== `${path}/review`) return false;
    if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
    if (!keyed(req)) return send(res, 401, { error: "unauthorized" }), true;
    let body: { id?: unknown; token?: unknown; model_token?: unknown; request?: Record<string, unknown> };
    try {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > 64_000_000) throw new Error("too large"); chunks.push(c); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
    const id = String(body.id ?? ""), token = String(body.token ?? ""), modelToken = String(body.model_token ?? "");
    if (!/^r-[0-9a-f]{16}$/.test(id) || !token || !modelToken || !body.request || typeof body.request !== "object") return send(res, 400, { error: "send {id, token, model_token, request}" }), true;
    // Only the fields a reviewer reads, each only when the requester sent it: an absent field keeps the reviewer's default.
    const request = Object.fromEntries(REQUEST_FIELDS.filter((k) => body.request![k] !== undefined).map((k) => [k, body.request![k]])) as unknown as ReviewRequest;
    send(res, 202, { accepted: true });
    let marked = false;
    const v = await review(request, { modelToken, onPanel: async () => { marked = true; } }).catch((e: Error) => ({ error: String(e.message ?? e).slice(0, 300) }));
    await deliver(id, token, "error" in v ? v : { ...v, ...(marked ? { panel_marked: true } : {}) });
    return true;
  };
}
