// The design service's store: runs in SQLite (DESIGN_DB), each run's evidence (the report's cited captures, fixes and notes)
// as files under <data>/evidence/<run>/. One store for every kind of run (review now; scan and pass in later phases).
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DAY = 86_400_000;
export const RETENTION_DAYS = 30;
const MAX_PUT_BYTES = 8 * 1024 * 1024;
const NAME = /^[\w-][\w.-]{0,119}\.(png|jpg|webp|json|md|diff)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", json: "application/json", md: "text/markdown", diff: "text/x-diff" };
const KINDS = new Set(["review", "scan", "pass"]);

type Row = { id: string; target: string; kind: string; app: string | null; task: string | null; agent: string; model: string; status: string; started: string; ended: string | null; cost_usd: number | null; report: string | null };

export interface Store {
  start(a: { target: string; kind: string; model: string; app?: string; task?: string; agent: string }): { run: string };
  put(run: string, agent: string, files: { name: string; data: string }[]): { stored: number };
  finish(run: string, agent: string, report: Record<string, unknown>): { url: string };
  runs(q: { app?: string; limit?: number }): { runs: Omit<Row, "report">[] };
  run(run: string): { run: Omit<Row, "report">; report: unknown; files: string[] };
  image(run: string, name: string): { data: string; type: string };
  sweep(): number;
}

export function openStore(dir: string, now: () => number = Date.now): Store {
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const db = new DatabaseSync(join(dir, "design.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, app TEXT, task TEXT, agent TEXT NOT NULL, model TEXT NOT NULL,
    status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, cost_usd REAL, report TEXT)`);
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

  return {
    start({ target, kind, model, app, task, agent }) {
      if (!target || !model) throw new Error("target and model are required");
      if (!KINDS.has(kind)) throw new Error(`kind is one of ${[...KINDS].join(", ")}`);
      const id = `r-${now().toString(36)}-${randomBytes(4).toString("hex")}`;
      db.prepare("INSERT INTO runs (id, target, kind, app, task, agent, model, status, started) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, target, kind, app ?? null, task ?? null, agent, model, "running", new Date(now()).toISOString());
      return { run: id };
    },
    put(run, agent, files) {
      if (own(run, agent).status !== "running") throw new Error(`run ${run} is finished`);
      if (!Array.isArray(files) || !files.length) throw new Error("files is a list of { name, data }");
      const decoded = files.map((f) => {
        if (typeof f?.name !== "string" || !NAME.test(f.name)) throw new Error(`file name ${String(f?.name).slice(0, 60)} isn't allowed (letters, digits, . _ -, ending .png .webp .json .md or .diff)`);
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
    image(run, name) {
      get(run);
      if (!NAME.test(name)) throw new Error("no such file");
      let data: Buffer;
      try { data = readFileSync(join(evidence(run), name)); } catch { throw new Error(`run ${run} has no ${name}`); }
      return { data: data.toString("base64"), type: TYPES[name.slice(name.lastIndexOf(".") + 1)]! };
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
