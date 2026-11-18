// The kernel owns an admitted job's computer (spec §4.2a): it gets the box from the computer launcher (its job routes, bearer
// launcher_kernel_key), mints the job's only credential (an `ahqj_` job token naming the job, whose authority is its row's,
// frozen at admission), builds the job's engine home (per agent and task: its skills, its compiled handbook, its granted
// connections as Codex config), starts the run (jobs.ts runAdmitted), renews the box's lease while the job lives and releases
// it when the job ends. A kernel restart changes nothing: the renewals and releases are driven from the job rows.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mcpBlock } from "../../services/computer/lib.mjs";
import type { Admitted } from "./admission.ts";
import { mintToken } from "./gateway/token.ts";
import type { Whoami } from "./identity.ts";
import { JobError, insideNoLinks, type Jobs } from "./jobs.ts";
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

export function createBoxes({ db, cfg, jobs, call, secret, whoami, connections, handbook, log, now = Date.now }: {
  db: DatabaseSync; cfg: SandboxConfig; jobs: Pick<Jobs, "runAdmitted">; call: Call; secret: (name: string) => string; whoami: Whoami;
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
    // An engineer job's workspace is codehost's credential-free clone (Task F7) and a check job's a snapshot (F8); until
    // those land, only crew jobs (an empty per-task folder) start here.
    if (a.profile !== "crew") throw new JobError(501, "profile-not-ready", `${a.profile} jobs need codehost's workspace, which the kernel can't get yet`);
    const workspace = join(cfg.workDir, "tasks", job.identifier);
    mkdirSync(workspace, { recursive: true });
    insideNoLinks(join(cfg.workDir, "tasks"), workspace, "workspace");
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
    const box = (await call("/job", { agentId: job.agent, issueId: job.task, identifier: job.identifier, workspace, engine: a.engine, state, image: a.image, token, mcp }).catch((e: { status?: number }) => {
      throw e.status === 409 ? Object.assign(e, { status: 503 }) : e;
    })) as unknown as Box;
    db.prepare("UPDATE jobs SET box = ?, renewed = ? WHERE id = ?").run(JSON.stringify(box), now(), job.id);
    try {
      jobs.runAdmitted(job.id, { box, worktree: workspace, prompt: job.prompt, session: job.session ?? lastSession(job.agent, job.task), label: job.identifier });
    } catch (e) {
      await release(job.id).catch(() => {});
      throw e;
    }
  }

  /** The engine's last session for this agent on this task: a crew agent resumes per task, as Paperclip ran it. */
  const lastSession = (agent: string, task: string) =>
    (db.prepare("SELECT session FROM jobs WHERE agent = ? AND task = ? AND session IS NOT NULL ORDER BY at DESC LIMIT 1").get(agent, task) as { session: string } | undefined)?.session;

  async function release(id: string) {
    const r = db.prepare("SELECT box FROM jobs WHERE id = ? AND authority IS NOT NULL AND released IS NULL").get(id) as { box: string | null } | undefined;
    if (!r?.box) return;
    const { container } = JSON.parse(r.box) as Box;
    await call("/job/release", { container });
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
