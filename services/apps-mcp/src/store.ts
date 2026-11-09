// Observations only (deploys, incidents). Desired state lives in git (the instance apps.yaml + config/apps.modules.yaml).
import Database from "better-sqlite3";

export interface Deploy { id: number; app: string; sha: string; images_json: string; by: string; at: number; status: string; detail: string }
export interface Incident { id: number; app: string; opened_at: number; closed_at: number | null; kind: string; detail: string; notified: number }

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploys (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, sha TEXT, images_json TEXT, by TEXT, at INTEGER, status TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, opened_at INTEGER, closed_at INTEGER, kind TEXT, detail TEXT, notified INTEGER DEFAULT 1);
    CREATE INDEX IF NOT EXISTS deploys_app ON deploys (app, id);
    CREATE TABLE IF NOT EXISTS running (app TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL);`);
  const setRunning = db.prepare(`INSERT INTO running (app, sha, at) VALUES (?, ?, ?) ON CONFLICT (app) DO UPDATE SET sha = excluded.sha, at = excluded.at`);
  const getRunning = db.prepare(`SELECT sha FROM running WHERE app = ?`);
  const clearRunning = db.prepare(`DELETE FROM running WHERE app = ?`);
  if (!(db.prepare(`PRAGMA table_info(incidents)`).all() as { name: string }[]).some((c) => c.name === "notified")) db.exec(`ALTER TABLE incidents ADD COLUMN notified INTEGER DEFAULT 1`);
  const addDeploy = db.prepare(`INSERT INTO deploys (app, sha, images_json, by, at, status, detail) VALUES (@app, @sha, @images_json, @by, @at, @status, @detail)`);
  const lastDeploy = db.prepare(`SELECT * FROM deploys WHERE app = ? ORDER BY id DESC LIMIT 1`);
  const seen = db.prepare(`SELECT 1 FROM deploys WHERE app = ? AND sha = ? LIMIT 1`);
  const goodDeploys = db.prepare(`SELECT * FROM deploys WHERE app = ? AND status = 'healthy' ORDER BY id DESC`);
  const recent = db.prepare(`SELECT * FROM deploys WHERE app = ? ORDER BY id DESC LIMIT ?`);
  const openInc = db.prepare(`SELECT * FROM incidents WHERE app = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1`);
  const addInc = db.prepare(`INSERT INTO incidents (app, opened_at, kind, detail, notified) VALUES (?, ?, ?, ?, 0)`);
  const pending = db.prepare(`SELECT * FROM incidents WHERE closed_at IS NULL AND notified = 0`);
  const markNotified = db.prepare(`UPDATE incidents SET notified = 1 WHERE id = ?`);
  const closeInc = db.prepare(`UPDATE incidents SET closed_at = ? WHERE app = ? AND closed_at IS NULL AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))`);
  return {
    addDeploy: (d: Omit<Deploy, "id">) => void addDeploy.run(d),
    lastDeploy: (app: string) => lastDeploy.get(app) as Deploy | undefined,
    /**
     * The commit whose containers are up (set when `compose up` succeeds: deploy, rollback, auto-rollback; cleared when a
     * first deploy is stopped). Not the latest deployment record, which can be a failed deploy.
     */
    running: (app: string) => (getRunning.get(app) as { sha: string } | undefined)?.sha,
    setRunning: (app: string, sha: string, at = Date.now()) => void setRunning.run(app, sha, at),
    clearRunning: (app: string) => void clearRunning.run(app),
    seen: (app: string, sha: string) => !!seen.get(app, sha),
    goodDeploys: (app: string) => goodDeploys.all(app) as Deploy[],
    recentDeploys: (app: string, n = 5) => recent.all(app, n) as Deploy[],
    openIncident: (app: string) => openInc.get(app) as Incident | undefined,
    addIncident: (app: string, kind: string, detail: string, at = Date.now()) => addInc.run(app, at, kind, detail).lastInsertRowid as number,
    /** Open incidents whose webhook hasn't gone through yet. */
    unnotified: () => pending.all() as Incident[],
    markNotified: (id: number) => void markNotified.run(id),
    /** Closes the app's open incident (of the given kinds only, when set). */
    closeIncident: (app: string, kinds?: string[], at = Date.now()) => closeInc.run(at, app, kinds ? 1 : null, JSON.stringify(kinds ?? [])).changes > 0,
  };
}
export type Store = ReturnType<typeof openStore>;
