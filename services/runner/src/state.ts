import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Durable runner state: per-task workspace/session and processed comment IDs. */
export class State {
  db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        issue_id    TEXT PRIMARY KEY,
        identifier  TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        repo        TEXT,
        base        TEXT,
        branch      TEXT,
        worktree    TEXT,
        engine_json TEXT,
        mode        TEXT,
        session_id  TEXT,
        pushed      INTEGER NOT NULL DEFAULT 0,
        pr_url      TEXT,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        comment_id TEXT PRIMARY KEY,
        issue_id   TEXT NOT NULL,
        handled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id    TEXT NOT NULL,
        status      TEXT NOT NULL,
        engine      TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        log_path    TEXT,
        detail      TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      -- A task's branches across its workspace's repositories.
      CREATE TABLE IF NOT EXISTS branches (
        issue_id   TEXT NOT NULL,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL,
        base       TEXT NOT NULL,
        purpose    TEXT,
        pushed     INTEGER NOT NULL DEFAULT 0,
        pr_url     TEXT,
        merged     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, repo, branch)
      );
    `);
    // The task's workspace directory.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'workspace'").get()) this.db.exec("ALTER TABLE tasks ADD COLUMN workspace TEXT");
    // A running job's process and what its finish needs, so the next runner can adopt it after a restart.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name = 'run_json'").get()) this.db.exec("ALTER TABLE jobs ADD COLUMN run_json TEXT");
    // Every commit the runner pushed as a branch's tip, any task: a merge without a card needs its PR's head to be one.
    this.db.exec("CREATE TABLE IF NOT EXISTS pushed_heads (repo TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repo, branch, sha))");
  }

  recordPush(repo: string, branch: string, sha: string) {
    this.db.prepare("INSERT OR IGNORE INTO pushed_heads (repo, branch, sha, at) VALUES (?, ?, ?, ?)").run(String(repo).toLowerCase(), branch, sha, new Date().toISOString());
  }

  /** Whether the runner pushed `sha` as the tip of `branch` in `repo`. */
  pushedHead(repo: string, branch: string, sha: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM pushed_heads WHERE repo = ? AND branch = ? AND sha = ?").get(String(repo).toLowerCase(), branch, sha));
  }

  branches(issueId: string): any[] {
    return this.db.prepare("SELECT * FROM branches WHERE issue_id = ? ORDER BY repo, branch").all(issueId);
  }

  /** Other tasks whose branches opened any of these PRs (a merge task can merge PRs another task opened). */
  issuesWithPrs(urls: string[], except: string): string[] {
    const want = new Set(urls.map((u) => String(u).toLowerCase()));
    const rows = this.db.prepare("SELECT DISTINCT issue_id, pr_url FROM branches WHERE pr_url IS NOT NULL AND issue_id != ?").all(except) as any[];
    return [...new Set(rows.filter((r) => want.has(String(r.pr_url).toLowerCase())).map((r) => r.issue_id as string))];
  }

  /** Record a branch the task has (insert or update its base and purpose). */
  saveBranch(issueId: string, { repo, branch, base, purpose }: { repo: string; branch: string; base: string; purpose?: string | null }) {
    this.db
      .prepare("INSERT INTO branches (issue_id, repo, branch, base, purpose, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (issue_id, repo, branch) DO UPDATE SET base = excluded.base, purpose = COALESCE(NULLIF(excluded.purpose, ''), branches.purpose), updated_at = excluded.updated_at")
      .run(issueId, repo, branch, base, purpose ?? "", new Date().toISOString());
  }

  updateBranch(issueId: string, repo: string, branch: string, fields: Record<string, any>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE branches SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE issue_id = ? AND repo = ? AND branch = ?`).run(...keys.map((k) => fields[k] ?? null), new Date().toISOString(), issueId, repo, branch);
  }

  deleteBranch(issueId: string, repo: string, branch: string) {
    this.db.prepare("DELETE FROM branches WHERE issue_id = ? AND repo = ? AND branch = ?").run(issueId, repo, branch);
  }

  task(issueId: string): any {
    const row = this.db.prepare("SELECT * FROM tasks WHERE issue_id = ?").get(issueId) as any;
    if (!row) return undefined;
    return { ...row, engine: row.engine_json ? JSON.parse(row.engine_json) : undefined };
  }

  ensureTask(issueId: string, identifier: string) {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO tasks (issue_id, identifier, first_seen, updated_at) VALUES (?, ?, ?, ?)").run(issueId, identifier, now, now);
    return this.task(issueId);
  }

  updateTask(issueId: string, fields: Record<string, any>) {
    const map: Record<string, any> = { ...fields };
    if ("engine" in map) (map.engine_json = JSON.stringify(map.engine)), delete map.engine;
    map.updated_at = new Date().toISOString();
    const keys = Object.keys(map);
    this.db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE issue_id = ?`).run(...keys.map((k) => map[k] ?? null), issueId);
  }

  handled(commentId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM comments WHERE comment_id = ?").get(commentId));
  }

  markHandled(commentId: string, issueId: string) {
    this.db.prepare("INSERT OR IGNORE INTO comments (comment_id, issue_id, handled_at) VALUES (?, ?, ?)").run(commentId, issueId, new Date().toISOString());
  }

  startJob(issueId: string, engine: string, logPath: string) {
    return Number(
      this.db.prepare("INSERT INTO jobs (issue_id, status, engine, started_at, log_path) VALUES (?, 'running', ?, ?, ?)").run(issueId, engine, new Date().toISOString(), logPath).lastInsertRowid,
    );
  }

  finishJob(id: number, status: string, detail?: string | null) {
    this.db.prepare("UPDATE jobs SET status = ?, finished_at = ?, detail = ? WHERE id = ?").run(status, new Date().toISOString(), detail ?? null, id);
  }

  lastJob(issueId: string): any {
    return this.db.prepare("SELECT * FROM jobs WHERE issue_id = ? ORDER BY id DESC LIMIT 1").get(issueId);
  }

  /** The latest finished job of each task, newest first (a stuck part shows on the board). */
  latestJobs(limit: number): any[] {
    return this.db
      .prepare("SELECT jobs.status, tasks.identifier FROM jobs JOIN tasks USING (issue_id) WHERE jobs.id IN (SELECT MAX(id) FROM jobs WHERE finished_at IS NOT NULL GROUP BY issue_id) ORDER BY jobs.id DESC LIMIT ?")
      .all(limit);
  }

  /** The newest finished jobs, with their task's identifier. */
  recentJobs(limit: number): any[] {
    return this.db
      .prepare("SELECT jobs.*, tasks.identifier FROM jobs JOIN tasks USING (issue_id) WHERE jobs.finished_at IS NOT NULL ORDER BY jobs.id DESC LIMIT ?")
      .all(limit);
  }

  saveRun(id: number, run: unknown) {
    this.db.prepare("UPDATE jobs SET run_json = ? WHERE id = ?").run(JSON.stringify(run), id);
  }

  /** Jobs left 'running' by the previous runner process: adopted, or resumed, at startup. */
  runningJobs(): any[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id").all() as any[]).map((j) => ({ ...j, run: j.run_json ? JSON.parse(j.run_json) : undefined }));
  }

  get(key: string): any {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as any)?.value;
  }

  set(key: string, value: any) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}
