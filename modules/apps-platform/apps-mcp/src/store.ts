// Observations only (deploys, incidents). Desired state lives in git (the instance apps.yaml + config/apps.modules.yaml).
import Database from "better-sqlite3";

export interface Deploy {
  id: number; app: string; sha: string; images_json: string; by: string; at: number; status: string; detail: string; disqualified?: number;
  /** Set only when the deploy's own identity probe proved the app serves no HTTP (checks.ts identityPorts `noHttpProven`). */
  no_http_proven?: number;
}
/** A pull request's preview (previews.ts): its parent app, PR, host port, the head it runs and the PR comment it keeps. */
export interface PreviewRow { name: string; app: string; pr: number; port: number; sha: string; status: string; at: number; comment_id: number | null; reason: string | null }
export interface Incident { id: number; app: string; opened_at: number; closed_at: number | null; kind: string; detail: string; notified: number }

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploys (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, sha TEXT, images_json TEXT, by TEXT, at INTEGER, status TEXT, detail TEXT, no_http_proven INTEGER);
    CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, opened_at INTEGER, closed_at INTEGER, kind TEXT, detail TEXT, notified INTEGER DEFAULT 1);
    CREATE INDEX IF NOT EXISTS deploys_app ON deploys (app, id);
    CREATE TABLE IF NOT EXISTS running (app TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS withheld (app TEXT PRIMARY KEY, why TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS previews (name TEXT PRIMARY KEY, app TEXT NOT NULL, pr INTEGER NOT NULL, port INTEGER NOT NULL UNIQUE, sha TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, comment_id INTEGER, reason TEXT);`);
  // A database from before `reason`: added here, under the write lock so two openers can't both try the ALTER.
  db.transaction(() => {
    if (!(db.prepare(`PRAGMA table_info(previews)`).all() as { name: string }[]).some((c) => c.name === "reason")) db.exec(`ALTER TABLE previews ADD COLUMN reason TEXT`);
  }).immediate();
  const putPreview = db.prepare(`INSERT INTO previews (name, app, pr, port, sha, status, at, comment_id, reason) VALUES (@name, @app, @pr, @port, @sha, @status, @at, @comment_id, @reason)
    ON CONFLICT (name) DO UPDATE SET sha = excluded.sha, status = excluded.status, at = excluded.at, comment_id = excluded.comment_id, reason = excluded.reason`);
  const allPreviews = db.prepare(`SELECT * FROM previews ORDER BY app, pr`);
  const dropPreview = db.prepare(`DELETE FROM previews WHERE name = ?`);
  const setRunning = db.prepare(`INSERT INTO running (app, sha, at) VALUES (?, ?, ?) ON CONFLICT (app) DO UPDATE SET sha = excluded.sha, at = excluded.at`);
  const getRunning = db.prepare(`SELECT sha FROM running WHERE app = ?`);
  const clearRunning = db.prepare(`DELETE FROM running WHERE app = ?`);
  const setWithheld = db.prepare(`INSERT INTO withheld (app, why, at) VALUES (?, ?, ?) ON CONFLICT (app) DO UPDATE SET why = excluded.why, at = excluded.at`);
  const getWithheld = db.prepare(`SELECT why FROM withheld WHERE app = ?`);
  const clearWithheld = db.prepare(`DELETE FROM withheld WHERE app = ? RETURNING why`);
  if (!(db.prepare(`PRAGMA table_info(incidents)`).all() as { name: string }[]).some((c) => c.name === "notified")) db.exec(`ALTER TABLE incidents ADD COLUMN notified INTEGER DEFAULT 1`);
  if (!(db.prepare(`PRAGMA table_info(deploys)`).all() as { name: string }[]).some((c) => c.name === "disqualified")) db.exec(`ALTER TABLE deploys ADD COLUMN disqualified INTEGER`);
  // A deploy from before the no-HTTP verdict: absent, which reads as not proven, never as no page.
  if (!(db.prepare(`PRAGMA table_info(deploys)`).all() as { name: string }[]).some((c) => c.name === "no_http_proven")) db.exec(`ALTER TABLE deploys ADD COLUMN no_http_proven INTEGER`);
  const addDeploy = db.prepare(`INSERT INTO deploys (app, sha, images_json, by, at, status, detail, no_http_proven) VALUES (@app, @sha, @images_json, @by, @at, @status, @detail, @no_http_proven)`);
  const lastDeploy = db.prepare(`SELECT * FROM deploys WHERE app = ? ORDER BY id DESC LIMIT 1`);
  const goodDeploys = db.prepare(`SELECT * FROM deploys WHERE app = ? AND status = 'healthy' ORDER BY id DESC`);
  const anyPublishable = db.prepare(`SELECT 1 FROM deploys WHERE app = ? AND status = 'healthy' AND disqualified IS NULL LIMIT 1`);
  const recent = db.prepare(`SELECT * FROM deploys WHERE app = ? ORDER BY id DESC LIMIT ?`);
  const rolledBack = db.prepare(`UPDATE deploys SET status = 'rolled_back', detail = ltrim(detail || '; ' || ?, '; ') WHERE id = ?`);
  const disqualify = db.prepare(`UPDATE deploys SET disqualified = 1, detail = ltrim(detail || '; ' || ?, '; ') WHERE id = ?`);
  const deploysOf = db.prepare(`SELECT * FROM deploys WHERE app = ? AND sha = ? ORDER BY id DESC`);
  const openInc = db.prepare(`SELECT * FROM incidents WHERE app = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1`);
  const addInc = db.prepare(`INSERT INTO incidents (app, opened_at, kind, detail, notified) VALUES (?, ?, ?, ?, 0)`);
  const pending = db.prepare(`SELECT * FROM incidents WHERE closed_at IS NULL AND notified = 0`);
  const markNotified = db.prepare(`UPDATE incidents SET notified = 1 WHERE id = ?`);
  const closeInc = db.prepare(`UPDATE incidents SET closed_at = ? WHERE app = ? AND closed_at IS NULL AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))`);
  return {
    addDeploy: (d: Omit<Deploy, "id"> & { no_http_proven?: number }) => void addDeploy.run({ no_http_proven: null, ...d }),
    lastDeploy: (app: string) => lastDeploy.get(app) as Deploy | undefined,
    /**
     * The commit whose containers are up (set when `compose up` succeeds: deploy, rollback, auto-rollback; cleared when a
     * first deploy is stopped). Not the latest deployment record, which can be a failed deploy.
     */
    running: (app: string) => (getRunning.get(app) as { sha: string } | undefined)?.sha,
    setRunning: (app: string, sha: string, at = Date.now()) => void setRunning.run(app, sha, at),
    clearRunning: (app: string) => void clearRunning.run(app),
    goodDeploys: (app: string) => goodDeploys.all(app) as Deploy[],
    /**
     * Whether the app may be served. Three conditions, all cheap on a per-tick path: a revision in the `running` row (a
     * confirmed stop clears it, and a healthy row in the history proves nothing about what is up), no hold from a failed
     * teardown (that one may have left an older or unverified revision serving), and at least one healthy deploy that was
     * not found answering without sign-in. A disqualified row can stay healthy while its `down` failed, so the two are
     * separate columns; only one such row has to exist, never the whole history.
     */
    publishable: (app: string) => !!getRunning.get(app) && !getWithheld.get(app) && !!anyPublishable.get(app),
    /** Why the app's routes are withheld (a teardown that failed left something possibly serving), if they are. */
    withheld: (app: string) => (getWithheld.get(app) as { why: string } | undefined)?.why,
    /** Withholds the app's routes; true when that is a change (it was not withheld already). */
    withhold: (app: string, why: string, at = Date.now()) => {
      const was = !!getWithheld.get(app);
      void setWithheld.run(app, why, at);
      return !was;
    },
    /** A deploy recorded healthy is the proof that what is up is the commit that was checked: serve again. True when held. */
    unwithhold: (app: string) => clearWithheld.run(app).changes > 0,
    /** A healthy deploy that failed later (the post-deploy watch rolled it back): never a rollback target again. */
    markRolledBack: (id: number, why: string) => void rolledBack.run(why, id),
    /**
     * A healthy deploy found answering without sign-in: never a rollback target again, even when its `down` failed and
     * so its row cannot honestly be marked `rolled_back`.
     */
    disqualify: (id: number, why: string) => void disqualify.run(why, id),
    recentDeploys: (app: string, n = 5) => recent.all(app, n) as Deploy[],
    /**
     * Every deploy of one exact commit, newest first, over the whole table (never a window): a merged commit stops being
     * provable as deployed once the bounded list has moved past it, which is not the same as never having deployed.
     */
    deploysOf: (app: string, sha: string) => deploysOf.all(app, sha) as Deploy[],
    previews: () => allPreviews.all() as PreviewRow[],
    putPreview: (r: PreviewRow) => void putPreview.run(r),
    dropPreview: (name: string) => void dropPreview.run(name),
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
