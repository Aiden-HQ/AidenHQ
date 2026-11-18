// The comment wake loop: one outbound SSE subscription to Primer's caller-scoped event stream (GET /api/events/stream?scope=me,
// resumed with Last-Event-ID). A primer.comment.created on a document an agent published (the ownership map, from publish
// receipts) wakes that agent's task with a fixed notice naming only the document, thread and comment ids (never the body: the
// agent reads it through the fenced Primer tools). Dispatch delivers the notice into the agent's live run, or starts the next.
//
// - Echo: the connector acts as the owner in Primer, so its own replies arrive as comments too. Every connector write runs
//   through guard(), which records the comment ids its receipt names; events are held while a write is in flight (the event
//   can beat the receipt), then checked against those ids. Never by author.
// - Closed task: the kernel answers {closed}; the connector files one "Revisions: <title>" task for the owning agent (kernel
//   tasks route, keyed by the document so a retry is the same task), keeps it in its state and wakes that next time.
// - Batches: comments not yet covered by a version are pending; a version the connector publishes covers the comments that
//   were pending when its write started (one arriving mid-publish waits for the next batch).
// - Durable: processed comment ids are stored once their wake is accepted, the stream cursor only after its event is handled,
//   so a restart replays without a second wake.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Owner { task: string; agent: string }
export interface Kernel {
  /** POST /v1/wakes {task, text}: {posted} or {closed} for a done or cancelled task. */
  wake(task: string, text: string): Promise<{ posted?: boolean; closed?: boolean }>;
  /** POST /v1/tasks: a task for an agent (by id), idempotent by source. */
  file(b: { title: string; description: string; agent: string; source: string; parent?: string }): Promise<{ id: string; identifier?: string }>;
}
interface DocState { pending: string[]; batches: { version?: string; comments: string[] }[]; revisions?: { task: string; n: number } }
interface State { cursor?: string; created: string[]; processed: string[]; docs: Record<string, DocState> }
type Log = (msg: string, f?: Record<string, unknown>) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[\w:.-]{1,200}$/;
const KEEP = 5000; // ids remembered (created, processed): far more than a stream replays
const id = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);

/** The comment ids a write's receipt names (JSON anywhere in the text: comment_id / commentId, or a reply's {comment: {id}}). */
export function createdIds(text: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key = ""): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "comment_id" || k === "commentId") && id(x)) out.add(x as string);
      else if (k === "id" && /comment/i.test(key) && id(x)) out.add(x as string);
      else walk(x, k);
    }
  };
  for (const m of text.matchAll(/\{[\s\S]*\}/g)) { try { walk(JSON.parse(m[0])); } catch { /* not JSON */ } }
  return [...out];
}

/** The fixed notice: ids only. */
export const notice = (doc: string, thread: string | undefined, comment: string, pending: number) =>
  `New comment on Primer document ${doc} (thread ${thread ?? "unknown"}, comment ${comment}; ${pending} comment${pending === 1 ? "" : "s"} not yet addressed by a version). Read the open threads with the Primer tools and revise as the primer-docs skill says.`;

export function createSubscriber(o: {
  /** Primer's origin (self-hosted http://primer-server:3000, or the hosted MCP address's origin). */
  primer: string;
  /** The connector's sign-in to Primer (the service token, or the owner's OAuth); throws while there is none. */
  headers: () => Promise<Record<string, string>>;
  kernel: Kernel;
  /** The ownership map (publish receipts): who published a document, on which task. */
  owner: (documentId: string) => Owner | undefined;
  stateFile: string;
  log: Log;
  fetch?: typeof fetch;
}) {
  const f = o.fetch ?? fetch;
  const st: State = existsSync(o.stateFile) ? { created: [], processed: [], docs: {}, ...JSON.parse(readFileSync(o.stateFile, "utf8")) } : { created: [], processed: [], docs: {} };
  const save = () => {
    st.created = st.created.slice(-KEEP);
    st.processed = st.processed.slice(-KEEP);
    writeFileSync(`${o.stateFile}.tmp`, JSON.stringify(st));
    renameSync(`${o.stateFile}.tmp`, o.stateFile);
  };
  const doc = (d: string) => (st.docs[d] ??= { pending: [], batches: [] });
  let inflight = 0;
  let drained: (() => void)[] = [];
  const idle = () => (inflight ? new Promise<void>((r) => drained.push(r)) : Promise.resolve());

  /**
   * Runs one connector write (a version, a thread reply). Events wait until it returns; the comment ids its receipt names are
   * the connector's own. A version (primer_add_version with documentId) covers the comments pending when it started.
   */
  async function guard<T extends { text: string; isError?: boolean }>(tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    const d = typeof args.documentId === "string" ? args.documentId : undefined;
    const covers = tool === "primer_add_version" && d ? [...doc(d).pending] : [];
    inflight++;
    try {
      const r = await run();
      if (!r.isError) {
        st.created.push(...createdIds(r.text));
        if (d && tool === "primer_add_version") {
          const s = doc(d);
          s.batches.push({ version: /"version_?[iI]d"\s*:\s*"([\w-]+)"/.exec(r.text)?.[1], comments: covers });
          s.batches = s.batches.slice(-50);
          s.pending = s.pending.filter((c) => !covers.includes(c));
        }
        save();
      }
      return r;
    } finally {
      if (--inflight === 0) { const w = drained; drained = []; w.forEach((r) => r()); }
    }
  }

  async function revisions(d: string, own: Owner, closedTask?: string): Promise<{ task: string; fresh: boolean }> {
    const s = doc(d);
    if (s.revisions && s.revisions.task !== closedTask) return { task: s.revisions.task, fresh: false };
    const n = (s.revisions?.n ?? 0) + (s.revisions ? 1 : 0);
    let title = `document ${d}`;
    try {
      const r = await f(`${o.primer}/api/documents/${encodeURIComponent(d)}`, { headers: await o.headers(), signal: AbortSignal.timeout(10_000) });
      const t = r.ok ? ((await r.json()) as { title?: unknown }).title : undefined;
      if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 150);
    } catch { /* the id is title enough */ }
    const t = await o.kernel.file({
      title: `Revisions: ${title}`,
      description: `People are commenting on Primer document ${d}, which you published on a task that is now closed. Revisions for it come here.\n\n${notice(d, undefined, "(see the open threads)", s.pending.length)}`,
      agent: own.agent, source: `primer-revisions:${d}:${n}`, ...(UUID.test(own.task) ? { parent: own.task } : {}),
    });
    s.revisions = { task: t.id, n };
    save();
    return { task: t.id, fresh: true };
  }

  /** One primer.comment.created: at most one wake, none for the connector's own comment or an unmapped document. */
  async function comment(p: Record<string, unknown>) {
    const d = id(p.document_id), c = id(p.comment_id), thread = id(p.thread_id);
    if (!d || !c) return;
    await idle();
    if (st.created.includes(c) || st.processed.includes(c)) return;
    const own = o.owner(d);
    if (!own) return;
    const s = doc(d);
    if (!s.pending.includes(c)) s.pending.push(c);
    const text = notice(d, thread, c, s.pending.length);
    let target = s.revisions?.task ?? own.task;
    let r = await o.kernel.wake(target, text);
    if (r.closed) {
      const rev = await revisions(d, own, s.revisions ? target : undefined);
      target = rev.task;
      // A new Revisions task starts its agent by itself (its description is the notice); a reused one gets the notice.
      if (!rev.fresh) r = await o.kernel.wake(target, text);
      else r = { posted: true };
      if (r.closed) throw new Error(`the Revisions task ${target} for document ${d} is closed right after filing`);
    }
    st.processed.push(c);
    save();
    o.log("comment wake", { document: d, thread, comment: c, task: target });
  }

  /** Handles one stream event (exported for the stream loop and tests); the cursor moves only after it. */
  async function handle(ev: { id?: string; type: string; data: Record<string, unknown> }) {
    if (ev.type === "primer.comment.created") await comment(ev.data);
    if (ev.id) { st.cursor = ev.id; save(); }
  }

  /** The SSE loop: reconnects with backoff (a Primer without the stream, 404, waits quietly); stops on stop(). */
  let stopped = false, ctl: AbortController | undefined;
  async function run() {
    let wait = 1000;
    while (!stopped) {
      try {
        const auth = await o.headers().catch((e) => { throw Object.assign(e as Error, { quiet: true }); }); // not signed in yet: wait
        ctl = new AbortController();
        const res = await f(`${o.primer}/api/events/stream?scope=me`, { headers: { ...auth, accept: "text/event-stream", ...(st.cursor ? { "last-event-id": st.cursor } : {}) }, signal: ctl.signal });
        if (!res.ok || !res.body) throw Object.assign(new Error(`the event stream answered ${res.status}`), { quiet: res.status === 404 });
        wait = 1000;
        for await (const ev of sse(res.body)) {
          let data: Record<string, unknown>;
          try { data = JSON.parse(ev.data); } catch { continue; }
          const type = ev.event ?? (typeof data.type === "string" ? data.type : "");
          const payload = (data.payload && typeof data.payload === "object" ? data.payload : data) as Record<string, unknown>;
          await handle({ id: ev.id, type, data: payload });
        }
      } catch (e) {
        if (stopped) return;
        if (!(e as { quiet?: boolean }).quiet) o.log("event stream failed; reconnecting", { err: (e as Error).message, in_ms: wait });
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }

  return { guard, handle, run, stop: () => { stopped = true; ctl?.abort(); }, state: () => st };
}

/** Server-sent events from a response body: {id, event, data} per blank-line-terminated block. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(buf.slice(i).match(/^\r?\n\r?\n/)![0].length + i);
      const ev: { id?: string; event?: string; data: string } = { data: "" };
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        const m = /^([a-z]+):\s?(.*)$/i.exec(line);
        if (!m) continue;
        if (m[1] === "data") data.push(m[2]!);
        else if (m[1] === "id") ev.id = m[2];
        else if (m[1] === "event") ev.event = m[2];
      }
      if (data.length) yield { ...ev, data: data.join("\n") };
    }
  }
}
