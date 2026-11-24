// The lane's operational state, outside model context. The conversation itself lives only in each agent's chat task
// (chat.ts). Here: each turn's timings (the latency record), pending wakes (wake_at) and what the lane still owes the owner
// (lane_owed: a promised answer the lane continues itself, or a background task whose chat_send hasn't come yet).
import Database from "better-sqlite3";

export interface Owed { id: number; agent: string; kind: "continue" | "task" | "deliver"; ask: string; attempts: number; due_at: number }
/** A wake into the agent's chat (`chat` 1) or onto a task. */
export interface Wake { id: number; agent: string; due_at: number; note: string; chat: number; task: string | null }

export function openLaneStore(path: string) {
  const db = new Database(path);
  // wake_at's cap is read and then written: per agent, those two run one at a time (the tool's check awaits the board).
  const wakeLocks = new Map<string, Promise<void>>();
  db.pragma("journal_mode = WAL");
  // The `conversation` columns are left from the lane's own message store (gone: tasks are the only conversation store); a
  // non-null one marks a chat wake.
  db.exec(`
    DROP TABLE IF EXISTS lane_messages;
    CREATE TABLE IF NOT EXISTS lane_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, conversation TEXT, model TEXT,
      received_at INTEGER, first_sent_at INTEGER, final_sent_at INTEGER, steps INTEGER, tools TEXT, status TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS lane_wakes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, due_at INTEGER, note TEXT,
      conversation TEXT, task TEXT, created_at INTEGER, fired_at INTEGER);
    CREATE INDEX IF NOT EXISTS lane_wakes_due ON lane_wakes (fired_at, due_at);
    CREATE TABLE IF NOT EXISTS lane_owed (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, conversation TEXT, kind TEXT, ask TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER, due_at INTEGER, done_at INTEGER);
    CREATE INDEX IF NOT EXISTS lane_owed_open ON lane_owed (done_at, due_at);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`);
  const q = {
    kvGet: db.prepare(`SELECT v FROM kv WHERE k = ?`),
    kvSet: db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`),
    turn: db.prepare(`INSERT INTO lane_turns (agent, conversation, model, received_at, status) VALUES (?, ?, ?, ?, 'running')`),
    first: db.prepare(`UPDATE lane_turns SET first_sent_at = ? WHERE id = ? AND first_sent_at IS NULL`),
    end: db.prepare(`UPDATE lane_turns SET final_sent_at = ?, steps = ?, tools = ?, status = ?, error = ? WHERE id = ?`),
    turns: db.prepare(`SELECT * FROM lane_turns WHERE agent = ? ORDER BY id DESC LIMIT ?`),
    wake: db.prepare(`INSERT INTO lane_wakes (agent, due_at, note, conversation, task, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    pendingWakes: db.prepare(`SELECT id, agent, due_at, note, conversation IS NOT NULL AS chat, task FROM lane_wakes WHERE agent = ? AND fired_at IS NULL ORDER BY due_at`),
    dueWakes: db.prepare(`SELECT id, agent, due_at, note, conversation IS NOT NULL AS chat, task FROM lane_wakes WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50`),
    fire: db.prepare(`UPDATE lane_wakes SET fired_at = ? WHERE id = ? AND fired_at IS NULL`),
    unfire: db.prepare(`UPDATE lane_wakes SET fired_at = NULL WHERE id = ?`),
    answered: db.prepare(`SELECT MAX(received_at) AS t FROM lane_turns WHERE agent = ? AND conversation = 'chat' AND status != 'running'`),
    owe: db.prepare(`INSERT INTO lane_owed (agent, conversation, kind, ask, created_at, due_at) VALUES (?, 'chat', ?, ?, ?, ?)`),
    due: db.prepare(`SELECT * FROM lane_owed WHERE done_at IS NULL AND kind = ? AND due_at <= ? ORDER BY id`),
    dueIn: db.prepare(`SELECT * FROM lane_owed WHERE done_at IS NULL AND kind = 'continue' AND agent = ? AND due_at <= ? ORDER BY id LIMIT 1`),
    anyOpen: db.prepare(`SELECT 1 FROM lane_owed WHERE done_at IS NULL AND kind = 'continue' AND agent = ? LIMIT 1`),
    attempt: db.prepare(`UPDATE lane_owed SET attempts = attempts + 1 WHERE id = ?`),
    retry: db.prepare(`UPDATE lane_owed SET due_at = ? WHERE id = ?`),
    settle: db.prepare(`UPDATE lane_owed SET done_at = ? WHERE id = ? AND done_at IS NULL`),
    settleAsk: db.prepare(`UPDATE lane_owed SET done_at = ? WHERE agent = ? AND kind = 'continue' AND ask = ? AND done_at IS NULL`),
    settleTasks: db.prepare(`UPDATE lane_owed SET done_at = ? WHERE agent = ? AND kind = 'task' AND done_at IS NULL`),
    running: db.prepare(`SELECT id, agent, received_at FROM lane_turns WHERE status = 'running'`),
    interrupt: db.prepare(`UPDATE lane_turns SET status = 'error', error = 'interrupted by a restart' WHERE id = ?`),
  };
  return {
    /** Small state of its own (each lane bot's Telegram offset). */
    getKv: (k: string): string | undefined => (q.kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string): void => void q.kvSet.run(k, v),
    /** `answers`: the turn answers an owner message (received at `receivedAt`), not a wake or a continuation. */
    startTurn(agent: string, model: string, receivedAt: number, answers = true): number {
      return Number(q.turn.run(agent, answers ? "chat" : "other", model, receivedAt).lastInsertRowid);
    },
    firstSent(turn: number, at = Date.now()): void {
      q.first.run(at, turn);
    },
    endTurn(turn: number, r: { steps: number; tools: string[]; status: "ok" | "error"; error?: string }, at = Date.now()): void {
      q.end.run(at, r.steps, r.tools.join(","), r.status, r.error ?? null, turn);
    },
    turns(agent: string, limit = 100): Record<string, unknown>[] {
      return q.turns.all(agent, limit) as Record<string, unknown>[];
    },
    /** A wake into the agent's chat (`chat`) or onto `task`. */
    addWake(agent: string, dueAt: number, note: string, chat: boolean, task: string | null, now = Date.now()): number {
      return Number(q.wake.run(agent, dueAt, note, chat ? "chat" : null, task, now).lastInsertRowid);
    },
    /** Runs `fn` after every earlier call for that agent finished: a cap read and its insert never interleave. */
    async withWakeLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
      const run = (wakeLocks.get(agent) ?? Promise.resolve()).then(fn);
      const tail = run.then(
        () => {},
        () => {},
      );
      wakeLocks.set(agent, tail);
      void tail.then(() => {
        if (wakeLocks.get(agent) === tail) wakeLocks.delete(agent);
      });
      return run;
    },
    pendingWakes(agent: string): Wake[] {
      return q.pendingWakes.all(agent) as Wake[];
    },
    /** Due wakes, each taken once (missed ones, e.g. while the service was down, fire once on the next pass). */
    takeDue(now = Date.now()): Wake[] {
      return (q.dueWakes.all(now) as Wake[]).filter((w) => q.fire.run(now, w.id).changes === 1);
    },
    /** A taken wake that could not be delivered: due again on the next pass. */
    unfire(id: number): void {
      q.unfire.run(id);
    },
    /** The newest owner message (its time) that a finished turn answered: later ones are unanswered. */
    answeredAt(agent: string): number {
      return ((q.answered.get(agent) as { t: number | null }).t) ?? 0;
    },
    /** Something the lane owes the owner in an agent's chat: `continue` (the lane finishes it) or `task` (a background run will). */
    owe(agent: string, kind: Owed["kind"], ask: string, dueAt: number, now = Date.now()): number {
      return Number(q.owe.run(agent, kind, ask, now, dueAt).lastInsertRowid);
    },
    due(kind: Owed["kind"], now = Date.now()): Owed[] {
      return q.due.all(kind, now) as Owed[];
    },
    /** The agent's next due continuation. */
    dueIn(agent: string, now = Date.now()): Owed | undefined {
      return q.dueIn.get(agent, now) as Owed | undefined;
    },
    owesContinue(agent: string): boolean {
      return Boolean(q.anyOpen.get(agent));
    },
    attempt(id: number): void {
      q.attempt.run(id);
    },
    retryAt(id: number, at: number): void {
      q.retry.run(at, id);
    },
    settle(id: number, now = Date.now()): void {
      q.settle.run(now, id);
    },
    /** A fresh answer to an ask settles the continuation owed for that same ask. */
    settleAsk(agent: string, ask: string, now = Date.now()): void {
      q.settleAsk.run(now, agent, ask);
    },
    settleTasks(agent: string, now = Date.now()): void {
      q.settleTasks.run(now, agent);
    },
    /** Turns a restart cut off: marked as such, and returned so the lane can finish them. */
    interrupted(): { agent: string; received_at: number }[] {
      const rows = q.running.all() as { id: number; agent: string; received_at: number }[];
      for (const r of rows) q.interrupt.run(r.id);
      return rows;
    },
  };
}
export type LaneStore = ReturnType<typeof openLaneStore>;
