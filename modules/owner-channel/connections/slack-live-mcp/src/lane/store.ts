// The lane's durable state, outside model context: every conversation's messages (the agent's own replies included),
// each turn's timings (the latency record), pending wakes (wake_at) and what the lane still owes the owner (lane_owed: a
// promised answer the lane continues itself, or a background task whose chat_send hasn't come yet).
import Database from "better-sqlite3";

export type Role = "owner" | "agent" | "wake";
export interface LaneMessage { id: number; agent: string; conversation: string; role: Role; text: string; at: number }
export interface Owed { id: number; agent: string; conversation: string; kind: "continue" | "task"; ask: string; attempts: number; due_at: number }
export interface Wake { id: number; agent: string; due_at: number; note: string; conversation: string | null; task: string | null }

export function openLaneStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lane_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, conversation TEXT, role TEXT, text TEXT, at INTEGER);
    CREATE INDEX IF NOT EXISTS lane_messages_conv ON lane_messages (agent, conversation, id);
    CREATE TABLE IF NOT EXISTS lane_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, conversation TEXT, model TEXT,
      received_at INTEGER, first_sent_at INTEGER, final_sent_at INTEGER, steps INTEGER, tools TEXT, status TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS lane_wakes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, due_at INTEGER, note TEXT,
      conversation TEXT, task TEXT, created_at INTEGER, fired_at INTEGER);
    CREATE INDEX IF NOT EXISTS lane_wakes_due ON lane_wakes (fired_at, due_at);
    CREATE TABLE IF NOT EXISTS lane_owed (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, conversation TEXT, kind TEXT, ask TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER, due_at INTEGER, done_at INTEGER);
    CREATE INDEX IF NOT EXISTS lane_owed_open ON lane_owed (done_at, due_at);`);
  const q = {
    add: db.prepare(`INSERT INTO lane_messages (agent, conversation, role, text, at) VALUES (?, ?, ?, ?, ?)`),
    recent: db.prepare(`SELECT * FROM lane_messages WHERE agent = ? AND conversation = ? AND at >= ? ORDER BY id DESC LIMIT ?`),
    after: db.prepare(`SELECT * FROM lane_messages WHERE agent = ? AND conversation = ? AND id > ? ORDER BY id LIMIT 500`),
    owns: db.prepare(`SELECT 1 FROM lane_messages WHERE agent = ? AND conversation = ? LIMIT 1`),
    turn: db.prepare(`INSERT INTO lane_turns (agent, conversation, model, received_at, status) VALUES (?, ?, ?, ?, 'running')`),
    first: db.prepare(`UPDATE lane_turns SET first_sent_at = ? WHERE id = ? AND first_sent_at IS NULL`),
    end: db.prepare(`UPDATE lane_turns SET final_sent_at = ?, steps = ?, tools = ?, status = ?, error = ? WHERE id = ?`),
    turns: db.prepare(`SELECT * FROM lane_turns WHERE agent = ? ORDER BY id DESC LIMIT ?`),
    wake: db.prepare(`INSERT INTO lane_wakes (agent, due_at, note, conversation, task, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    pendingWakes: db.prepare(`SELECT * FROM lane_wakes WHERE agent = ? AND fired_at IS NULL ORDER BY due_at`),
    dueWakes: db.prepare(`SELECT * FROM lane_wakes WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50`),
    fire: db.prepare(`UPDATE lane_wakes SET fired_at = ? WHERE id = ? AND fired_at IS NULL`),
    owe: db.prepare(`INSERT INTO lane_owed (agent, conversation, kind, ask, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?)`),
    due: db.prepare(`SELECT * FROM lane_owed WHERE done_at IS NULL AND kind = ? AND due_at <= ? ORDER BY id`),
    dueIn: db.prepare(`SELECT * FROM lane_owed WHERE done_at IS NULL AND kind = 'continue' AND agent = ? AND conversation = ? AND due_at <= ? ORDER BY id LIMIT 1`),
    anyOpen: db.prepare(`SELECT 1 FROM lane_owed WHERE done_at IS NULL AND kind = 'continue' AND agent = ? AND conversation = ? LIMIT 1`),
    attempt: db.prepare(`UPDATE lane_owed SET attempts = attempts + 1 WHERE id = ?`),
    retry: db.prepare(`UPDATE lane_owed SET due_at = ? WHERE id = ?`),
    settle: db.prepare(`UPDATE lane_owed SET done_at = ? WHERE id = ? AND done_at IS NULL`),
    settleTasks: db.prepare(`UPDATE lane_owed SET done_at = ? WHERE agent = ? AND conversation = ? AND kind = 'task' AND done_at IS NULL`),
    running: db.prepare(`SELECT id, agent, conversation, received_at FROM lane_turns WHERE status = 'running'`),
    interrupt: db.prepare(`UPDATE lane_turns SET status = 'error', error = 'interrupted by a restart' WHERE id = ?`),
  };
  return {
    add(agent: string, conversation: string, role: Role, text: string, at = Date.now()): number {
      return Number(q.add.run(agent, conversation, role, text, at).lastInsertRowid);
    },
    /** The last `limit` messages since `since`, oldest first. */
    recent(agent: string, conversation: string, since: number, limit = 20): LaneMessage[] {
      return (q.recent.all(agent, conversation, since, limit) as LaneMessage[]).reverse();
    },
    after(agent: string, conversation: string, id: number): LaneMessage[] {
      return q.after.all(agent, conversation, id) as LaneMessage[];
    },
    owns(agent: string, conversation: string): boolean {
      return Boolean(q.owns.get(agent, conversation));
    },
    startTurn(agent: string, conversation: string, model: string, receivedAt: number): number {
      return Number(q.turn.run(agent, conversation, model, receivedAt).lastInsertRowid);
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
    addWake(agent: string, dueAt: number, note: string, conversation: string | null, task: string | null, now = Date.now()): number {
      return Number(q.wake.run(agent, dueAt, note, conversation, task, now).lastInsertRowid);
    },
    pendingWakes(agent: string): Wake[] {
      return q.pendingWakes.all(agent) as Wake[];
    },
    /** Due wakes, each taken once (missed ones, e.g. while the service was down, fire once on the next pass). */
    takeDue(now = Date.now()): Wake[] {
      return (q.dueWakes.all(now) as Wake[]).filter((w) => q.fire.run(now, w.id).changes === 1);
    },
    /** Something the lane owes the owner in a conversation: `continue` (the lane finishes it) or `task` (a background run will). */
    owe(agent: string, conversation: string, kind: Owed["kind"], ask: string, dueAt: number, now = Date.now()): number {
      return Number(q.owe.run(agent, conversation, kind, ask, now, dueAt).lastInsertRowid);
    },
    due(kind: Owed["kind"], now = Date.now()): Owed[] {
      return q.due.all(kind, now) as Owed[];
    },
    /** The next due continuation for this conversation. */
    dueIn(agent: string, conversation: string, now = Date.now()): Owed | undefined {
      return q.dueIn.get(agent, conversation, now) as Owed | undefined;
    },
    owesContinue(agent: string, conversation: string): boolean {
      return Boolean(q.anyOpen.get(agent, conversation));
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
    settleTasks(agent: string, conversation: string, now = Date.now()): void {
      q.settleTasks.run(now, agent, conversation);
    },
    /** Turns a restart cut off: marked as such, and returned so the lane can finish them. */
    interrupted(): { agent: string; conversation: string; received_at: number }[] {
      const rows = q.running.all() as { id: number; agent: string; conversation: string; received_at: number }[];
      for (const r of rows) q.interrupt.run(r.id);
      return rows;
    },
  };
}
export type LaneStore = ReturnType<typeof openLaneStore>;
