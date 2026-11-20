// The comment wake loop: one outbound SSE subscription to Primer's caller-scoped event stream (GET /api/events/stream?scope=me,
// resumed with Last-Event-ID). On a document an agent published (the ownership map, from publish receipts), a
// primer.comment.created, or a primer.version.published that is an automatic checkpoint of people's live edits (not by the
// connector's own Primer identity), wakes that agent's task with a fixed notice naming only ids and whether the author is the
// owner (never a name or the body: the agent reads them through the fenced Primer tools). Dispatch delivers the notice into the
// agent's live run, or starts the next.
//
// - Who: the connector's identity comes from Primer once (GET /api/me). The owner is the person its agent identity acts via
//   (viaUserId, self-host); "by the owner" in a notice is set here in code, by author id. In connect mode the connector signs
//   in as the owner, so its tools' comments (any agent's) carry the owner's id: every author there is "someone else".
// - Coalesced: after a wake, more comments and edits on that document within COALESCE_MS wake nobody (a burst is one wake);
//   the agent's next version or reply on the document ends that, and whatever arrived meanwhile and is still unaddressed gets
//   one wake then. An owner's comment always wakes: its notice is the only place that says it is the owner's.
//
// - Echo: the connector acts as the owner in Primer, so its own replies arrive as comments too. Every connector write runs
//   through guard(), which records the comment ids its receipt names; events are held while a write is in flight (the event
//   can beat the receipt), then checked against those ids. Never by author.
// - Closed task: the kernel answers {closed}; the connector files one "Revisions: <title>" task for the owning agent (kernel
//   tasks route, keyed by the document so a retry is the same task), keeps it in its state and wakes that next time.
// - Batches: comments not yet addressed are pending; a version the connector publishes covers the comments that were pending
//   when its write started (one arriving mid-publish waits for the next batch), and a thread reply addresses that thread's.
//   A version Primer didn't make (nothing applied) covers nothing.
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
/** Per document. threads: a pending comment's thread; woken: when its last wake went (ms); quiet: what arrived after it unwoken. */
interface DocState { pending: string[]; batches: { version?: string; comments: string[] }[]; revisions?: number; threads?: Record<string, string>; woken?: number; quiet?: string[] }
/** The connector's Primer identity: its own user id, and the owner's (the person its agent identity acts via; none in connect mode). */
interface Identity { self: string; owner?: string; agent: boolean }
interface State { cursor?: string; created: string[]; processed: string[]; docs: Record<string, DocState> }
type Log = (msg: string, f?: Record<string, unknown>) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[\w:.-]{1,200}$/;
const KEEP = 5000; // ids remembered (created, processed): far more than a stream replays
// Primer's reads (main.ts PRIMER_READ): they run unguarded, so a read's comment ids are never taken for the connector's own.
const READ = /^primer_(whoami|resolve_url|get_|list_|find_)/;
/** A kernel answer that will never change on a retry (a deleted task, a paused agent): skipped loudly, never replayed. */
const permanent = (e: unknown) => [400, 403, 404, 409, 422].includes(Number((e as { status?: number }).status));
const id = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);
/** A burst of comments and edits on one document within this of its last wake is one wake. */
export const COALESCE_MS = 5 * 60_000;

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

const by = (owner: boolean) => (owner ? "by the owner" : "by someone else");
/** The fixed notices: ids and authorship only. */
export const notice = (doc: string, thread: string | undefined, comment: string, pending: number, owner = false) =>
  `New comment ${by(owner)} on Primer document ${doc} (thread ${thread ?? "unknown"}, comment ${comment}; ${pending} comment${pending === 1 ? "" : "s"} not yet addressed). Read the open threads with the Primer tools and handle them as the primer-docs skill says.`;
export const editNotice = (doc: string, version: string, owner: boolean) =>
  `Primer document ${doc} was edited directly ${by(owner)} (checkpoint version ${version}). Read it and handle it as the primer-docs skill says.`;
const followUp = (doc: string, pending: number) =>
  `More happened on Primer document ${doc} since your last wake (${pending} comment${pending === 1 ? "" : "s"} not yet addressed, or direct edits). Read it and its open threads and handle them as the primer-docs skill says.`;

export function createSubscriber(o: {
  /** Primer's origin (self-hosted http://primer-server:3000, or the hosted MCP address's origin). */
  primer: string;
  /** The connector's sign-in to Primer (the service token, or the owner's OAuth); throws while there is none. */
  headers: () => Promise<Record<string, string>>;
  kernel: Kernel;
  /** The ownership map (publish receipts): who published a document, on which task; a Revisions task becomes its owner. */
  owner: (documentId: string) => Owner | undefined;
  recordOwner: (documentId: string, owner: Owner) => void;
  stateFile: string;
  log: Log;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const st: State = existsSync(o.stateFile) ? { created: [], processed: [], docs: {}, ...JSON.parse(readFileSync(o.stateFile, "utf8")) } : { created: [], processed: [], docs: {} };
  const save = () => {
    st.created = st.created.slice(-KEEP);
    st.processed = st.processed.slice(-KEEP);
    writeFileSync(`${o.stateFile}.tmp`, JSON.stringify(st));
    renameSync(`${o.stateFile}.tmp`, o.stateFile);
  };
  const doc = (d: string) => (st.docs[d] ??= { pending: [], batches: [] });
  /** The connector's identity, read once (retried on the next event while Primer doesn't answer). */
  let me: Identity | undefined;
  async function identity(): Promise<Identity | undefined> {
    if (me) return me;
    try {
      const r = await f(`${o.primer}/api/me`, { headers: await o.headers(), signal: AbortSignal.timeout(10_000) });
      const j = r.ok ? ((await r.json()) as { id?: unknown; kind?: unknown; viaUserId?: unknown }) : undefined;
      const self = id(j?.id);
      if (self) me = { self, owner: id(j?.viaUserId), agent: j?.kind === "agent" };
    } catch { /* not now: the next event asks again */ }
    return me;
  }
  let inflight = 0;
  let drained: (() => void)[] = [];
  const idle = () => (inflight ? new Promise<void>((r) => drained.push(r)) : Promise.resolve());

  /**
   * Runs one connector write (a version, a thread reply). Events wait until it returns; the comment ids its receipt names are
   * the connector's own. A version (primer_add_version with documentId) covers the comments pending when it started, a reply
   * its thread's; either ends the document's coalescing, and what arrived unwoken meanwhile and is still pending wakes once.
   */
  async function guard<T extends { text: string; isError?: boolean }>(tool: string, args: Record<string, unknown>, run: () => Promise<T>, document?: string): Promise<T> {
    if (READ.test(tool)) return run();
    const d = document ?? (typeof args.documentId === "string" ? args.documentId : undefined);
    const version = tool === "primer_add_version";
    const covers = version && d ? [...doc(d).pending] : [];
    inflight++;
    let after: (() => Promise<unknown>) | undefined;
    try {
      const r = await run();
      if (!r.isError) {
        st.created.push(...createdIds(r.text));
        if (d && st.docs[d]) {
          const s = doc(d);
          const made = /"version_?[iI]d"\s*:\s*"([\w-]+)"/.exec(r.text)?.[1];
          // A version Primer didn't make (nothing applied) addresses nothing; a reply addresses its thread's comments.
          // One that arrived unwoken during the burst may postdate what the agent read: it stays pending and gets the follow-up.
          const done = (version ? (made ? covers : []) : s.pending.filter((c) => s.threads?.[c] === args.thread_id)).filter((c) => !s.quiet?.includes(c));
          if (version && made) s.batches = [...s.batches, { version: made, comments: covers }].slice(-50);
          s.pending = s.pending.filter((c) => !done.includes(c));
          for (const c of done) delete s.threads?.[c];
          const left = (s.quiet ?? []).filter((q) => s.pending.includes(q) || (q.startsWith("edit:") && !(version && made)));
          s.woken = undefined;
          s.quiet = [];
          if (left.length) after = () => wake(d, followUp(d, s.pending.length));
        }
        save();
      }
      return r;
    } finally {
      if (--inflight === 0) { const w = drained; drained = []; w.forEach((r) => r()); }
      if (after) await after().catch((e: Error) => o.log("follow-up wake failed; the next event wakes it", { err: e.message }));
    }
  }

  /**
   * The document's task is closed: one new "Revisions" task for its agent, which becomes the document's owner in the map (so
   * the agent's versions and replies there are its own, and the next comment wakes it). Numbered, so a closed Revisions task
   * gets a fresh one rather than the same closed task back from the kernel's idempotency.
   */
  async function revisions(d: string, own: Owner): Promise<string> {
    const s = doc(d);
    const n = s.revisions == null ? 0 : s.revisions + 1;
    let title = `document ${d}`;
    try {
      const r = await f(`${o.primer}/api/documents/${encodeURIComponent(d)}`, { headers: await o.headers(), signal: AbortSignal.timeout(10_000) });
      const t = r.ok ? ((await r.json()) as { title?: unknown }).title : undefined;
      if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 150);
    } catch { /* the id is title enough */ }
    const t = await o.kernel.file({
      title: `Revisions: ${title}`,
      description: `People are commenting on or editing Primer document ${d}, which you published on a task that is now closed. Revisions for it come here.\n\n${notice(d, undefined, "(see the open threads)", s.pending.length)}`,
      agent: own.agent, source: `primer-revisions:${d}:${n}`, ...(UUID.test(own.task) ? { parent: own.task } : {}),
    });
    s.revisions = n;
    o.recordOwner(d, { task: t.id, agent: own.agent });
    save();
    return t.id;
  }

  /** Wakes the document's owning task with a notice (a closed task gets a Revisions task); returns the task woken. */
  async function wake(d: string, text: string): Promise<string | undefined> {
    const own = o.owner(d);
    if (!own) return undefined;
    let target = own.task;
    try {
      // Closed: a new Revisions task, whose assignment starts its agent by itself (its description is the notice).
      if ((await o.kernel.wake(target, text)).closed) target = await revisions(d, own);
    } catch (e) {
      if (!permanent(e)) throw e; // the kernel or the network: the event replays
      o.log("wake refused for good; skipped", { document: d, task: target, err: (e as Error).message });
    }
    doc(d).woken = now();
    return target;
  }

  /** Whether a wake on this document went out recently and nothing the agent did since ended it. */
  const coalescing = (s: DocState) => s.woken !== undefined && now() - s.woken < COALESCE_MS;

  /** One primer.comment.created: at most one wake, none for the connector's own comment or an unmapped document. */
  async function comment(p: Record<string, unknown>) {
    const d = id(p.document_id), c = id(p.comment_id), thread = id(p.thread_id);
    if (!d || !c) return;
    await idle();
    if (st.created.includes(c) || st.processed.includes(c)) return;
    if (!o.owner(d)) return;
    const who = (await identity())?.owner;
    const owner = who !== undefined && who === p.author_id;
    const s = doc(d);
    if (!s.pending.includes(c)) s.pending.push(c);
    if (thread) (s.threads ??= {})[c] = thread;
    let target: string | undefined;
    if (coalescing(s) && !owner) (s.quiet ??= []).push(c);
    else target = await wake(d, notice(d, thread, c, s.pending.length, owner));
    st.processed.push(c);
    save();
    o.log(target ? "comment wake" : "comment coalesced", { document: d, thread, comment: c, task: target });
  }

  /** One primer.version.published: an automatic checkpoint of people's live edits wakes like a comment; the connector's own never. */
  async function version(p: Record<string, unknown>) {
    const d = id(p.document_id), v = id(p.version_id);
    if (!d || !v || p.automatic !== true) return;
    await idle();
    const key = `edit:${v}`;
    if (st.processed.includes(key) || !o.owner(d)) return;
    const me = await identity();
    // The connector's own live edits (an agent identity of its own; in connect mode it is the owner and edits nothing live).
    if (me?.agent && p.author_id === me.self) return;
    const s = doc(d);
    let target: string | undefined;
    if (coalescing(s)) (s.quiet ??= []).push(key);
    else target = await wake(d, editNotice(d, v, me?.owner !== undefined && me.owner === p.author_id));
    st.processed.push(key);
    save();
    o.log(target ? "edit wake" : "edit coalesced", { document: d, version: v, task: target });
  }

  /** Handles one stream event (exported for the stream loop and tests); the cursor moves only after it. */
  async function handle(ev: { id?: string; type: string; data: Record<string, unknown> }) {
    if (ev.type === "primer.comment.created") await comment(ev.data);
    if (ev.type === "primer.version.published") await version(ev.data);
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
        // A Primer without the stream (404, or an answer that isn't an event stream) waits quietly at the backoff's pace.
        if (!res.ok || !res.body || !/^text\/event-stream/.test(res.headers.get("content-type") ?? "")) throw Object.assign(new Error(`the event stream answered ${res.status}`), { quiet: res.status === 404 || res.ok });
        for await (const ev of sse(res.body)) {
          wait = 1000; // only a real event resets the backoff: a stream that closes at once doesn't hammer Primer
          let data: Record<string, unknown>;
          try { data = JSON.parse(ev.data); } catch { continue; }
          // `event: primer.comment.created` with the payload as data, or Primer's event row {namespace, type, payload, documentId}.
          const t = typeof data.type === "string" ? data.type : "";
          const type = ev.event ?? (typeof data.namespace === "string" && !t.startsWith(`${data.namespace}.`) ? `${data.namespace}.${t}` : t);
          const payload = { ...(typeof data.documentId === "string" ? { document_id: data.documentId } : {}), ...((data.payload && typeof data.payload === "object" ? data.payload : data) as Record<string, unknown>) };
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
