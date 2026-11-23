// Projects (docs/design/agent-work-board.md, "Projects that fill themselves in"): a project is a product, and repos map into it.
// The one place that names or makes a Paperclip project, and that sets a task's project for a repo; it writes with the owner key
// (the plugin may only read projects). Paperclip keeps the projects and each task's `projectId`; the repo → project map is this
// kernel table (`project_repos`), not Paperclip's project workspaces (those pull a project into Paperclip's execution workspaces).
// - products: the instance's `projects:` map (instance.yaml, through the grants table): a product's name and its repos. A repo
//   listed there belongs to that product's project; any other repo gets a project of its own, named after it.
// - touch(task, repo): a PR opened for the task on that repo (backplane's /v1/facts, pr.opened). The repo's project, made on first
//   sight, is set on the task only while the task has none; the task is remembered as the repo's (`project_tasks`).
// - sync(): the map changed (a repo moved into a product): each listed repo whose project differs moves there, and with it its open
//   tasks and those that changed in the last two days, when they are still in its old project. Older tasks stay; nothing is archived.
// - named(company, name): an agent's `project` tag (cp.ts): the company's unarchived project of that name (trimmed, any case),
//   else a new one. Two projects of one name is an error the agent sees.
// Every write here runs on one chain (`serial`), every task an agent creates or tags in cp.ts too, so two first sights of one repo
// make one project and a repo's fill never lands over an agent's tag; each create carries Paperclip's idempotency key too. A fill
// that fails (Paperclip restarting) is tried again a minute later, three times at most; a kernel restart meanwhile drops it.
import type { DatabaseSync } from "node:sqlite";
import { repoKey } from "./kinds.ts";

type Project = { id: string; name: string; archivedAt?: string | null };
type Issue = { id: string; companyId: string; projectId?: string | null; status?: string; updatedAt?: string };
/** The control plane with the owner key: status and parsed JSON (null when the body isn't JSON). */
export type OwnerCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
/** The instance's products: a project's name → its repos (owner/name). */
export type Products = Record<string, string[]>;

export class ProjectError extends Error { status = 400; }
/** How long a failed fill waits before it is tried again. */
const RETRY_MS = 60_000;
/** A closed task this recent moves with its repo (the board's Done window). */
const RECENT_MS = 48 * 3600_000;

export function createProjects({ db, owner, products = () => ({}), log = () => {}, now = Date.now }: {
  db: DatabaseSync; owner: OwnerCall;
  products?: () => Products;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => number;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_repos (company TEXT NOT NULL, repo TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (company, repo));
    CREATE TABLE IF NOT EXISTS project_tasks (task TEXT PRIMARY KEY, company TEXT NOT NULL, repo TEXT NOT NULL)`);
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
    const short = repo.split("/")[1]!;
    const taken = await byName(company, short, false);
    const clash = taken && db.prepare("SELECT 1 FROM project_repos WHERE company = ? AND project = ? AND repo != ?").get(company, taken, repo);
    return (await byName(company, clash ? repo : short, true))!;
  }

  /** The repo's project, made on first sight. */
  async function forRepo(company: string, repo: string): Promise<string> {
    const row = db.prepare("SELECT project FROM project_repos WHERE company = ? AND repo = ?").get(company, repo) as { project: string } | undefined;
    if (row) return row.project;
    const project = await projectFor(company, repo);
    db.prepare("INSERT OR IGNORE INTO project_repos (company, repo, project) VALUES (?, ?, ?)").run(company, repo, project);
    return project;
  }

  let synced = "";
  const api = {
    serial,
    /** A PR for `task` on `repo`: the task joins the repo's project unless it has one (retried as above). */
    touch: (task: string, repo: string, tries = 3): Promise<void> => serial(async () => {
      const key = repoKey(repo);
      if (!key) return;
      const issue = ok(await owner("GET", `/api/issues/${enc(task)}`), "reading the task") as Issue;
      db.prepare("INSERT OR IGNORE INTO project_tasks (task, company, repo) VALUES (?, ?, ?)").run(issue.id, issue.companyId, key);
      if (issue.projectId) return;
      const project = await forRepo(issue.companyId, key);
      ok(await owner("PATCH", `/api/issues/${enc(issue.id)}`, { projectId: project }), "setting the task's project");
      log("task joined its repo's project", { task: issue.id, repo: key, project });
    }).catch((e: Error & { status?: number }) => {
      if (tries <= 1 || e.status === 404 || e instanceof ProjectError) throw e;
      log("project fill failed; trying again in a minute", { task, repo, err: e.message });
      return new Promise<void>((done, fail) => setTimeout(() => void api.touch(task, repo, tries - 1).then(done, fail), RETRY_MS).unref());
    }),
    /** An agent's tag: the project of that name, made when there is none. Call it inside `serial` with the write it is for. */
    named: (company: string, name: string) => byName(company, name, true) as Promise<string>,
    /** Moves each listed repo whose project differs into its product's, with its open and recent tasks (once per change of the map). */
    sync: () => serial(async () => {
      const map = JSON.stringify(products());
      if (map === synced) return;
      const rows = db.prepare("SELECT company, repo, project FROM project_repos").all() as { company: string; repo: string; project: string }[];
      for (const r of rows) {
        if (!productOf(r.repo)) continue;
        const to = await projectFor(r.company, r.repo);
        if (to === r.project) continue;
        db.prepare("UPDATE project_repos SET project = ? WHERE company = ? AND repo = ?").run(to, r.company, r.repo);
        let moved = 0;
        for (const { task } of db.prepare("SELECT task FROM project_tasks WHERE company = ? AND repo = ?").all(r.company, r.repo) as { task: string }[]) {
          const r2 = await owner("GET", `/api/issues/${enc(task)}`);
          if (r2.status === 404) continue;
          const i = ok(r2, "reading a task") as Issue;
          const recent = !["done", "cancelled"].includes(String(i.status)) || now() - Date.parse(String(i.updatedAt)) < RECENT_MS;
          if (i.projectId !== r.project || !recent) continue;
          ok(await owner("PATCH", `/api/issues/${enc(i.id)}`, { projectId: to }), "moving a task");
          moved++;
        }
        log("repo moved into its product", { company: r.company, repo: r.repo, from: r.project, to, moved });
      }
      synced = map;
    }),
  };
  return api;
}
export type Projects = ReturnType<typeof createProjects>;
