// The channel's own state: key-values (tokens, card messages, offsets) and the reply-to-chat map.
import Database from "better-sqlite3";

/** What a pairing code did: paired this chat, was right but past its 15 minutes, or matched no live code. */
export type TakePairCode = "paired" | "expired" | "wrong";

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS pair_code (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS thread (channel TEXT, chat_id TEXT, message_id TEXT, issue_id TEXT, PRIMARY KEY (channel, chat_id, message_id));`);

  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  const threadSet = db.prepare(`INSERT OR REPLACE INTO thread (channel, chat_id, message_id, issue_id) VALUES (?, ?, ?, ?)`);
  const threadGet = db.prepare(`SELECT issue_id FROM thread WHERE channel = ? AND chat_id = ? AND message_id = ?`);

  // Pairing (pair.ts): at most one live code, kept as its hash. Using it and recording the owner chat is one transaction.
  const codeClear = db.prepare(`DELETE FROM pair_code`);
  const codeAdd = db.prepare(`INSERT INTO pair_code (hash, expires) VALUES (?, ?)`);
  const codeTake = db.prepare(`DELETE FROM pair_code WHERE hash = ? RETURNING expires`);
  const putPairCode = db.transaction((hash: string, expires: number) => {
    codeClear.run();
    codeAdd.run(hash, expires);
  });
  const takePairCode = db.transaction((hash: string, chatId: string, now: number): TakePairCode => {
    const row = codeTake.get(hash) as { expires: number } | undefined;
    if (!row) return "wrong";
    if (row.expires < now) return "expired";
    kvSet.run("owner_chat", chatId);
    kvSet.run("paired_at", new Date(now).toISOString());
    return "paired";
  });

  return {
    /** The paired owner chat's id (Telegram), or undefined before pairing. */
    ownerChat: (): string | undefined => (kvGet.get("owner_chat") as { v: string } | undefined)?.v || undefined,
    /** When the owner chat was last set (ISO), so the board can tell a re-pair finished. */
    pairedAt: (): string | undefined => (kvGet.get("paired_at") as { v: string } | undefined)?.v || undefined,
    setOwnerChat: (chatId: string, now = Date.now()): void => {
      kvSet.run("owner_chat", chatId);
      kvSet.run("paired_at", new Date(now).toISOString());
    },
    putPairCode: (hash: string, expires: number): void => putPairCode(hash, expires),
    /** Uses the code with this hash, if live, and makes chatId the owner chat. An expired code is used up too, and says so. */
    takePairCode: (hash: string, chatId: string, now: number): TakePairCode => takePairCode(hash, chatId, now),
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    /** Which chat task a message we sent belongs to, so a reply to it continues that chat. */
    setThread: (channel: string, chatId: string, messageId: string, issueId: string): void => void threadSet.run(channel, chatId, messageId, issueId),
    threadOf: (channel: string, chatId: string, messageId: string): string | undefined => (threadGet.get(channel, chatId, messageId) as { issue_id: string } | undefined)?.issue_id,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
  };
}
export type Store = ReturnType<typeof openStore>;
