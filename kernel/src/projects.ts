// Projects (docs/design/agent-work-board.md, "Projects that fill themselves in"): a project is a product, and repos map into it.
// The one place that names or makes a Paperclip project, and that sets a task's project for a repo; it writes with the owner key
// (the plugin may only read projects). Paperclip keeps the projects and each task's `projectId`; the repo → project map is this
// kernel table (`project_repos`), not Paperclip's project workspaces (those pull a project into Paperclip's execution workspaces).
// - products: the instance's `projects:` map (instance.yaml, through the grants table): a product's name and its repos. A repo
//   listed there belongs to that product's project; any other repo gets a project of its own, named after it.
// - touch(task, repo): a PR opened for the task on that repo (backplane's /v1/facts, pr.opened). The repo's project, made on first
//   sight, is set on the task only while the task has none; the task is remembered as the repo's (`project_tasks`).
// - sync(): the map changed (a repo moved into a product, or taken off one): each repo whose project differs moves there, and with it
//   its open tasks and those closed in the last two days, when they are still in its old project. Older tasks stay; nothing is
//   archived.
// - named(company, name): an agent's `project` tag (cp.ts): the company's unarchived project of that name (trimmed, any case),
//   else a new one. Two projects of one name is an error the agent sees.
// Every write here runs on one chain (`serial`), every task an agent creates or tags in cp.ts too, so two first sights of one repo
// make one project and a repo's fill never lands over an agent's tag; each create carries Paperclip's idempotency key too. A fill
// is queued in kernel.db (`project_pending`) before it is tried: one that fails (Paperclip restarting) is tried again each minute,
// across kernel restarts.
import type { DatabaseSync } from "node:sqlite";
import { repoKey } from "./kinds.ts";

type Project = { id: string; name: string; archivedAt?: string | null };
type Issue = { id: string; companyId: string; projectId?: string | null; status?: string; updatedAt?: string; completedAt?: string | null; cancelledAt?: string | null };
/** The control plane with the owner key: status and parsed JSON (null when the body isn't JSON). */
export type OwnerCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
/** The instance's products: a project's name → its repos (owner/name). */
export type Products = Record<string, string[]>;

export class ProjectError extends Error { status = 400; }
/** A closed task this recent moves with its repo (the board's Done window). */
const RECENT_MS = 48 * 3600_000;

export function createProjects({ db, owner, products = () => ({}), log = () => {}, now = Date.now }: {
  db: DatabaseSync; owner: OwnerCall;
  products?: () => Products;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => number;
}) {
  // `product`: the row came from the products map (1), else it is the repo's own project (0).
  db.exec(`CREATE TABLE IF NOT EXISTS project_repos (company TEXT NOT NULL, repo TEXT NOT NULL, project TEXT NOT NULL, product INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, repo));
    CREATE TABLE IF NOT EXISTS project_tasks (task TEXT PRIMARY KEY, repo TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_pending (task TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (task, repo));
    CREATE TABLE IF NOT EXISTS project_backfilled (done INTEGER)`);
  // The tasks PRs touched before this table existed: from the fact log's pr.opened, once (a repo's own facts name it lower-case).
  // Only the facts the live path takes (backplane's /v1/facts): a code host's own, recorded live, first one per task. Every
  // remembered task is then queued for a fill (one with a project is left alone), so existing work joins its repo's project
  // through the minute's retry. Once, by a marker in this db, written last: a run cut short is done again.
  try {
    if (!db.prepare("SELECT 1 FROM project_backfilled").get()) {
      db.exec("INSERT OR IGNORE INTO project_tasks (task, repo) SELECT task, lower(json_extract(data, '$.repo')) FROM facts WHERE type = 'pr.opened' AND source = 'live' AND (version LIKE 'github/%' OR version LIKE 'codehost-local/%') AND task IS NOT NULL AND json_extract(data, '$.repo') IS NOT NULL ORDER BY seq");
      db.exec("INSERT OR IGNORE INTO project_pending (task, repo) SELECT task, repo FROM project_tasks");
      db.exec("INSERT INTO project_backfilled VALUES (1)");
    }
  } catch { /* no fact log here */ }
  let chain: Promise<unknown> = Promise.resolve();
  /** One write at a time, in order. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const ok = (r: { status: number; json: any }, what: string) => {
    if (r.status >= 300) throw Object.assign(new Error(`the control plane answered ${r.status} ${what}`), { status: r.status === 404 ? 404 : 502 });
    return r.json;
  };
  const enc = encodeURIComponent;
  const catalog = async (company: string): Promise<Project[]> => (ok(await owner("GET", `/api/companies/${enc(company)}/projects`), "listing projects") as Project[]).filter((p) => !p.archivedAt);
  /** The product a repo is listed under, if any. */
  const productOf = (repo: string) => Object.entries(products()).find(([, repos]) => (repos ?? []).some((r) => repoKey(r) === repo))?.[0];

  /** The unarchived project named `name` (trimmed, any case), made when there is none and `create`. */
  async function byName(company: string, name: string, create: boolean): Promise<string | undefined> {
    const want = name.trim().replace(/\s+/g, " ");
    if (!want || want.length > 100) throw new ProjectError("project: a name, at most 100 characters");
    const hits = (await catalog(company)).filter((p) => p.name.trim().toLowerCase() === want.toLowerCase());
    if (hits.length > 1) throw new ProjectError(`project: ${hits.length} projects are named "${want}"; name one of them exactly, or ask the owner which`);
    if (hits[0]) return hits[0].id;
    if (!create) return undefined;
    const made = ok(await owner("POST", `/api/companies/${enc(company)}/projects`, { name: want, status: "in_progress", idempotencyKey: `aidenhq:project:${want.toLowerCase()}`.slice(0, 255) }), "making a project") as Project;
    log("project made", { company, project: made.id, name: want });
    return made.id;
  }

  /** The project a repo belongs to now: its product's, else its own (named after it; in full beside another org's repo of that name). */
  async function projectFor(company: string, repo: string): Promise<string> {
    const product = productOf(repo);
    if (product) return (await byName(company, product, true))!;
    // Named in full when its short name is a product's, or another org's repo of that name has it already.
    const short = repo.split("/")[1]!;
    const isProduct = Object.keys(products()).some((n) => n.trim().toLowerCase() === short.toLowerCase());
    const taken = !isProduct && (await byName(company, short, false));
    const clash = isProduct || (taken && db.prepare("SELECT 1 FROM project_repos WHERE company = ? AND project = ? AND repo != ?").get(company, taken, repo));
    return (await byName(company, clash ? repo : short, true))!;
  }

  /** The repo's project, made on first sight. */
  async function forRepo(company: string, repo: string): Promise<string> {
    const row = db.prepare("SELECT project, product FROM project_repos WHERE company = ? AND repo = ?").get(company, repo) as { project: string; product: number } | undefined;
    // A repo the map names (or named) follows the map, so a fill during a move lands where the move goes; a project archived or
    // deleted in Paperclip since is no home: the repo's project is found again.
    if (row && !row.product && !productOf(repo)) {
      const own = (await catalog(company)).find((p) => p.id === row.project);
      // Its own project, unless a product has taken that name: then it goes where sync is moving it (named in full).
      if (own && !Object.keys(products()).some((n) => n.trim().toLowerCase() === own.name.trim().toLowerCase())) return row.project;
      if (own) return projectFor(company, repo);
    }
    // A repo the map names follows it here; its row moves with its tasks in sync, never ahead of them.
    if (row && (row.product || productOf(repo))) return projectFor(company, repo);
    // New, or its own project archived since: found (or made) again and remembered.
    const project = await projectFor(company, repo);
    db.prepare("INSERT OR REPLACE INTO project_repos (company, repo, project, product) VALUES (?, ?, ?, ?)").run(company, repo, project, productOf(repo) ? 1 : 0);
    return project;
  }

  /** One fill: the task joins the repo's project unless it has one. Throws when it can't be done now. */
  const fill = (task: string, key: string) => serial(async () => {
    const issue = ok(await owner("GET", `/api/issues/${enc(task)}`), "reading the task") as Issue;
    // The repo a task's project came from: the first PR's while another set it, the filling one's once it fills.
    db.prepare("INSERT OR IGNORE INTO project_tasks (task, repo) VALUES (?, ?)").run(issue.id, key);
    if (issue.projectId) return;
    const project = await forRepo(issue.companyId, key);
    db.prepare("INSERT OR REPLACE INTO project_tasks (task, repo) VALUES (?, ?)").run(issue.id, key);
    ok(await owner("PATCH", `/api/issues/${enc(issue.id)}`, { projectId: project }), "setting the task's project");
    log("task joined its repo's project", { task: issue.id, repo: key, project });
  });
  /** One queued fill tried: done or impossible (the task gone, a name refused) leaves the queue; a transient failure stays. */
  async function attempt(task: string, repo: string) {
    try { await fill(task, repo); } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status !== 404 && !(err instanceof ProjectError)) {
        // To the back of the queue, so a run of failing fills never starves the ones behind them.
        db.prepare("INSERT OR REPLACE INTO project_pending (task, repo) VALUES (?, ?)").run(task, repo);
        return log("project fill failed; trying again in a minute", { task, repo, err: err.message });
      }
      log("project fill dropped", { task, repo, err: err.message });
    }
    db.prepare("DELETE FROM project_pending WHERE task = ? AND repo = ?").run(task, repo);
  }
  /** The queue, once a minute (sync): at most 100 fills a run. */
  async function retryPending() {
    for (const { task, repo } of db.prepare("SELECT task, repo FROM project_pending ORDER BY rowid LIMIT 100").all() as { task: string; repo: string }[]) await attempt(task, repo);
  }

  let synced = "";
  let syncing = false;
  const api = {
    serial,
    /** A PR's fill, queued: called in the transaction that records the PR fact, so the two land together (kernel.db). */
    queue: (task: string, repo: string) => {
      const key = repoKey(repo);
      if (key) db.prepare("INSERT OR IGNORE INTO project_pending (task, repo) VALUES (?, ?)").run(task, key);
    },
    /** A queued fill tried now (after its fact's commit); the minute's run retries one that fails. */
    touch: async (task: string, repo: string): Promise<void> => {
      const key = repoKey(repo);
      if (key) await attempt(task, key);
    },
    /** An agent's tag: the project of that name, made when there is none. Call it inside `serial` with the write it is for. */
    named: (company: string, name: string) => byName(company, name, true) as Promise<string>,
    /**
     * Each minute: the pending fills, then, when the map changed, each repo whose project differs from the map's (into its product,
     * or back to its own when it was taken off one) moves with its open and recent tasks. Each task moves on the chain on its own,
     * so creates never wait behind a whole move; a repo that fails is left for the next run and the others go on; its row moves
     * last, so a run cut short is done again in full.
     */
    sync: async () => {
      if (syncing) return;
      syncing = true;
      try {
        await retryPending();
        const map = JSON.stringify(products());
        if (map === synced) return;
        let failed = false;
        const rows = db.prepare("SELECT company, repo, project, product FROM project_repos").all() as { company: string; repo: string; project: string; product: number }[];
        const names = new Set(Object.keys(products()).map((n) => n.trim().toLowerCase()));
        const named = new Map<string, Map<string, string>>(); // per company: project id → its name
        for (const r of rows) {
          const product = productOf(r.repo) ? 1 : 0;
          // A repo's own project stays as it is while no product lists it, unless a product now has its name: then the repo
          // moves to a project named in full, and the name is the product's.
          if (!r.product && !product) {
            try {
              if (!named.has(r.company)) named.set(r.company, new Map((await serial(() => catalog(r.company))).map((p) => [p.id, p.name.trim().toLowerCase()])));
            } catch (e) {
              failed = true;
              log("project catalog unreadable; trying again in a minute", { company: r.company, err: (e as Error).message });
              continue;
            }
            if (!names.has(named.get(r.company)!.get(r.project) ?? "")) continue;
          }
          try {
            const to = await serial(() => projectFor(r.company, r.repo));
            let moved = 0, skipped = 0;
            if (to !== r.project) for (const { task } of db.prepare("SELECT task FROM project_tasks WHERE repo = ?").all(r.repo) as { task: string }[]) {
              // A task the control plane refuses is skipped and logged; the others still move. The repo's row moves last, only when
              // none was skipped, so the next run tries the skipped ones again (those moved already no longer match, and are left).
              try {
                moved += await serial(async () => {
                  const r2 = await owner("GET", `/api/issues/${enc(task)}`);
                  if (r2.status === 404) return 0;
                  const i = ok(r2, "reading a task") as Issue;
                  // Closed in the board's Done window, by when it closed (an old task edited since stays where it is).
                  const recent = !["done", "cancelled"].includes(String(i.status)) || now() - Date.parse(String(i.completedAt ?? i.cancelledAt ?? i.updatedAt)) < RECENT_MS;
                  if (i.companyId !== r.company || i.projectId !== r.project || !recent) return 0;
                  ok(await owner("PATCH", `/api/issues/${enc(i.id)}`, { projectId: to }), "moving a task");
                  return 1;
                });
              } catch (e) {
                skipped++;
                log("task move refused; skipped, tried again in a minute", { task, repo: r.repo, err: (e as Error).message });
              }
            }
            if (skipped) { failed = true; continue; }
            db.prepare("UPDATE project_repos SET project = ?, product = ? WHERE company = ? AND repo = ?").run(to, product, r.company, r.repo);
            if (to !== r.project) log("repo moved to the project the map gives it", { company: r.company, repo: r.repo, from: r.project, to, moved });
          } catch (e) {
            failed = true;
            log("repo move failed; trying again in a minute", { company: r.company, repo: r.repo, err: (e as Error).message });
          }
        }
        if (!failed) synced = map;
      } finally {
        syncing = false;
      }
    },
  };
  return api;
}
export type Projects = ReturnType<typeof createProjects>;
