// GET /v1/tasks/state's read: the state (task-state.ts) of a batch of tasks (`ids`, ids or identifiers) or of every open one
// (with those closed after `closed_since`, the board's Done), from the fact log on the reader's own read-only connection, in one snapshot (one transaction), with the fleet's counts.
import { DatabaseSync } from "node:sqlite";
import type { FactRow } from "./facts.ts";
import type { Stage } from "./flow-stages.ts";
import { taskState } from "./task-state.ts";
import type { IssueRow, StateRead, StateRow } from "../sdk/src/task-state-types.ts";

export type Agent = { name: string; terminated: boolean };

const DAY = 864e5;
const CLOSED = new Set(["done", "cancelled"]);
const UNEXPLAINED = new Set(["unpolled", "orphaned", "unknown", "history_expired"]);
const taskOf = (f: FactRow) => f.task ?? (f.subject.startsWith("task:") ? f.subject.slice(5) : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FRESH_MS = 5 * 60_000;

export function createTaskStateRead({ file, stages, agent, polled = () => true, now = () => Date.now() }: {
  file: string; stages: () => Stage[];
  agent?: (id: string) => Promise<Agent | undefined>;
  /** Whether an enabled dispatcher runs this agent (compile's `dispatches`): a held task nobody polls is `unpolled`, not `orphaned`. */
  polled?: (agent: string) => boolean;
  now?: () => number;
}) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const row = (r: any): FactRow => ({ ...r, data: JSON.parse(r.data) });
  const chunked = <T>(sql: (marks: string) => string, xs: string[], map: (r: any) => T): T[] => {
    const out: T[] = [];
    for (let i = 0; i < xs.length; i += 400) { const c = xs.slice(i, i + 400); out.push(...(db.prepare(sql(c.map(() => "?").join(","))).all(...c) as any[]).map(map)); }
    return out;
  };

  /** Every open task, and each closed at or after `closedSince` (its latest status fact, by kernel time). */
  function openIds(closedSince?: number): string[] {
    const rows = db.prepare(`SELECT subject, at, json_extract(data, '$.to') AS st FROM (SELECT subject, at, data, ROW_NUMBER() OVER (PARTITION BY subject ORDER BY at DESC, seq DESC) AS n
      FROM facts WHERE type = 'task.status_changed') WHERE n = 1`).all() as { subject: string; at: string; st: string }[];
    return rows.filter((r) => r.subject.startsWith("task:") && (!CLOSED.has(r.st) || (closedSince !== undefined && Date.parse(r.at) >= closedSince))).map((r) => r.subject.slice(5));
  }
  /** Identifiers (WOR-1) to ids, from their task.created; anything else is taken as an id. */
  function resolve(xs: string[]): string[] {
    const byIdent = new Map(chunked((m) => `SELECT subject, json_extract(data, '$.identifier') AS ident FROM facts WHERE type = 'task.created' AND json_extract(data, '$.identifier') IN (${m})`, xs, (r) => [r.ident as string, (r.subject as string).slice(5)] as const));
    return [...new Set(xs.map((x) => byIdent.get(x) ?? x))];
  }

  function states(ids: string[], t: number): StateRow[] {
    const facts = chunked((m) => `SELECT * FROM facts WHERE task IN (${m})`, ids, row);
    const byTask = new Map<string, FactRow[]>();
    for (const f of facts) { const k = taskOf(f); if (k) (byTask.get(k) ?? byTask.set(k, []).get(k)!).push(f); }
    const blockers = new Set<string>();
    for (const fs of byTask.values()) {
      const b = fs.filter((f) => f.type === "task.blocked_changed").sort((a, c) => a.at.localeCompare(c.at) || a.seq - c.seq).at(-1);
      if (Array.isArray(b?.data.blocked_by)) for (const x of b!.data.blocked_by) blockers.add(`task:${String(x)}`);
    }
    const ctx = chunked((m) => `SELECT * FROM facts WHERE subject IN (${m}) AND type IN ('task.created', 'task.status_changed')`, [...blockers], row);
    const all = stages();
    const out: StateRow[] = [];
    for (const id of ids) {
      const fs = byTask.get(id);
      if (!fs?.length) continue;
      const s = taskState(id, [...fs, ...ctx], t, all, polled);
      const created = fs.find((f) => f.type === "task.created" && f.subject === `task:${id}`);
      const idleWakes = fs.filter((f) => f.type === "wake.opened" && f.data.cause === "idle" && Date.parse(f.at) > t - DAY && Date.parse(f.at) <= t).length;
      out.push({ ...s, task: id, identifier: typeof created?.data.identifier === "string" ? created.data.identifier : null, idle_wakes: idleWakes, origin: typeof created?.data.origin === "string" ? created.data.origin : null });
    }
    return out;
  }

  const known = new Map<string, { at: number; agent: Agent | undefined }>();
  return {
    /** The issue mirror's rows (wakes.ts) for `ids` (ids or identifiers, ≤ 200): no Paperclip read. */
    issues(ids: string[]): { issues: IssueRow[] } {
      ids = ids.slice(0, 200);
      if (!ids.length) return { issues: [] };
      const m = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT task AS id, identifier, title, NULLIF(status, '') AS status, json_extract(issue, '$.assigneeAgentId') AS assignee, parent, updated_at FROM task_facts_seen WHERE task IN (${m}) OR identifier IN (${m})`).all(...ids, ...ids) as unknown as IssueRow[];
      return { issues: rows };
    },
    /** A read with the removed agents' holders named, each from its own record (the company agent lists leave terminated agents out): read once per 5 minutes per holder, and a bad read leaves that row as it is. */
    async named(r: StateRead): Promise<StateRead> {
      if (!agent) return r;
      const ids = [...new Set(r.tasks.flatMap((x) => (x.holder && UUID.test(x.holder) ? [x.holder] : [])))]; // a key ("owner", "app-maintainer") is no Paperclip agent
      await Promise.all(ids.map(async (id) => {
        const k = known.get(id);
        if (k && now() - k.at <= AGENT_FRESH_MS) return;
        try { known.set(id, { at: now(), agent: await agent(id) }); } catch { /* the row keeps its raw id */ }
      }));
      return { ...r, tasks: r.tasks.map((x) => { const a = x.holder ? known.get(x.holder)?.agent : undefined; return a?.terminated ? { ...x, holder_name: a.name, holder_gone: true as const } : x; }) };
    },
    /**
     * `ids` (≤ 200, ids or identifiers; an id with no facts has no row) or `open` (with `closed_since`, an instant: the tasks closed
     * since then too); rows needing attention first, then by `since`.
     */
    read(q: { ids?: string[]; open?: boolean; closed_since?: string }): StateRead {
      const t = now();
      db.exec("BEGIN");
      let tasks: StateRow[];
      try {
        tasks = states(q.open ? openIds(q.closed_since ? Date.parse(q.closed_since) : undefined) : resolve(q.ids ?? []), t);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      tasks.sort((a, b) => Number(b.attention.length > 0) - Number(a.attention.length > 0) || a.since.localeCompare(b.since));
      const has = (r: StateRow, p: (a: StateRow["attention"][number]) => boolean) => r.attention.some(p);
      return {
        as_of: new Date(t).toISOString(),
        tasks,
        counts: {
          needs_you: tasks.filter((r) => has(r, (a) => a.who === "owner")).length,
          failed: tasks.filter((r) => has(r, (a) => a.why === "failed")).length,
          unexplained_idle: tasks.filter((r) => has(r, (a) => UNEXPLAINED.has(a.why))).length,
        },
      };
    },
  };
}
export type TaskStateRead = ReturnType<typeof createTaskStateRead>;
