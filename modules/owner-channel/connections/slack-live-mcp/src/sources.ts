// src_slack writer (shared sources, docs/design/sources.md). Every Socket Mode event is
// teed here before any of the Triage filters: bot posts kept, edits update the row (the old text goes to the change log as
// the revision), deletes become tombstones, thread replies kept. A gap sync with the owner's user token fills disconnects:
// conversations.history per channel the owner is in, plus conversations.replies for recently active threads; once a week it
// re-reads the last week in full and tombstones what Slack no longer returns (Events have no replay). No LLM.
import type { Logger } from "pino";
import { capText, SourceStore, tableDdl, USERS, type Row, type Table } from "./source-store.js";
import { permalink } from "./map.js";

export const MESSAGE: Table = {
  name: "message",
  key: ["channel_id", "ts"],
  cols: {
    channel_id: "text", ts: "text", channel_type: "text", user_id: "text", bot_id: "text", subtype: "text", text: "text", text_truncated: "boolean",
    thread_ts: "text", source_ts: "timestamptz", edited_at: "timestamptz", deleted: "boolean", permalink: "text",
  },
  tracked: ["text", "deleted"],
  scope: "channel_id",
  url: "permalink",
  search: ["text"],
};
// A delete blanks the text without logging it: the tombstone keeps no copy.
const TOMBSTONE: Table = { ...MESSAGE, tracked: ["deleted"] };
export const CHANNEL: Table = { name: "channel", key: ["channel_id"], cols: { channel_id: "text", name: "text", channel_type: "text" }, tracked: [] };

// One view per shape, readable by every warehouse reader (DMs and private channels included: owner, 2026-11-11);
// channel_type is Slack's own (from the event or users.conversations), kept so a gate can be added later.
export const DDL = `${tableDdl("src_slack", MESSAGE)}
${tableDdl("src_slack", CHANNEL)}
${tableDdl("src_slack", USERS)}
CREATE OR REPLACE VIEW src_slack.messages AS
  SELECT m.channel_id, c.name AS channel_name, COALESCE(m.channel_type, c.channel_type, 'unknown') AS channel_type, m.ts, m.thread_ts,
    m.user_id, m.bot_id, m.subtype, m.text, m.text_truncated, m.deleted, m.edited_at, m.source_ts, m.permalink,
    m.baseline, m.first_seen_at, m.ingested_at, m.seq, m.tsv
  FROM src_slack.message m LEFT JOIN src_slack.channel c USING (channel_id);
COMMENT ON VIEW src_slack.messages IS 'Every Slack message the owner''s token sees: public and private channels, DMs, group DMs (channel_type). One row per (channel_id, ts), current text (bot and attachment text included); edits bump seq and log the old text in src_slack.changes; deleted = tombstone. baseline = from a channel''s first backfill, not a recent message. text is capped at 4 KB (text_truncated; permalink for the rest). tsv: full-text (simple config). user_id joins src_slack.users.';
CREATE OR REPLACE VIEW src_slack.threads AS
  SELECT channel_id, max(channel_name) AS channel_name, max(channel_type) AS channel_type, thread_ts,
    min(ts) AS first_ts, max(ts) AS last_ts, count(*) FILTER (WHERE ts <> thread_ts AND NOT deleted) AS reply_count,
    array_agg(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS participants,
    (array_agg(text ORDER BY ts DESC) FILTER (WHERE NOT deleted))[1] AS last_text,
    max(source_ts) AS last_at, bool_and(baseline) AS baseline, max(ingested_at) AS ingested_at, max(seq) AS seq,
    'https://slack.com/archives/' || channel_id || '/p' || replace(thread_ts, '.', '') AS permalink
  FROM src_slack.messages WHERE thread_ts IS NOT NULL GROUP BY channel_id, thread_ts;
COMMENT ON VIEW src_slack.threads IS 'One row per Slack thread: first and last ts, reply count, participants (src_slack.users ids), the last message text; seq is the newest message''s, so a thread comes back in source_new when it gets activity.';
CREATE OR REPLACE VIEW src_slack.changes AS
  SELECT seq, entity, entity_id, scope AS channel_id, field, old_value, new_value, url, observed_at, false AS baseline FROM src_slack.change;
COMMENT ON VIEW src_slack.changes IS 'Edits (field text: old_value is the previous revision) and deletes of Slack messages, with observed_at.';
COMMENT ON TABLE src_slack.users IS 'Slack people by user id: handle, display name, email (when the token may read it), bots.';
GRANT SELECT ON src_slack.messages, src_slack.threads, src_slack.changes, src_slack.users TO agents_open;`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, any> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
const tsDate = (ts: unknown): Date | null => (str(ts) && Number.isFinite(Number(ts)) ? new Date(Math.round(Number(ts) * 1000)) : null);

/** Slack's channel_type on events (channel, group, im, mpim) as ours; undefined when Slack didn't say. */
export function channelType(t: unknown): string | undefined {
  return ({ channel: "public", group: "private", im: "im", mpim: "mpim" } as Record<string, string>)[String(t)];
}
/** A conversation from users.conversations / conversations.info as our channel_type (fails closed to private). */
export const conversationType = (c: Record<string, any>): string => (c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private || c.is_group ? "private" : c.is_channel ? "public" : "private");

/** A message's text plus its attachments' (bots often post only attachments: deploy and release notices). */
export function fullText(m: Record<string, any>): string {
  const parts = [str(m.text)];
  // Link unfurls are Slack's previews of a URL in the text, added later by a message_changed: not the message's words.
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) if (!a?.from_url && !a?.is_msg_unfurl) parts.push(str(a?.pretext), str(a?.title), str(a?.text) ?? str(a?.fallback));
  for (const f of Array.isArray(m.files) ? m.files : []) parts.push(str(f?.title));
  return parts.filter(Boolean).join("\n");
}

/** A Slack message object (from an event or conversations.history) as a message row. */
export function messageRow(channel: string, m: Record<string, any>, type: string | undefined): Row {
  const t = capText(fullText(m));
  return {
    channel_id: channel, ts: m.ts, ...(type ? { channel_type: type } : {}), user_id: str(m.user) ?? null, bot_id: str(m.bot_id) ?? null, subtype: str(m.subtype) ?? null,
    text: t.text, text_truncated: t.truncated, thread_ts: str(m.thread_ts) ?? null, source_ts: tsDate(m.ts), edited_at: tsDate(m.edited?.ts), deleted: false, permalink: permalink(channel, m.ts),
  };
}

const tombstone = (channel: string, ts: string, type?: string): Row => ({ channel_id: channel, ts, ...(type ? { channel_type: type } : {}), text: null, text_truncated: false, deleted: true, permalink: permalink(channel, ts) });

/**
 * A Slack message object as its write: a message row, or a tombstone for a deleted thread parent (Slack keeps it as
 * subtype "tombstone", "This message was deleted.", while the thread has replies).
 */
export function messageWrite(channel: string, m: Record<string, any>, type: string | undefined): { table: Table; row: Row } {
  return m.subtype === "tombstone" ? { table: TOMBSTONE, row: tombstone(channel, m.ts, type) } : { table: MESSAGE, row: messageRow(channel, m, type) };
}

/** A Socket Mode events_api body as the write it means: a message row, or a tombstone. Null for everything else. */
export function eventWrite(body: unknown): { table: Table; row: Row } | null {
  const ev = rec(rec(body)?.event);
  const channel = str(ev?.channel);
  if (!ev || ev.type !== "message" || !channel) return null;
  const type = channelType(ev.channel_type);
  if (ev.subtype === "message_deleted") {
    const ts = str(ev.deleted_ts);
    return ts ? { table: TOMBSTONE, row: tombstone(channel, ts, type) } : null;
  }
  const m = ev.subtype === "message_changed" ? rec(ev.message) : ev;
  if (!m || !str(m.ts)) return null;
  return messageWrite(channel, m, type);
}

/**
 * Writes one message row; a tombstone also blanks the message's earlier revisions in the change log, so deleted content
 * stays readable nowhere.
 */
export async function writeMessage(store: SourceStore, t: Table, row: Row, baseline: boolean): Promise<boolean> {
  const r = await store.upsert(t, row, { baseline });
  if (row.deleted)
    await store.pool.query(`UPDATE src_slack.change SET old_value = NULL, new_value = NULL WHERE entity = 'message' AND entity_id = $1 AND field = 'text' AND (old_value IS NOT NULL OR new_value IS NOT NULL)`, [`${row.channel_id}/${row.ts}`]);
  return r !== "same";
}

/**
 * The tee: writes each event in arrival order (an edit after its message), never blocking or failing the caller. While
 * the warehouse is unreachable at most MAX_PENDING writes wait; the rest are dropped (the gap sync fills them in).
 */
const MAX_PENDING = 5000;
export function slackTee(store: SourceStore, log: Logger): (body: unknown) => void {
  let chain = Promise.resolve();
  let pending = 0;
  let lastWarn = 0;
  const warn = (msg: string, err?: unknown) => {
    if (Date.now() - lastWarn > 60_000) (lastWarn = Date.now()), log.warn({ err: String(err ?? "").slice(0, 300), pending }, msg);
  };
  return (body) => {
    try {
      const w = eventWrite(body);
      if (!w) return;
      if (pending >= MAX_PENDING) return warn("src_slack backlog full; dropping events (the gap sync fills them in)");
      pending++;
      chain = chain
        .then(async () => {
          await store.migrate(DDL);
          await writeMessage(store, w.table, w.row, false);
        })
        .catch((err) => warn("src_slack write failed (the gap sync fills it in)", err))
        .finally(() => void pending--);
    } catch (err) {
      warn("src_slack event not understood", err);
    }
  };
}

export type Api = (method: string, params: Record<string, string>) => Promise<Record<string, any>>;

/** Slack Web API GET with the owner's token; waits out 429s (Retry-After) and retries. */
export function slackApi(token: string, fetchFn: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Api {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && attempt < 5) {
        await sleep((Number(res.headers.get("retry-after")) || 30) * 1000);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`);
      return json;
    }
  };
}

async function* pages(api: Api, method: string, params: Record<string, string>, key: string): AsyncGenerator<Record<string, any>> {
  let cursor = "";
  do {
    const r = await api(method, { ...params, limit: "200", ...(cursor ? { cursor } : {}) });
    for (const x of r[key] ?? []) yield x;
    cursor = r.response_metadata?.next_cursor ?? "";
  } while (cursor);
}

export const BASELINE_DAYS = 7;
const DAY = 86_400_000;
const tsAt = (ms: number) => (ms / 1000).toFixed(6);

/** A pass stops starting new conversations after this long; the rest are the oldest-synced, so the next pass takes them. */
export const PASS_BUDGET_MS = 10 * 60_000;
const PERMANENT = /channel_not_found|not_in_channel|missing_scope|is_archived|access_denied/;

/**
 * One time-boxed gap-sync pass over the conversations the owner is in, oldest-synced first (never-synced, then by when
 * each was last saved), stopping once `budgetMs` is spent (at least one conversation per pass); the rest wait for the
 * next pass. A channel's first pass is its baseline (the last BASELINE_DAYS days, baseline = true); later passes read
 * from its cursor (the newest ts seen). A reconcile cycle (weekly, and once for the first full baseline) re-reads the
 * last week of each channel and its threads and tombstones messages Slack no longer returns; it spans passes and is
 * recorded done only when every conversation was covered since the cycle began. People (users.list) are refreshed
 * daily. Returns rows written with a difference.
 */
export async function gapSync(store: SourceStore, api: Api, now = Date.now(), log?: Pick<Logger, "warn" | "info">, budgetMs = PASS_BUDGET_MS): Promise<number> {
  await store.migrate(DDL);
  const started = Date.now();
  let written = 0;
  const skipped: string[] = [];
  const put = async (t: Table, row: Row, baseline: boolean) => void ((await store.upsert(t, row, { baseline })) !== "same" && written++);

  const people = await store.scope("users");
  if (!people.cursor || now - Number(people.cursor) > DAY) {
    for await (const u of pages(api, "users.list", {}, "members"))
      await put(USERS, { user_id: u.id, handle: u.name ?? null, display_name: u.profile?.display_name || u.real_name || null, email: u.profile?.email ?? null, is_bot: !!u.is_bot }, !people.baselined);
    await store.saveScope("users", String(now), true);
  }

  // The reconcile cycle in progress (started after the last completed one), or a new one while the first baseline is
  // still open or once a week has passed.
  const rec = await store.scope("reconcile");
  const cyc = await store.scope("reconcile-cycle");
  let cycleStart: number | null = cyc.cursor && Number(cyc.cursor) > Number(rec.cursor ?? 0) ? Number(cyc.cursor) : null;
  if (cycleStart === null && (!rec.baselined || now - Number(rec.cursor) > 7 * DAY)) {
    cycleStart = now;
    await store.saveScope("reconcile-cycle", String(now), true);
  }
  const reconcile = !!rec.baselined && cycleStart !== null;

  const convs: { id: string; type: ReturnType<typeof conversationType> }[] = [];
  for await (const c of pages(api, "users.conversations", { types: "public_channel,private_channel,mpim,im", exclude_archived: "true" }, "channels")) {
    const type = conversationType(c);
    await put(CHANNEL, { channel_id: String(c.id), name: c.name ?? c.user ?? null, channel_type: type }, false);
    convs.push({ id: String(c.id), type });
  }
  const synced = await store.scopesByPrefix("channel:");
  const at = (id: string) => synced.get(`channel:${id}`)?.syncedAt ?? -1; // never synced sorts first
  const todo = convs.filter((c) => cycleStart === null || at(c.id) < cycleStart).sort((a, b) => at(a.id) - at(b.id));
  let handled = 0;

  for (const { id, type } of todo) {
    if (handled > 0 && Date.now() - started >= budgetMs) break;
    handled++;
    // One conversation Slack can't read (channel_not_found, not_in_channel, ...) is skipped; the pass goes on.
    try {
    const scope = `channel:${id}`;
    const st = synced.get(scope) ?? { baselined: false, cursor: null };
    const baseline = !st.baselined;
    const weekAgo = tsAt(now - BASELINE_DAYS * DAY);
    const oldest = st.cursor && !reconcile ? st.cursor : weekAgo;
    let newest = st.cursor ?? oldest;
    const seen = new Set<string>();
    const threads = new Set<string>();
    for await (const m of pages(api, "conversations.history", { channel: id, oldest }, "messages")) {
      seen.add(m.ts);
      const w = messageWrite(id, m, type);
      if (await writeMessage(store, w.table, w.row, baseline)) written++;
      if (Number(m.ts) > Number(newest)) newest = m.ts;
      if (m.reply_count && Number(m.latest_reply) > Number(oldest)) threads.add(m.ts);
    }
    // Threads under older parents that were active lately (seen live or by an earlier pass); the whole last week on a reconcile.
    const active = await store.pool.query(`SELECT DISTINCT thread_ts FROM src_slack.message WHERE channel_id = $1 AND thread_ts IS NOT NULL AND source_ts > now() - $2::interval`, [id, reconcile ? "7 days" : "1 day"]);
    for (const r of active.rows) threads.add(r.thread_ts);
    for (const ts of threads)
      for await (const m of pages(api, "conversations.replies", { channel: id, ts, oldest }, "messages")) {
        seen.add(m.ts);
        if (m.ts === ts && Number(ts) <= Number(oldest)) continue; // the parent comes back with every page
        const w = messageWrite(id, m, type);
        if (await writeMessage(store, w.table, w.row, baseline)) written++;
      }
    if (reconcile) {
      // Messages of the last week that Slack no longer returns were deleted while we weren't listening.
      const ours = await store.pool.query(`SELECT ts FROM src_slack.message WHERE channel_id = $1 AND NOT deleted AND ts > $2 AND (thread_ts IS NULL OR thread_ts = ts OR thread_ts = ANY($3))`, [id, weekAgo, [...threads]]);
      for (const r of ours.rows) if (!seen.has(r.ts) && (await writeMessage(store, TOMBSTONE, tombstone(id, r.ts, type), false))) written++;
    }
    await store.saveScope(scope, newest, true);
    } catch (err) {
      // Only errors that won't go away are skipped; anything else (rate limits, network, the database) fails the pass,
      // so it retries and a reconcile isn't recorded as done with channels missing.
      const msg = String((err as Error)?.message ?? err);
      if (!PERMANENT.test(msg)) throw err;
      skipped.push(`${id}: ${msg.slice(0, 80)}`);
      await store.saveScope(`channel:${id}`, null); // counts as covered this cycle and goes to the back of the line
    }
  }
  if (skipped.length) log?.warn({ skipped: skipped.slice(0, 20), count: skipped.length }, "src_slack gap sync skipped conversations it couldn't read");
  const left = todo.length - handled;
  log?.info({ processed: handled, pending: todo.length, listed: convs.length, left }, `src_slack gap sync: ${handled} of ${todo.length} pending conversations this pass (${convs.length} listed)`);
  if (cycleStart !== null && left === 0) await store.saveScope("reconcile", String(cycleStart), true);
  return written;
}

/** Runs the gap sync every `everyMs` (15 minutes), one pass at a time, each recorded in src_meta.ingest_run. */
export function startGapSync(store: SourceStore, token: string, log: Logger, everyMs = 15 * 60_000): void {
  const api = slackApi(token);
  const tick = async () => {
    try {
      const rows = await store.run("slack", "gap-sync", () => gapSync(store, api, Date.now(), log));
      log.info({ rows }, "src_slack gap sync done");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 300) }, "src_slack gap sync failed");
    }
    setTimeout(tick, everyMs).unref();
  };
  setTimeout(tick, 30_000).unref();
}
