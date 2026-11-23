// Projects (docs/design/agent-work-board.md, "Projects that fill themselves in"): a project is a product, and repos map into it.
// The one place that names or makes a Paperclip project, and that sets a task's project for a repo; it writes with the owner key
// (the plugin may only read projects). Paperclip keeps the projects and each task's `projectId`; the repo → project map is this
// kernel table (`project_repos`), not Paperclip's project workspaces (those pull a project into Paperclip's execution workspaces).
// - touch(task, repo): a PR opened for the task on that repo (backplane's /v1/facts, pr.opened). The repo's project, made on first
//   sight and named after the repo, is set on the task only while the task has none. The kernel's own repos (product, instance,
//   the distro) map to one project, "AidenHQ", made when the first of them is seen.
// - named(company, name): an agent's `project` tag (cp.ts): the company's unarchived project of that name (trimmed, any case),
//   else a new one. Two projects of one name is an error the agent sees.
// - fold(company, project, into): the chief of staff's `project_fold`: the project's repos map to `into`, its tasks move there, and
//   it is archived last (a failure part-way leaves it in place: run it again).
// Every write here runs on one chain (`serial`), the agent's tagged writes in cp.ts too, so two first sights of one repo make one
// project and a repo's fill never lands over an agent's tag. Each create also carries Paperclip's idempotency key.
import type { DatabaseSync } from "node:sqlite";
import { repoKey } from "./kinds.ts";

type Project = { id: string; name: string; archivedAt?: string | null };
type Issue = { id: string; companyId: string; projectId?: string | null };
/** The control plane with the owner key: status and parsed JSON (null when the body isn't JSON). */
export type OwnerCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

/** The project the kernel's own repos form. */
export const OWN_PROJECT = "AidenHQ";
const ALL = "backlog,todo,in_progress,in_review,blocked,done,cancelled";

export class ProjectError extends Error { status = 400; }

export function createProjects({ db, owner, ownRepos = () => [], log = () => {} }: {
  db: DatabaseSync; owner: OwnerCall;
  /** The kernel's own repos (owner/name): the product, the instance and the distro. */
  ownRepos?: () => (string | undefined)[];
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS project_repos (company TEXT NOT NULL, repo TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY (company, repo))");
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

  /** The unarchived project named `name` (trimmed, any case), made when there is none and `create`. */
  async function byName(company: string, name: string, create: boolean): Promise<string | undefined> {
    const want = name.trim().replace(/\s+/g, " ");
    if (!want || want.length > 100) throw new ProjectError("project: a name, at most 100 characters");
    const hits = (await catalog(company)).filter((p) => p.name.trim().toLowerCase() === want.toLowerCase());
    if (hits.length > 1) throw new ProjectError(`project: ${hits.length} projects are named "${want}"; ask the chief of staff to fold one into the other`);
    if (hits[0]) return hits[0].id;
    if (!create) return undefined;
    const made = ok(await owner("POST", `/api/companies/${enc(company)}/projects`, { name: want, status: "in_progress", idempotencyKey: `aidenhq:project:${want.toLowerCase()}`.slice(0, 255) }), "making a project") as Project;
    log("project made", { company, project: made.id, name: want });
    return made.id;
  }

  /** The repo's project, made on first sight (the kernel's own repos: one "AidenHQ" for all of them). */
  async function forRepo(company: string, repo: string): Promise<string> {
    const row = db.prepare("SELECT project FROM project_repos WHERE company = ? AND repo = ?").get(company, repo) as { project: string } | undefined;
    if (row) return row.project;
    const own = ownRepos().map(repoKey).filter((r): r is string => Boolean(r));
    const group = own.includes(repo) ? own : [repo];
    const project = (await byName(company, own.includes(repo) ? OWN_PROJECT : repo.split("/")[1]!, true))!;
    const put = db.prepare("INSERT OR IGNORE INTO project_repos (company, repo, project) VALUES (?, ?, ?)");
    for (const r of group) put.run(company, r, project);
    return project;
  }

  return {
    serial,
    /** A PR for `task` on `repo`: the task joins the repo's project unless it has one. */
    touch: (task: string, repo: string) => serial(async () => {
      const key = repoKey(repo);
      if (!key) return;
      const issue = ok(await owner("GET", `/api/issues/${enc(task)}`), "reading the task") as Issue;
      if (issue.projectId) return;
      const project = await forRepo(issue.companyId, key);
      ok(await owner("PATCH", `/api/issues/${enc(issue.id)}`, { projectId: project }), "setting the task's project");
      log("task joined its repo's project", { task: issue.id, repo: key, project });
    }),
    /** An agent's tag: the project of that name, made when there is none. Call it inside `serial` with the write it is for. */
    named: (company: string, name: string) => byName(company, name, true) as Promise<string>,
    /** Folds `project` into `into` (both by name): its repos and tasks move, then it is archived. */
    fold: (company: string, project: string, into: string) => serial(async () => {
      const from = await byName(company, project, false);
      const to = await byName(company, into, false);
      if (!from) throw new ProjectError(`no project named "${project}"`);
      if (!to) throw new ProjectError(`no project named "${into}"`);
      if (from === to) throw new ProjectError("a project can't be folded into itself");
      const repos = db.prepare("UPDATE project_repos SET project = ? WHERE company = ? AND project = ? RETURNING repo").all(to, company, from).map((r) => (r as { repo: string }).repo);
      let moved = 0;
      for (let page = 0; page < 50; page++) {
        const list = ok(await owner("GET", `/api/companies/${enc(company)}/issues?projectId=${enc(from)}&status=${ALL}&limit=500`), "listing the project's tasks") as Issue[];
        const left = list.filter((i) => i.projectId === from);
        if (!left.length) break;
        for (const i of left) { ok(await owner("PATCH", `/api/issues/${enc(i.id)}`, { projectId: to }), "moving a task"); moved++; }
      }
      ok(await owner("PATCH", `/api/projects/${enc(from)}`, { archivedAt: new Date().toISOString() }), "archiving the project");
      log("project folded", { company, from, into: to, repos: repos.length, moved });
      return { project: into, repos, moved };
    }),
  };
}
export type Projects = ReturnType<typeof createProjects>;
