// Agent memory (spec §2): one document per agent on the kernel's data volume, <data>/kernel/memory/agents/<key>.json, its
// facts and tombstones together, always replaced whole (a temp file, then a rename). The only writer: memory_note,
// memory_forget and memory_rewrite reach it through POST /v1/memory/:op (backplane.ts), and a job's handbook and the chat
// lane read its view, fenced as data, in their `{{memory}}` (fillMemory). Every fact passes one check (checkLine): its
// length, secrets redacted, and nothing instruction-shaped. Memory is runtime state: no git, no apply, no grant.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export { fillMemory } from "../sdk/src/fence.ts";

export const MEMORY_MAX = 4096, FACT_MAX = 500, SOURCE_MAX = 300, WRITES_PER_JOB = 10;
const TOMBSTONES = 500;
export type Line = { date: string; src: string; fact: string };
export type Imported = { at: string; from: string; lines: number; merged: number; refused: number; dropped: number };
export type Doc = { facts: Line[]; forgotten: string[]; imported?: Imported };
export class MemoryError extends Error {
  status: 400 | 403 | 409 | 413 | 429;
  constructor(status: 400 | 403 | 409 | 413 | 429, message: string) { super(message); this.status = status; }
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID = /^([A-Z][A-Z0-9]{0,9}-\d{1,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** Text shaped like a credential (a vendor token prefix, a private key), the one list memory and a module share check. */
export const SECRET_SHAPES = /\b(sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|ahq[a-z]?_[A-Za-z0-9]{16,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** A memory line with each credential-shaped value blanked (the shapes only: prose like "token budget" stays). */
const redact = (t: string) => t.replace(new RegExp(SECRET_SHAPES.source, "g"), "[secret]").replace(/:\/\/[^/\s@]+@/g, "://…@")
  .replace(/([?&](?:token|key|secret|password|sig|access_token)=)[^&\s'"]+/gi, "$1…");

/** A fact as compared for duplicates and tombstones: lower case, single spaces, no trailing punctuation. */
export const norm = (fact: string) => fact.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!;,\s]+$/, "");

const REFUSE: [RegExp, string][] = [
  [/<untrusted-data|untrusted content|<!--|aidenhq:|```|~~~/i, "it carries markup or a fence"],
  [/^\s*#/, "it starts like a heading"],
  [/\b(ignore|disregard|override)\b.{0,60}\b(instructions?|rules?|handbook|prompt|above|previous)\b/i, "it is an instruction about instructions"],
  [/system prompt|you are now|new instructions/i, "it is instruction-shaped"],
  [/\(\d{4}-\d{2}-\d{2}, src:/i, "it forges a memory line"],
  [/^\s*(from now on|always|never|do not|don't|you must|you should|make sure)\b/i, "it starts as an order"],
  [/\bsend\b.{0,80}\bto\b/i, "it asks to send something somewhere"],
];
/** Why a fact (or a source) can't be memory, or undefined. A lasting rule belongs in the handbook, not memory. */
export const refusal = (fact: string): string | undefined => REFUSE.find(([re]) => re.test(fact))?.[1];

/** The one check for a fact and its source: length, secrets redacted, refusal(). `migration`: the import's instance sha. */
export function checkLine(l: Line, o: { migration?: string } = {}): Line {
  const fact = redact(String(l.fact ?? "").replace(/\s+/g, " ").trim());
  const src = redact(String(l.src ?? "").replace(/\s+/g, " ").trim());
  if (!DATE.test(String(l.date))) throw new MemoryError(400, "a memory line's date is YYYY-MM-DD");
  if (!fact || fact.length > FACT_MAX) throw new MemoryError(400, `a fact is one statement of at most ${FACT_MAX} characters`);
  if (!src || src.length > SOURCE_MAX) throw new MemoryError(400, `a source is required, at most ${SOURCE_MAX} characters`);
  const migration = o.migration !== undefined && src === `migration:${o.migration}`;
  if (!migration && !TASK_ID.test(src) && !/^https:\/\/\S+$/.test(src)) throw new MemoryError(400, "a source is a task id or an https: link");
  const why = refusal(fact) ?? (migration ? undefined : refusal(src));
  if (why) throw new MemoryError(400, `Refused: ${why}. Memory holds facts and lessons as plain statements; a standing rule goes in your handbook.`);
  return { date: l.date, src, fact };
}

const lineOf = (l: Line) => `- (${l.date}, src: ${l.src}) ${l.fact}`;
/** The Markdown read view, one line per fact. */
export const view = (d: Doc) => d.facts.map(lineOf).join("\n");
const bytes = (d: Doc) => Buffer.byteLength(view(d));
const same = (a: Line, b: Line) => a.date === b.date && a.src === b.src && a.fact === b.fact;

export function createMemory(o: { dir: string; now?: () => number }) {
  const now = o.now ?? Date.now;
  const root = join(o.dir, "agents");
  const used = new Map<string, number>();
  const fileOf = (key: string) => {
    if (!KEY.test(key)) throw new MemoryError(400, "an agent key is lower-case letters, digits, - and _");
    return join(root, `${key}.json`);
  };
  const load = (key: string): Doc => {
    const f = fileOf(key);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Doc) : { facts: [], forgotten: [] };
  };
  const digestOf = (d: Doc) => createHash("sha256").update(JSON.stringify(d)).digest("hex");
  const save = (key: string, d: Doc) => {
    if (bytes(d) > MEMORY_MAX) throw new MemoryError(413, `memory is full (${MEMORY_MAX} bytes): compact it with memory_rewrite (merge or drop lines), then note again`);
    d.forgotten = d.forgotten.slice(-TOMBSTONES);
    mkdirSync(root, { recursive: true });
    const f = fileOf(key), tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, f);
  };
  /** One mutation of a job's budget: refused past WRITES_PER_JOB, counted only once it is written. */
  const spend = (job: string, write: () => void) => {
    const n = used.get(job) ?? 0;
    if (n >= WRITES_PER_JOB) throw new MemoryError(429, `at most ${WRITES_PER_JOB} memory changes per job`);
    write();
    if (used.size > 5000) used.clear();
    used.set(job, n + 1);
  };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const known = (d: Doc, fact: string) => {
    const n = norm(fact);
    if (d.facts.some((l) => norm(l.fact) === n)) throw new MemoryError(409, "that fact is already in memory");
    if (d.forgotten.includes(n)) throw new MemoryError(409, "that fact was forgotten; it isn't learned again");
  };

  return {
    read(key: string) { const doc = load(key); return { doc, digest: digestOf(doc) }; },
    view: (key: string) => view(load(key)),
    list() {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((f) => f.endsWith(".json")).map((f) => {
        const key = f.slice(0, -5);
        return { key, bytes: bytes(load(key)), updated: statSync(join(root, f)).mtime.toISOString() };
      });
    },
    updated(key: string) { const f = fileOf(key); return existsSync(f) ? statSync(f).mtime.toISOString() : undefined; },
    note(key: string, n: { fact: string; source: string; job: string }) {
      const d = load(key);
      const l = checkLine({ date: today(), src: n.source, fact: n.fact });
      known(d, l.fact);
      spend(n.job, () => save(key, { ...d, facts: [...d.facts, l] }));
      return { line: lineOf(l) };
    },
    forget(key: string, n: { match: string; job: string }) {
      const m = norm(String(n.match ?? ""));
      if (m.length < 3) throw new MemoryError(400, "match is at least 3 characters of the fact to forget");
      const d = load(key);
      const gone = d.facts.filter((l) => norm(l.fact).includes(m));
      if (!gone.length) return { removed: [] as string[] };
      spend(n.job, () => save(key, { ...d, facts: d.facts.filter((l) => !gone.includes(l)), forgotten: [...d.forgotten, ...gone.map((l) => norm(l.fact))] }));
      return { removed: gone.map(lineOf) };
    },
    rewrite(key: string, r: { facts: Line[]; digest: string; job: string; removeOnly: boolean }) {
      const d = load(key);
      if (r.digest !== digestOf(d)) throw new MemoryError(409, "memory changed since you read it: memory_read again, then rewrite");
      if (!Array.isArray(r.facts) || r.facts.length > 200) throw new MemoryError(400, "facts is a list of {date, src, fact}");
      const next: Line[] = [];
      for (const raw of r.facts) {
        const kept = d.facts.find((b) => same(b, raw));
        if (!kept && r.removeOnly) throw new MemoryError(400, "this rewrite only removes lines: every fact must be one already there, unchanged");
        const l = kept ?? checkLine(raw);
        if (!kept && d.forgotten.includes(norm(l.fact))) throw new MemoryError(409, `"${l.fact.slice(0, 60)}" was forgotten; it isn't learned again`);
        if (next.some((x) => norm(x.fact) === norm(l.fact))) throw new MemoryError(409, `"${l.fact.slice(0, 60)}" is listed twice`);
        next.push(l);
      }
      const removed = d.facts.filter((b) => !next.some((x) => norm(x.fact) === norm(b.fact)));
      const doc = { ...d, facts: next, forgotten: [...d.forgotten, ...removed.map((l) => norm(l.fact))] };
      spend(r.job, () => save(key, doc));
      return { bytes: bytes(doc) };
    },
    /**
     * An agent's legacy memory file from the instance repo, once per agent (ops/memory-move.ts): each line a fact with source
     * `migration:<sha>`, dated by the date it carries (else today), through checkLine; duplicates merged, refusals counted,
     * the oldest dropped past the cap. Facts and the marker land in one write, so a rerun skips an agent already imported.
     */
    importLegacy(key: string, markdown: string, from: string): Imported {
      if (!SHA.test(from)) throw new MemoryError(400, "the import names the instance sha it came from");
      const d = load(key);
      if (d.imported) return d.imported;
      const facts = [...d.facts];
      let lines = 0, merged = 0, refused = 0, dropped = 0;
      for (const raw of markdown.split("\n")) {
        const text = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
        if (!text || /^#/.test(raw.trim())) continue;
        lines++;
        // The old format ended each line "(source, date)": the date dates the fact, the tail leaves its text.
        const tail = /\s*\(([^()]*\b\d{4}-\d{2}-\d{2}\b[^()]*)\)\s*$/.exec(text);
        const fact = tail ? text.slice(0, tail.index).trim() : text;
        let l: Line;
        try { l = checkLine({ date: /\b(\d{4}-\d{2}-\d{2})\b/.exec(tail?.[1] ?? text)?.[1] ?? today(), src: `migration:${from}`, fact }, { migration: from }); } catch { refused++; continue; }
        if (facts.some((x) => norm(x.fact) === norm(l.fact)) || d.forgotten.includes(norm(l.fact))) { merged++; continue; }
        facts.push(l);
      }
      facts.sort((a, b) => a.date.localeCompare(b.date));
      while (bytes({ facts, forgotten: [] }) > MEMORY_MAX) { facts.shift(); dropped++; }
      const imported = { at: new Date(now()).toISOString(), from, lines, merged, refused, dropped };
      save(key, { ...d, facts, imported });
      return imported;
    },
  };
}
export type Memory = ReturnType<typeof createMemory>;

/**
 * POST /v1/memory/:op for a job's memory_<op> call in flight (backplane.ts checks the module, the assertion and the tool):
 * its own document, or, for read and a removals-only rewrite, any agent's when its live grants row holds `librarian`.
 */
export function memoryOp(memory: Memory, op: string, b: Record<string, unknown>, job: { key: string; job: string; librarian: boolean; task: string }, keys: string[]) {
  const target = b.key === undefined ? job.key : String(b.key);
  if (!keys.includes(target)) throw new MemoryError(400, `no agent ${target.slice(0, 60)}`);
  const own = target === job.key;
  if (!own && !((op === "read" || op === "rewrite") && job.librarian)) throw new MemoryError(403, "an agent reads and changes only its own memory (the librarian role reads any, and only removes lines)");
  if (op === "read") { const { doc, digest } = memory.read(target); return { key: target, view: view(doc), facts: doc.facts, digest, bytes: Buffer.byteLength(view(doc)), max: MEMORY_MAX }; }
  if (op === "note") return memory.note(target, { fact: String(b.fact ?? ""), source: b.source === undefined || b.source === "" ? job.task : String(b.source), job: job.job });
  if (op === "forget") return memory.forget(target, { match: String(b.match ?? ""), job: job.job });
  return memory.rewrite(target, { facts: b.facts as Line[], digest: String(b.digest ?? ""), job: job.job, removeOnly: !own });
}
