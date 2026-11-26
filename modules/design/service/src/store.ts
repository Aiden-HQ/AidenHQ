// The design service's store: runs in SQLite (DESIGN_DB), each run's evidence (the report's cited captures, fixes and notes)
// as files under <data>/evidence/<run>/. One store for every kind of run: a review an agent starts, and a pass (passes.ts) the
// service files for an app.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DAY = 86_400_000;
export const RETENTION_DAYS = 30;
const MAX_PUT_BYTES = 8 * 1024 * 1024;
const NAME = /^[\w-][\w.-]{0,119}\.(png|jpg|webp|json|md|diff|webm)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", json: "application/json", md: "text/markdown", diff: "text/x-diff", webm: "video/webm" };
/** An issue marker: an app's one design issue, or one verified bug of it (the engine's issue.ts builds them). */
export const MARKER = /^aidenhq-ui:(design:([a-z][a-z0-9-]{1,30})|bug:([a-z][a-z0-9-]{1,30}):[0-9a-f]{12})$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
/** An issue the UI Reviewer filed or adopted for a marker in a repo: refreshed by number from then on, never searched for again. */
export type IssueRow = { app: string; repo: string; marker: string; number: number };
const KINDS = new Set(["review", "scan", "pass"]);

type Row = { id: string; target: string; kind: string; app: string | null; task: string | null; agent: string; model: string; status: string; started: string; ended: string | null; cost_usd: number | null; report: string | null; depth: string | null; mode: string | null; source: string | null; trigger: string | null; why: string | null; stopping: string | null; slot: number | null };
/** A pass's run as passes.ts and jobtools.ts read it. */
export type PassRow = Omit<Row, "report">;

export interface Store {
  start(a: { target: string; kind: string; model: string; app?: string; task?: string; agent: string }): { run: string };
  put(run: string, agent: string, files: { name: string; data: string }[]): { stored: number };
  finish(run: string, agent: string, report: Record<string, unknown>): { url: string };
  /**
   * A pass's run, filed by the service itself (passes.ts): `agent` and `task` are set once its task is filed (bindPass). It holds
   * its app's one slot (the unique index runs_active) from here until its job has ended (release, endPass), past
   * design_run_finish: while one holds it, the answer names that run instead.
   */
  startPass(a: { app: string; target: string; model: string; depth: string; mode: string; trigger: string }): { run: string } | { running: string };
  bindPass(run: string, task: string, agent: string, source: string): void;
  /** A pass ends: `failed` with why, or `stopped` (the owner's Stop, once its job ended), unless it already finished. Frees the app. */
  endPass(run: string, status: "failed" | "stopped", why: string): void;
  /** The owner asked to stop the pass: it stays running ("stopping") until its job has ended. */
  markStopping(run: string): void;
  pass(run: string): PassRow | undefined;
  /** The pass holding the app's slot, if any (running, or finished while its job still ends). */
  active(app: string): PassRow | undefined;
  /** Every pass holding its app's slot (the scheduler's reconcile). */
  holding(): PassRow[];
  /** The app's passes started or ended at or after `since` (ISO), newest first. */
  passesSince(app: string, since: string): PassRow[];
  /** The app's newest ended pass that stored a coverage queue (queue.json), with what the queue has left to do. */
  lastQueue(app: string): { run: string; left: number } | undefined;
  runs(q: { app?: string; limit?: number }): { runs: Omit<Row, "report">[] };
  run(run: string): { run: Omit<Row, "report">; report: unknown; files: string[] };
  /** An evidence file as base64, whole or the `length` bytes from `offset` (a box reads a big file in parts: the proxy's answers are 1 MB at most). */
  image(run: string, name: string, part?: { offset: number; length: number }): { data: string; type: string; size: number };
  /** Remembers the issue number of a marker in a repo (repo names compare without case). */
  noteIssue(i: IssueRow): IssueRow;
  /** The app's known issues, of one repo when given. */
  issues(app: string, repo?: string): IssueRow[];
  sweep(): number;
}

export function openStore(dir: string, now: () => number = Date.now): Store {
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const db = new DatabaseSync(join(dir, "design.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, app TEXT, task TEXT, agent TEXT NOT NULL, model TEXT NOT NULL,
    status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, cost_usd REAL, report TEXT)`);
  // data_version 1: a pass's depth (scan | signed-in | tester), live-app mode and task source. 2: what started it (request | deploy
  // | always), why it failed, when its stop was asked; and one running pass per app (runs_active), the newest kept from before it.
  const cols = new Set((db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["depth", "mode", "source", "trigger", "why", "stopping"]) if (!cols.has(c)) db.exec(`ALTER TABLE runs ADD COLUMN ${c} TEXT`);
  if (!cols.has("slot")) db.exec(`DROP INDEX IF EXISTS runs_active; ALTER TABLE runs ADD COLUMN slot INTEGER;
    UPDATE runs SET status = 'superseded', ended = started WHERE kind = 'pass' AND status = 'running' AND id NOT IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY app ORDER BY started DESC, id DESC) AS n FROM runs WHERE kind = 'pass' AND status = 'running') WHERE n = 1);
    UPDATE runs SET slot = 1 WHERE kind = 'pass' AND status = 'running';`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_active ON runs(app) WHERE kind = 'pass' AND slot = 1");
  // data_version 3: the issues each app's passes filed, by marker and repo (lowercase owner/name).
  db.exec("CREATE TABLE IF NOT EXISTS issues (app TEXT NOT NULL, repo TEXT NOT NULL, marker TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (app, repo, marker))");
  const evidence = (run: string) => join(dir, "evidence", run);
  const get = (run: string): Row => {
    if (!/^[\w-]{1,40}$/.test(run)) throw new Error(`no run ${run}`);
    const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(run) as Row | undefined;
    if (!r) throw new Error(`no run ${run}`);
    return r;
  };
  const own = (run: string, agent: string) => {
    const r = get(run);
    if (r.agent !== agent) throw new Error(`run ${run} belongs to another agent`);
    return r;
  };
  const head = ({ report: _r, ...r }: Row) => r;
  const newId = () => `r-${now().toString(36)}-${randomBytes(4).toString("hex")}`;

  return {
    start({ target, kind, model, app, task, agent }) {
      if (!target || !model) throw new Error("target and model are required");
      if (!KINDS.has(kind)) throw new Error(`kind is one of ${[...KINDS].join(", ")}`);
      const id = newId();
      db.prepare("INSERT INTO runs (id, target, kind, app, task, agent, model, status, started) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, target, kind, app ?? null, task ?? null, agent, model, "running", new Date(now()).toISOString());
      return { run: id };
    },
    startPass({ app, target, model, depth, mode, trigger }) {
      const id = newId(), at = new Date(now()).toISOString();
      try {
        db.prepare("INSERT INTO runs (id, target, kind, app, agent, model, status, started, depth, mode, trigger, slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)")
          .run(id, target, "pass", app, "", model, "running", at, depth, mode, trigger);
      } catch (e) {
        const active = db.prepare("SELECT id FROM runs WHERE kind = 'pass' AND slot = 1 AND app = ?").get(app) as { id: string } | undefined;
        if (active) return { running: active.id };
        throw e;
      }
      return { run: id };
    },
    bindPass(run, task, agent, source) { db.prepare("UPDATE runs SET task = ?, agent = ?, source = ? WHERE id = ? AND kind = 'pass'").run(task, agent, source, run); },
    endPass(run, status, why) {
      const at = new Date(now()).toISOString();
      db.prepare("UPDATE runs SET status = ?, why = ?, ended = ? WHERE id = ? AND kind = 'pass' AND status = 'running'").run(status, why.slice(0, 300), at, run);
      db.prepare("UPDATE runs SET slot = NULL WHERE id = ? AND kind = 'pass'").run(run);
    },
    markStopping(run) { db.prepare("UPDATE runs SET stopping = COALESCE(stopping, ?) WHERE id = ? AND kind = 'pass' AND slot = 1").run(new Date(now()).toISOString(), run); },
    pass(run) {
      if (!/^[\w-]{1,40}$/.test(run)) return undefined;
      const r = db.prepare("SELECT * FROM runs WHERE id = ? AND kind = 'pass'").get(run) as Row | undefined;
      return r && head(r);
    },
    active(app) {
      const r = db.prepare("SELECT * FROM runs WHERE kind = 'pass' AND slot = 1 AND app = ?").get(app) as Row | undefined;
      return r && head(r);
    },
    holding() { return (db.prepare("SELECT * FROM runs WHERE kind = 'pass' AND slot = 1 ORDER BY started").all() as Row[]).map(head); },
    passesSince(app, since) { return (db.prepare("SELECT * FROM runs WHERE kind = 'pass' AND app = ? AND (started >= ? OR ended >= ?) ORDER BY started DESC").all(app, since, since) as Row[]).map(head); },
    lastQueue(app) {
      for (const { id } of db.prepare("SELECT id FROM runs WHERE kind = 'pass' AND app = ? AND status != 'running' ORDER BY started DESC LIMIT 20").all(app) as { id: string }[]) {
        let items: unknown;
        try { items = JSON.parse(readFileSync(join(evidence(id), "queue.json"), "utf8")); } catch { continue; }
        if (!Array.isArray(items)) continue;
        return { run: id, left: items.filter((i) => i && typeof i === "object" && ["todo", "deferred"].includes(String((i as { status?: unknown }).status))).length };
      }
      return undefined;
    },
    put(run, agent, files) {
      if (own(run, agent).status !== "running") throw new Error(`run ${run} is finished`);
      if (!Array.isArray(files) || !files.length) throw new Error("files is a list of { name, data }");
      const decoded = files.map((f) => {
        if (typeof f?.name !== "string" || !NAME.test(f.name)) throw new Error(`file name ${String(f?.name).slice(0, 60)} isn't allowed (letters, digits, . _ -, ending .png .jpg .webp .json .md .diff or .webm)`);
        if (typeof f.data !== "string") throw new Error(`${f.name} has no data`);
        return { name: f.name, bytes: Buffer.from(f.data, "base64") };
      });
      if (decoded.reduce((n, f) => n + f.bytes.length, 0) > MAX_PUT_BYTES) throw new Error("a call takes at most 8 MB; put fewer files per call");
      mkdirSync(evidence(run), { recursive: true });
      for (const f of decoded) writeFileSync(join(evidence(run), f.name), f.bytes);
      return { stored: decoded.length };
    },
    finish(run, agent, report) {
      if (own(run, agent).status !== "running") throw new Error(`run ${run} is finished`);
      if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("report is the run's report object");
      const cost = typeof report.cost_usd === "number" ? report.cost_usd : null;
      db.prepare("UPDATE runs SET status = 'done', ended = ?, cost_usd = ?, report = ? WHERE id = ?").run(new Date(now()).toISOString(), cost, JSON.stringify(report), run);
      return { url: `/design/runs/${run}` };
    },
    runs({ app, limit }) {
      const n = Math.min(Math.max(Math.trunc(Number(limit ?? 20)) || 20, 1), 200);
      const rows = (app
        ? db.prepare("SELECT * FROM runs WHERE app = ? ORDER BY started DESC LIMIT ?").all(app, n)
        : db.prepare("SELECT * FROM runs ORDER BY started DESC LIMIT ?").all(n)) as Row[];
      return { runs: rows.map(head) };
    },
    run(run) {
      const r = get(run);
      let files: string[] = [];
      try { files = readdirSync(evidence(run)).sort(); } catch { /* no evidence yet */ }
      return { run: head(r), report: r.report ? JSON.parse(r.report) : null, files };
    },
    image(run, name, part) {
      get(run);
      if (!NAME.test(name)) throw new Error("no such file");
      let data: Buffer;
      try { data = readFileSync(join(evidence(run), name)); } catch { throw new Error(`run ${run} has no ${name}`); }
      const at = Math.max(0, Math.trunc(part?.offset ?? 0)), slice = part ? data.subarray(at, at + Math.max(0, Math.trunc(part.length))) : data;
      return { data: slice.toString("base64"), type: TYPES[name.slice(name.lastIndexOf(".") + 1)]!, size: data.length };
    },
    noteIssue({ app, repo, marker, number }) {
      const m = MARKER.exec(String(marker));
      if (!m || (m[2] ?? m[3]) !== app) throw new Error(`marker is aidenhq-ui:design:${String(app).slice(0, 40)} or aidenhq-ui:bug:${String(app).slice(0, 40)}:<12 hex>, as ui-review issue-body prints it`);
      if (!REPO.test(String(repo))) throw new Error("repo is owner/name");
      if (!Number.isInteger(number) || number < 1) throw new Error("number is the issue's number");
      const r = { app, repo: repo.toLowerCase(), marker, number };
      db.prepare("INSERT INTO issues (app, repo, marker, number) VALUES (?,?,?,?) ON CONFLICT (app, repo, marker) DO UPDATE SET number = excluded.number").run(r.app, r.repo, r.marker, r.number);
      return r;
    },
    issues(app, repo) {
      return ((repo === undefined
        ? db.prepare("SELECT app, repo, marker, number FROM issues WHERE app = ? ORDER BY marker").all(app)
        : db.prepare("SELECT app, repo, marker, number FROM issues WHERE app = ? AND repo = ? ORDER BY marker").all(app, repo.toLowerCase())) as IssueRow[]).map((r) => ({ ...r }));
    },
    // Older than 30 days goes, except each app's (or, with no app, each target's) latest finished run.
    sweep() {
      const cut = new Date(now() - RETENTION_DAYS * DAY).toISOString();
      const old = db.prepare(`SELECT id FROM runs WHERE started < ? AND id NOT IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(app, target) ORDER BY started DESC) AS n FROM runs WHERE status = 'done') WHERE n = 1)`).all(cut) as { id: string }[];
      for (const { id } of old) {
        rmSync(evidence(id), { recursive: true, force: true });
        db.prepare("DELETE FROM runs WHERE id = ?").run(id);
      }
      return old.length;
    },
  };
}
