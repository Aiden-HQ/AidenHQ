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
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Connection, Grant } from "./identity.ts";

/** `thread`: the conversation an event replies in (a Slack reply's thread root ts), when it is a reply. */
export type SourceEvent = { connection: string; resource: string; id: string; kind: string; author?: string; text?: string; labels?: string[]; bot?: boolean; url?: string; thread?: string };
export type Filter = { kind?: string | string[]; author?: string | string[]; label?: string | string[]; contains?: string[]; bot?: boolean };
export type Subscription = { key: string; agent: string; connection: string; resource: string; filter: Filter };
export type GrantsTable = { agents?: Record<string, Grant>; routine_events?: Record<string, Subscription> };
export type EventsConnection = Connection & { events?: { reads?: string[] } };
export type IngestResult = { queued: number } | { skipped: "invalid"; why: string } | { dropped: number; reason: "overflow" | "cap" };
type Log = (msg: string, f?: Record<string, unknown>) => void;

export const WINDOW_MS = 60_000, BATCH_MAX = 20, TEXT_MAX = 2000, LABELS_MAX = 10;
export const ROUTINE_HOURLY = 12, TOTAL_HOURLY = 120, PENDING_MAX = 2000;
const DRAIN_MS = 30_000, FIRING_MS = 10 * 60_000, PENDING_RETRY_S = 10, BODY_MS = 24 * 3600_000, KEEP_MS = 7 * 24 * 3600_000, HOUR = 3600_000;

export class EventsError extends Error {
  status: 403 | 404;
  constructor(status: 403 | 404, message: string) { super(message); this.status = status; }
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
/** An envelope as the schema allows it (text clipped), or why not. */
function envelope(e: unknown): SourceEvent | string {
  const o = (e && typeof e === "object" && !Array.isArray(e) ? e : {}) as Record<string, unknown>;
  if (!str(o.connection, 100) || !str(o.resource, 200) || !str(o.id, 200) || !str(o.kind, 100)) return "connection, resource, id and kind are short strings";
  if (!opt(o.author, 200) || !opt(o.url, 500) || !opt(o.thread, 200) || (o.text !== undefined && typeof o.text !== "string")) return "author, url, thread and text are strings";
  if (o.bot !== undefined && typeof o.bot !== "boolean") return "bot is true or false";
  if (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.length > LABELS_MAX || o.labels.some((l) => !str(l, 100)))) return `labels are at most ${LABELS_MAX} short strings`;
  return {
    connection: o.connection as string, resource: o.resource as string, id: o.id as string, kind: o.kind as string,
    ...(o.author !== undefined ? { author: o.author as string } : {}), ...(o.text !== undefined ? { text: (o.text as string).slice(0, TEXT_MAX) } : {}),
    ...(o.labels !== undefined ? { labels: o.labels as string[] } : {}), ...(o.bot !== undefined ? { bot: o.bot as boolean } : {}), ...(o.url !== undefined ? { url: o.url as string } : {}), ...(o.thread !== undefined ? { thread: o.thread as string } : {}),
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
  /** Paperclip's /run as the owner: `issue` only when the run created its task (status issue_created with its linkedIssueId). */
  run: (routineId: string, key: string, vars: { batch: string; count: string }) => Promise<{ status: number; issue?: string }>;
  /** The routine as Paperclip has it now; undefined when it is gone. Throws when it can't be read now (a timeout). */
  routine: (id: string) => Promise<{ status: string; assignee: string } | undefined>;
  now?: () => number; log?: Log;
}) {
  const { db } = o, now = o.now ?? Date.now, log = o.log ?? (() => {});
  db.exec(`CREATE TABLE IF NOT EXISTS event_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, routine TEXT NOT NULL, id TEXT NOT NULL, batch TEXT NOT NULL, body TEXT, at INTEGER NOT NULL, UNIQUE(routine, id));
    CREATE TABLE IF NOT EXISTS event_batches (id TEXT PRIMARY KEY, routine TEXT NOT NULL, sub TEXT NOT NULL, task TEXT, count INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL, sealed_at INTEGER, dispatched_at INTEGER);
    CREATE INDEX IF NOT EXISTS event_queue_batch ON event_queue (batch);
    CREATE INDEX IF NOT EXISTS event_batches_state ON event_batches (state, routine);
    CREATE INDEX IF NOT EXISTS event_batches_dispatched ON event_batches (state, dispatched_at);
    CREATE INDEX IF NOT EXISTS event_batches_task ON event_batches (task);`);
  type Batch = { id: string; routine: string; sub: string; task: string | null; count: number; state: string; tries: number; opened_at: number; sealed_at: number | null; dispatched_at: number | null };
  const subs = () => o.grants().routine_events ?? {};
  /** What a batch was accepted under: a routine that changes its source, resource, filter or agent starts afresh. */
  const subOf = (s: Subscription) => JSON.stringify([s.key, s.agent, s.connection, s.resource, s.filter ?? {}]);
  /** A resource as the router compares it: GitHub's repo slugs come lower-cased from its poller, a routine's as written. */
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  /** Whether `agent` holds one of the connection's declared `reads` tools. */
  const reads = (agent: string, connection: string) => {
    const tools = o.grants().agents?.[agent]?.tools?.[connection] ?? [];
    return (o.connections()[connection]?.events?.reads ?? []).some((t) => tools.includes(t));
  };
  /** A fired batch whose bodies are gone (kept a day after it fired). */
  const dispatchedOld = (b: Batch) => b.count > 0 && now() - (b.dispatched_at ?? 0) > BODY_MS;
  const get = (id: string) => db.prepare("SELECT * FROM event_batches WHERE id = ?").get(id) as Batch | undefined;
  const drop = (b: Batch, why: string) => {
    db.prepare("UPDATE event_batches SET state = 'dropped' WHERE id = ?").run(b.id);
    db.prepare("UPDATE event_queue SET body = NULL WHERE batch = ?").run(b.id);
    log("events: batch dropped", { batch: b.id, routine: b.routine, count: b.count, why });
  };
  const ownerOf = (module: string, connection: string) => {
    if (o.connections()[connection]?.module !== module) throw new EventsError(403, `${module} isn't connection ${connection.slice(0, 100)}'s module`);
  };
  let draining = false;

  return {
    /** One source event from `module`: 2xx for everything (queued, skipped or dropped) except a caller that isn't the connection's module. */
    ingest(module: string, e: unknown): IngestResult {
      ownerOf(module, String((e as { connection?: unknown } | null)?.connection ?? ""));
      const ev = envelope(e);
      if (typeof ev === "string") { log("events: skipped an invalid event", { module, why: ev }); return { skipped: "invalid", why: ev }; }
      const targets = Object.entries(subs()).filter(([, s]) => s.connection === ev.connection && (s.resource === "*" || same(s.resource, ev.resource)) && reads(s.agent, s.connection) && matches(s.filter ?? {}, ev));
      if (!targets.length) return { queued: 0 };
      const pending = (db.prepare("SELECT count(*) AS n FROM event_queue q JOIN event_batches b ON b.id = q.batch WHERE b.state IN ('open', 'sealed', 'firing')").get() as { n: number }).n;
      // Only events not yet delivered count against intake; delivered bodies go with the 24 h retention.
      if (pending + targets.length > PENDING_MAX) { log("events: dropped on overflow", { module, pending }); return { dropped: targets.length, reason: "overflow" }; }
      const { connection: _c, ...body } = ev;
      const t = now();
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
    },
    /** Whether a batch was fired into this task: its run read outside text. */
    fired: (task: string) => Boolean(db.prepare("SELECT 1 FROM event_batches WHERE task = ?").get(task)),
    /** The resources a source module should watch on its connection: every subscription's ("*" for all it reads). */
    resources(module: string, connection: string): string[] {
      ownerOf(module, connection);
      return [...new Set(Object.values(subs()).filter((s) => s.connection === connection).map((s) => s.resource))];
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
        if (b.state === "fired" && dispatchedOld(b)) return { expired: true, count: b.count };
        if (b.state === "fired") return { count: b.count, events: (db.prepare("SELECT body FROM event_queue WHERE batch = ? AND body IS NOT NULL ORDER BY seq").all(b.id) as { body: string }[]).map((q) => JSON.parse(q.body)) };
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
        for (const b of db.prepare("SELECT * FROM event_batches WHERE state IN ('sealed', 'firing') ORDER BY sealed_at").all() as Batch[]) {
          if (Date.now() > until) break;
          if (b.state === "firing" && now() - b.sealed_at! > FIRING_MS) { drop(b, "Paperclip didn't take the run in 10 minutes"); continue; }
          const s = subs()[b.routine];
          if (!s || !reads(s.agent, s.connection)) { drop(b, "the subscription or its read grant is gone"); continue; }
          if (subOf(s) !== b.sub) { drop(b, "the routine's subscription changed since these events were accepted"); continue; }
          let r: Awaited<ReturnType<typeof o.routine>>;
          try { r = await o.routine(b.routine); } catch (e) { log("events: routine lookup failed; retried next drain", { routine: b.routine, err: String((e as Error).message).slice(0, 200) }); continue; }
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
      } finally { draining = false; }
    },
  };
}
export type Events = ReturnType<typeof createEvents>;
