import Database from "better-sqlite3";

export interface LiveEvent {
  eventId: string;
  kind: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  ts: string;
  text: string;
  permalink: string;
  receivedAt: number;
}

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, kind TEXT, channel_id TEXT, user_id TEXT,
      thread_ts TEXT, ts TEXT, text TEXT, permalink TEXT, received_at INTEGER, taken INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS urgent_dms (channel_id TEXT, thread_key TEXT, posted_at INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE INDEX IF NOT EXISTS urgent_dms_thread ON urgent_dms (channel_id, thread_key, posted_at);`);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (event_id, kind, channel_id, user_id, thread_ts, ts, text, permalink, received_at)
     VALUES (@eventId, @kind, @channelId, @userId, @threadTs, @ts, @text, @permalink, @receivedAt)`,
  );
  const pending = db.prepare(`SELECT * FROM events WHERE taken = 0 ORDER BY seq LIMIT ?`);
  const mark = db.prepare(`UPDATE events SET taken = 1 WHERE seq = ?`);
  const last = db.prepare(`SELECT MAX(posted_at) AS at FROM urgent_dms WHERE channel_id = ? AND thread_key = ?`);
  const urgent = db.prepare(`INSERT INTO urgent_dms (channel_id, thread_key, posted_at) VALUES (?, ?, ?)`);

  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);

  return {
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
    // False when event_id was already stored (Slack redelivery).
    insertEvent: (e: LiveEvent): boolean => insert.run({ ...e, threadTs: e.threadTs ?? null }).changes > 0,
    takePending: db.transaction((limit: number): LiveEvent[] => {
      const rows = pending.all(limit) as Record<string, any>[];
      for (const r of rows) mark.run(r.seq);
      return rows.map((r) => ({
        eventId: r.event_id, kind: r.kind, channelId: r.channel_id, userId: r.user_id,
        ...(r.thread_ts ? { threadTs: r.thread_ts } : {}),
        ts: r.ts, text: r.text, permalink: r.permalink, receivedAt: r.received_at,
      }));
    }),
    lastUrgent: (channelId: string, threadKey: string): number | null => (last.get(channelId, threadKey) as { at: number | null }).at,
    recordUrgent: (channelId: string, threadKey: string, postedAt = Date.now()): void => void urgent.run(channelId, threadKey, postedAt),
  };
}
export type Store = ReturnType<typeof openStore>;
