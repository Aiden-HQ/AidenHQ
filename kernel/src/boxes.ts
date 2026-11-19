// The kernel owns an admitted job's computer (spec §4.2a): it gets the box from the computer launcher (its job routes, bearer
// launcher_kernel_key), mints the job's only credential (an `ahqj_` job token naming the job, whose authority is its row's,
// frozen at admission), clones an engineer job's named repositories into its workspace (the code host broker), builds the job's engine home (per agent and task: its skills, its compiled handbook, its granted
// connections as Codex config), starts the run (jobs.ts runAdmitted), renews the box's lease while the job lives and releases
// it when the job ends, removing the task's workspace then if the job asked (`aidenhq cleanup`, jobtools.ts). A kernel restart
// changes nothing: the renewals and releases are driven from the job rows.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mcpBlock } from "../../services/computer/lib.mjs";
import type { Admitted } from "./admission.ts";
import { mintToken } from "./gateway/token.ts";
import type { Whoami } from "./identity.ts";
import { JobError, insideNoLinks, type Jobs } from "./jobs.ts";
import type { Once } from "./once.ts";
import { outFiles } from "./outfiles.ts";
import { engineState, type Box, type SandboxConfig } from "./sandbox.ts";

const RENEW_MS = 5 * 60_000; // the launcher's lease is 15 minutes

type Call = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The launcher's job routes as the kernel: a non-2xx answer throws with its status (503: no free computer). */
export function launcherClient(url: string, key: () => string, fetchImpl: typeof fetch = fetch): Call {
  return async (route, body) => {
    const res = await fetchImpl(new URL(route, url), { method: "POST", headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(`the computer launcher answered ${res.status} on ${route}: ${String(j.error ?? "").slice(0, 300)}`), { status: res.status });
    return j;
  };
}

/**
 * Every owner/name a task's text names (a GitHub URL or a bare org/repo token), first mention first: the runner's rule. An
 * all-digit name is an issue or board number, not a repository.
 */
export function mentionedRepos(text: string): string[] {
  const found = new Map<string, string>();
  const re = /(?:https?:\/\/github\.com\/|git@github\.com:|(?<![\w./@:-]))([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/#?)\]>,;:'"`]|\.(?:[\s)\]>,;:'"`]|$)|$)/g;
  for (const m of text.matchAll(re)) {
    if (/^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!) || /^\d+$/.test(m[2]!)) continue;
    const slug = `${m[1]}/${m[2]}`;
    if (!found.has(slug.toLowerCase())) found.set(slug.toLowerCase(), slug);
  }
  return [...found.values()];
}

/** An engineer job's clones (the kernel's code host broker, codehost.ts): what may be cloned for a dispatcher, and the clone. */
export type Clones = {
  /** The task's title and description (the control plane, as the owner). */
  text: (task: string) => Promise<string>;
  /** Whether `module`'s codehost grant lets it clone `repo` (checked here, so a token that names no repository never reaches GitHub). */
  may: (module: string, repo: string) => boolean;
  /** `repo`'s default branch cloned into the task's workspace as <workspace>/<name>; throws with the code host's status. */
  clone: (module: string, repo: string, task: string) => Promise<void>;
};
const MAX_CLONES = 5;

/** The task's files in the control plane, and a way to attach one (as the owner: the control plane takes an agent key's writes only inside a run). */
export type Attachments = {
  list: (task: string) => Promise<{ originalFilename?: string; byteSize?: number }[]>;
  add: (task: string, name: string, type: string, data: Buffer) => Promise<void>;
};

export function createBoxes({ db, cfg, jobs, call, secret, whoami, connections, handbook, cleanup, clones, identity, attachments, once, log, now = Date.now }: {
  db: DatabaseSync; attachments: Attachments; once: Once; cfg: SandboxConfig; jobs: Pick<Jobs, "runAdmitted">; call: Call; secret: (name: string) => string; whoami: Whoami;
  /** Who the agent's commits are authored as: its name and its own address (never the owner's). */
  identity: (agent: string) => { name: string; email: string };
  /** An engineer job's workspace: the repositories its task names, cloned before the box starts. */
  clones: Clones;
  /** Whether a job asked for its workspace to go when it ends (jobtools.ts). */
  cleanup: (job: string) => boolean;
  /** config/computers.json `connections`: each connection's tool timeout, for the box's Codex config. */
  connections: () => Record<string, { tool_timeout_sec?: number }>;
  /** The agent's compiled handbook (setup writes config/handbooks/<agent id>.md), or undefined. */
  handbook: (agent: string) => string | undefined;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}) {

  /** admission.ts `launch`: the job's token, its engine home and workspace, its box, then the run. */
  async function launch(job: Admitted) {
    const { authority: a } = job;
    const workspace = join(cfg.workDir, "tasks", job.identifier);
    const state = engineState(cfg, a.engine, `${job.agent}/${job.task}`, a.skills);
    if (!state) throw new JobError(400, "no-engine-home", `the ${a.engine} engine keeps no state folder, so the job can't have its own home`);
    // The agent's compiled handbook is the engine's instructions file (what Paperclip delivered to crew runs).
    const book = handbook(job.agent);
    if (!book) throw new JobError(500, "no-handbook", `agent ${job.agent} has no compiled handbook (config/handbooks; apply writes it)`);
    writeFileSync(join(state, "AGENTS.md"), book, { mode: 0o600 });
    const token = mintToken(secret("gateway_job_secret"), { kind: "job", job: job.id, agentId: job.agent, issueId: job.task, ttlMs: (cfg.timeout_minutes + 60) * 60_000 }, now());
    // The box's connections: exactly what this job's token resolves to (its frozen authority), never the grants table.
    const mcp = mcpBlock((await whoami(token)).tools, connections(), cfg.boxGatewayUrl);
    // The task's last box goes first (the launcher keeps one per task); while it is still going, the job waits a tick.
    for (const r of db.prepare("SELECT id FROM jobs WHERE task = ? AND authority IS NOT NULL AND box IS NOT NULL AND released IS NULL AND state NOT IN ('admitted', 'running')").all(job.task) as { id: string }[]) await release(r.id);
    // After that release: a cleanup it does removes the last job's workspace, never this one's.
    mkdirSync(workspace, { recursive: true });
    insideNoLinks(join(cfg.workDir, "tasks"), workspace, "workspace");
    const notes = a.profile === "engineer" ? await cloneNamed(job) : [];
    const session = job.fresh ? undefined : lastSession(job.agent, job.task, a.engine);
    const base = session ? job.prompt : job.fullPrompt ?? job.prompt;
    const prompt = notes.length ? `(Kernel note: ${notes.join(" ")})\n\n${base}` : base;
    const box = (await call("/job", { agentId: job.agent, issueId: job.task, identifier: job.identifier, workspace, engine: a.engine, state, image: a.image, token, mcp, roles: a.roles, identity: identity(job.agent) }).catch((e: { status?: number }) => {
      throw e.status === 409 ? Object.assign(e, { status: 503 }) : e;
    })) as unknown as Box;
    // The row's box names its workspace too, for a cleanup at release.
    db.prepare("UPDATE jobs SET box = ?, renewed = ? WHERE id = ?").run(JSON.stringify({ ...box, workspace }), now(), job.id);
    try {
      jobs.runAdmitted(job.id, { box: { ...box, workspace } as Box, worktree: workspace, prompt, session, label: job.identifier });
    } catch (e) {
      await release(job.id).catch(() => {});
      throw e;
    }
  }

  /**
   * An engineer job's repositories: each one its task names that its dispatcher may clone, cloned into the workspace as
   * <name> (the box's /workspace/<name>) on its default branch; one already there (409) is kept as it is. A refusal is told to
   * the job (its notes); a code host that can't answer (5xx, unreachable) makes the launch a 503, so admission tries again.
   */
  async function cloneNamed(job: Admitted): Promise<string[]> {
    const named = mentionedRepos(await clones.text(job.task)).filter((r) => clones.may(job.module, r)).slice(0, MAX_CLONES);
    const notes: string[] = [];
    for (const repo of named) {
      try {
        await clones.clone(job.module, repo, job.task);
        log("repository cloned into the job's workspace", { job: job.id, repo });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 502;
        if (status === 409) continue;
        if (status >= 500) throw new JobError(503, "clone-failed", `${repo} couldn't be cloned now (${(e as Error).message.slice(0, 200)})`);
        log("repository not cloned", { job: job.id, repo, status, err: (e as Error).message.slice(0, 200) });
        notes.push(`\`${repo}\` is named in the task but couldn't be cloned into your workspace (${(e as Error).message.slice(0, 200)}).`);
      }
    }
    return notes;
  }

  /**
   * The session to resume: the one of this agent's last finished job on this task with this engine, when that job's engine ran
   * (it wrote events). A resume that died at start (no events: its session isn't in the engine home) starts the next job
   * fresh, so one lost session never fails every later job; a job the kernel didn't admit (before the engine home was per agent
   * and task) is never resumed.
   */
  const lastSession = (agent: string, task: string, engine: string) => {
    const r = db.prepare("SELECT session, offset FROM jobs WHERE agent = ? AND task = ? AND engine = ? AND authority IS NOT NULL AND state NOT IN ('admitted', 'running') ORDER BY at DESC LIMIT 1").get(agent, task, engine) as { session: string | null; offset: number } | undefined;
    return r && r.offset > 0 ? r.session ?? undefined : undefined;
  };

  /**
   * What an engineer job made in <workspace>/.aidenhq/out/ is attached to its task, once per job (the once-key), before its
   * workspace can go. A failure is logged and never holds the box.
   */
  async function shareOutFiles(id: string, task: string, workspace: string) {
    try {
      await once(`outfiles:${id}`, async () => {
        if (!existsSync(workspace)) return [];
        const have = new Set((await attachments.list(task)).map((a) => `${a.originalFilename}:${a.byteSize}`));
        const sent: string[] = [];
        for (const f of outFiles(workspace, have)) {
          try { await attachments.add(task, f.name, f.type, f.data); sent.push(f.name); } catch (e) { log("couldn't attach an output file", { job: id, file: f.name, err: (e as Error).message.slice(0, 200) }); }
        }
        if (sent.length) log("output files attached to the task", { job: id, task, files: sent });
        return sent;
      });
    } catch (e) {
      log("couldn't attach a job's output files", { job: id, err: (e as Error).message.slice(0, 200) });
    }
  }

  /**
   * The job's box goes, once: a release claims the row first (released = -1), so two at once (the job's end and tend) never
   * both run; a failed launcher call gives the claim back for the next tend. The workspace goes too when the job asked
   * (`aidenhq cleanup`), unless a later job on the task is already admitted or running in it.
   */
  async function release(id: string) {
    const r = db.prepare("SELECT task, box FROM jobs WHERE id = ? AND authority IS NOT NULL AND released IS NULL").get(id) as { task: string; box: string | null } | undefined;
    if (!r?.box || db.prepare("UPDATE jobs SET released = -1 WHERE id = ? AND released IS NULL").run(id).changes !== 1) return;
    const { container, workspace } = JSON.parse(r.box) as Box & { workspace?: string };
    if (workspace) await shareOutFiles(id, r.task, workspace);
    try {
      await call("/job/release", { container });
    } catch (e) {
      db.prepare("UPDATE jobs SET released = NULL WHERE id = ? AND released = -1").run(id);
      throw e;
    }
    if (workspace && cleanup(id) && existsSync(workspace) && !db.prepare("SELECT 1 FROM jobs WHERE task = ? AND state IN ('admitted', 'running')").get(r.task)) {
      insideNoLinks(join(cfg.workDir, "tasks"), workspace, "workspace");
      rmSync(workspace, { recursive: true, force: true, maxRetries: 2 });
      log("job's workspace removed (aidenhq cleanup)", { job: id, workspace });
    }
    db.prepare("UPDATE jobs SET released = ? WHERE id = ?").run(now(), id);
    log("job's computer released", { job: id, container });
  }

  /** Every few minutes and at start: live jobs' leases renewed, ended jobs' boxes released (retried until the launcher agrees). */
  async function tend() {
    const rows = db.prepare("SELECT id, task, state, box, renewed FROM jobs WHERE authority IS NOT NULL AND box IS NOT NULL AND released IS NULL").all() as { id: string; task: string; state: string; box: string; renewed: number | null }[];
    for (const r of rows) {
      try {
        if (r.state !== "running") await release(r.id);
        else if (now() - (r.renewed ?? 0) >= RENEW_MS) {
          await call("/job/renew", { container: (JSON.parse(r.box) as Box).container, issueId: r.task });
          db.prepare("UPDATE jobs SET renewed = ? WHERE id = ?").run(now(), r.id);
        }
      } catch (e) {
        log("couldn't tend a job's computer", { job: r.id, err: (e as Error).message });
      }
    }
  }

  return {
    launch,
    /** jobs.ts onEnd: the job is over, its box goes. */
    ended: (id: string) => void release(id).catch((e: Error) => log("couldn't release a job's computer", { job: id, err: e.message })),
    tend,
    /** Tends now (adopted jobs keep their leases) and every minute after. */
    start() {
      // A release this kernel's last run claimed but never finished is tended again.
      db.prepare("UPDATE jobs SET released = NULL WHERE released = -1").run();
      void tend();
      const t = setInterval(() => void tend(), 60_000);
      t.unref();
      return () => clearInterval(t);
    },
  };
}
export type Boxes = ReturnType<typeof createBoxes>;

/** The compiled handbook setup wrote for an agent (config/handbooks/<id>.md). */
export const handbookFrom = (configDir: string) => (agent: string) => {
  if (!/^[\w-]+$/.test(agent)) return undefined;
  try { return readFileSync(join(configDir, "handbooks", `${agent}.md`), "utf8"); } catch { return undefined; }
};
