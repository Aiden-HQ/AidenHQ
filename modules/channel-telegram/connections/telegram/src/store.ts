// The channel's own state: key-values (tokens, card messages, offsets), the reply-to-chat map and urgent cooldowns.
import Database from "better-sqlite3";

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS urgent_dms (channel_id TEXT, thread_key TEXT, posted_at INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS thread (channel TEXT, chat_id TEXT, message_id TEXT, issue_id TEXT, PRIMARY KEY (channel, chat_id, message_id));
    CREATE INDEX IF NOT EXISTS urgent_dms_thread ON urgent_dms (channel_id, thread_key, posted_at);`);

  const last = db.prepare(`SELECT MAX(posted_at) AS at FROM urgent_dms WHERE channel_id = ? AND thread_key = ?`);
  const urgent = db.prepare(`INSERT INTO urgent_dms (channel_id, thread_key, posted_at) VALUES (?, ?, ?)`);

  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  const threadSet = db.prepare(`INSERT OR REPLACE INTO thread (channel, chat_id, message_id, issue_id) VALUES (?, ?, ?, ?)`);
  const threadGet = db.prepare(`SELECT issue_id FROM thread WHERE channel = ? AND chat_id = ? AND message_id = ?`);

  return {
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    /** Which chat task a message we sent belongs to, so a reply to it continues that chat. */
    setThread: (channel: string, chatId: string, messageId: string, issueId: string): void => void threadSet.run(channel, chatId, messageId, issueId),
    threadOf: (channel: string, chatId: string, messageId: string): string | undefined => (threadGet.get(channel, chatId, messageId) as { issue_id: string } | undefined)?.issue_id,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
    lastUrgent: (channelId: string, threadKey: string): number | null => (last.get(channelId, threadKey) as { at: number | null }).at,
    recordUrgent: (channelId: string, threadKey: string, postedAt = Date.now()): void => void urgent.run(channelId, threadKey, postedAt),
  };
}
export type Store = ReturnType<typeof openStore>;
