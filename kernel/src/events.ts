// The event router (spec §4): Slack and GitHub events become routine runs. A source module posts each event it sees
// (POST /v1/events); every routine subscribed to that connection and resource whose agent holds one of the connection's
// declared `reads` tools and whose filter matches gets it queued. Per routine one batch is open at a time; it is sealed when
// its 60 s window ends or it holds 20 events, and one drain fires each sealed batch through Paperclip's own `/run` as the
// owner, the batch id as its idempotency key (a retry is the same run and issue). The run's job reads its batch with
// routine_events (GET /v1/events/batch/:id), bound to its task and routine. Event text never travels in the task.
//
// Its two inputs come from setup and compile:
// - grants.json `routine_events`: Paperclip routine id -> { key: the routine's compiled key, agent: its assignee's Paperclip
//   id, connection, resource (or "*"), filter };
// - connections.json `<connection>.events`: { resource, kinds, filter, reads }: `reads` are the read tools whose grant reaches
//   what the connection's events carry.
//
// Code services read a second delivery (docs/superpowers/specs/2026-11-24-github-change-feed-design.md §3): an append-only log
// (`event_log`), kept 3 days, of the events whose kind and resource some module subscribes to (kernel modules.json
// `modules.<m>.subscribes.<connection>`: { kinds, resources: [...] | "*" }, compiled from module.yaml `subscribes:`). A module
// reads it with its own committed cursor (GET /v1/events/log), and the kernel keeps where each reader is (`event_readers`), so
// one that stops committing shows (GET /v1/events/readers). One ingest feeds both, in one transaction; an id the log holds is
// accepted once.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Connection, Grant } from "./identity.ts";

/** `thread`: the conversation an event replies in (a Slack reply's thread root ts), when it is a reply. */
/** `data`: a small flat object of what a consumer keys on (head, number, state…); never a stranger's words (those are `text`). */
export type EventData = Record<string, string | number | boolean | null | (string | number)[]>;
export type SourceEvent = { connection: string; resource: string; id: string; kind: string; author?: string; text?: string; labels?: string[]; bot?: boolean; url?: string; thread?: string; truncated?: boolean; data?: EventData };
/** A module's subscription to one connection's events (compiled): the kinds it reads and its resources ("*": all). */
export type ModuleSubscription = { kinds: string[]; resources: string[] | "*" };
export type LoggedEvent = Omit<SourceEvent, "connection"> & { seq: number; at: string };
export type Filter = { kind?: string | string[]; author?: string | string[]; label?: string | string[]; contains?: string[]; bot?: boolean };
export type Subscription = { key: string; agent: string; connection: string; resource: string; filter: Filter };
export type GrantsTable = { agents?: Record<string, Grant>; routine_events?: Record<string, Subscription> };
export type EventsConnection = Connection & { events?: { reads?: string[] } };
/** Accepted (new, or an id the log already holds): what routines got of it. A refusal throws (EventsError 403 or 422). */
export type IngestResult = { accepted: true; seq?: number; duplicate?: true; queued: number; dropped?: { n: number; reason: "overflow" } };
type Log = (msg: string, f?: Record<string, unknown>) => void;

export const WINDOW_MS = 60_000, BATCH_MAX = 20, TEXT_MAX = 2000, LABELS_MAX = 10, DATA_KEYS = 20, DATA_BYTES = 2048, LOG_KEEP_MS = 3 * 24 * 3600_000, LOG_PAGE = 200;
export const ROUTINE_HOURLY = 12, TOTAL_HOURLY = 120, PENDING_MAX = 2000;
const DRAIN_MS = 30_000, FIRING_MS = 10 * 60_000, PENDING_RETRY_S = 10, BODY_MS = 24 * 3600_000, KEEP_MS = 7 * 24 * 3600_000, HOUR = 3600_000;

export class EventsError extends Error {
  status: 403 | 404 | 422;
  constructor(status: 403 | 404 | 422, message: string) { super(message); this.status = status; }
}

const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
/** Whether an event passes a routine's filter: every key set must hold (a list is any of; `contains` is any substring, any case). */
export function matches(f: Filter, e: SourceEvent): boolean {
  const kind = list(f.kind), author = list(f.author), label = list(f.label);
  if (kind && !kind.includes(e.kind)) return false;
  if (author && !author.includes(e.author ?? "")) return false;
  if (label && !(e.labels ?? []).some((l) => label.includes(l))) return false;
  if (f.contains?.length && !f.contains.some((c) => (e.text ?? "").toLowerCase().includes(c.toLowerCase()))) return false;
  if (f.bot !== undefined && (e.bot === true) !== f.bot) return false;
  return true;
}

const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
const opt = (v: unknown, max: number) => v === undefined || str(v, max);
const scalar = (v: unknown) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200);
/** `data` as the schema allows it: flat, at most 20 keys, each a short string, a number, a boolean, null or a list of at most 20 strings or numbers; 2 KB. */
const dataOk = (d: unknown) => d === undefined || (Boolean(d) && typeof d === "object" && !Array.isArray(d) && Object.keys(d as object).length <= DATA_KEYS
  && Object.values(d as object).every((v) => (Array.isArray(v) ? v.length <= 20 && v.every((x) => typeof x !== "boolean" && x !== null && scalar(x)) : scalar(v)))
  && Buffer.byteLength(JSON.stringify(d)) <= DATA_BYTES);
/** An envelope as the schema allows it (text clipped), or why not. */
function envelope(e: unknown): SourceEvent | string {
  const o = (e && typeof e === "object" && !Array.isArray(e) ? e : {}) as Record<string, unknown>;
  if (!str(o.connection, 100) || !str(o.resource, 200) || !str(o.id, 200) || !str(o.kind, 100)) return "connection, resource, id and kind are short strings";
  if (!opt(o.author, 200) || !opt(o.url, 500) || !opt(o.thread, 200) || (o.text !== undefined && typeof o.text !== "string")) return "author, url, thread and text are strings";
  if ((o.bot !== undefined && typeof o.bot !== "boolean") || (o.truncated !== undefined && typeof o.truncated !== "boolean")) return "bot and truncated are true or false";
  if (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.length > LABELS_MAX || o.labels.some((l) => !str(l, 100)))) return `labels are at most ${LABELS_MAX} short strings`;
  if (!dataOk(o.data)) return `data is a flat object of at most ${DATA_KEYS} short values (${DATA_BYTES} bytes)`;
  return {
    connection: o.connection as string, resource: o.resource as string, id: o.id as string, kind: o.kind as string,
    ...(o.author !== undefined ? { author: o.author as string } : {}), ...(o.text !== undefined ? { text: (o.text as string).slice(0, TEXT_MAX) } : {}),
    ...(o.labels !== undefined ? { labels: o.labels as string[] } : {}), ...(o.bot !== undefined ? { bot: o.bot as boolean } : {}), ...(o.url !== undefined ? { url: o.url as string } : {}), ...(o.thread !== undefined ? { thread: o.thread as string } : {}), ...(o.text !== undefined && (o.truncated === true || (o.text as string).length > TEXT_MAX) ? { truncated: true } : {}),
    ...(o.data !== undefined ? { data: o.data as EventData } : {}),
  };
}

/**
 * Paperclip's `/run` of a routine as the owner (`post`: the control plane with the owner key). The batch id is the body's
 * idempotencyKey (Paperclip ignores the header) and the run's `variables` (event routines declare `batch` and `count`). A run
 * counts only once it created its task: status issue_created with its linkedIssueId; any other answer (a 202 that failed) is retried.
 */
export const routineRun = (post: (path: string, body: unknown) => Promise<{ status: number; json: unknown }>) =>
  async (id: string, key: string, variables: { batch: string; count: string }): Promise<{ status: number; issue?: string }> => {
    const r = await post(`/api/routines/${encodeURIComponent(id)}/run`, { idempotencyKey: key, variables });
    const run = (r.json ?? {}) as { status?: string; linkedIssueId?: string };
    return { status: r.status, ...(run.status === "issue_created" && run.linkedIssueId ? { issue: run.linkedIssueId } : {}) };
  };

export function createEvents(o: {
  db: DatabaseSync; grants: () => GrantsTable; connections: () => Record<string, EventsConnection>;
  /** Modules' compiled subscriptions: module -> connection -> what it reads (kernel modules.json `subscribes`). */
  subscriptions?: () => Record<string, Record<string, ModuleSubscription>>;
  /** Paperclip's /run as the owner: `issue` only when the run created its task (status issue_created with its linkedIssueId). */
  run: (routineId: string, key: string, vars: { batch: string; count: string }) => Promise<{ status: number; issue?: string }>;
  /** The routine as Paperclip has it now; undefined when it is gone. Throws when it can't be read now (a timeout). */
  routine: (id: string) => Promise<{ status: string; assignee: string } | undefined>;
  now?: () => number; log?: Log;
}) {
  const { db } = o, now = o.now ?? Date.now, log = o.log ?? (() => {});
  /** A resource as the router compares it: GitHub's repo slugs come lower-cased from its reader, a routine's as written. */
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  db.exec(`CREATE TABLE IF NOT EXISTS event_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, routine TEXT NOT NULL, id TEXT NOT NULL, batch TEXT NOT NULL, body TEXT, at INTEGER NOT NULL, UNIQUE(routine, id));
    CREATE TABLE IF NOT EXISTS event_batches (id TEXT PRIMARY KEY, routine TEXT NOT NULL, sub TEXT NOT NULL, turn INTEGER NOT NULL DEFAULT 0, task TEXT, count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, sealed_at INTEGER, dispatched_at INTEGER);
    CREATE INDEX IF NOT EXISTS event_queue_batch ON event_queue (batch);
    CREATE INDEX IF NOT EXISTS event_batches_state ON event_batches (state, routine);
    CREATE INDEX IF NOT EXISTS event_batches_dispatched ON event_batches (dispatched_at);
    CREATE INDEX IF NOT EXISTS event_batches_fired ON event_batches (state, dispatched_at);
    CREATE INDEX IF NOT EXISTS event_batches_task ON event_batches (task);
    CREATE TABLE IF NOT EXISTS event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, resource TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(connection, id));
    CREATE INDEX IF NOT EXISTS event_log_at ON event_log (at);
    CREATE TABLE IF NOT EXISTS event_log_pruned (connection TEXT PRIMARY KEY, through INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS event_readers (module TEXT NOT NULL, connection TEXT NOT NULL, after INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, connection));`);
  const modSubs = () => o.subscriptions?.() ?? {};
  /** Whether module subscription `s` takes this kind and resource. */
  const takes = (s: ModuleSubscription | undefined, kind: string, resource: string) => Boolean(s && s.kinds.includes(kind) && (s.resources === "*" || s.resources.some((r) => same(r, resource))));
  type Batch = { id: string; routine: string; sub: string; task: string | null; count: number; state: string; tries: number; opened_at: number; sealed_at: number | null; dispatched_at: number | null };
  const subs = () => o.grants().routine_events ?? {};
  /** What a batch was accepted under: a routine that changes its source, resource, filter or agent starts afresh. */
  const subOf = (s: Subscription) => JSON.stringify([s.key, s.agent, s.connection, s.resource, s.filter ?? {}]);
  /** Whether `agent` holds one of the connection's declared `reads` tools. */
  const reads = (agent: string, connection: string) => {
    const tools = o.grants().agents?.[agent]?.tools?.[connection] ?? [];
    return (o.connections()[connection]?.events?.reads ?? []).some((t) => tools.includes(t));
  };
  const get = (id: string) => db.prepare("SELECT * FROM event_batches WHERE id = ?").get(id) as Batch | undefined;
  const drop = (b: Batch, why: string) => {
    db.prepare("UPDATE event_batches SET state = 'dropped' WHERE id = ?").run(b.id);
    db.prepare("UPDATE event_queue SET body = NULL WHERE batch = ?").run(b.id);
    log("events: batch dropped", { batch: b.id, routine: b.routine, count: b.count, why });
  };
  const ownerOf = (module: string, connection: string) => {
    if (o.connections()[connection]?.module !== module) throw new EventsError(403, `${module} isn't connection ${connection.slice(0, 100)}'s module`);
  };
  /** The routines an event matches, queued (inside ingest's transaction). Over the pending cap, routines drop it (logged). */
  function route(ev: SourceEvent, body: Omit<SourceEvent, "connection">, t: number): { queued: number; dropped?: { n: number; reason: "overflow" } } {
    const targets = Object.entries(subs()).filter(([, s]) => s.connection === ev.connection && (s.resource === "*" || same(s.resource, ev.resource)) && reads(s.agent, s.connection) && matches(s.filter ?? {}, ev));
    if (!targets.length) return { queued: 0 };
    const pending = (db.prepare("SELECT count(*) AS n FROM event_queue q JOIN event_batches b ON b.id = q.batch WHERE b.state IN ('open', 'sealed', 'firing')").get() as { n: number }).n;
    // Only events not yet delivered count against intake; delivered bodies go with the 24 h retention.
    if (pending + targets.length > PENDING_MAX) { log("events: dropped on overflow", { pending }); return { queued: 0, dropped: { n: targets.length, reason: "overflow" } }; }
    let queued = 0;
    for (const [routine, s] of targets) {
      // A repeated source id for this routine is dropped (its row is kept 7 days), before it could open an empty batch.
      if (db.prepare("SELECT 1 FROM event_queue WHERE routine = ? AND id = ?").get(routine, ev.id)) continue;
      let b = db.prepare("SELECT * FROM event_batches WHERE routine = ? AND state = 'open'").get(routine) as Batch | undefined;
      // A batch whose window ended (the drain seals it on its next pass) takes no more events: they open the next one.
      if (b && b.opened_at <= t - WINDOW_MS) { db.prepare("UPDATE event_batches SET state = 'sealed', sealed_at = ? WHERE id = ?").run(t, b.id); b = undefined; }
      if (b && b.sub !== subOf(s)) { db.prepare("UPDATE event_batches SET state = 'sealed', sealed_at = ? WHERE id = ?").run(t, b.id); b = undefined; }
      if (!b) { const id = randomUUID(); db.prepare("INSERT INTO event_batches (id, routine, sub, state, opened_at) VALUES (?, ?, ?, 'open', ?)").run(id, routine, subOf(s), t); b = get(id)!; }
      db.prepare("INSERT INTO event_queue (routine, id, batch, body, at) VALUES (?, ?, ?, ?, ?)").run(routine, ev.id, b.id, JSON.stringify(body), t);
      queued++;
      db.prepare(`UPDATE event_batches SET count = count + 1${b.count + 1 >= BATCH_MAX ? ", state = 'sealed', sealed_at = ?" : ""} WHERE id = ?`).run(...(b.count + 1 >= BATCH_MAX ? [t, b.id] : [b.id]));
    }
    return { queued };
  }
  let draining = false;

  return {
    /**
     * One source event from `module`, in one transaction: appended to the log when a module subscribes to its kind and resource
     * (an id the log holds is accepted once: nothing appended or fanned out again), and queued for the routines it matches.
     * Throws 403 for a caller that isn't the connection's module and 422 for an envelope the schema refuses: both are final.
     */
    ingest(module: string, e: unknown): IngestResult {
      ownerOf(module, String((e as { connection?: unknown } | null)?.connection ?? ""));
      const ev = envelope(e);
      if (typeof ev === "string") { log("events: refused an invalid event", { module, why: ev }); throw new EventsError(422, ev); }
      const { connection: _c, ...body } = ev;
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        let seq: number | undefined;
        if (Object.values(modSubs()).some((m) => takes(m[ev.connection], ev.kind, ev.resource))) {
          if (db.prepare("SELECT 1 FROM event_log WHERE connection = ? AND id = ?").get(ev.connection, ev.id)) { db.exec("COMMIT"); return { accepted: true, duplicate: true, queued: 0 }; }
          seq = Number(db.prepare("INSERT INTO event_log (connection, resource, id, kind, body, at) VALUES (?, ?, ?, ?, ?, ?)").run(ev.connection, ev.resource.toLowerCase(), ev.id, ev.kind, JSON.stringify(body), t).lastInsertRowid);
        }
        const out = { accepted: true as const, ...(seq !== undefined ? { seq } : {}), ...route(ev, body, t) };
        db.exec("COMMIT");
        return out;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    /**
     * A module's page of the log after `after` (its last committed seq), only the kinds and resources it subscribes to. With no
     * `after`: no events and `next` at the log's end, the watermark a fresh reader starts from. `gap`: rows after `after` were
     * already pruned. A read with `after` records where the reader is (event_readers).
     */
    log(module: string, connection: string, after?: number, limit = LOG_PAGE): { events: LoggedEvent[]; next: number; gap: boolean } {
      const s = modSubs()[module]?.[connection];
      if (!s) throw new EventsError(403, `${module} doesn't subscribe to ${connection.slice(0, 100)}'s events`);
      const end = Number((db.prepare("SELECT max(seq) AS m FROM event_log WHERE connection = ?").get(connection) as { m: number | null }).m ?? 0);
      const pruned = Number((db.prepare("SELECT through FROM event_log_pruned WHERE connection = ?").get(connection) as { through: number } | undefined)?.through ?? 0);
      // The watermark registers a new reader where it starts (an existing one keeps its committed cursor), so one that never
      // reads past it still shows as lagging.
      if (after === undefined) {
        db.prepare("INSERT INTO event_readers (module, connection, after, at) VALUES (?, ?, ?, ?) ON CONFLICT (module, connection) DO NOTHING").run(module, connection, Math.max(end, pruned), now());
        return { events: [], next: Math.max(end, pruned), gap: false };
      }
      db.prepare("INSERT INTO event_readers (module, connection, after, at) VALUES (?, ?, ?, ?) ON CONFLICT (module, connection) DO UPDATE SET after = excluded.after, at = excluded.at").run(module, connection, after, now());
      const kinds = s.kinds.map(() => "?").join(","), res = s.resources === "*" ? "" : ` AND resource IN (${s.resources.map(() => "?").join(",")})`;
      const rows = db.prepare(`SELECT seq, body, at FROM event_log WHERE connection = ? AND seq > ? AND kind IN (${kinds})${res} ORDER BY seq LIMIT ?`)
        .all(connection, after, ...s.kinds, ...(s.resources === "*" ? [] : s.resources.map((r) => r.toLowerCase())), Math.min(Math.max(limit, 1), LOG_PAGE)) as { seq: number; body: string; at: number }[];
      const events = rows.map((r) => ({ ...JSON.parse(r.body), seq: r.seq, at: new Date(r.at).toISOString() }));
      // A short page reached the end: the cursor moves past rows this module doesn't read, too.
      const next = rows.length >= Math.min(Math.max(limit, 1), LOG_PAGE) ? rows.at(-1)!.seq : Math.max(after, end, pruned);
      return { events, next, gap: after < pruned };
    },
    /** Each subscribed module per connection: its committed cursor, when it last read, and how many of its events wait past it. */
    readers(): { module: string; connection: string; after: number | null; read_at: string | null; waiting: number; oldest: string | null }[] {
      const out = [];
      for (const [module, conns] of Object.entries(modSubs())) {
        for (const [connection, s] of Object.entries(conns)) {
          const r = db.prepare("SELECT after, at FROM event_readers WHERE module = ? AND connection = ?").get(module, connection) as { after: number; at: number } | undefined;
          const res = s.resources === "*" ? "" : ` AND resource IN (${s.resources.map(() => "?").join(",")})`;
          const w = db.prepare(`SELECT count(*) AS n, min(at) AS oldest FROM event_log WHERE connection = ? AND seq > ? AND kind IN (${s.kinds.map(() => "?").join(",")})${res}`)
            .get(connection, r?.after ?? 0, ...s.kinds, ...(s.resources === "*" ? [] : s.resources.map((x) => x.toLowerCase()))) as { n: number; oldest: number | null };
          out.push({ module, connection, after: r?.after ?? null, read_at: r ? new Date(r.at).toISOString() : null, waiting: r ? w.n : 0, oldest: r && w.oldest ? new Date(w.oldest).toISOString() : null });
        }
      }
      return out;
    },
    /** Whether a batch was fired into this task: its run read outside text. */
    fired: (task: string) => Boolean(db.prepare("SELECT 1 FROM event_batches WHERE task = ?").get(task)),
    /** The resources a source module should watch on its connection: every routine's and module's ("*" for all it reads). */
    resources(module: string, connection: string): string[] {
      ownerOf(module, connection);
      const mods = Object.values(modSubs()).flatMap((m) => { const s = m[connection]; return !s ? [] : s.resources === "*" ? ["*"] : s.resources; });
      return [...new Set([...Object.values(subs()).filter((s) => s.connection === connection).map((s) => s.resource), ...mods])];
    },
    /**
     * A run's batch, for its job: its own task and routine (`job.routine` is the job's routine's compiled key), the routine still
     * active and assigned to the job's agent, and that agent's read grant still held. A batch still firing (the job started before
     * its binding was stored) answers pending for a while. Anything else is 403.
     */
    async batch(job: { task: string; agent: string; routine?: string | null }, id: string): Promise<{ pending: true; retry_after_s: number } | { expired: true; count: number } | { count: number; events: Omit<SourceEvent, "connection">[] }> {
      const b = get(id), s = b && subs()[b.routine];
      // Fired: bound to its task (a later job on that task reads it too, a retry or a reopen). Still firing: the run's own routine.
      const bound = b?.state === "fired" ? b.task === job.task : Boolean(job.routine && s?.key === job.routine);
      const own = b && s && bound && subOf(s) === b.sub && s.agent === job.agent && reads(s.agent, s.connection);
      const r = own ? await o.routine(b.routine) : undefined;
      if (b && own && r?.status === "active" && r.assignee === job.agent) {
        if (b.state === "fired") {
          const events = (db.prepare("SELECT body FROM event_queue WHERE batch = ? AND body IS NOT NULL ORDER BY seq").all(b.id) as { body: string }[]).map((q) => JSON.parse(q.body));
          // Kept a day after it fired: past that, or with fewer bodies than the batch held, it is expired, never an empty batch.
          return events.length < b.count || now() - (b.dispatched_at ?? 0) > BODY_MS ? { expired: true, count: b.count } : { count: b.count, events };
        }
        if (b.state === "firing" && now() - (b.sealed_at ?? 0) < FIRING_MS) return { pending: true, retry_after_s: PENDING_RETRY_S };
      }
      throw new EventsError(403, "this batch isn't your run's");
    },
    /** One pass (never two at once): seal windows that ended, fire sealed batches, retry firing ones, expire old rows. */
    async drain(): Promise<void> {
      if (draining) return;
      draining = true;
      // A pass is bounded: what it doesn't reach waits for the next one (sealing and cleanup run every pass).
      const until = Date.now() + DRAIN_MS;
      try {
        const t = now();
        db.prepare("UPDATE event_batches SET state = 'sealed', sealed_at = ? WHERE state = 'open' AND opened_at <= ?").run(t, t - WINDOW_MS);
        // In turn order (sealed first; a failed routine lookup moves its batch's turn to the back), never the firing deadline.
        for (const b of db.prepare("SELECT * FROM event_batches WHERE state IN ('sealed', 'firing') ORDER BY max(turn, sealed_at)").all() as Batch[]) {
          if (Date.now() > until) break;
          if (b.state === "firing" && now() - b.sealed_at! > FIRING_MS) { drop(b, "Paperclip didn't take the run in 10 minutes"); continue; }
          const s = subs()[b.routine];
          if (!s || !reads(s.agent, s.connection)) { drop(b, "the subscription or its read grant is gone"); continue; }
          if (subOf(s) !== b.sub) { drop(b, "the routine's subscription changed since these events were accepted"); continue; }
          let r: Awaited<ReturnType<typeof o.routine>>;
          try { r = await o.routine(b.routine); } catch (e) {
            // To the back of the line: one routine whose lookup fails never holds up the batches behind it.
            db.prepare("UPDATE event_batches SET turn = ? WHERE id = ?").run(now(), b.id);
            log("events: routine lookup failed; retried next drain", { routine: b.routine, err: String((e as Error).message).slice(0, 200) });
            continue;
          }
          if (r?.status !== "active" || r.assignee !== s.agent) { drop(b, r ? `the routine is ${r.status}` : "the routine is gone"); continue; }
          if (b.state === "sealed") {
            const since = now() - HOUR;
            // A batch firing holds its place in the caps until it lands (its retries keep the same key and place).
            const mine = (db.prepare("SELECT count(*) AS n FROM event_batches WHERE routine = ? AND (dispatched_at > ? OR state = 'firing')").get(b.routine, since) as { n: number }).n;
            const all = (db.prepare("SELECT count(*) AS n FROM event_batches WHERE dispatched_at > ? OR state = 'firing'").get(since) as { n: number }).n;
            if (mine >= ROUTINE_HOURLY || all >= TOTAL_HOURLY) { drop(b, `cap: ${mine} runs of this routine and ${all} in all in the past hour`); continue; }
            db.prepare("UPDATE event_batches SET state = 'firing' WHERE id = ?").run(b.id);
          }
          db.prepare("UPDATE event_batches SET tries = tries + 1 WHERE id = ?").run(b.id);
          let res: { status: number; issue?: string };
          try { res = await o.run(b.routine, b.id, { batch: b.id, count: String(b.count) }); } catch (e) { log("events: run failed; retried with the same key", { batch: b.id, err: String((e as Error).message).slice(0, 200) }); continue; }
          // The binding, its state and its dispatch time in one statement.
          if (res.status >= 200 && res.status < 300 && res.issue) db.prepare("UPDATE event_batches SET task = ?, state = 'fired', dispatched_at = ? WHERE id = ?").run(res.issue, now(), b.id);
          else if (res.status >= 400 && res.status < 500 && res.status !== 429) drop(b, `Paperclip refused the run (${res.status})`);
          else log("events: run not taken; retried with the same key", { batch: b.id, status: res.status });
        }
        const t2 = now();
        // Only batches still in the queue's 7-day window: older ones' queue rows are gone already.
        db.prepare("UPDATE event_queue SET body = NULL WHERE body IS NOT NULL AND batch IN (SELECT id FROM event_batches WHERE state = 'fired' AND dispatched_at < ? AND dispatched_at > ?)").run(t2 - BODY_MS, t2 - KEEP_MS - HOUR);
        db.prepare("DELETE FROM event_queue WHERE at < ?").run(t2 - KEEP_MS);
        // A fired batch's row stays (its body is gone after a day): it is what tells the kernel the task read outside text.
        db.prepare("DELETE FROM event_batches WHERE state = 'dropped' AND opened_at < ?").run(t2 - KEEP_MS);
        // The log keeps 3 days; what is pruned is remembered per connection, so a reader behind it is told (`gap`).
        for (const r of db.prepare("SELECT connection, max(seq) AS through FROM event_log WHERE at < ? GROUP BY connection").all(t2 - LOG_KEEP_MS) as { connection: string; through: number }[]) {
          db.prepare("INSERT INTO event_log_pruned (connection, through) VALUES (?, ?) ON CONFLICT (connection) DO UPDATE SET through = max(through, excluded.through)").run(r.connection, r.through);
        }
        db.prepare("DELETE FROM event_log WHERE at < ?").run(t2 - LOG_KEEP_MS);
      } finally { draining = false; }
    },
  };
}
export type Events = ReturnType<typeof createEvents>;
