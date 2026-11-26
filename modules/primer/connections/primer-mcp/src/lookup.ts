// The small reads an approval card needs to name its target (a document's title, a thread's first comment), each bounded:
// the kernel plans a write under its own 30 s deadline and plans the record again just before execution, so a cosmetic
// read must never hold either up (a card that times out is never filed). What was read is kept, bounded, so the second plan
// reuses it instead of reading again: the same record must name the same document twice.
export type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

/** How long a card's lookup may take: well inside the kernel's plan deadline (writes.ts), and past any real Primer read. */
export const LOOKUP_MS = 3_000;
/** What each small cache keeps: far more than the records planned in one go, never unbounded. */
const KEEP = 500;

/** `p` answered within `ms`, else undefined. A late answer still settles harmlessly: a lookup changes nothing. */
export async function within<T>(p: Promise<T | undefined>, ms = LOOKUP_MS): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((settle) => { timer = setTimeout(() => settle(undefined), ms); });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The parsed JSON of a tool's answer, or undefined when it isn't one (a fenced or plain-text answer counts as no answer). */
export function parsed(text: string | undefined): any {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Sets a cache entry, dropping the oldest past `KEEP` (insertion order: a Map keeps it). */
export function keep<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.set(k, v);
  if (m.size > KEEP) m.delete(m.keys().next().value!);
}

const titles = new Map<string, string>();

/**
 * A document's title from primer_get_document, or undefined when Primer doesn't answer with one in time (or at all).
 * `reuse` (the kernel's revalidation plan) reads nothing: it names the document from what the filing plan read, if it did.
 * The cache only spares that second read; a filing always reads, so a renamed document is named as it is now.
 */
export async function titleOf(call: Call, id: string, reuse = false): Promise<string | undefined> {
  if (reuse) return titles.get(id);
  const r = await within(call("primer_get_document", { documentId: id }).catch(() => undefined));
  const j = r && !r.isError ? parsed(r.text) : undefined;
  const t = j?.title ?? j?.document?.title;
  if (typeof t !== "string" || !t.trim()) return undefined;
  keep(titles, id, t.trim());
  return t.trim();
}

/** What a card can say about one comment thread: its document's title, and the first comment quoted, both optional. */
export type Thread = { has: boolean; title?: string; excerpt?: string };
/** Only what a card says (its title and quote): never `has`, which decides the tier and is read live at every filing. */
const threads = new Map<string, Omit<Thread, "has">>();

/**
 * A thread's document title and first comment, from primer_get_document and primer_get_comments (both bounded, read side by
 * side). `has` is the comment check's own answer of this read: the comments array holds a comment whose `thread_id` is exactly
 * this thread. `reuse` (the kernel's revalidation plan) reads nothing, and answers `has: false` (its tier is already decided).
 */
export async function threadOf(call: Call, documentId: string, threadId: string, reuse = false): Promise<Thread> {
  const key = `${documentId}|${threadId}`;
  if (reuse) return { has: false, ...threads.get(key) };
  const [doc, comments] = await Promise.all([
    within(call("primer_get_document", { documentId }).catch(() => undefined)),
    within(call("primer_get_comments", { documentId }).catch(() => undefined)),
  ]);
  const j = doc && !doc.isError ? parsed(doc.text) : undefined;
  const t = j?.title ?? j?.document?.title;
  const answer = comments && !comments.isError ? parsed(comments.text) : undefined;
  const list: any[] = Array.isArray(answer?.comments) ? answer.comments : [];
  const first = list.find((c) => c?.thread_id === threadId);
  const said = first?.quote ?? first?.body ?? first?.text;
  const named: Omit<Thread, "has"> = {
    ...(typeof t === "string" && t.trim() ? { title: t.trim() } : {}),
    ...(typeof said === "string" && said.trim() ? { excerpt: few(said) } : {}),
  };
  keep(threads, key, named);
  return { has: Boolean(first), ...named };
}

/** A comment's words, one line, about 160 characters: enough to tell two threads apart, never the whole document. */
export const few = (t: string, max = 160) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};
